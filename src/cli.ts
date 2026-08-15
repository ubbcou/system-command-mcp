#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { codexSnippet, discoveredManifest, doctor, dshSnippet, EXIT, readManifest, runtimeOptions, writeManifestTemplate, type ManagementOptions } from "./management.js";
import { createServer } from "./server.js";

type Command = "serve" | "init" | "doctor" | "print-config";
interface Parsed { command: Command; target?: "codex" | "dsh"; options: ManagementOptions; execute: boolean; force: boolean; initPath?: string; legacy: boolean; }

function integer(value: string, name: string): number { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`INVALID_OPTION: ${name}`); return result; }
function requireValue(argv: readonly string[], index: number, flag: string): string { const value = argv[index + 1]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`); return value; }

export function parseCli(argv: readonly string[]): Parsed {
  const first = argv[0];
  const command: Command = first === "serve" || first === "init" || first === "doctor" || first === "print-config" ? first : "serve";
  const legacy = command === "serve" && first !== "serve";
  let index = legacy ? 0 : 1;
  const options: ManagementOptions = { roots: [] };
  let execute = false; let force = false; let target: "codex" | "dsh" | undefined; let initPath: string | undefined;
  if (command === "print-config") { target = argv[index] as "codex" | "dsh" | undefined; index++; if (target !== "codex" && target !== "dsh") throw new Error("print-config requires codex or dsh"); }
  if (command === "init" && argv[index] && !argv[index]!.startsWith("--")) initPath = argv[index++];
  for (; index < argv.length; index++) {
    const flag = argv[index]!;
    if ((flag === "--execute" || flag === "--probe") && command === "doctor") { execute = true; if (flag === "--probe") console.error("system-command-mcp: --probe is deprecated; use --execute"); continue; }
    if (flag === "--force" && command === "init") { force = true; continue; }
    if (flag === "--yes" && command === "init") continue;
    const value = requireValue(argv, index, flag); index++;
    if (flag === "--manifest") options.manifestPath = resolve(value);
    else if (flag === "--root") options.roots.push(resolve(value));
    else if (flag === "--artifact-dir") options.artifactDirectory = resolve(value);
    else if (flag === "--artifact-retention-ms") options.artifactRetentionMs = integer(value, flag);
    else if (flag === "--artifact-quota-bytes") options.artifactQuotaBytes = integer(value, flag);
    else if (flag === "--artifact-max-stream-bytes") options.artifactMaxStreamBytes = integer(value, flag);
    else if (flag === "--max-output-bytes") options.maxOutputBytes = integer(value, flag);
    else if (flag === "--inline-head-bytes") options.inlineHeadBytes = integer(value, flag);
    else if (flag === "--default-timeout-ms") options.defaultTimeoutMs = integer(value, flag);
    else throw new Error(`UNKNOWN_OPTION: ${flag}`);
  }
  return { command, target, options, execute, force, initPath, legacy };
}

async function serve(options: ManagementOptions): Promise<void> {
  const manifest = options.manifestPath ? await readManifest(options.manifestPath) : undefined;
  if (manifest && !options.roots.length) throw new Error("ROOT_REQUIRED");
  const roots = options.roots.length ? options.roots : [process.cwd()];
  const server = await createServer(runtimeOptions({ ...options, roots }, manifest));
  await server.connect(new StdioServerTransport());
  console.error(`system-command-mcp running on stdio (roots: ${roots.join(", ")})`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCli(argv);
  if (parsed.command === "serve") { if (parsed.legacy) console.error("system-command-mcp: legacy direct flags are deprecated; use serve"); return serve(parsed.options); }
  if (parsed.command === "init") {
    const path = resolve(parsed.initPath ?? parsed.options.manifestPath ?? "system-command-manifest.json");
    await writeManifestTemplate(path, parsed.force, await discoveredManifest());
    console.error(`wrote ${path}`);
    const options = { ...parsed.options, manifestPath: path, roots: parsed.options.roots.length ? parsed.options.roots : [process.cwd()] };
    process.stdout.write(`${codexSnippet(options)}\n${dshSnippet(options)}`);
    return;
  }
  if (parsed.command === "doctor") {
    const result = await doctor(parsed.options, parsed.execute); console.error(`doctor: ${result.message}`); return;
  }
  if (parsed.options.manifestPath && !parsed.options.roots.length) throw new Error("ROOT_REQUIRED");
  const options = { ...parsed.options, roots: parsed.options.roots.length ? parsed.options.roots : [process.cwd()] };
  process.stdout.write(parsed.target === "codex" ? codexSnippet(options) : dshSnippet(options));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`system-command-mcp: ${message}`);
  process.exitCode = /^(UNKNOWN_OPTION|.*requires a value|print-config requires)/.test(message) ? EXIT.usage : EXIT.unusable;
});
