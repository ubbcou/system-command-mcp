import { access, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCommandRuntime, parseProgramManifest, type CommandRuntimeOptions } from "./runtime.js";

export const EXIT = { unusable: 1, usage: 2 } as const;

export interface ManagementOptions {
  manifestPath?: string;
  roots: string[];
  artifactDirectory?: string;
  artifactRetentionMs?: number;
  artifactQuotaBytes?: number;
  artifactMaxStreamBytes?: number;
  maxOutputBytes?: number;
  inlineHeadBytes?: number;
  defaultTimeoutMs?: number;
}

export const MANIFEST_TEMPLATE = `{
  "version": 1,
  "allowInheritedPath": true,
  "programs": {
    "git": { "candidates": ["git"], "required": true },
    "node": { "candidates": ["node"], "required": false }
  }
}
`;

export async function readManifest(path: string): Promise<unknown> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { throw new Error(`MANIFEST_READ_FAILED: ${path}`); }
  try { return JSON.parse(text) as unknown; } catch { throw new Error(`MANIFEST_JSON_INVALID: ${path}`); }
}

export async function validatedManifest(path: string): Promise<unknown> {
  const manifest = await readManifest(path);
  parseProgramManifest(manifest);
  return manifest;
}

export async function writeManifestTemplate(path: string): Promise<void> {
  try { await access(path, constants.F_OK); throw new Error(`MANIFEST_EXISTS: ${path}`); } catch (error) {
    if (error instanceof Error && error.message.startsWith("MANIFEST_EXISTS:")) throw error;
  }
  await writeFile(path, MANIFEST_TEMPLATE, { encoding: "utf8", flag: "wx" });
}

export function runtimeOptions(options: ManagementOptions, manifest: unknown): CommandRuntimeOptions {
  return {
    roots: options.roots.map(root => resolve(root)), manifest, manifestPath: options.manifestPath,
    artifactDirectory: options.artifactDirectory, artifactRetentionMs: options.artifactRetentionMs,
    artifactQuotaBytes: options.artifactQuotaBytes, artifactMaxStreamBytes: options.artifactMaxStreamBytes,
    maxOutputBytes: options.maxOutputBytes, inlineHeadBytes: options.inlineHeadBytes,
    defaultTimeoutMs: options.defaultTimeoutMs,
  };
}

export async function doctor(options: ManagementOptions, probe: boolean): Promise<{ ok: boolean; message: string }> {
  if (!options.manifestPath) throw new Error("MANIFEST_REQUIRED");
  const manifest = await validatedManifest(options.manifestPath);
  if (!options.roots.length) throw new Error("ROOT_REQUIRED");
  for (const root of options.roots) { try { if (!(await stat(root)).isDirectory()) throw new Error(); } catch { throw new Error(`ROOT_NOT_DIRECTORY: ${root}`); } }
  if (!probe) return { ok: true, message: "static configuration is valid (no programs executed)" };
  const runtime = await createCommandRuntime(runtimeOptions(options, manifest));
  try { return { ok: true, message: `probe registered ${Object.keys((await runtime.inspectEnvironment()).programs).length} program(s)` }; }
  finally { await runtime.close(); }
}

function quoteToml(value: string): string { return JSON.stringify(value); }
function quoteYaml(value: string): string { return JSON.stringify(value); }
function entryPath(): string { return resolve(process.argv[1] ?? "system-command-mcp"); }
function configArgs(options: ManagementOptions): string[] {
  const args = [entryPath(), "serve"];
  if (options.manifestPath) args.push("--manifest", resolve(options.manifestPath));
  for (const root of options.roots) args.push("--root", resolve(root));
  return args;
}

export function codexSnippet(options: ManagementOptions): string {
  const codexHome = process.env.CODEX_HOME || "~/.codex";
  const args = configArgs(options).map(quoteToml).join(", ");
  return `# Add to ${codexHome}/config.toml\n[mcp_servers.system-command]\ncommand = ${quoteToml(process.execPath)}\nargs = [${args}]\ncwd = ${quoteToml(options.roots[0] ? resolve(options.roots[0]) : process.cwd())}\nstartup_timeout_sec = 10\ntool_timeout_sec = 60\n`;
}

export function dshSnippet(options: ManagementOptions): string {
  const args = configArgs(options).map(value => `      - ${quoteYaml(value)}`).join("\n");
  return `mcpServers:\n  system-command:\n    command: ${quoteYaml(process.execPath)}\n    args:\n${args}\n    cwd: ${quoteYaml(options.roots[0] ? resolve(options.roots[0]) : process.cwd())}\n    toolCallTimeoutMs: 60000\n    failOnStartupError: true\n    reconnect: true\n`;
}

export function manifestDirectory(path: string): string { return dirname(resolve(path)); }
