import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer, type ServerConfig } from "../src/server.ts";
import type { Fetcher } from "../src/fetch.ts";
import { MAX_DETECT_UPLOAD, MAX_UPLOAD } from "../src/io.ts";

const secret = "test-key-only";
const asset = "ast_" + "b".repeat(64);
const source = "ast_" + "e".repeat(64);
const req = "req_" + "a".repeat(64);
const upload = "upl_" + "1".repeat(32);
const linkUrl = `https://api.example/assets/${asset}/download?token=signed`;
const expires = "2026-10-27T12:15:00Z";
const bytes = Buffer.from("watermarked result bytes");
const LOCAL_FIELDS = [
  "input_path",
  "output_path",
  "output_dir",
  "input_paths",
  "input_dir",
];

type Seen = {
  method: string;
  path: string;
  query: URLSearchParams;
  key?: string;
  form?: FormData;
  json?: Record<string, unknown>;
};

/** A fake Etchv API with the routes the input and link paths use. */
async function fakeApi() {
  const seen: Seen[] = [];
  const state = {
    linkStatus: 201,
    uploadSize: 1024,
    uploadKind: "image",
    uploadStatus: "received",
  };
  const http = createHttp(async (incoming, response) => {
    const url = new URL(incoming.url!, "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const record: Seen = {
      method: incoming.method!,
      path: url.pathname,
      query: url.searchParams,
      key: incoming.headers["x-api-key"] as string | undefined,
    };
    const type = incoming.headers["content-type"] ?? "";
    if (type.startsWith("multipart/"))
      record.form = await new Response(body, {
        headers: { "content-type": type },
      }).formData();
    else if (body.length) record.json = JSON.parse(body.toString());
    seen.push(record);
    const route = `${record.method} ${record.path}`;
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const file = (headers: Record<string, string> = {}) => {
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(bytes.length),
        "x-request-id": req,
        "x-watermark-id": "1".repeat(64),
        "x-asset-id": asset,
        ...headers,
      });
      response.end(bytes);
    };
    if (route === `POST /assets/${asset}/links`)
      return state.linkStatus === 201
        ? send(201, { url: linkUrl, expires_at: expires })
        : send(state.linkStatus, { detail: "denied" });
    if (route === `GET /assets/${source}/content`)
      return file({
        "x-asset-id": source,
        "content-disposition": `attachment; filename="asset.png"; filename*=UTF-8''Delivered%20copy.png`,
      });
    if (route === "POST /uploads")
      return send(201, {
        upload_id: upload,
        kind: record.json?.kind,
        filename: record.json?.filename,
        size: record.json?.size,
        status: "pending",
        expires_at: expires,
        upload: {
          method: "PUT",
          url: `https://uploads.example/${upload}?Signature=s`,
          expires_at: expires,
        },
      });
    if (route === `GET /uploads/${upload}`)
      return send(200, {
        upload_id: upload,
        kind: state.uploadKind,
        size: state.uploadSize,
        status: state.uploadStatus,
      });
    if (route === "GET /auth/api-key")
      return send(200, { organization_id: "org_fixture", scopes: [] });
    if (record.path.endsWith("/async"))
      return send(202, { request_id: req, status: "queued" });
    if (record.path.endsWith("/detect"))
      return send(200, { watermarked: true, confidence: 0.99 });
    if (
      (record.method === "POST" && record.path.startsWith("/watermarks/")) ||
      route === `GET /watermarks/jobs/${req}/result` ||
      route === `GET /assets/${asset}/content`
    )
      return file();
    send(404, { detail: "not found" });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    state,
    base: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    close: () => {
      http.closeAllConnections();
      http.close();
    },
  };
}

/** A fetcher that serves fixed bytes; null stands for a URL with no file name. */
function fakeFetcher(filename: string | null = "photo.png") {
  const calls: { url: string; limit: number }[] = [];
  const fetcher: Fetcher = async (url, { limit }) => {
    calls.push({ url, limit });
    return {
      bytes: Buffer.from("fetched bytes"),
      filename: filename ?? undefined,
    };
  };
  return { calls, fetcher };
}

async function connectInProcess(config: ServerConfig) {
  const server = await createServer(config);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "etchv-mcp-test", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  expectError = false,
) {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(
    Boolean(response.isError),
    expectError,
    JSON.stringify(response),
  );
  return response.structuredContent as Record<string, unknown>;
}

test("hosted mode needs no files root and hides local files", async (t) => {
  const api = await fakeApi();
  t.after(api.close);
  const client = await connectInProcess({
    apiKey: secret,
    baseUrl: api.base,
    mode: "hosted",
  });
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name);
  assert.equal(tools.length, 27);
  for (const local of ["watermark_batch", "download_batch"])
    assert(!names.includes(local), local);
  for (const kept of ["get_batch", "create_upload", "download_asset"])
    assert(names.includes(kept), kept);
  for (const tool of tools) {
    const properties = Object.keys(tool.inputSchema.properties ?? {});
    for (const field of LOCAL_FIELDS)
      assert(!properties.includes(field), `${tool.name}.${field}`);
    assert(!JSON.stringify(tool).includes("ETCHV_FILES_ROOT"), tool.name);
    assert(!/output_path/.test(tool.description ?? ""), tool.name);
  }
  const watermark = tools.find((x) => x.name === "watermark_media")!;
  assert.deepEqual(
    ["input_url", "upload_id", "asset_id", "filename"].filter(
      (field) => !(field in (watermark.inputSchema.properties ?? {})),
    ),
    [],
  );
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /input_url/);
  assert.doesNotMatch(instructions, /ETCHV_FILES_ROOT/);
  const resource = JSON.stringify(
    await client.readResource({ uri: "etchv://capabilities" }),
  );
  assert.doesNotMatch(resource, /ETCHV_FILES_ROOT|watermark_batch/);
  assert.match(resource, /download_url/);
  assert.match(resource, /\\"server_mode\\": \\"hosted\\"/);
});

test("every tool has a title and complete annotations in both modes", async (t) => {
  const api = await fakeApi();
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-modes-"));
  t.after(async () => {
    api.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const mode of ["local", "hosted"] as const) {
    const client = await connectInProcess({
      apiKey: secret,
      baseUrl: api.base,
      mode,
      filesRoot: mode === "local" ? root : undefined,
    });
    const { tools } = await client.listTools();
    assert.equal(tools.length, mode === "local" ? 29 : 27);
    const titles = new Set<string>();
    for (const tool of tools) {
      assert(tool.title && /^[A-Z][a-z]/.test(tool.title), tool.name);
      assert.equal(tool.annotations?.title, tool.title, tool.name);
      titles.add(tool.title);
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const)
        assert.equal(
          typeof tool.annotations?.[hint],
          "boolean",
          `${tool.name}.${hint}`,
        );
      if (tool.annotations?.readOnlyHint)
        assert.equal(tool.annotations.destructiveHint, false, tool.name);
      // Directory rule: factual descriptions, no promotion.
      assert.doesNotMatch(
        tool.description ?? "",
        /\b(best|leading|powerful|world-class|seamless|revolutionary)\b/i,
        tool.name,
      );
    }
    assert.equal(titles.size, tools.length);
    const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
    assert.equal(byName.delete_asset.annotations?.destructiveHint, true);
    assert.equal(byName.create_upload.annotations?.readOnlyHint, false);
    assert.equal(byName.create_upload.annotations?.idempotentHint, false);
    assert.equal(byName.create_upload.annotations?.destructiveHint, false);
    const local = mode === "local";
    assert.equal(
      "output_path" in (byName.download_asset.inputSchema.properties ?? {}),
      local,
    );
    assert.equal(
      (byName.download_asset.inputSchema.required ?? []).includes(
        "output_path",
      ),
      false,
    );
    assert.match(
      client.getInstructions() ?? "",
      local ? /ETCHV_FILES_ROOT/ : /download links/,
    );
    await client.close();
  }
  await assert.rejects(
    createServer({ apiKey: secret, baseUrl: api.base }),
    /ETCHV_FILES_ROOT/,
  );
  await assert.rejects(
    createServer({
      apiKey: secret,
      baseUrl: api.base,
      mode: "remote" as "hosted",
    }),
    /mode must be/,
  );
});

test("hosted inputs: URL, upload_id and asset_id, with link outputs", async (t) => {
  const api = await fakeApi();
  t.after(api.close);
  const fake = fakeFetcher();
  const client = await connectInProcess({
    apiKey: secret,
    baseUrl: api.base,
    mode: "hosted",
    fetcher: fake.fetcher,
  });
  t.after(() => client.close());
  const base = {
    media: "images",
    mode: "sync",
    data: { recipient: "fixture" },
  };

  await t.test("input_url is fetched and sent as a file", async () => {
    const value = await call(client, "watermark_media", {
      ...base,
      input_url: "https://media.example/photo.png",
      idempotency_key: "url-1",
    });
    assert.deepEqual(fake.calls.at(-1), {
      url: "https://media.example/photo.png",
      limit: MAX_UPLOAD,
    });
    const sent = api.seen.at(-2)!;
    assert.equal(sent.path, "/watermarks/images");
    const file = sent.form!.get("file") as File;
    assert.equal(file.name, "photo.png");
    assert.equal(
      Buffer.from(await file.arrayBuffer()).toString(),
      "fetched bytes",
    );
    assert.equal(sent.form!.get("upload_id"), null);
    assert.equal(api.seen.at(-1)!.path, `/assets/${asset}/links`);
    assert.equal(api.seen.at(-1)!.method, "POST");
    assert.equal(api.seen.at(-1)!.key, secret);
    assert.equal(value.asset_id, asset);
    assert.equal(value.watermark_id, "1".repeat(64));
    assert.equal(value.download_url, linkUrl);
    assert.equal(value.download_expires_at, expires);
    assert.equal(value.content_type, "image/png");
    assert.equal(value.size_bytes, bytes.length);
    assert.equal(value.idempotency_key, "url-1");
    assert.equal(value.output_path, undefined);
  });

  await t.test("detection fetches up to the detection limit", async () => {
    const value = await call(client, "detect_media", {
      media: "images",
      mode: "sync",
      input_url: "https://media.example/photo.png",
      idempotency_key: "url-detect",
    });
    assert.equal(fake.calls.at(-1)!.limit, MAX_DETECT_UPLOAD);
    assert.equal(value.watermarked, true);
    assert.equal(api.seen.at(-1)!.path, "/watermarks/images/detect");
  });

  await t.test(
    "filename overrides the fetched name and is checked",
    async () => {
      await call(client, "watermark_media", {
        ...base,
        mode: "async",
        input_url: "https://media.example/download?id=7",
        filename: "renamed.jpg",
        idempotency_key: "url-2",
      });
      const file = api.seen.at(-1)!.form!.get("file") as File;
      assert.equal(file.name, "renamed.jpg");
      const before = api.seen.length;
      const calls = fake.calls.length;
      const wrong = await call(
        client,
        "watermark_media",
        {
          ...base,
          input_url: "https://media.example/photo.png",
          filename: "notes.txt",
          idempotency_key: "url-3",
        },
        true,
      );
      assert.match(String(wrong.error), /extension does not match/);
      // A wrong filename is refused before downloading anything.
      assert.equal(fake.calls.length, calls);
      assert.equal(api.seen.length, before);
    },
  );

  await t.test(
    "a fetched name that does not match media is refused",
    async () => {
      const other = fakeFetcher("page.html");
      const strict = await connectInProcess({
        apiKey: secret,
        baseUrl: api.base,
        mode: "hosted",
        fetcher: other.fetcher,
      });
      const before = api.seen.length;
      const value = await call(
        strict,
        "watermark_media",
        {
          ...base,
          input_url: "https://media.example/page",
          idempotency_key: "url-4",
        },
        true,
      );
      assert.match(String(value.error), /extension does not match/);
      const unnamed = await connectInProcess({
        apiKey: secret,
        baseUrl: api.base,
        mode: "hosted",
        fetcher: fakeFetcher(null).fetcher,
      });
      const nameless = await call(
        unnamed,
        "watermark_media",
        { ...base, input_url: "https://media.example/", idempotency_key: "u5" },
        true,
      );
      assert.match(String(nameless.error), /Pass filename/);
      assert.equal(api.seen.length, before);
      await strict.close();
      await unnamed.close();
    },
  );

  await t.test("upload_id is passed through instead of a file", async () => {
    await call(client, "watermark_media", {
      ...base,
      mode: "async",
      upload_id: upload,
      idempotency_key: "upload-1",
    });
    const sent = api.seen.at(-1)!;
    assert.equal(sent.path, "/watermarks/images/async");
    assert.equal(sent.form!.get("upload_id"), upload);
    assert.equal(sent.form!.get("file"), null);
    assert.equal(
      JSON.parse(String(sent.form!.get("data"))).recipient,
      "fixture",
    );
    const bad = await client.callTool({
      name: "watermark_media",
      arguments: { ...base, upload_id: "upl_nothex", idempotency_key: "u2" },
    });
    assert.equal(bad.isError, true);
  });

  await t.test(
    "an upload of the wrong kind or without its file is refused before it is claimed",
    async () => {
      for (const [kind, status, pattern] of [
        [
          "detect",
          "received",
          /created with kind detect; this call needs kind image/,
        ],
        ["image", "pending", /has no file yet/],
        ["image", "rejected", /is rejected and cannot be used/],
        ["image", "expired", /is expired and cannot be used/],
      ] as const) {
        api.state.uploadKind = kind;
        api.state.uploadStatus = status;
        const before = api.seen.length;
        const refused = await client.callTool({
          name: "watermark_media",
          arguments: {
            ...base,
            mode: "async",
            upload_id: upload,
            idempotency_key: `k-${kind}-${status}`,
          },
        });
        assert.equal(refused.isError, true);
        assert.match(JSON.stringify(refused.structuredContent), pattern);
        // Only the status read; nothing was submitted.
        assert.deepEqual(
          api.seen.slice(before).map((r) => `${r.method} ${r.path}`),
          [`GET /uploads/${upload}`],
        );
      }
      // A consumed upload reaches the API, which replays the original request.
      api.state.uploadKind = "image";
      api.state.uploadStatus = "consumed";
      await call(client, "watermark_media", {
        ...base,
        mode: "async",
        upload_id: upload,
        idempotency_key: "upload-1",
      });
      assert.equal(api.seen.at(-1)!.path, "/watermarks/images/async");
      api.state.uploadStatus = "received";
    },
  );

  await t.test(
    "a large upload_id for sync detection runs as a job",
    async () => {
      api.state.uploadSize = 96 * 1024 * 1024;
      api.state.uploadKind = "detect";
      try {
        const value = await call(client, "detect_media", {
          media: "images",
          mode: "sync",
          upload_id: upload,
          idempotency_key: "upload-detect",
        });
        assert.equal(value.http_status, 202);
        assert.deepEqual(
          api.seen.slice(-2).map((r) => `${r.method} ${r.path}`),
          [`GET /uploads/${upload}`, "POST /watermarks/images/detect/async"],
        );
      } finally {
        api.state.uploadSize = 1024;
        api.state.uploadKind = "image";
      }
    },
  );

  await t.test("asset_id is downloaded and submitted again", async () => {
    const value = await call(client, "detect_media", {
      media: "images",
      mode: "sync",
      asset_id: source,
      idempotency_key: "asset-1",
    });
    assert.equal(value.watermarked, true);
    const [download, detect] = api.seen.slice(-2);
    assert.equal(download.path, `/assets/${source}/content`);
    assert.equal(detect.path, "/watermarks/images/detect");
    const file = detect.form!.get("file") as File;
    assert.equal(file.name, "Delivered copy.png");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    const mismatch = await call(
      client,
      "detect_media",
      {
        media: "documents",
        asset_id: source,
        idempotency_key: "asset-2",
      },
      true,
    );
    assert.match(String(mismatch.error), /extension does not match/);
    assert.equal(api.seen.at(-1)!.path, `/assets/${source}/content`);
  });

  await t.test("exactly one input is required", async () => {
    const before = api.seen.length;
    const calls = fake.calls.length;
    for (const [args, message] of [
      [{}, /exactly one of input_url, upload_id or asset_id\./],
      [
        { input_url: "https://media.example/a.png", upload_id: upload },
        /exactly one/,
      ],
      [{ asset_id: source, upload_id: upload }, /exactly one/],
      [{ upload_id: upload, filename: "a.png" }, /filename applies only/],
    ] as const) {
      const value = await call(
        client,
        "watermark_media",
        { ...base, ...args, idempotency_key: "one-input" },
        true,
      );
      assert.match(String(value.error), message);
    }
    for (const field of ["input_path", "output_path"]) {
      const value = await client.callTool({
        name: "watermark_media",
        arguments: {
          ...base,
          upload_id: upload,
          [field]: "photo.png",
          idempotency_key: "local-field",
        },
      });
      assert.equal(value.isError, true, field);
    }
    assert.equal(api.seen.length, before);
    assert.equal(fake.calls.length, calls);
  });

  await t.test("get_job_result and download_asset return links", async () => {
    const result = await call(client, "get_job_result", {
      operation: "embed",
      request_id: req,
    });
    assert.deepEqual(
      api.seen.slice(-2).map((r) => `${r.method} ${r.path}`),
      [`GET /watermarks/jobs/${req}/result`, `POST /assets/${asset}/links`],
    );
    assert.equal(result.download_url, linkUrl);
    assert.equal(result.asset_id, asset);
    const download = await call(client, "download_asset", { asset_id: asset });
    assert.deepEqual(download, {
      asset_id: asset,
      download_url: linkUrl,
      download_expires_at: expires,
    });
    assert.equal(api.seen.at(-1)!.path, `/assets/${asset}/links`);
  });

  await t.test("a failed link explains what to do", async () => {
    api.state.linkStatus = 403;
    try {
      const value = await call(
        client,
        "watermark_media",
        {
          ...base,
          input_url: "https://media.example/photo.png",
          idempotency_key: "url-1",
        },
        true,
      );
      assert.match(String(value.error), /assets:read/);
      assert.match(String(value.error), new RegExp(asset));
      assert.match(String(value.error), /download_asset/);
      assert.doesNotMatch(String(value.error), /output_path/);
      assert.equal(value.idempotency_key, "url-1");
      api.state.linkStatus = 410;
      const gone = await call(
        client,
        "download_asset",
        { asset_id: asset },
        true,
      );
      assert.match(String(gone.error), /no longer available/);
    } finally {
      api.state.linkStatus = 201;
    }
  });

  await t.test("create_upload returns the signed URL", async () => {
    const value = await call(client, "create_upload", {
      kind: "detect",
      filename: "delivered.pdf",
      size: 123456,
    });
    assert.deepEqual(api.seen.at(-1)!.json, {
      kind: "detect",
      filename: "delivered.pdf",
      size: 123456,
    });
    assert.equal(value.upload_id, upload);
    assert.equal(
      (value.upload as Record<string, unknown>).url,
      `https://uploads.example/${upload}?Signature=s`,
    );
    assert.match(String(value.message), /detect_media/);
    for (const args of [
      { kind: "audio", filename: "a.mp3", size: 1 },
      { kind: "image", filename: "a.png", size: 0 },
      { kind: "image", filename: "dir/a.png", size: 1 },
      { kind: "image", filename: "a.png", size: MAX_DETECT_UPLOAD + 1 },
    ]) {
      const bad = await client.callTool({
        name: "create_upload",
        arguments: args,
      });
      assert.equal(bad.isError, true, JSON.stringify(args));
    }
  });
});

test("local mode keeps output_path and links without it", async (t) => {
  const api = await fakeApi();
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-modes-"));
  t.after(async () => {
    api.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "photo.png"), "local bytes");
  const fake = fakeFetcher();
  const client = await connectInProcess({
    apiKey: secret,
    baseUrl: api.base,
    filesRoot: root,
    fetcher: fake.fetcher,
  });
  t.after(() => client.close());
  const base = {
    media: "images",
    mode: "sync",
    data: { recipient: "fixture" },
  };
  const saved = await call(client, "watermark_media", {
    ...base,
    input_path: "photo.png",
    output_path: "out.png",
    idempotency_key: "local-1",
  });
  assert.deepEqual(await readFile(join(root, "out.png")), bytes);
  assert.equal(saved.download_url, undefined);
  assert.equal(api.seen.at(-1)!.path, "/watermarks/images");
  const linked = await call(client, "watermark_media", {
    ...base,
    input_url: "https://media.example/photo.png",
    idempotency_key: "local-2",
  });
  assert.equal(linked.download_url, linkUrl);
  const result = await call(client, "get_job_result", {
    operation: "embed",
    request_id: req,
  });
  assert.equal(result.download_url, linkUrl);
  assert.deepEqual(await call(client, "download_asset", { asset_id: asset }), {
    asset_id: asset,
    download_url: linkUrl,
    download_expires_at: expires,
  });
  await call(client, "download_asset", {
    asset_id: asset,
    output_path: "asset.png",
  });
  assert.deepEqual(await readFile(join(root, "asset.png")), bytes);
  const two = await call(
    client,
    "watermark_media",
    {
      ...base,
      input_path: "photo.png",
      asset_id: source,
      idempotency_key: "local-3",
    },
    true,
  );
  assert.match(
    String(two.error),
    /exactly one of input_path, input_url, upload_id or asset_id\./,
  );
  api.state.linkStatus = 403;
  const denied = await call(
    client,
    "download_asset",
    { asset_id: asset },
    true,
  );
  assert.match(String(denied.error), /assets:read.*or pass output_path/);
  api.state.linkStatus = 201;
});
