#!/usr/bin/env node
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

function parseRoot(argv: readonly string[]): string {
  const index = argv.indexOf("--root");
  if (index === -1) return process.cwd();
  const value = argv[index + 1];
  if (!value) throw new Error("--root requires a path");
  return resolve(value);
}

async function main(): Promise<void> {
  const root = parseRoot(process.argv.slice(2));
  const server = await createServer({ root });
  await server.connect(new StdioServerTransport());
  console.error("system-command-mcp running on stdio (root: " + root + ")");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
