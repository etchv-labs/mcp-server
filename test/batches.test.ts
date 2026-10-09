import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, connect } from "./helpers.ts";
import {
  fillTemplate,
  isBatchFile,
  outputName,
  safeStem,
} from "../src/batches.ts";
import { fileAccess } from "../src/io.ts";
import { apiClient } from "../src/api.ts";

const secret = "etchv_" + "k".repeat(43);
const batchId = "bat_" + "b".repeat(32);
const req = (n: number) => "req_" + String(n).repeat(64);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(40),
]);
const pdf = Buffer.from("%PDF-1.7\n%%EOF\n");

type Seen = {
  method: string;
  path: string;
  key?: string;
  idempotency?: string;
  json?: Record<string, unknown>;
  size: number;
};

/** A stand-in for the batches API that records every request it receives. */
async function fakeApi(
  views: (
    seen: Seen[],
    base: string,
  ) => Record<string, Record<string, unknown>>,
) {
  const seen: Seen[] = [];
  let polls = 0;
  const http = createServer(async (incoming, response) => {
    const url = new URL(incoming.url!, "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const record: Seen = {
      method: incoming.method!,
      path: url.pathname,
      key: incoming.headers["x-api-key"] as string | undefined,
      idempotency: incoming.headers["idempotency-key"] as string | undefined,
      size: body.length,
    };
    if (incoming.headers["content-type"] === "application/json")
      record.json = JSON.parse(body.toString());
    seen.push(record);
    const base = `http://localhost:${(http.address() as AddressInfo).port}`;
    const pages = views(seen, base);
    const route = `${record.method} ${record.path}`;
    if (record.path.startsWith("/signed/"))
      return response.writeHead(200).end();
    if (route === `GET /watermarks/batches/${batchId}`) {
      const { http_status, ...page } = pages[`poll${polls++}`] ?? pages.done;
      response.writeHead(Number(http_status ?? 200), {
        "content-type": "application/json",
        ...(page.status === "completed" ? {} : { "retry-after": "1" }),
      });
      return response.end(JSON.stringify(page));
    }
    if (route === `GET /watermarks/batches/${batchId}/archive`) {
      response.writeHead(200, { "content-type": "application/zip" });
      return response.end("PK zip bytes");
    }
    if (record.method === "GET" && record.path.endsWith("/result")) {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition":
          'attachment; filename="api-name-watermarked.png"',
      });
      return response.end(`marked ${record.path}`);
    }
    const found = pages[route];
    if (!found) return response.writeHead(404).end();
    // A page may set the HTTP status it answers with.
    const { http_status, ...page } = found;
    response.writeHead(
      Number(http_status ?? (route.endsWith("/start") ? 202 : 201)),
      { "content-type": "application/json", "retry-after": "1" },
    );
    response.end(JSON.stringify(page));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    http,
    base: `http://localhost:${(http.address() as AddressInfo).port}`,
  };
}

const counts = (o: Record<string, number> = {}) => ({
  pending: 0,
  accepted: 0,
  rejected: 0,
  succeeded: 0,
  failed: 0,
  in_progress: 0,
  ...o,
});
const item = (index: number, filename: string, extra = {}) => ({
  index,
  filename,
  size: 1,
  upload_id: "upl_" + String(index).repeat(32),
  request_id: null,
  status: "pending",
  error_code: null,
  error_detail: null,
  credits: null,
  ...extra,
});

test("watermark_batch uploads each file without the API key, starts, polls and saves results", async () => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-batch-"));
  await mkdir(join(root, "in", "nested"), { recursive: true });
  await mkdir(join(root, "out"));
  await writeFile(join(root, "in", "b.pdf"), pdf);
  await writeFile(join(root, "in", "nested", "a.png"), png);
  await writeFile(join(root, "in", "notes.txt"), "skip me");
  const api = await fakeApi((_seen, base) => {
    const upload = (n: number, ext: string) => ({
      method: "PUT",
      url: `${base}/signed/${n}.${ext}?Signature=s`,
      expires_at: "2026-10-09T18:00:00Z",
    });
    const summary = { batch_id: batchId, item_count: 2, archive: false };
    return {
      "POST /watermarks/batches": {
        ...summary,
        status: "draft",
        counts: counts({ pending: 2 }),
        items: [
          item(0, "b.pdf", { upload: upload(0, "pdf") }),
          item(1, "a.png", { upload: upload(1, "png") }),
        ],
      },
      [`POST /watermarks/batches/${batchId}/start`]: {
        ...summary,
        status: "starting",
        counts: counts({ pending: 2 }),
        items: [item(0, "b.pdf"), item(1, "a.png")],
      },
      done: {
        ...summary,
        status: "completed",
        counts: counts({ accepted: 2, succeeded: 1, failed: 1 }),
        credits: { reserved: 2, charged: 1, refunded: 1 },
        items: [
          item(0, "b.pdf", {
            status: "failed",
            request_id: req(1),
            error_code: "invalid_input",
            error_detail: "The PDF could not be read",
            credits: 0,
          }),
          item(1, "a.png", {
            status: "succeeded",
            request_id: req(2),
            result_url: `/watermarks/jobs/${req(2)}/result`,
            credits: 1,
          }),
        ],
      },
    };
  });
  const session = await connect(root, secret, api.base);
  try {
    const value = await call(session.client, "watermark_batch", {
      input_dir: "in",
      data_template: { recipient: "acme", file: "{stem}", n: ["{index}"] },
      wait: true,
      output_dir: "out",
    });
    // Uploads run in parallel, so only their set is fixed.
    const routes = api.seen.map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(routes.slice(1, 3).sort(), [
      "PUT /signed/0.pdf",
      "PUT /signed/1.png",
    ]);
    assert.deepEqual(
      [routes[0], ...routes.slice(3)],
      [
        "POST /watermarks/batches",
        `POST /watermarks/batches/${batchId}/start`,
        `GET /watermarks/batches/${batchId}`,
        `GET /watermarks/jobs/${req(2)}/result`,
      ],
    );
    const create = api.seen[0];
    assert.equal(create.key, secret);
    assert.match(create.idempotency ?? "", /^mcp_[a-f0-9]{60}$/);
    assert.deepEqual(create.json, {
      items: [
        {
          filename: "b.pdf",
          size: pdf.length,
          data: { recipient: "acme", file: "b", n: ["0"] },
        },
        {
          filename: "a.png",
          size: png.length,
          data: { recipient: "acme", file: "a", n: ["1"] },
        },
      ],
      archive: false,
    });
    for (const put of api.seen.filter((r) => r.method === "PUT")) {
      assert.equal(put.key, undefined);
      assert.equal(put.idempotency, undefined);
    }
    assert.deepEqual(
      Object.fromEntries(
        api.seen.filter((r) => r.method === "PUT").map((r) => [r.path, r.size]),
      ),
      { "/signed/0.pdf": pdf.length, "/signed/1.png": png.length },
    );
    assert.equal(value.status, "completed");
    assert.equal(value.files_uploaded, 2);
    assert.equal(JSON.stringify(value).includes("Signature"), false);
    const items = value.items as Record<string, unknown>[];
    assert.equal(items[1].input_path, join("in", "nested", "a.png"));
    const download = value.download as Record<string, unknown>;
    assert.deepEqual(download.failed, [
      {
        index: 0,
        filename: "b.pdf",
        status: "failed",
        error_code: "invalid_input",
        error_detail: "The PDF could not be read",
      },
    ]);
    assert.deepEqual(await readdir(join(root, "out")), [
      "001-api-name-watermarked.png",
    ]);
    assert.equal(
      await readFile(join(root, "out", "001-api-name-watermarked.png"), "utf8"),
      `marked /watermarks/jobs/${req(2)}/result`,
    );

    // The same call again derives the same idempotency key.
    await call(session.client, "watermark_batch", {
      input_dir: "in",
      data_template: { recipient: "acme", file: "{stem}", n: ["{index}"] },
    });
    const creates = api.seen.filter(
      (r) => r.path === "/watermarks/batches" && r.method === "POST",
    );
    assert.equal(creates[1].idempotency, creates[0].idempotency);
  } finally {
    await session.close();
    api.http.close();
  }
});

test("watermark_batch enforces the 100-file cap and its input rules before any request", async () => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-batch-"));
  await writeFile(join(root, "a.png"), png);
  await writeFile(join(root, "a.txt"), "text");
  const api = await fakeApi(() => ({}));
  const session = await connect(root, secret, api.base);
  try {
    const many = Array.from({ length: 101 }, (_, i) => `f${i}.png`);
    const capped = await call(
      session.client,
      "watermark_batch",
      { input_paths: many, data_template: { id: "{index}" } },
      true,
    );
    assert.match(String(capped.error), /up to 100 files.*names 101/);
    for (const [args, message] of [
      [{ data_template: { a: 1 } }, /exactly one of/],
      [
        { input_paths: ["a.png"], input_dir: ".", data_template: { a: 1 } },
        /exactly one of/,
      ],
      [
        { input_paths: ["a.png"], glob: "*.png", data_template: { a: 1 } },
        /glob requires input_dir/,
      ],
      [{ input_paths: ["a.png"] }, /data must be a non-empty JSON object/],
      [
        { input_paths: ["a.txt"], data_template: { a: 1 } },
        /unsupported file type/,
      ],
      [
        { input_paths: ["a.png"], data_template: { a: 1 }, output_dir: "." },
        /output_dir requires wait/,
      ],
      [
        { input_dir: ".", glob: "../*", data_template: { a: 1 } },
        /relative pattern/,
      ],
      [
        { input_paths: ["../a.png"], data_template: { a: 1 } },
        /inside ETCHV_FILES_ROOT/,
      ],
      [
        { input_paths: ["missing.png"], data_template: { a: 1 } },
        /missing.png: file does not exist/,
      ],
    ] as const) {
      const value = await call(session.client, "watermark_batch", args, true);
      assert.match(String(value.error), message, JSON.stringify(args));
    }
    assert.equal(api.seen.length, 0);
  } finally {
    await session.close();
    api.http.close();
  }
});

test("items carry their own data and a caller key; get_batch hides upload URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-batch-"));
  await writeFile(join(root, "a.png"), png);
  await writeFile(join(root, "b.png"), png);
  const api = await fakeApi((_seen, base) => {
    const draft = {
      batch_id: batchId,
      status: "processing",
      item_count: 2,
      counts: counts({ accepted: 2, in_progress: 2 }),
      items: [
        item(0, "a.png", {
          upload: { method: "PUT", url: `${base}/signed/0.png?Signature=s` },
        }),
        item(1, "b.png", {
          upload: { method: "PUT", url: `${base}/signed/1.png?Signature=s` },
        }),
      ],
    };
    return {
      "POST /watermarks/batches": { ...draft, status: "draft" },
      [`POST /watermarks/batches/${batchId}/start`]: draft,
      poll0: draft,
      done: draft,
    };
  });
  const session = await connect(root, secret, api.base);
  try {
    const value = await call(session.client, "watermark_batch", {
      items: [
        { input_path: "a.png", data: { recipient: "first" } },
        { input_path: "b.png" },
      ],
      data_template: { recipient: "{filename}" },
      archive: true,
      accelerator: "gpu",
      idempotency_key: "caller_key_0001",
    });
    assert.equal(value.status, "processing");
    assert.equal(value.retry_after_seconds, 1);
    assert.match(String(value.message), /get_batch/);
    assert.equal(api.seen[0].idempotency, "caller_key_0001");
    assert.deepEqual(api.seen[0].json, {
      items: [
        { filename: "a.png", size: png.length, data: { recipient: "first" } },
        { filename: "b.png", size: png.length, data: { recipient: "b.png" } },
      ],
      archive: true,
      accelerator: "gpu",
    });
    const batch = await call(session.client, "get_batch", {
      batch_id: batchId,
    });
    assert.equal(batch.retry_after_seconds, 1);
    assert.equal(JSON.stringify(batch).includes("/signed/"), false);
    assert.equal(
      (batch.items as Record<string, unknown>[])[0].awaiting_upload,
      true,
    );
    const early = await call(session.client, "download_batch", {
      batch_id: batchId,
      output_dir: ".",
    });
    assert.match(String(early.message), /still running/);
    const invalid = await session.client.callTool({
      name: "get_batch",
      arguments: { batch_id: "bat_nope" },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await session.close();
    api.http.close();
  }
});

test("download_batch saves the zip of an archived batch and reports failed items", async () => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-batch-"));
  const done = {
    batch_id: batchId,
    status: "completed",
    item_count: 2,
    archive: true,
    archive_status: "ready",
    archive_url: `/watermarks/batches/${batchId}/archive`,
    counts: counts({ accepted: 1, rejected: 1, succeeded: 1 }),
    items: [
      item(0, "a.png", {
        status: "succeeded",
        request_id: req(3),
        result_url: `/watermarks/jobs/${req(3)}/result`,
      }),
      item(1, "b.png", {
        status: "rejected",
        error_code: "upload_not_received",
      }),
    ],
  };
  const api = await fakeApi(() => ({ done }));
  const session = await connect(root, secret, api.base);
  try {
    const value = await call(session.client, "download_batch", {
      batch_id: batchId,
      output_dir: ".",
    });
    assert.equal((value.archive as Record<string, unknown>).size_bytes, 12);
    assert.deepEqual(value.failed, [
      {
        index: 1,
        filename: "b.png",
        status: "rejected",
        error_code: "upload_not_received",
        error_detail: null,
      },
    ]);
    assert.equal(
      await readFile(join(root, `${batchId}.zip`), "utf8"),
      "PK zip bytes",
    );
    // Separate files on request; an existing file is reported, never overwritten.
    await writeFile(join(root, "000-api-name-watermarked.png"), "keep");
    const separate = await call(session.client, "download_batch", {
      batch_id: batchId,
      output_dir: ".",
      archive: false,
    });
    assert.deepEqual(separate.files, []);
    assert.match(
      String((separate.download_errors as Record<string, unknown>[])[0].error),
      /already exists/,
    );
    assert.equal(
      await readFile(join(root, "000-api-name-watermarked.png"), "utf8"),
      "keep",
    );
    assert.equal(api.seen.filter((r) => r.path.endsWith("/archive")).length, 1);
  } finally {
    await session.close();
    api.http.close();
  }
});

test("data templates and output names", () => {
  assert.deepEqual(
    fillTemplate(
      {
        a: "{filename}",
        b: { c: ["{stem}-{index}", 3, null] },
        "{index}": "{other}",
      },
      { filename: "x.pdf", stem: "x", index: "7" },
    ),
    { a: "x.pdf", b: { c: ["x-7", 3, null] }, "{index}": "{other}" },
  );
  // Without a usable Content-Disposition, names follow the API's stem rule.
  assert.equal(outputName(4, "Q3 report.pdf"), "004-Q3-report-watermarked.pdf");
  assert.equal(
    outputName(7, "résumé final!!.JPG"),
    "007-r-sum-final-watermarked.jpg",
  );
  assert.equal(
    outputName(12, "../../etc/passwd.png"),
    "012-passwd-watermarked.png",
  );
  assert.equal(outputName(0, ".."), "000-image-watermarked");
  assert.equal(safeStem("x".repeat(300) + ".png").length, 180);
  assert.equal(
    outputName(3, "x.png", 'attachment; filename="x-watermarked.webp"'),
    "003-x-watermarked.webp",
  );
  for (const hostile of ['filename="../x.png"', 'filename=".hidden"', ""])
    assert.equal(
      outputName(3, "x.png", `attachment; ${hostile}`),
      "003-x-watermarked.png",
    );
});

test("globs cannot leave input_dir or ETCHV_FILES_ROOT, and outside names never appear", async () => {
  const outside = await mkdtemp(join(tmpdir(), "etchv-mcp-outside-"));
  await writeFile(join(outside, "secret-outside.pdf"), pdf);
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-batch-"));
  await mkdir(join(root, "in"));
  await writeFile(join(root, "sibling.pdf"), pdf);
  await symlink(outside, join(root, "in", "link"));
  const api = await fakeApi(() => ({}));
  const session = await connect(root, secret, api.base);
  try {
    for (const glob of [
      "{..,x}/**/*.pdf",
      "../*.pdf",
      "a/../../*.pdf",
      "*.{pdf,png}",
      "\\..\\*.pdf",
    ]) {
      const value = await call(
        session.client,
        "watermark_batch",
        { input_dir: "in", glob, data_template: { a: 1 } },
        true,
      );
      assert.match(String(value.error), /glob must be a relative pattern/);
    }
    // Files reached through a symlinked directory are skipped, not named.
    const value = await call(
      session.client,
      "watermark_batch",
      { input_dir: "in", data_template: { a: 1 } },
      true,
    );
    assert.match(String(value.error), /No images, PDFs/);
    assert.equal(JSON.stringify(value).includes("secret-outside"), false);
    assert.equal(api.seen.length, 0);
  } finally {
    await session.close();
    api.http.close();
  }
});

test("watermark_batch reports progress and resumes a batch without re-sending received files", async () => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-batch-"));
  await writeFile(join(root, "a.png"), png);
  await writeFile(join(root, "b.png"), png);
  const api = await fakeApi((_seen, base) => {
    const summary = { batch_id: batchId, item_count: 2, archive: false };
    return {
      "POST /watermarks/batches": {
        ...summary,
        http_status: 200,
        status: "draft",
        items: [
          item(0, "a.png", { upload_received: true }),
          item(1, "b.png", {
            upload: { method: "PUT", url: `${base}/signed/1.png?Signature=s` },
          }),
        ],
      },
      [`POST /watermarks/batches/${batchId}/start`]: {
        ...summary,
        status: "processing",
        counts: counts({ accepted: 2, in_progress: 2 }),
        items: [item(0, "a.png"), item(1, "b.png")],
      },
      done: {
        ...summary,
        status: "completed",
        counts: counts({ accepted: 2, succeeded: 2 }),
        items: [item(0, "a.png"), item(1, "b.png")],
      },
    };
  });
  const session = await connect(root, secret, api.base);
  try {
    const messages: string[] = [];
    const response = await session.client.callTool(
      {
        name: "watermark_batch",
        arguments: {
          input_paths: ["a.png", "b.png"],
          data_template: { id: "{index}" },
          wait: true,
        },
      },
      {
        timeout: 60000,
        onprogress: (p: { message?: string }) => {
          messages.push(String(p.message));
        },
      },
    );
    assert.equal(response.isError, undefined, JSON.stringify(response));
    assert.deepEqual(
      api.seen.filter((r) => r.method === "PUT").map((r) => r.path),
      ["/signed/1.png"],
    );
    const value = response.structuredContent as Record<string, unknown>;
    assert.equal(value.status, "completed");
    assert.equal(value.files_uploaded, 1);
    assert.ok(messages.includes("Uploaded 1 of 1 files"), messages.join());
    assert.ok(messages.includes(`Started batch ${batchId}`), messages.join());
    // Progress for the final state is sent, but the SDK's client drops a
    // notification that lands in the same read as the result (it removes the
    // call's progress handler on the response before its deferred notification
    // handler runs), so the result's status is what proves completion.
    assert.ok(
      messages.every(
        (m) =>
          !m.startsWith("Batch ") ||
          /^Batch \w+: \d+ of 2 files finished$/.test(m),
      ),
      messages.join(),
    );
  } finally {
    await session.close();
    api.http.close();
  }
});

test("a derived key that matches an expired or spent batch asks for a new idempotency_key", async () => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-batch-"));
  await writeFile(join(root, "a.png"), png);
  const cases: [Record<string, unknown>, Record<string, unknown>, RegExp][] = [
    [
      { http_status: 200, status: "expired", items: [item(0, "a.png")] },
      {},
      /never started and has expired.*Pass an idempotency_key/,
    ],
    [
      {
        http_status: 200,
        status: "completed",
        items: [
          item(0, "a.png", {
            status: "succeeded",
            result_url: `/watermarks/jobs/${req(4)}/result`,
            result_expires_at: "2026-01-01T00:00:00Z",
          }),
        ],
      },
      {},
      /already finished \(completed\) and whose results have expired/,
    ],
    [
      { status: "draft", items: [item(0, "a.png")] },
      { http_status: 410, detail: "expired" },
      /never started and has expired/,
    ],
  ];
  for (const [create, start, message] of cases) {
    const api = await fakeApi(() => ({
      "POST /watermarks/batches": { batch_id: batchId, ...create },
      [`POST /watermarks/batches/${batchId}/start`]: start,
    }));
    const session = await connect(root, secret, api.base);
    try {
      const value = await call(
        session.client,
        "watermark_batch",
        { input_paths: ["a.png"], data_template: { a: 1 } },
        true,
      );
      assert.match(String(value.error), message);
      assert.match(String(value.error), new RegExp(batchId));
    } finally {
      await session.close();
      api.http.close();
    }
  }
});

test("a directory listing filters by type while walking and refuses a walk it cannot finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-batch-"));
  await mkdir(join(root, "many"));
  // More unsupported entries than the old 10,000-entry bound, then two PDFs.
  for (let start = 0; start < 10005; start += 500)
    await Promise.all(
      Array.from({ length: Math.min(500, 10005 - start) }, (_, i) =>
        writeFile(join(root, "many", `note-${start + i}.txt`), "x"),
      ),
    );
  await writeFile(join(root, "many", "zz-a.pdf"), pdf);
  await writeFile(join(root, "many", "zz-b.pdf"), pdf);
  const files = await fileAccess(root);
  assert.deepEqual(await files.list("many", "**/*", isBatchFile, 100), {
    files: [join("many", "zz-a.pdf"), join("many", "zz-b.pdf")],
    more: false,
  });
  await assert.rejects(
    files.list("many", "**/*", isBatchFile, 100, 50),
    /more than 50 entries.*narrower glob/,
  );
  await mkdir(join(root, "pdfs"));
  for (let i = 0; i < 101; i++)
    await writeFile(join(root, "pdfs", `f${i}.pdf`), pdf);
  const capped = await files.list("pdfs", "*.pdf", isBatchFile, 100);
  assert.equal(capped.more, true);
  const api = await fakeApi(() => ({}));
  const session = await connect(root, secret, api.base);
  try {
    const value = await call(
      session.client,
      "watermark_batch",
      { input_dir: "pdfs", data_template: { a: 1 } },
      true,
    );
    assert.match(String(value.error), /names more than 100\./);
    assert.equal(api.seen.length, 0);
  } finally {
    await session.close();
    api.http.close();
  }
});

test("a stalled signed upload times out with a clear message", async () => {
  let puts = 0;
  const http = createServer((incoming) => {
    puts++;
    incoming.resume(); // Read the body, never answer.
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base = `http://localhost:${(http.address() as AddressInfo).port}`;
  try {
    const api = apiClient({ apiKey: secret, baseUrl: base, timeout: 50 });
    await assert.rejects(
      api.put({ method: "PUT", url: `${base}/signed/x` }, new Uint8Array(10)),
      /upload timed out/,
    );
    assert.equal(puts, 3);
  } finally {
    http.closeAllConnections();
    http.close();
  }
});

test("a failed check while waiting keeps the batch ID, and a draft is never called running", async () => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-batch-"));
  await writeFile(join(root, "a.png"), png);
  const summary = { batch_id: batchId, item_count: 1, archive: false };
  const api = await fakeApi((_seen, base) => ({
    "POST /watermarks/batches": {
      ...summary,
      status: "draft",
      items: [
        item(0, "a.png", {
          upload: { method: "PUT", url: `${base}/signed/0.png?Signature=s` },
        }),
      ],
    },
    [`POST /watermarks/batches/${batchId}/start`]: {
      ...summary,
      status: "processing",
      items: [item(0, "a.png")],
    },
    poll0: { http_status: 503 },
    done: { ...summary, status: "draft", items: [item(0, "a.png")] },
  }));
  const session = await connect(root, secret, api.base);
  try {
    const failed = await call(
      session.client,
      "watermark_batch",
      { input_paths: ["a.png"], data_template: { a: 1 }, wait: true },
      true,
    );
    assert.match(
      String(failed.error),
      new RegExp(`Checking batch ${batchId} failed.*keeps running.*get_batch`),
    );
    for (const name of ["get_batch", "download_batch"]) {
      const value = await call(session.client, name, {
        batch_id: batchId,
        output_dir: name === "download_batch" ? "." : undefined,
      });
      assert.match(String(value.message), /never started/);
      assert.match(String(value.message), /idempotency_key/);
      assert.doesNotMatch(String(value.message), /running/);
      assert.equal(value.retry_after_seconds, undefined);
    }
  } finally {
    await session.close();
    api.http.close();
  }
});
