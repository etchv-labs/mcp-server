#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.ts";
import { SafeError } from "./io.ts";

try {
  const config = {
    apiKey: process.env.ETCHV_API_KEY,
    baseUrl: process.env.ETCHV_API_BASE_URL,
    filesRoot: process.env.ETCHV_FILES_ROOT,
  };
  // Validate before accepting a connection. stdout is reserved for MCP messages.
  const initial = await createServer(config);
  let first = true;
  const handle = serveStdio(() => {
    if (first) {
      first = false;
      return initial;
    }
    return createServer(config);
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void handle.close().finally(() => process.exit(0));
    });
} catch (error) {
  // Only fixed, secret-free messages are printed. stderr is not protocol traffic.
  console.error(
    `Etchv MCP could not start. ${error instanceof SafeError ? error.message : "Check ETCHV_API_KEY, ETCHV_FILES_ROOT and ETCHV_API_BASE_URL."}`,
  );
  process.exitCode = 1;
}
