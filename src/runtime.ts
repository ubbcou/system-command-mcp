import { realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { executeProgram } from "./execute.js";
import { DEFAULT_ALIASES, inspectEnvironment, resolveExecutable } from "./program-registry.js";
import type { EnvironmentSnapshot, ExecuteResult, RegisteredProgram } from "./types.js";

export interface ProgramPolicy { defaultTimeoutMs?: number; maxTimeoutMs?: number; allowStdin?: boolean; }
export interface ManifestProgram { candidates: string[]; required?: boolean; enabled?: boolean; policy?: ProgramPolicy; environment?: EnvironmentLayer; }
export interface EnvironmentReference { fromEnvironment: string; required?: boolean; }
export type EnvironmentValue = string | EnvironmentReference;
export interface EnvironmentLayer { remove?: string[]; set?: Record<string, EnvironmentValue>; }
export interface ProgramManifest { version: 1; searchPath?: string[]; pathExt?: string; allowInheritedPath?: boolean; environment?: EnvironmentLayer; programs: Record<string, ManifestProgram>; platforms?: Record<string, { searchPath?: string[]; pathExt?: string; allowInheritedPath?: boolean; environment?: EnvironmentLayer; programs?: Record<string, Partial<ManifestProgram>> }>; }
export interface RuntimeEnvironment extends EnvironmentSnapshot { mode: "configured" | "automatic-discovery"; roots: string[]; environmentNames: string[]; }
export interface ExecutionRequest { program: string; args?: readonly string[]; cwd?: string; timeoutMs?: number; input?: string; signal?: AbortSignal; }
export interface CommandRuntime { inspectEnvironment(): Promise<RuntimeEnvironment>; execute(request: ExecutionRequest): Promise<ExecuteResult>; close(): Promise<void>; }
export interface CommandRuntimeOptions { roots: readonly string[]; manifest?: unknown; manifestPath?: string; manifestDirectory?: string; environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; defaultTimeoutMs?: number; maxOutputBytes?: number; }

const MAX_TIMEOUT = 600_000;
const MAX_ARGS = 4_096;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_ARG_TOTAL_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const LOGICAL_PROGRAM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const object = (value: unknown, path: string): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_MANIFEST: ${path} must be an object`); return value as Record<string, unknown>; };
const unknownFields = (value: Record<string, unknown>, allowed: readonly string[], path: string): void => { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`INVALID_MANIFEST: unknown field ${path}.${key}`); };

function layer(value: unknown, path: string): EnvironmentLayer | undefined {
  if (value === undefined) return undefined;
  const result = object(value, path); unknownFields(result, ["remove", "set"], path);
  if (result.remove !== undefined && (!Array.isArray(result.remove) || !result.remove.every(x => typeof x === "string"))) throw new Error(`INVALID_MANIFEST: ${path}.remove`);
  if (result.set !== undefined) for (const [key, assignment] of Object.entries(object(result.set, `${path}.set`))) {
    if (typeof assignment === "string") continue;
    const reference = object(assignment, `${path}.set.${key}`); unknownFields(reference, ["fromEnvironment", "required"], `${path}.set.${key}`);
    if (typeof reference.fromEnvironment !== "string" || (reference.required !== undefined && typeof reference.required !== "boolean")) throw new Error(`INVALID_MANIFEST: ${path}.set.${key}`);
  }
  return result as EnvironmentLayer;
}
function policy(value: unknown, path: string): ProgramPolicy | undefined {
  if (value === undefined) return undefined;
  const result = object(value, path); unknownFields(result, ["defaultTimeoutMs", "maxTimeoutMs", "allowStdin"], path);
  for (const name of ["defaultTimeoutMs", "maxTimeoutMs"] as const) if (result[name] !== undefined && (!Number.isInteger(result[name]) || (result[name] as number) <= 0 || (result[name] as number) > MAX_TIMEOUT)) throw new Error(`INVALID_MANIFEST: ${path}.${name}`);
  if (result.allowStdin !== undefined && typeof result.allowStdin !== "boolean") throw new Error(`INVALID_MANIFEST: ${path}.allowStdin`);
  return result as ProgramPolicy;
}
function program(value: unknown, path: string, partial = false): ManifestProgram | Partial<ManifestProgram> {
  const result = object(value, path); unknownFields(result, ["candidates", "required", "enabled", "policy", "environment"], path);
  if (!partial && (!Array.isArray(result.candidates) || result.candidates.length === 0 || !result.candidates.every(x => typeof x === "string" && x.length > 0))) throw new Error(`INVALID_MANIFEST: ${path}.candidates`);
  if (partial && result.candidates !== undefined && (!Array.isArray(result.candidates) || result.candidates.length === 0 || !result.candidates.every(x => typeof x === "string" && x.length > 0))) throw new Error(`INVALID_MANIFEST: ${path}.candidates`);
  if (result.required !== undefined && typeof result.required !== "boolean") throw new Error(`INVALID_MANIFEST: ${path}.required`);
  if (result.enabled !== undefined && typeof result.enabled !== "boolean") throw new Error(`INVALID_MANIFEST: ${path}.enabled`);
  return { ...result, policy: policy(result.policy, `${path}.policy`), environment: layer(result.environment, `${path}.environment`) } as ManifestProgram;
}
function mergeLayer(base?: EnvironmentLayer, override?: EnvironmentLayer): EnvironmentLayer | undefined { return base || override ? { remove: override?.remove ?? base?.remove, set: { ...base?.set, ...override?.set } } : undefined; }
function mergeProgram(base: ManifestProgram, override?: Partial<ManifestProgram>): ManifestProgram { return { ...base, ...override, candidates: override?.candidates ?? base.candidates, required: base.required || override?.required, policy: { ...base.policy, ...override?.policy }, environment: mergeLayer(base.environment, override?.environment) }; }

export function parseProgramManifest(value: unknown, platform: NodeJS.Platform = process.platform): ProgramManifest {
  const root = object(value, "manifest"); unknownFields(root, ["version", "searchPath", "pathExt", "allowInheritedPath", "environment", "programs", "platforms"], "manifest");
  if (root.version !== 1) throw new Error("INVALID_MANIFEST: version must be 1");
  if (!root.programs) throw new Error("INVALID_MANIFEST: programs is required");
  if (root.searchPath !== undefined && (!Array.isArray(root.searchPath) || !root.searchPath.every(x => typeof x === "string"))) throw new Error("INVALID_MANIFEST: searchPath");
  if (root.pathExt !== undefined && typeof root.pathExt !== "string") throw new Error("INVALID_MANIFEST: pathExt");
  if (root.allowInheritedPath !== undefined && typeof root.allowInheritedPath !== "boolean") throw new Error("INVALID_MANIFEST: allowInheritedPath");
  const programs = Object.fromEntries(Object.entries(object(root.programs, "manifest.programs")).map(([name, definition]) => {
    if (!LOGICAL_PROGRAM_NAME.test(name)) throw new Error(`INVALID_MANIFEST: manifest.programs.${name}`);
    return [name, program(definition, `manifest.programs.${name}`) as ManifestProgram];
  }));
  for (const [name, definition] of Object.entries(programs)) if (definition.required && definition.enabled === false) throw new Error(`INVALID_MANIFEST: required Program ${name} cannot be disabled`);
  const platforms = root.platforms === undefined ? {} : object(root.platforms, "manifest.platforms");
  const platformOverrides: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of Object.entries(platforms)) {
    const item = object(raw, `manifest.platforms.${name}`); unknownFields(item, ["searchPath", "pathExt", "allowInheritedPath", "environment", "programs"], `manifest.platforms.${name}`);
    if (item.searchPath !== undefined && (!Array.isArray(item.searchPath) || !item.searchPath.every(x => typeof x === "string"))) throw new Error(`INVALID_MANIFEST: manifest.platforms.${name}.searchPath`);
    if (item.pathExt !== undefined && typeof item.pathExt !== "string") throw new Error(`INVALID_MANIFEST: manifest.platforms.${name}.pathExt`);
    if (item.allowInheritedPath !== undefined && typeof item.allowInheritedPath !== "boolean") throw new Error(`INVALID_MANIFEST: manifest.platforms.${name}.allowInheritedPath`);
    layer(item.environment, `manifest.platforms.${name}.environment`);
    const overrides = item.programs === undefined ? {} : object(item.programs, `manifest.platforms.${name}.programs`);
    for (const [programName, definition] of Object.entries(overrides)) {
      if (!LOGICAL_PROGRAM_NAME.test(programName)) throw new Error(`INVALID_MANIFEST: manifest.platforms.${name}.programs.${programName}`);
      const parsed = program(definition, `manifest.platforms.${name}.programs.${programName}`, true) as Partial<ManifestProgram>;
      if (!programs[programName]) throw new Error(`INVALID_MANIFEST: platform program ${programName} has no base definition`);
      if (programs[programName].required && parsed.required === false) throw new Error(`INVALID_MANIFEST: required Program ${programName} cannot be optional`);
      if (programs[programName].required && parsed.enabled === false) throw new Error(`INVALID_MANIFEST: required Program ${programName} cannot be disabled`);
    }
    platformOverrides[name] = item;
  }
  const override = platformOverrides[platform] ?? {};
  const overrides = override.programs === undefined ? {} : object(override.programs, `manifest.platforms.${platform}.programs`);
  for (const [name, item] of Object.entries(overrides)) programs[name] = mergeProgram(programs[name]!, program(item, `manifest.platforms.${platform}.programs.${name}`, true) as Partial<ManifestProgram>);
  for (const [name, definition] of Object.entries(programs)) if (definition.required && definition.enabled === false) throw new Error(`INVALID_MANIFEST: required Program ${name} cannot be disabled`);
  return { version: 1, programs, searchPath: [...((override.searchPath as string[] | undefined) ?? []), ...((root.searchPath as string[] | undefined) ?? [])], pathExt: (override.pathExt as string | undefined) ?? root.pathExt as string | undefined, allowInheritedPath: (override.allowInheritedPath as boolean | undefined) ?? root.allowInheritedPath as boolean | undefined, environment: mergeLayer(layer(root.environment, "manifest.environment"), layer(override.environment, `manifest.platforms.${platform}.environment`)) };
}

function isInside(root: string, candidate: string): boolean { const child = relative(root, candidate); return child === "" || (!child.startsWith("..") && !isAbsolute(child)); }
function get(environment: Record<string, string>, key: string, platform: NodeJS.Platform): string | undefined { return platform === "win32" ? Object.entries(environment).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] : environment[key]; }
function set(environment: Record<string, string>, key: string, value: string, platform: NodeJS.Platform): void { const actual = platform === "win32" ? Object.keys(environment).find(existing => existing.toLowerCase() === key.toLowerCase()) ?? key : key; environment[actual] = value; }
function remove(environment: Record<string, string>, key: string, platform: NodeJS.Platform): void { for (const existing of Object.keys(environment)) if (platform !== "win32" ? existing === key : existing.toLowerCase() === key.toLowerCase()) delete environment[existing]; }
function applyLayer(environment: Record<string, string>, input: NodeJS.ProcessEnv, layer: EnvironmentLayer | undefined, platform: NodeJS.Platform): void { for (const key of layer?.remove ?? []) remove(environment, key, platform); for (const [key, value] of Object.entries(layer?.set ?? {})) { if (typeof value === "string") set(environment, key, value, platform); else { const found = platform === "win32" ? Object.entries(input).find(([name]) => name.toLowerCase() === value.fromEnvironment.toLowerCase())?.[1] : input[value.fromEnvironment]; if (found === undefined) { if (value.required !== false) throw new Error(`MISSING_ENVIRONMENT_REFERENCE: ${value.fromEnvironment}`); remove(environment, key, platform); } else set(environment, key, found, platform); } } }

export async function createCommandRuntime(options: CommandRuntimeOptions): Promise<CommandRuntime> {
  if (!options.roots.length) throw new Error("ROOT_REQUIRED");
  const platform = options.platform ?? process.platform;
  const physicalRoots = [...new Set(await Promise.all(options.roots.map(root => realpath(root))))];
  const roots = physicalRoots.filter(root => !physicalRoots.some(other => other !== root && isInside(other, root)));
  const rootIdentities = await Promise.all(roots.map(async root => { const info = await stat(root); return `${info.dev}:${info.ino}`; }));
  const input = Object.freeze(Object.fromEntries(Object.entries(options.environment ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  const configured = options.manifest !== undefined;
  const manifest = configured ? parseProgramManifest(options.manifest, platform) : undefined;
  const manifestDirectory = options.manifestPath ? dirname(resolve(options.manifestPath)) : options.manifestDirectory;
  const environment: Record<string, string> = { ...input };
  if (manifest) {
    const pathKey = platform === "win32" ? Object.keys(environment).find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
    const paths = [...(manifest.searchPath ?? []), ...(manifest.allowInheritedPath ? [environment[pathKey] ?? ""] : [])].filter(Boolean);
    environment[pathKey] = paths.join(platform === "win32" ? ";" : delimiter);
    if (platform === "win32") set(environment, "PATHEXT", manifest.pathExt ?? ".COM;.EXE;.BAT;.CMD", platform);
    applyLayer(environment, input, manifest.environment, platform);
  }
  const definitions: Record<string, ManifestProgram> = manifest?.programs ?? Object.fromEntries(Object.entries(DEFAULT_ALIASES).filter(([name]) => name !== "powershell").map(([name, candidates]) => [name, { candidates: [...candidates] }]));
  const programs: Record<string, RegisteredProgram> = {};
  const policies: Record<string, ProgramPolicy> = {};
  for (const [logicalName, definition] of Object.entries(definitions)) {
    if (definition.enabled === false) continue;
    const perProgramEnvironment = { ...environment }; applyLayer(perProgramEnvironment, input, definition.environment, platform);
    let executable: string | undefined;
    let declaredCandidate: string | undefined;
    for (const candidate of definition.candidates) {
      executable = await resolveExecutable([candidate], { platform, manifestDirectory, path: get(perProgramEnvironment, "PATH", platform), pathExt: get(perProgramEnvironment, "PATHEXT", platform) });
      if (executable) { declaredCandidate = candidate; break; }
    }
    if (!executable || !declaredCandidate) { if (definition.required) throw new Error(`REQUIRED_PROGRAM_UNAVAILABLE: ${logicalName}`); continue; }
    programs[logicalName] = { logicalName, executable, declaredCandidate, kind: /\.(cmd|bat)$/i.test(executable) ? "cmd-script" : "native" }; policies[logicalName] = definition.policy ?? {};
  }
  let closed = false;
  const snapshot = (): RuntimeEnvironment => ({ platform, arch: process.arch, cwd: roots[0]!, programs, mode: configured ? "configured" : "automatic-discovery", roots, environmentNames: Object.keys(environment).sort() });
  return { async inspectEnvironment() { return snapshot(); }, async execute(request) {
    if (closed) throw new Error("RUNTIME_CLOSING"); const definition = programs[request.program]; if (!definition) throw new Error(`PROGRAM_NOT_REGISTERED: ${request.program}`);
    const args = request.args ?? []; if (args.length > MAX_ARGS || args.some(argument => argument.includes("\0") || Buffer.byteLength(argument) > MAX_ARG_BYTES) || args.reduce((size, argument) => size + Buffer.byteLength(argument), 0) > MAX_ARG_TOTAL_BYTES) throw new Error("INVALID_ARGUMENT");
    try { const current = await Promise.all(roots.map(async root => { const info = await stat(root); return `${info.dev}:${info.ino}`; })); if (current.some((identity, index) => identity !== rootIdentities[index])) throw new Error(); } catch { throw new Error("ROOT_UNAVAILABLE"); }
    const policy = policies[request.program] ?? {}; const timeoutMs = request.timeoutMs ?? policy.defaultTimeoutMs ?? options.defaultTimeoutMs ?? 30_000; if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > Math.min(policy.maxTimeoutMs ?? MAX_TIMEOUT, MAX_TIMEOUT)) throw new Error("INVALID_TIMEOUT");
    if (request.input !== undefined && (!policy.allowStdin || Buffer.byteLength(request.input) > MAX_INPUT_BYTES)) throw new Error("INVALID_INPUT");
    const wanted = request.cwd === undefined ? roots[0]! : roots.length === 1 ? resolve(roots[0]!, request.cwd) : request.cwd; if (roots.length > 1 && !isAbsolute(wanted)) throw new Error("CWD_NOT_ALLOWED");
    let cwd: string; try { cwd = await realpath(wanted); } catch { throw new Error("CWD_NOT_FOUND"); }
    if (!roots.some(root => isInside(root, cwd))) throw new Error("CWD_NOT_ALLOWED");
    const childEnvironment = { ...environment }; applyLayer(childEnvironment, input, definitions[request.program]?.environment, platform);
    return executeProgram({ program: definition, args, cwd, timeoutMs, signal: request.signal, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024, input: request.input, environment: childEnvironment });
  }, async close() { closed = true; } };
}
