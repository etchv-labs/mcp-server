import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, open, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAccess, MAX_UPLOAD, MAX_DOWNLOAD } from "../src/io.ts";
import { apiClient, errorResult, jsonResponse } from "../src/api.ts";
import { VERSION } from "../src/version.ts";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

test("bounded inputs, partial download cleanup and private exclusive output files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "etchv-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = await fileAccess(root);
  const file = await open(join(root, "large.jpg"), "w");
  await file.truncate(MAX_UPLOAD + 1);
  await file.close();
  await assert.rejects(files.read("large.jpg"), /50 MiB/);
  await assert.rejects(files.read(root));
  const output = await files.reserve("partial.jpg");
  await assert.rejects(files.reserve("partial.jpg"), { code: "EEXIST" });
  const broken = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("connection interrupted"));
      },
    }),
  );
  await assert.rejects(output.save(broken));
  await output.close();
  await assert.rejects(access(join(root, "partial.jpg")));
  const limited = await files.reserve("limited.jpg");
  let sent = 0;
  const chunk = new Uint8Array(8 * 1024 * 1024);
  const huge = new Response(
    new ReadableStream({
      pull(controller) {
        sent += chunk.length;
        controller.enqueue(chunk);
        if (sent > MAX_DOWNLOAD) controller.close();
      },
    }),
  );
  await assert.rejects(limited.save(huge), /512 MiB/);
  await limited.close();
  await assert.rejects(access(join(root, "limited.jpg")));
  const complete = await files.reserve("complete.jpg");
  const result = await complete.save(new Response(new Uint8Array([1, 2, 3])));
  await complete.close();
  assert.equal(result.size_bytes, 3);
  assert.equal((await readFile(join(root, "complete.jpg"))).length, 3);
});

test("configuration rejects untrusted origins and missing filesystem root", async () => {
  for (const baseUrl of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com?key=x",
    "https://example.com/path",
    "https://example.com/#fragment",
  ]) {
    assert.throws(() => apiClient({ apiKey: "fixture", baseUrl }));
  }
  assert.throws(() => apiClient({}));
  assert.throws(() => apiClient({ apiKey: "line\nbreak" }));
  await assert.rejects(fileAccess(undefined));
  await assert.rejects(fileAccess("relative"));
});

test("package, server and user-agent versions match", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.version, VERSION);
  // A single bin lets `npx @etchv-labs/mcp-server` resolve it unambiguously.
  assert.deepEqual(pkg.bin, { "etchv-mcp": "dist/cli.js" });
});

test("header and body deadlines produce a clear timeout error", async (t) => {
  const http = createServer((request, response) => {
    if (request.url === "/slow-body") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write("partial");
    }
    // Otherwise never respond.
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  assert(address && typeof address !== "string");
  const api = apiClient({
    apiKey: "fixture-secret",
    baseUrl: `http://127.0.0.1:${address.port}`,
    timeout: 100,
    bodyTimeout: 100,
  });
  const headerError = await api.request("/slow-headers").catch((e) => e);
  assert.equal(headerError.name, "TimeoutError");
  assert.match(errorResult(headerError).error, /timed out/);
  const response = await api.request("/slow-body");
  const bodyError = await jsonResponse(response).catch((e) => e);
  assert.equal(bodyError.name, "TimeoutError");
  assert(!JSON.stringify(errorResult(bodyError)).includes("fixture-secret"));
});

test("startup failures write only to stderr and never echo the key", async () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  for (const env of [
    {},
    { ETCHV_API_KEY: "etchv_startup_secret" },
    {
      ETCHV_API_KEY: "etchv_startup_secret",
      ETCHV_FILES_ROOT: "/definitely/missing/etchv-root",
    },
    {
      ETCHV_API_KEY: "etchv_startup_secret",
      ETCHV_FILES_ROOT: tmpdir(),
      ETCHV_API_BASE_URL: "http://etchv_startup_secret.example.com",
    },
  ]) {
    const { code, stdout, stderr } = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = execFile(
        process.execPath,
        [cli],
        { env: { PATH: process.env.PATH ?? "", ...env } },
        (error, stdout, stderr) =>
          resolve({ code: child.exitCode, stdout, stderr }),
      );
    });
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /^Etchv MCP could not start\. /);
    assert(!stderr.includes("etchv_startup_secret"));
  }
});
