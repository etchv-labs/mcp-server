import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  access,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, call } from "./helpers.ts";
import { VERSION } from "../src/version.ts";

const req = "req_" + "a".repeat(64),
  asset = "ast_" + "b".repeat(64),
  dst = "dst_" + "c".repeat(32),
  wh = "wh_" + "d".repeat(32),
  event = "evt_" + "e".repeat(64),
  delivery = "std_" + "f".repeat(64);
const secret = "test-key-only";
test("MCP stdio protocol, media routes, assets, storage and webhooks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "etchv-mcp-"));
  const requests: {
    path: string;
    query: URLSearchParams;
    method: string;
    idempotency?: string;
    form?: FormData;
    json?: Record<string, unknown>;
  }[] = [];
  let responseStatus = 200,
    pending = false,
    acceleratorHeader: string | undefined;
  const bytes = Buffer.from("preserved native file bytes");
  const http = createServer(async (incoming, response) => {
    try {
      assert.equal(incoming.headers["x-api-key"], secret);
      assert.equal(
        incoming.headers["user-agent"],
        `etchv-mcp-server/${VERSION} node/${process.versions.node}`,
      );
      const url = new URL(incoming.url!, "http://localhost");
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const record: (typeof requests)[number] = {
        path: url.pathname,
        query: url.searchParams,
        method: incoming.method!,
        idempotency: incoming.headers["idempotency-key"] as string | undefined,
      };
      if (incoming.headers["content-type"]?.startsWith("multipart/")) {
        record.form = await new Response(body, {
          headers: { "content-type": incoming.headers["content-type"] },
        }).formData();
      } else if (body.length) record.json = JSON.parse(body.toString());
      requests.push(record);
      response.setHeader("x-request-id", req);
      const accelerator =
        url.searchParams.get("accelerator") ?? acceleratorHeader;
      if (accelerator) response.setHeader("x-etchv-accelerator", accelerator);
      if (responseStatus !== 200) {
        response.writeHead(responseStatus, {
          "content-type": "application/json",
          location: "https://example.com/credential-trap",
          "retry-after": "3",
        });
        response.end(JSON.stringify({ detail: secret }));
        return;
      }
      const route = url.pathname;
      if (route === "/auth/api-key") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            organization_id: "org_fixture",
            key_id: "key_" + "0".repeat(32),
            scopes: ["watermarks:embed", "assets:read"],
          }),
        );
        return;
      }
      if (incoming.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      const receipt = {
        request_id: req,
        status: "queued",
        status_url: "https://example.com/untrusted",
        result_url: "https://example.com/untrusted",
      };
      if (
        route.endsWith("/async") ||
        (pending && route.startsWith("/watermarks/"))
      ) {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify(receipt));
        return;
      }
      if (/^\/watermarks\/(detection-)?jobs\/req_[a-f0-9]{64}$/.test(route)) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            ...receipt,
            status: "succeeded",
            accelerator_requested: "gpu",
            accelerator: "cpu",
          }),
        );
        return;
      }
      if (
        route.endsWith("/detect") ||
        (route.includes("/detection-jobs/") && route.endsWith("/result"))
      ) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            watermarked: true,
            confidence: 0.99,
            watermark_id: "1".repeat(64),
          }),
        );
        return;
      }
      if (
        record.form ||
        route.endsWith("/content") ||
        route.endsWith("/result")
      ) {
        response.setHeader("content-type", "application/octet-stream");
        response.setHeader("x-asset-id", asset);
        response.setHeader("x-watermark-id", "1".repeat(64));
        response.end(bytes);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          route === "/webhooks" || route === "/storage/destinations"
            ? [{ id: route === "/webhooks" ? wh : dst }]
            : {
                id: asset,
                version: 3,
                status: "succeeded",
                items: [],
                next_cursor: "cursor-2",
              },
        ),
      );
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert(address && typeof address !== "string");
  const session = await connect(
    root,
    secret,
    `http://127.0.0.1:${address.port}`,
  );
  t.after(async () => {
    await session.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const { client } = session;
  await t.test(
    "discovers typed tools, annotations and capabilities",
    async () => {
      assert.equal(client.getServerVersion()?.name, "etchv");
      assert.equal(client.getServerVersion()?.version, VERSION);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 19);
      for (const tool of tools) {
        assert(tool.description && tool.description.length > 20, tool.name);
        assert.equal(tool.inputSchema.type, "object", tool.name);
        assert.equal(tool.annotations?.openWorldHint, true, tool.name);
        if (tool.annotations?.readOnlyHint)
          assert.equal(tool.annotations.destructiveHint, false, tool.name);
      }
      const readOnly = tools
        .filter((x) => x.annotations?.readOnlyHint)
        .map((x) => x.name)
        .sort();
      assert.deepEqual(
        readOnly,
        [
          "check_api_key",
          "get_asset",
          "get_job",
          "list_assets",
          "list_storage_deliveries",
          "list_storage_destinations",
          "list_webhook_deliveries",
          "list_webhooks",
          "get_storage_delivery",
        ].sort(),
      );
      const destructive = tools
        .filter((x) => x.annotations?.destructiveHint)
        .map((x) => x.name)
        .sort();
      assert.deepEqual(destructive, [
        "delete_asset",
        "store_asset",
        "update_asset",
      ]);
      assert.equal(
        tools.find((x) => x.name === "delete_asset")?.annotations
          ?.destructiveHint,
        true,
      );
      assert.equal(
        tools.find((x) => x.name === "list_assets")?.annotations?.readOnlyHint,
        true,
      );
      assert.equal(
        tools.find((x) => x.name === "detect_media")?.annotations?.readOnlyHint,
        false,
      );
      assert.equal(
        tools.find((x) => x.name === "download_asset")?.annotations
          ?.readOnlyHint,
        false,
      );
      const resource = await client.readResource({
        uri: "etchv://capabilities",
      });
      assert.match(JSON.stringify(resource), /PDF/);
      assert.match(JSON.stringify(resource), /sync/);
      assert.equal(session.stderr(), "");
    },
  );
  for (const [media, extensions] of Object.entries({
    images: [
      "jpg",
      "jpeg",
      "png",
      "apng",
      "tif",
      "tiff",
      "psd",
      "psb",
      "gif",
      "bmp",
      "ppm",
      "webp",
    ],
    documents: ["pdf"],
    videos: ["mp4", "mov"],
  })) {
    for (const extension of extensions) {
      await writeFile(join(root, `input.${extension}`), bytes);
      for (const mode of ["sync", "async"])
        for (const detect of [false, true]) {
          await t.test(
            `${media} .${extension} ${mode} ${detect ? "detect" : "embed"}`,
            async () => {
              const output_path = `output-${extension}-${mode}.${extension}`;
              const args = {
                media,
                input_path: `input.${extension}`,
                mode,
                idempotency_key: `${extension}-${mode}-${detect}`,
                ...(!detect
                  ? {
                      data: { recipient: "fixture" },
                      ...(mode === "sync" ? { output_path } : {}),
                    }
                  : {}),
                ...(mode === "async" ? { webhook_id: wh } : {}),
              };
              const value = await call(
                client,
                detect ? "detect_media" : "watermark_media",
                args,
              );
              const record = requests.at(-1)!;
              assert.equal(
                record.path,
                `/watermarks/${media}${detect ? "/detect" : ""}${mode === "async" ? "/async" : ""}`,
              );
              assert.equal(record.idempotency, args.idempotency_key);
              assert.deepEqual(
                Buffer.from(
                  await (record.form!.get("file") as File).arrayBuffer(),
                ),
                bytes,
              );
              if (!detect)
                assert.deepEqual(
                  JSON.parse(record.form!.get("data") as string),
                  { recipient: "fixture" },
                );
              if (mode === "async") {
                assert.equal(value.http_status, 202);
                assert.equal(record.query.get("webhook_id"), wh);
              } else if (!detect) {
                assert.deepEqual(
                  await readFile(join(root, output_path)),
                  bytes,
                );
                assert.equal(value.asset_id, asset);
              } else assert.equal(value.watermarked, true);
            },
          );
        }
    }
  }
  await t.test(
    "defaults to async; forwards storage query and stable retry key",
    async () => {
      const args = {
        media: "images",
        input_path: "input.jpg",
        data: { id: 1 },
        idempotency_key: "stable",
        storage_destination_id: dst,
        storage_key: "folder/name.jpg",
      };
      await call(client, "watermark_media", args);
      await call(client, "watermark_media", args);
      assert.equal(requests.at(-1)!.idempotency, requests.at(-2)!.idempotency);
      assert.equal(requests.at(-1)!.query.get("storage_destination_id"), dst);
      assert.equal(
        requests.at(-1)!.query.get("storage_key"),
        "folder/name.jpg",
      );
    },
  );
  await t.test(
    "sync deadline returns receipt; collect both result types using trusted paths",
    async () => {
      pending = true;
      const value = await call(client, "watermark_media", {
        media: "documents",
        input_path: "input.pdf",
        mode: "sync",
        data: { id: 1 },
        idempotency_key: "fallback",
        output_path: "eventual.pdf",
      });
      assert.equal(value.http_status, 202);
      await assert.rejects(access(join(root, "eventual.pdf")));
      await call(client, "get_job_result", {
        operation: "embed",
        request_id: req,
        output_path: "eventual.pdf",
      });
      await assert.rejects(access(join(root, "eventual.pdf")));
      pending = false;
      for (const operation of ["embed", "detect"]) {
        await call(client, "get_job", { operation, request_id: req });
        assert.equal(
          requests.at(-1)!.path,
          `/watermarks/${operation === "detect" ? "detection-jobs" : "jobs"}/${req}`,
        );
        await call(client, "get_job_result", {
          operation,
          request_id: req,
          ...(operation === "embed" ? { output_path: "eventual.pdf" } : {}),
        });
        assert.equal(
          requests.at(-1)!.path,
          `/watermarks/${operation === "detect" ? "detection-jobs" : "jobs"}/${req}/result`,
        );
      }
      assert.deepEqual(await readFile(join(root, "eventual.pdf")), bytes);
    },
  );
  await t.test(
    "forwards the accelerator and reports the one actually used",
    async () => {
      await writeFile(join(root, "input.mp4"), bytes);
      for (const [tool, extra] of [
        ["watermark_media", { data: { id: 1 }, output_path: "gpu.png" }],
        ["detect_media", {}],
      ] as const) {
        const value = await call(client, tool, {
          media: "images",
          input_path: "input.png",
          mode: "sync",
          idempotency_key: `gpu-${tool}`,
          accelerator: "gpu",
          ...extra,
        });
        assert.equal(requests.at(-1)!.query.get("accelerator"), "gpu");
        assert.equal(value.accelerator, "gpu");
      }
      for (const detect of [false, true]) {
        await call(client, detect ? "detect_media" : "watermark_media", {
          media: "videos",
          input_path: "input.mp4",
          idempotency_key: `gpu-async-${detect}`,
          accelerator: "gpu",
          webhook_id: wh,
          storage_destination_id: detect ? undefined : dst,
          ...(detect ? {} : { data: { id: 1 } }),
        });
        const record = requests.at(-1)!;
        assert.equal(
          record.path,
          `/watermarks/videos${detect ? "/detect" : ""}/async`,
        );
        assert.equal(record.query.get("accelerator"), "gpu");
        assert.equal(record.query.get("webhook_id"), wh);
        if (!detect)
          assert.equal(record.query.get("storage_destination_id"), dst);
      }
      await call(client, "watermark_media", {
        media: "images",
        input_path: "input.png",
        idempotency_key: "cpu-default",
        data: { id: 1 },
      });
      assert.equal(requests.at(-1)!.query.has("accelerator"), false);
      const job = await call(client, "get_job", {
        operation: "embed",
        request_id: req,
      });
      assert.equal(job.accelerator_requested, "gpu");
      assert.equal(job.accelerator, "cpu");
      acceleratorHeader = "cpu";
      try {
        const embedded = await call(client, "get_job_result", {
          operation: "embed",
          request_id: req,
          output_path: "gpu-fallback.png",
        });
        assert.equal(embedded.accelerator, "cpu");
        const detected = await call(client, "get_job_result", {
          operation: "detect",
          request_id: req,
        });
        assert.equal(detected.accelerator, "cpu");
        acceleratorHeader = "tpu";
        const unknown = await call(client, "get_job_result", {
          operation: "detect",
          request_id: req,
        });
        assert.equal(unknown.accelerator, undefined);
      } finally {
        acceleratorHeader = undefined;
      }
      responseStatus = 403;
      try {
        const denied = await call(
          client,
          "detect_media",
          {
            media: "images",
            input_path: "input.png",
            mode: "sync",
            idempotency_key: "gpu-denied",
            accelerator: "gpu",
          },
          true,
        );
        assert.equal(denied.http_status, 403);
        assert.match(
          String(denied.error),
          /GPU processing requires Business or a higher plan/,
        );
        const cpuDenied = await call(
          client,
          "detect_media",
          {
            media: "images",
            input_path: "input.png",
            mode: "sync",
            idempotency_key: "cpu-denied",
          },
          true,
        );
        assert.doesNotMatch(String(cpuDenied.error), /GPU/);
      } finally {
        responseStatus = 200;
      }
      const invalid = await client.callTool({
        name: "detect_media",
        arguments: {
          media: "images",
          input_path: "input.png",
          idempotency_key: "bad-accelerator",
          accelerator: "tpu",
        },
      });
      assert.equal(invalid.isError, true);
    },
  );
  await t.test(
    "check_api_key reports key identity without exposing the key",
    async () => {
      const value = await call(client, "check_api_key");
      assert.equal(requests.at(-1)!.path, "/auth/api-key");
      assert.equal(requests.at(-1)!.method, "GET");
      assert.deepEqual(value.scopes, ["watermarks:embed", "assets:read"]);
      assert.equal(value.organization_id, "org_fixture");
      assert(!JSON.stringify(value).includes(secret));
      const extra = await client.callTool({
        name: "check_api_key",
        arguments: { api_key: secret },
      });
      assert.equal(extra.isError, true);
      assert(!JSON.stringify(extra).includes(secret));
    },
  );
  await t.test(
    "asset pagination, updates, downloads and deletion",
    async () => {
      await call(client, "list_assets", {
        limit: 10,
        cursor: "page+2",
        kind: "watermarked",
        media_type: "video",
      });
      assert.equal(requests.at(-1)!.query.get("cursor"), "page+2");
      await call(client, "get_asset", {
        asset_id: asset,
        include_metadata: false,
      });
      assert.equal(requests.at(-1)!.query.get("include_metadata"), "false");
      await call(client, "update_asset", {
        asset_id: asset,
        version: 3,
        metadata: null,
      });
      assert.deepEqual(requests.at(-1)!.json, { version: 3, metadata: null });
      await call(client, "download_asset", {
        asset_id: asset,
        output_path: "asset.bin",
      });
      assert.deepEqual(await readFile(join(root, "asset.bin")), bytes);
      assert.deepEqual(
        await call(client, "delete_asset", { asset_id: asset }),
        { success: true },
      );
      assert.equal(requests.at(-1)!.method, "DELETE");
    },
  );
  await t.test(
    "storage and webhook tools use the real API routes",
    async () => {
      const cases: [string, Record<string, unknown>, string, string][] = [
        ["list_storage_destinations", {}, "/storage/destinations", "GET"],
        [
          "verify_storage_destination",
          { destination_id: dst },
          `/storage/destinations/${dst}/verify`,
          "POST",
        ],
        [
          "list_storage_deliveries",
          { destination_id: dst, after: delivery },
          `/storage/destinations/${dst}/deliveries`,
          "GET",
        ],
        [
          "get_storage_delivery",
          { delivery_id: delivery },
          `/storage/deliveries/${delivery}`,
          "GET",
        ],
        [
          "retry_storage_delivery",
          { delivery_id: delivery },
          `/storage/deliveries/${delivery}/retry`,
          "POST",
        ],
        [
          "store_asset",
          { destination_id: dst, asset_id: asset, key: "new.jpg" },
          `/storage/destinations/${dst}/deliveries`,
          "POST",
        ],
        ["list_webhooks", {}, "/webhooks", "GET"],
        [
          "list_webhook_deliveries",
          { webhook_id: wh, after: event },
          `/webhooks/${wh}/deliveries`,
          "GET",
        ],
        [
          "redeliver_webhook",
          { webhook_id: wh, event_id: event },
          `/webhooks/${wh}/deliveries/${event}/redeliver`,
          "POST",
        ],
      ];
      for (const [tool, args, path, method] of cases) {
        const value = await call(client, tool, args);
        assert.equal(requests.at(-1)!.path, path);
        assert.equal(requests.at(-1)!.method, method);
        if (
          tool.startsWith("list_") &&
          ["list_webhooks", "list_storage_destinations"].includes(tool)
        )
          assert(Array.isArray(value.items));
        if (tool === "store_asset")
          assert.deepEqual(requests.at(-1)!.json, {
            asset_id: asset,
            key: "new.jpg",
          });
      }
    },
  );
  await t.test(
    "HTTP errors are actionable, do not leak secrets, and redirects are not followed",
    async () => {
      for (const code of [302, 401, 403, 409, 410, 422, 429, 503]) {
        responseStatus = code;
        const before = requests.length;
        const value = await call(
          client,
          "get_asset",
          { asset_id: asset },
          true,
        );
        assert.equal(value.http_status, code);
        assert.equal(value.request_id, req);
        assert.equal(requests.length, before + 1);
        assert(!JSON.stringify(value).includes(secret));
      }
      responseStatus = 200;
    },
  );
  await t.test(
    "rejects invalid paths/options before upload and never overwrites",
    async () => {
      await symlink(join(root, "input.jpg"), join(root, "symlink.jpg"));
      await mkdir(join(root, "folder"));
      await symlink(join(root, "folder"), join(root, "linked-folder"));
      const base = {
        media: "images",
        input_path: "input.jpg",
        data: { id: 1 },
        idempotency_key: "invalid",
      };
      const invalid = [
        { input_path: "../outside.jpg" },
        { input_path: "symlink.jpg" },
        { input_path: "input.pdf" },
        { storage_key: "key.jpg" },
        { mode: "sync" },
        { mode: "sync", webhook_id: wh, output_path: "no.jpg" },
        { output_path: "no.jpg" },
        { data: {} },
        { mode: "sync", output_path: "input.jpg" },
        { mode: "sync", output_path: "linked-folder/no.jpg" },
      ];
      const before = requests.length;
      for (const change of invalid)
        await call(client, "watermark_media", { ...base, ...change }, true);
      assert.equal(requests.length, before);
      assert.deepEqual(await readFile(join(root, "input.jpg")), bytes);
      await call(
        client,
        "download_asset",
        { asset_id: asset, output_path: "../escape.bin" },
        true,
      );
      assert.equal(requests.length, before);
      const invalidId = await client.callTool({
        name: "get_asset",
        arguments: { asset_id: "../other-route" },
      });
      assert.equal(invalidId.isError, true);
    },
  );
});
