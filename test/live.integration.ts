import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { connect, call } from "./helpers.ts";

const apiKey = process.env.ETCHV_INTEGRATION_API_KEY;
test(
  "live MCP watermark/detect roundtrips for images, PDFs and videos in both modes",
  { skip: !apiKey, timeout: 1200000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "etchv-mcp-live-"));
    const session = await connect(
      root,
      apiKey!,
      process.env.ETCHV_INTEGRATION_BASE_URL,
    );
    const assets = new Set<string>();
    t.after(async () => {
      try {
        for (const asset_id of assets)
          await call(session.client, "delete_asset", { asset_id });
      } finally {
        await session.close();
        await rm(root, { recursive: true, force: true });
      }
    });
    async function completed(
      receipt: Record<string, unknown>,
      operation: string,
      output_path?: string,
    ) {
      let value = receipt;
      const deadline = Date.now() + 180000;
      while (value.http_status === 202) {
        assert.equal(typeof value.request_id, "string");
        assert(Date.now() < deadline, `Timed out collecting ${operation}`);
        await setTimeout(2000);
        value = await call(session.client, "get_job_result", {
          operation,
          request_id: value.request_id,
          ...(output_path ? { output_path } : {}),
        });
      }
      for (const id of [
        value.asset_id,
        value.source_asset_id,
        receipt.asset_id,
        receipt.source_asset_id,
      ])
        if (typeof id === "string") assets.add(id);
      return value;
    }
    await t.test("check_api_key", async () => {
      const identity = await call(session.client, "check_api_key");
      assert(Array.isArray(identity.scopes));
      assert(!JSON.stringify(identity).includes(apiKey!));
    });
    for (const [media, fixture] of [
      ["images", "image.jpg"],
      ["documents", "vector-text.pdf"],
      ["videos", "h264-aac.mp4"],
    ]) {
      await cp(
        new URL(`fixtures/${fixture}`, import.meta.url),
        join(root, fixture),
      );
      for (const mode of ["sync", "async"])
        await t.test(`${media} ${mode}`, async () => {
          const output_path = `${mode}-${fixture}`;
          const idempotency_key = randomUUID();
          const args = {
            media,
            mode,
            input_path: fixture,
            data: { test: "mcp-live", run: idempotency_key },
            idempotency_key,
            ...(mode === "sync" ? { output_path } : {}),
          };
          const receipt = await call(session.client, "watermark_media", args);
          if (mode === "async") {
            const replay = await call(session.client, "watermark_media", args);
            assert.equal(
              replay.request_id,
              receipt.request_id,
              "Idempotent replay must return the same job",
            );
          }
          const embedded = await completed(receipt, "embed", output_path);
          assert.equal(typeof embedded.watermark_id, "string");
          assert((await readFile(join(root, output_path))).length > 0);
          const detection = await completed(
            await call(session.client, "detect_media", {
              media,
              mode,
              input_path: output_path,
              idempotency_key: randomUUID(),
            }),
            "detect",
          );
          assert.equal(detection.watermarked, true);
          assert.equal(detection.watermark_id, embedded.watermark_id);
          const record = await call(session.client, "get_asset", {
            asset_id: embedded.asset_id,
          });
          assert.equal(record.storage_provider, "etchv");
          await call(session.client, "download_asset", {
            asset_id: embedded.asset_id,
            output_path: `download-${output_path}`,
          });
          assert.deepEqual(
            await readFile(join(root, `download-${output_path}`)),
            await readFile(join(root, output_path)),
          );
        });
    }
  },
);
