import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

export async function connect(
  filesRoot: string,
  apiKey: string,
  baseUrl?: string,
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url))],
    env: {
      PATH: process.env.PATH ?? "",
      ETCHV_API_KEY: apiKey,
      ETCHV_FILES_ROOT: filesRoot,
      ...(baseUrl ? { ETCHV_API_BASE_URL: baseUrl } : {}),
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "etchv-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  expectError = false,
): Promise<Record<string, unknown>> {
  const response = await client.callTool(
    { name, arguments: args },
    { timeout: 60000 },
  );
  assert.equal(
    Boolean(response.isError),
    expectError,
    JSON.stringify(response),
  );
  assert(
    response.structuredContent &&
      typeof response.structuredContent === "object",
  );
  return response.structuredContent as Record<string, unknown>;
}
