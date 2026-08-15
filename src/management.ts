import { access, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCommandRuntime, parseProgramManifest, type CommandRuntimeOptions } from "./runtime.js";
import { parseManifestProbes } from "./manifest-probes.js";
import { DEFAULT_ALIASES, resolveExecutable } from "./program-registry.js";

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

export async function discoveredManifest(): Promise<string> {
  const entries = await Promise.all(Object.entries(DEFAULT_ALIASES).filter(([name]) => name !== "powershell").map(async ([name, candidates]) => {
    const executable = await resolveExecutable(candidates);
    return executable ? [name, { candidates: [executable], required: false }] : undefined;
  }));
  const programs = Object.fromEntries(entries.filter((entry): entry is [string, { candidates: string[]; required: boolean }] => entry !== undefined));
  return `${JSON.stringify({ version: 1, allowInheritedPath: false, programs }, null, 2)}\n`;
}

export async function readManifest(path: string): Promise<unknown> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { throw new Error(`MANIFEST_READ_FAILED: ${path}`); }
  try { return JSON.parse(text) as unknown; } catch { throw new Error(`MANIFEST_JSON_INVALID: ${path}`); }
}

export async function validatedManifest(path: string): Promise<unknown> {
  const manifest = await readManifest(path);
  parseProgramManifest(manifest);
  parseManifestProbes(manifest);
  return manifest;
}

export async function writeManifestTemplate(path: string, force = false, content = MANIFEST_TEMPLATE): Promise<void> {
  if (!force) try { await access(path, constants.F_OK); throw new Error(`MANIFEST_EXISTS: ${path}`); } catch (error) {
    if (error instanceof Error && error.message.startsWith("MANIFEST_EXISTS:")) throw error;
  }
  await writeFile(path, content, { encoding: "utf8", flag: force ? "w" : "wx" });
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

export async function doctor(options: ManagementOptions, execute = false): Promise<{ ok: boolean; message: string }> {
  if (!options.manifestPath) throw new Error("MANIFEST_REQUIRED");
  const manifest = await validatedManifest(options.manifestPath);
  if (!options.roots.length) throw new Error("ROOT_REQUIRED");
  for (const root of options.roots) { try { if (!(await stat(root)).isDirectory()) throw new Error(); } catch { throw new Error(`ROOT_NOT_DIRECTORY: ${root}`); } }
  const runtime = await createCommandRuntime(runtimeOptions(options, manifest));
  try {
    const environment = await runtime.inspectEnvironment();
    const winners = Object.values(environment.programs).map(program => `${program.logicalName}=${program.declaredCandidate} -> ${program.executable}`).join(", ");
    if (!execute) return { ok: true, message: `static configuration is valid (no programs executed; winners: ${winners || "none"})` };
    const probes = parseManifestProbes(manifest);
    for (const [name, probe] of Object.entries(probes)) {
      if (!environment.programs[name]) throw new Error(`PROBE_PROGRAM_UNAVAILABLE: ${name}`);
      const result = await runtime.execute({ program: name, args: probe.args });
      if (!(probe.acceptedExitCodes ?? [0]).includes(result.exitCode ?? -1)) throw new Error(`PROBE_FAILED: ${name}`);
    }
    return { ok: true, message: `executed ${Object.keys(probes).length} declared probe(s); winners: ${winners || "none"}` };
  } finally { await runtime.close(); }
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
  return `# Add to $CODEX_HOME/config.toml (effective: ${codexHome}/config.toml; v0.1.0 values intentionally use startup 30s and tool 300s)\n# Verify JSON with: codex mcp list --json && codex mcp get system-command --json\n[mcp_servers.system-command]\ncommand = ${quoteToml(process.execPath)}\nargs = [${args}]\ncwd = ${quoteToml(options.roots[0] ? resolve(options.roots[0]) : process.cwd())}\nstartup_timeout_sec = 30\ntool_timeout_sec = 300\n`;
}

export function dshSnippet(options: ManagementOptions): string {
  const args = configArgs(options).map(value => `      - ${quoteYaml(value)}`).join("\n");
  return `- id: system-command\n  name: "@deepseek-ai/dsh-mcp-client"\n  config:\n    serverName: system-command\n    transport: stdio\n    command: ${quoteYaml(process.execPath)}\n    args:\n${args}\n    cwd: ${quoteYaml(options.roots[0] ? resolve(options.roots[0]) : process.cwd())}\n    toolCallTimeoutMs: 30000\n    failOnStartupError: true\n    reconnect:\n      enabled: true\n      initialDelayMs: 500\n      maxDelayMs: 30000\n      maxAttempts: 10\n`;
}

export function manifestDirectory(path: string): string { return dirname(resolve(path)); }
