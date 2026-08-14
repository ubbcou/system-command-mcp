import { realpath } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { executeProgram } from "./execute.js";
import { DEFAULT_ALIASES, inspectEnvironment, resolveExecutable } from "./program-registry.js";
import type { EnvironmentSnapshot, ExecuteResult, RegisteredProgram } from "./types.js";

export interface ProgramPolicy { defaultTimeoutMs?: number; maximumTimeoutMs?: number; allowStdin?: boolean; }
export interface ManifestProgram { candidates: string[]; core?: boolean; enabled?: boolean; policy?: ProgramPolicy; environment?: EnvironmentLayer; }
export interface EnvironmentReference { fromEnvironment: string; required?: boolean; }
export type EnvironmentValue = string | EnvironmentReference;
export interface EnvironmentLayer { removals?: string[]; assignments?: Record<string, EnvironmentValue>; }
export interface ProgramManifest { version: 1; searchPaths?: string[]; allowInheritedPath?: boolean; environment?: EnvironmentLayer; programs: Record<string, ManifestProgram>; platform?: Record<string, { searchPaths?: string[]; allowInheritedPath?: boolean; environment?: EnvironmentLayer; programs?: Record<string, Partial<ManifestProgram>> }>; }
export interface RuntimeEnvironment extends EnvironmentSnapshot { mode: "configured" | "automatic-discovery"; roots: string[]; environmentNames: string[]; }
export interface ExecutionRequest { program: string; args?: readonly string[]; cwd?: string; timeoutMs?: number; input?: string; signal?: AbortSignal; }
export interface CommandRuntime { inspectEnvironment(): Promise<RuntimeEnvironment>; execute(request: ExecutionRequest): Promise<ExecuteResult>; close(): Promise<void>; }
export interface CommandRuntimeOptions { roots: readonly string[]; manifest?: unknown; environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; defaultTimeoutMs?: number; maxOutputBytes?: number; }

const MAX_TIMEOUT = 600_000;
const MAX_ARGS = 4_096;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_ARG_TOTAL_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const object = (value: unknown, path: string): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_MANIFEST: ${path} must be an object`); return value as Record<string, unknown>; };
const unknownFields = (value: Record<string, unknown>, allowed: readonly string[], path: string): void => { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`INVALID_MANIFEST: unknown field ${path}.${key}`); };

function layer(value: unknown, path: string): EnvironmentLayer | undefined {
  if (value === undefined) return undefined;
  const result = object(value, path); unknownFields(result, ["removals", "assignments"], path);
  if (result.removals !== undefined && (!Array.isArray(result.removals) || !result.removals.every(x => typeof x === "string"))) throw new Error(`INVALID_MANIFEST: ${path}.removals`);
  if (result.assignments !== undefined) for (const [key, assignment] of Object.entries(object(result.assignments, `${path}.assignments`))) {
    if (typeof assignment === "string") continue;
    const reference = object(assignment, `${path}.assignments.${key}`); unknownFields(reference, ["fromEnvironment", "required"], `${path}.assignments.${key}`);
    if (typeof reference.fromEnvironment !== "string" || (reference.required !== undefined && typeof reference.required !== "boolean")) throw new Error(`INVALID_MANIFEST: ${path}.assignments.${key}`);
  }
  return result as EnvironmentLayer;
}
function policy(value: unknown, path: string): ProgramPolicy | undefined {
  if (value === undefined) return undefined;
  const result = object(value, path); unknownFields(result, ["defaultTimeoutMs", "maximumTimeoutMs", "allowStdin"], path);
  for (const name of ["defaultTimeoutMs", "maximumTimeoutMs"] as const) if (result[name] !== undefined && (!Number.isInteger(result[name]) || (result[name] as number) <= 0 || (result[name] as number) > MAX_TIMEOUT)) throw new Error(`INVALID_MANIFEST: ${path}.${name}`);
  if (result.allowStdin !== undefined && typeof result.allowStdin !== "boolean") throw new Error(`INVALID_MANIFEST: ${path}.allowStdin`);
  return result as ProgramPolicy;
}
function program(value: unknown, path: string, partial = false): ManifestProgram | Partial<ManifestProgram> {
  const result = object(value, path); unknownFields(result, ["candidates", "core", "enabled", "policy", "environment"], path);
  if (!partial && (!Array.isArray(result.candidates) || result.candidates.length === 0 || !result.candidates.every(x => typeof x === "string" && x.length > 0))) throw new Error(`INVALID_MANIFEST: ${path}.candidates`);
  if (partial && result.candidates !== undefined && (!Array.isArray(result.candidates) || result.candidates.length === 0 || !result.candidates.every(x => typeof x === "string"))) throw new Error(`INVALID_MANIFEST: ${path}.candidates`);
  if (result.core !== undefined && typeof result.core !== "boolean") throw new Error(`INVALID_MANIFEST: ${path}.core`);
  if (result.enabled !== undefined && typeof result.enabled !== "boolean") throw new Error(`INVALID_MANIFEST: ${path}.enabled`);
  return { ...result, policy: policy(result.policy, `${path}.policy`), environment: layer(result.environment, `${path}.environment`) } as ManifestProgram;
}
function mergeLayer(base?: EnvironmentLayer, override?: EnvironmentLayer): EnvironmentLayer | undefined { return base || override ? { removals: override?.removals ?? base?.removals, assignments: { ...base?.assignments, ...override?.assignments } } : undefined; }
function mergeProgram(base: ManifestProgram, override?: Partial<ManifestProgram>): ManifestProgram { return { ...base, ...override, candidates: override?.candidates ?? base.candidates, policy: { ...base.policy, ...override?.policy }, environment: mergeLayer(base.environment, override?.environment) }; }

export function parseProgramManifest(value: unknown, platform: NodeJS.Platform = process.platform): ProgramManifest {
  const root = object(value, "manifest"); unknownFields(root, ["version", "searchPaths", "allowInheritedPath", "environment", "programs", "platform"], "manifest");
  if (root.version !== 1) throw new Error("INVALID_MANIFEST: version must be 1");
  if (!root.programs) throw new Error("INVALID_MANIFEST: programs is required");
  if (root.searchPaths !== undefined && (!Array.isArray(root.searchPaths) || !root.searchPaths.every(x => typeof x === "string"))) throw new Error("INVALID_MANIFEST: searchPaths");
  if (root.allowInheritedPath !== undefined && typeof root.allowInheritedPath !== "boolean") throw new Error("INVALID_MANIFEST: allowInheritedPath");
  const programs = Object.fromEntries(Object.entries(object(root.programs, "manifest.programs")).map(([name, definition]) => [name, program(definition, `manifest.programs.${name}`) as ManifestProgram]));
  const platforms = root.platform === undefined ? {} : object(root.platform, "manifest.platform");
  const overrideRaw = platforms[platform];
  let override: Record<string, unknown> = {};
  if (overrideRaw !== undefined) { override = object(overrideRaw, `manifest.platform.${platform}`); unknownFields(override, ["searchPaths", "allowInheritedPath", "environment", "programs"], `manifest.platform.${platform}`); }
  const overrides = override.programs === undefined ? {} : object(override.programs, `manifest.platform.${platform}.programs`);
  for (const [name, item] of Object.entries(overrides)) {
    const parsed = program(item, `manifest.platform.${platform}.programs.${name}`, true) as Partial<ManifestProgram>;
    if (!programs[name]) throw new Error(`INVALID_MANIFEST: platform program ${name} has no base definition`);
    programs[name] = mergeProgram(programs[name], parsed);
    if (programs[name].core && programs[name].enabled === false) throw new Error(`INVALID_MANIFEST: Core Program ${name} cannot be disabled`);
  }
  return { version: 1, programs, searchPaths: (override.searchPaths as string[] | undefined) ?? root.searchPaths as string[] | undefined, allowInheritedPath: (override.allowInheritedPath as boolean | undefined) ?? root.allowInheritedPath as boolean | undefined, environment: mergeLayer(layer(root.environment, "manifest.environment"), layer(override.environment, `manifest.platform.${platform}.environment`)) };
}

function set(environment: Record<string, string>, key: string, value: string, platform: NodeJS.Platform): void { const actual = platform === "win32" ? Object.keys(environment).find(existing => existing.toLowerCase() === key.toLowerCase()) ?? key : key; environment[actual] = value; }
function remove(environment: Record<string, string>, key: string, platform: NodeJS.Platform): void { for (const existing of Object.keys(environment)) if (platform !== "win32" ? existing === key : existing.toLowerCase() === key.toLowerCase()) delete environment[existing]; }
function applyLayer(environment: Record<string, string>, input: NodeJS.ProcessEnv, layer: EnvironmentLayer | undefined, platform: NodeJS.Platform): void { for (const key of layer?.removals ?? []) remove(environment, key, platform); for (const [key, value] of Object.entries(layer?.assignments ?? {})) { if (typeof value === "string") set(environment, key, value, platform); else { const found = platform === "win32" ? Object.entries(input).find(([name]) => name.toLowerCase() === value.fromEnvironment.toLowerCase())?.[1] : input[value.fromEnvironment]; if (found === undefined) { if (value.required) throw new Error(`MISSING_ENVIRONMENT_REFERENCE: ${value.fromEnvironment}`); remove(environment, key, platform); } else set(environment, key, found, platform); } } }

export async function createCommandRuntime(options: CommandRuntimeOptions): Promise<CommandRuntime> {
  if (!options.roots.length) throw new Error("ROOT_REQUIRED");
  const platform = options.platform ?? process.platform;
  const roots = [...new Set(await Promise.all(options.roots.map(root => realpath(root))) )].filter((root, index, all) => !all.some((other, otherIndex) => otherIndex !== index && relative(other, root) && !relative(other, root).startsWith("..") && !isAbsolute(relative(other, root))));
  const input = options.environment ?? process.env;
  const configured = options.manifest !== undefined;
  const manifest = configured ? parseProgramManifest(options.manifest, platform) : undefined;
  const environment: Record<string, string> = Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined));
  if (manifest) {
    const pathKey = platform === "win32" ? Object.keys(environment).find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
    const paths = [...(manifest.searchPaths ?? []), ...(manifest.allowInheritedPath ? [environment[pathKey] ?? ""] : [])].filter(Boolean);
    environment[pathKey] = paths.join(platform === "win32" ? ";" : delimiter);
    applyLayer(environment, input, manifest.environment, platform);
  }
  const definitions: Record<string, ManifestProgram> = manifest?.programs ?? Object.fromEntries(Object.entries(DEFAULT_ALIASES).filter(([name]) => name !== "powershell").map(([name, candidates]) => [name, { candidates: [...candidates] }]));
  const programs: Record<string, RegisteredProgram> = {};
  const policies: Record<string, ProgramPolicy> = {};
  for (const [logicalName, definition] of Object.entries(definitions)) {
    if (definition.enabled === false) continue;
    const perProgramEnvironment = { ...environment }; applyLayer(perProgramEnvironment, input, definition.environment, platform);
    const executable = await resolveExecutable(definition.candidates, { platform, path: perProgramEnvironment[platform === "win32" ? Object.keys(perProgramEnvironment).find(k => k.toLowerCase() === "path") ?? "PATH" : "PATH"], pathExt: perProgramEnvironment.PATHEXT });
    if (!executable) { if (definition.core) throw new Error(`CORE_PROGRAM_UNAVAILABLE: ${logicalName}`); continue; }
    programs[logicalName] = { logicalName, executable, kind: /\.(cmd|bat)$/i.test(executable) ? "cmd-script" : "native" }; policies[logicalName] = definition.policy ?? {};
  }
  let closed = false;
  const snapshot = (): RuntimeEnvironment => ({ platform, arch: process.arch, cwd: roots[0]!, programs, mode: configured ? "configured" : "automatic-discovery", roots, environmentNames: Object.keys(environment).sort() });
  return { async inspectEnvironment() { return snapshot(); }, async execute(request) {
    if (closed) throw new Error("RUNTIME_CLOSING"); const definition = programs[request.program]; if (!definition) throw new Error(`PROGRAM_NOT_REGISTERED: ${request.program}`);
    const args = request.args ?? []; if (args.length > MAX_ARGS || args.some(argument => argument.includes("\0") || Buffer.byteLength(argument) > MAX_ARG_BYTES) || args.reduce((size, argument) => size + Buffer.byteLength(argument), 0) > MAX_ARG_TOTAL_BYTES) throw new Error("INVALID_ARGUMENT");
    const policy = policies[request.program] ?? {}; const timeoutMs = request.timeoutMs ?? policy.defaultTimeoutMs ?? options.defaultTimeoutMs ?? 30_000; if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > Math.min(policy.maximumTimeoutMs ?? MAX_TIMEOUT, MAX_TIMEOUT)) throw new Error("INVALID_TIMEOUT");
    if (request.input !== undefined && (!policy.allowStdin || Buffer.byteLength(request.input) > MAX_INPUT_BYTES)) throw new Error("INVALID_INPUT");
    const wanted = request.cwd === undefined ? roots[0]! : roots.length === 1 ? resolve(roots[0]!, request.cwd) : request.cwd; if (roots.length > 1 && !isAbsolute(wanted)) throw new Error("CWD_NOT_ALLOWED");
    let cwd: string; try { cwd = await realpath(wanted); } catch { throw new Error("CWD_NOT_FOUND"); }
    if (!roots.some(root => cwd === root || (!relative(root, cwd).startsWith("..") && !isAbsolute(relative(root, cwd))))) throw new Error("CWD_NOT_ALLOWED");
    const childEnvironment = { ...environment }; applyLayer(childEnvironment, input, (manifest?.programs[request.program] ?? {}).environment, platform);
    return executeProgram({ program: definition, args, cwd, timeoutMs, signal: request.signal, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024, input: request.input, environment: childEnvironment });
  }, async close() { closed = true; } };
}
