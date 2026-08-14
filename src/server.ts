import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executeProgram } from "./execute.js";
import { inspectEnvironment, type RegistryOptions } from "./program-registry.js";
import type { EnvironmentSnapshot } from "./types.js";

export interface ServerOptions extends Omit<RegistryOptions, "cwd"> {
  root: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

async function resolveAllowedCwd(root: string, requested?: string): Promise<string> {
  const candidate = resolve(root, requested ?? ".");
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  const child = relative(realRoot, realCandidate);
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return realCandidate;
  throw new Error("CWD_NOT_ALLOWED: " + (requested ?? candidate));
}

function environmentValue(snapshot: EnvironmentSnapshot): Record<string, unknown> {
  return {
    platform: snapshot.platform,
    arch: snapshot.arch,
    cwd: snapshot.cwd,
    programs: Object.fromEntries(Object.entries(snapshot.programs).map(([name, program]) => [name, {
      executable: program.executable,
      kind: program.kind,
    }])),
  };
}

export async function createServer(options: ServerOptions): Promise<McpServer> {
  const root = await realpath(options.root);
  const snapshot = await inspectEnvironment({
    cwd: root, aliases: options.aliases, path: options.path,
    pathExt: options.pathExt, platform: options.platform,
  });
  const programNames = Object.keys(snapshot.programs).sort();
  const programSchema = programNames.length > 0
    ? z.enum(programNames as [string, ...string[]])
    : z.string().refine(() => false, "No programs are registered");
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  const server = new McpServer({ name: "system-command-mcp", version: "0.1.0" });

  server.registerTool("system_environment", {
    description: "Return the authoritative system execution environment and registered logical program names. Program availability is already reflected in system_exec; do not probe with which, where, command -v, or Get-Command.",
  }, async () => {
    const value = environmentValue(snapshot);
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
  });

  server.registerTool("system_exec", {
    description: "Execute one registered system program directly through a cross-platform program-and-arguments interface. Use only program names in the enum. Pass arguments separately without shell quoting. Shell operators, pipelines, redirects, command substitution, and environment expansion are not supported. Do not probe or guess alternative executable names.",
    inputSchema: {
      program: programSchema.describe("Registered logical program name mapped to the platform-specific executable."),
      args: z.array(z.string()).optional().describe("Arguments passed individually and literally; do not add shell escaping."),
      cwd: z.string().optional().describe("Working directory relative to the configured root, or an absolute path inside it."),
      timeoutMs: z.number().optional().describe("Positive timeout in milliseconds, at most 600000; defaults to 30000."),
    },
  }, async ({ program, args = [], cwd, timeoutMs }, extra) => {
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000)) {
      throw new Error("INVALID_TIMEOUT: expected a positive integer no greater than 600000");
    }
    const definition = snapshot.programs[program];
    if (!definition) throw new Error("PROGRAM_NOT_REGISTERED: " + program);
    const result = await executeProgram({
      program: definition,
      args,
      cwd: await resolveAllowedCwd(root, cwd),
      timeoutMs: timeoutMs ?? defaultTimeoutMs,
      signal: extra.signal,
      maxOutputBytes,
    });
    const value = result as unknown as Record<string, unknown>;
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: value,
      isError: result.exitCode !== 0 || result.timedOut || result.cancelled,
    };
  });
  return server;
}
