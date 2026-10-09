import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, connect } from "./helpers.ts";

const secret = "etchv_" + "k".repeat(43);
const uploadId = "upl_" + "1".repeat(32);
const requestId = "req_" + "c".repeat(64);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(40),
]);

async function fakeApi() {
  const seen: {
    method: string;
    path: string;
    key?: string;
    json?: Record<string, unknown>;
    form?: FormData;
  }[] = [];
  const http = createServer(async (incoming, response) => {
    const url = new URL(incoming.url!, "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const record: (typeof seen)[number] = {
      method: incoming.method!,
      path: url.pathname,
      key: incoming.headers["x-api-key"] as string | undefined,
    };
    if (incoming.headers["content-type"]?.startsWith("multipart/"))
      record.form = await new Response(body, {
        headers: { "content-type": incoming.headers["content-type"] },
      }).formData();
    else if (incoming.headers["content-type"] === "application/json")
      record.json = JSON.parse(body.toString());
    seen.push(record);
    const { port } = http.address() as AddressInfo;
    if (url.pathname === "/uploads") {
      const kind = String(record.json?.kind);
      response.writeHead(201, { "content-type": "application/json" });
      return response.end(
        JSON.stringify({
          upload_id: uploadId,
          kind,
          status: "pending",
          upload: {
            method: "PUT",
            url: `http://localhost:${port}/signed/${kind}/${uploadId}.png?Signature=s`,
          },
        }),
      );
    }
    if (url.pathname.startsWith("/signed/"))
      return response.writeHead(200).end();
    if (url.pathname.endsWith("/detect/async")) {
      response.writeHead(202, { "content-type": "application/json" });
      return response.end(
        JSON.stringify({ request_id: requestId, status: "queued" }),
      );
    }
    response.writeHead(200, {
      "content-type": "image/png",
      "x-watermark-id": "ab".repeat(32),
      "x-request-id": requestId,
    });
    response.end(png);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    http,
    base: `http://localhost:${(http.address() as AddressInfo).port}`,
  };
}

test("files above the threshold go through an upload session without the API key", async () => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-uploads-"));
  await writeFile(join(root, "photo.png"), png);
  const api = await fakeApi();
  const session = await connect(root, secret, api.base, {
    ETCHV_LARGE_FILE_THRESHOLD: "16",
  });
  try {
    await call(session.client, "watermark_media", {
      media: "images",
      input_path: "photo.png",
      data: { recipient: "acme" },
      output_path: "out.png",
      mode: "sync",
      idempotency_key: "mcp-upload-test-1",
    });
    assert.deepEqual(
      api.seen.map((r) => `${r.method} ${r.path}`),
      [
        "POST /uploads",
        `PUT /signed/image/${uploadId}.png`,
        "POST /watermarks/images",
      ],
    );
    assert.deepEqual(api.seen[0].json, {
      kind: "image",
      filename: "photo.png",
      size: png.length,
    });
    assert.equal(api.seen[0].key, secret);
    assert.equal(api.seen[1].key, undefined);
    assert.equal(api.seen[2].form?.get("upload_id"), uploadId);
    assert.equal(api.seen[2].form?.get("file"), null);
  } finally {
    await session.close();
    api.http.close();
  }
});

test("image detection above 95 MiB runs as a job and returns its receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-uploads-"));
  const file = await open(join(root, "delivered.png"), "w");
  await file.write(png, 0, png.length, 0);
  await file.truncate(96 * 1024 * 1024);
  await file.close();
  const api = await fakeApi();
  const session = await connect(root, secret, api.base);
  try {
    const value = await call(session.client, "detect_media", {
      media: "images",
      input_path: "delivered.png",
      mode: "sync",
      idempotency_key: "mcp-upload-test-2",
    });
    assert.equal(value.http_status, 202);
    assert.equal(value.request_id, requestId);
    assert.deepEqual(
      api.seen.map((r) => `${r.method} ${r.path}`),
      [
        "POST /uploads",
        `PUT /signed/detect/${uploadId}.png`,
        "POST /watermarks/images/detect/async",
      ],
    );
  } finally {
    await session.close();
    api.http.close();
  }
});

test("an invalid threshold stops the server", async () => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-uploads-"));
  await assert.rejects(
    connect(root, secret, undefined, { ETCHV_LARGE_FILE_THRESHOLD: "zero" }),
  );
});
