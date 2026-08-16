import { realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { ArtifactStore, type ArtifactPolicy, type ArtifactStatus, type OutputEncoding, type OutputPage, type OutputStream } from "./artifact.js";
import { executeProgram } from "./execute.js";
import { DEFAULT_ALIASES, inspectEnvironment, resolveExecutable } from "./program-registry.js";
import { isWithinRoot } from "./path-policy.js";
import { parseManifestProbes } from "./manifest-probes.js";
import { discoverNodeVariants, parseNodeResolution, parseProjectNodeResolution, projectNodeSelection, resolveProjectNodeV2, revalidateNodeVariant, withNodePath, type NodeResolution, type NodeVariant, type NodeSelection, type ProjectNodeResolution } from "./node-resolution.js";
import { DEFAULT_MAX_CONCURRENT_EXECUTIONS, MAX_CONCURRENT_EXECUTIONS, MAX_DEFAULT_TIMEOUT_MS, validateRuntimeLimits } from "./config.js";
import type { EnvironmentSnapshot, ExecuteResult, RegisteredProgram } from "./types.js";

export interface ProgramPolicy { defaultTimeoutMs?: number; maxTimeoutMs?: number; allowStdin?: boolean; gracePeriodMs?: number; finalTerminationWaitMs?: number; artifactPolicy?: ArtifactPolicy; }
export interface ManifestProgram { candidates: string[]; required?: boolean; enabled?: boolean; policy?: ProgramPolicy; environment?: EnvironmentLayer; }
export interface EnvironmentReference { fromEnvironment: string; required?: boolean; }
export type EnvironmentValue = string | EnvironmentReference;
export interface EnvironmentLayer { remove?: string[]; set?: Record<string, EnvironmentValue>; }
export interface ProgramManifest { version: 1 | 2; searchPath?: string[]; pathExt?: string; allowInheritedPath?: boolean; environment?: EnvironmentLayer; nodeResolution?: NodeResolution; projectNode?: ProjectNodeResolution; programs: Record<string, ManifestProgram>; platforms?: Record<string, { searchPath?: string[]; pathExt?: string; allowInheritedPath?: boolean; environment?: EnvironmentLayer; nodeResolution?: NodeResolution; projectNode?: ProjectNodeResolution; programs?: Record<string, Partial<ManifestProgram>> }>; }
export interface RuntimeEnvironment extends EnvironmentSnapshot { mode: "configured" | "automatic-discovery"; roots: string[]; environmentNames: string[]; }
export interface ExecutionRequest { program: string; args?: readonly string[]; cwd?: string; timeoutMs?: number; input?: string; signal?: AbortSignal; }
export interface CommandRuntime { inspectEnvironment(): Promise<RuntimeEnvironment>; execute(request: ExecutionRequest): Promise<ExecuteResult & { artifact: ArtifactStatus }>; readOutput(id: string, stream: OutputStream, offset: number, limit: number, encoding: OutputEncoding): Promise<OutputPage>; close(): Promise<void>; }
export interface CommandRuntimeOptions { roots: readonly string[]; manifest?: unknown; manifestPath?: string; manifestDirectory?: string; environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; defaultTimeoutMs?: number; gracePeriodMs?: number; finalTerminationWaitMs?: number; closeDeadlineMs?: number; maxOutputBytes?: number; inlineHeadBytes?: number; maxConcurrentExecutions?: number; artifactDirectory?: string; artifactRetentionMs?: number; artifactQuotaBytes?: number; artifactMaxStreamBytes?: number; }

const MAX_ARGS = 4_096;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_ARG_TOTAL_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_TERMINATION_WAIT = 60_000;
// cmd.exe expands %...% and may expand !...!, while these metacharacters are parser syntax.
const UNSAFE_CMD_SCRIPT_ARGUMENT = /[%!&|<>^\r\n\0]/;
export const cmdScriptArgumentIsSafe = (argument: string): boolean => !UNSAFE_CMD_SCRIPT_ARGUMENT.test(argument);
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
  return { remove: result.remove === undefined ? undefined : [...result.remove as string[]], set: result.set === undefined ? undefined : Object.fromEntries(Object.entries(result.set as Record<string, EnvironmentValue>).map(([key, assignment]) => [key, typeof assignment === "string" ? assignment : { ...assignment }])) };
}
function policy(value: unknown, path: string): ProgramPolicy | undefined {
  if (value === undefined) return undefined;
  const result = object(value, path); unknownFields(result, ["defaultTimeoutMs", "maxTimeoutMs", "allowStdin", "gracePeriodMs", "finalTerminationWaitMs", "artifactPolicy"], path);
  for (const name of ["defaultTimeoutMs", "maxTimeoutMs"] as const) if (result[name] !== undefined && (!Number.isInteger(result[name]) || (result[name] as number) <= 0 || (result[name] as number) > MAX_DEFAULT_TIMEOUT_MS)) throw new Error(`INVALID_MANIFEST: ${path}.${name}`);
  for (const name of ["gracePeriodMs", "finalTerminationWaitMs"] as const) if (result[name] !== undefined && (!Number.isInteger(result[name]) || (result[name] as number) <= 0 || (result[name] as number) > MAX_TERMINATION_WAIT)) throw new Error(`INVALID_MANIFEST: ${path}.${name}`);
  if (result.allowStdin !== undefined && typeof result.allowStdin !== "boolean") throw new Error(`INVALID_MANIFEST: ${path}.allowStdin`);
  if (result.artifactPolicy !== undefined && !["never", "on-truncation", "always"].includes(result.artifactPolicy as string)) throw new Error(`INVALID_MANIFEST: ${path}.artifactPolicy`);
  return { ...result } as ProgramPolicy;
}
function program(value: unknown, path: string, partial = false): ManifestProgram | Partial<ManifestProgram> {
  const result = object(value, path); unknownFields(result, ["candidates", "required", "enabled", "policy", "environment"], path);
  if (!partial && (!Array.isArray(result.candidates) || result.candidates.length === 0 || !result.candidates.every(x => typeof x === "string" && x.length > 0))) throw new Error(`INVALID_MANIFEST: ${path}.candidates`);
  if (partial && result.candidates !== undefined && (!Array.isArray(result.candidates) || result.candidates.length === 0 || !result.candidates.every(x => typeof x === "string" && x.length > 0))) throw new Error(`INVALID_MANIFEST: ${path}.candidates`);
  if (result.required !== undefined && typeof result.required !== "boolean") throw new Error(`INVALID_MANIFEST: ${path}.required`);
  if (result.enabled !== undefined && typeof result.enabled !== "boolean") throw new Error(`INVALID_MANIFEST: ${path}.enabled`);
  return { ...result, candidates: result.candidates === undefined ? undefined : [...result.candidates as string[]], policy: policy(result.policy, `${path}.policy`), environment: layer(result.environment, `${path}.environment`) } as ManifestProgram;
}
function mergeLayer(base?: EnvironmentLayer, override?: EnvironmentLayer): EnvironmentLayer | undefined { return base || override ? { remove: override?.remove ?? base?.remove, set: { ...base?.set, ...override?.set } } : undefined; }
function mergeProgram(base: ManifestProgram, override?: Partial<ManifestProgram>): ManifestProgram { return { ...base, ...override, candidates: override?.candidates ?? base.candidates, required: base.required || override?.required, policy: { ...base.policy, ...override?.policy }, environment: mergeLayer(base.environment, override?.environment) }; }
function validatePolicy(value: ProgramPolicy | undefined, path: string): void { if (value?.defaultTimeoutMs !== undefined && value.maxTimeoutMs !== undefined && value.defaultTimeoutMs > value.maxTimeoutMs) throw new Error(`INVALID_MANIFEST: ${path}.defaultTimeoutMs exceeds ${path}.maxTimeoutMs`); }
export function effectiveTimeoutMs(policy: ProgramPolicy | undefined, globalDefaultTimeoutMs?: number, suppliedTimeoutMs?: number): number { return suppliedTimeoutMs ?? policy?.defaultTimeoutMs ?? globalDefaultTimeoutMs ?? 30_000; }

export function parseProgramManifest(value: unknown, platform: NodeJS.Platform = process.platform): ProgramManifest {
  const root = object(value, "manifest"); unknownFields(root, ["version", "searchPath", "pathExt", "allowInheritedPath", "environment", "nodeResolution", "projectNode", "programs", "platforms", "probes"], "manifest");
  if (root.version !== 1 && root.version !== 2) throw new Error("INVALID_MANIFEST: version must be 1 or 2");
  if (root.version === 1 && root.projectNode !== undefined) throw new Error("INVALID_MANIFEST: manifest.projectNode");
  if (root.version === 2 && root.nodeResolution !== undefined) throw new Error("INVALID_MANIFEST: manifest.nodeResolution");
  if (root.version === 2) parseProjectNodeResolution(root.projectNode, "manifest.projectNode");
  if (!root.programs) throw new Error("INVALID_MANIFEST: programs is required");
  if (root.searchPath !== undefined && (!Array.isArray(root.searchPath) || !root.searchPath.every(x => typeof x === "string"))) throw new Error("INVALID_MANIFEST: searchPath");
  if (root.pathExt !== undefined && typeof root.pathExt !== "string") throw new Error("INVALID_MANIFEST: pathExt");
  if (root.allowInheritedPath !== undefined && typeof root.allowInheritedPath !== "boolean") throw new Error("INVALID_MANIFEST: allowInheritedPath");
  const programs = Object.fromEntries(Object.entries(object(root.programs, "manifest.programs")).map(([name, definition]) => {
    if (!LOGICAL_PROGRAM_NAME.test(name)) throw new Error(`INVALID_MANIFEST: manifest.programs.${name}`);
    return [name, program(definition, `manifest.programs.${name}`) as ManifestProgram];
  }));
  for (const [name, definition] of Object.entries(programs)) { if (definition.required && definition.enabled === false) throw new Error(`INVALID_MANIFEST: required Program ${name} cannot be disabled`); validatePolicy(definition.policy, `manifest.programs.${name}.policy`); }
  parseManifestProbes(value);
  const platforms = root.platforms === undefined ? {} : object(root.platforms, "manifest.platforms");
  const platformOverrides: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of Object.entries(platforms)) {
    const item = object(raw, `manifest.platforms.${name}`); unknownFields(item, ["searchPath", "pathExt", "allowInheritedPath", "environment", "nodeResolution", "projectNode", "programs"], `manifest.platforms.${name}`);
    if (root.version === 1 && item.projectNode !== undefined) throw new Error(`INVALID_MANIFEST: manifest.platforms.${name}.projectNode`);
    if (root.version === 2 && item.nodeResolution !== undefined) throw new Error(`INVALID_MANIFEST: manifest.platforms.${name}.nodeResolution`);
    if (item.searchPath !== undefined && (!Array.isArray(item.searchPath) || !item.searchPath.every(x => typeof x === "string"))) throw new Error(`INVALID_MANIFEST: manifest.platforms.${name}.searchPath`);
    if (item.pathExt !== undefined && typeof item.pathExt !== "string") throw new Error(`INVALID_MANIFEST: manifest.platforms.${name}.pathExt`);
    if (item.allowInheritedPath !== undefined && typeof item.allowInheritedPath !== "boolean") throw new Error(`INVALID_MANIFEST: manifest.platforms.${name}.allowInheritedPath`);
    layer(item.environment, `manifest.platforms.${name}.environment`);
    if (root.version === 1) parseNodeResolution(item.nodeResolution, `manifest.platforms.${name}.nodeResolution`);
    else parseProjectNodeResolution(item.projectNode, `manifest.platforms.${name}.projectNode`);
    const overrides = item.programs === undefined ? {} : object(item.programs, `manifest.platforms.${name}.programs`);
    for (const [programName, definition] of Object.entries(overrides)) {
      if (!LOGICAL_PROGRAM_NAME.test(programName)) throw new Error(`INVALID_MANIFEST: manifest.platforms.${name}.programs.${programName}`);
      const parsed = program(definition, `manifest.platforms.${name}.programs.${programName}`, true) as Partial<ManifestProgram>;
      if (!programs[programName]) throw new Error(`INVALID_MANIFEST: platform program ${programName} has no base definition`);
      const merged = mergeProgram(programs[programName], parsed);
      if (programs[programName].required && parsed.required === false) throw new Error(`INVALID_MANIFEST: required Program ${programName} cannot be optional`);
      if (merged.required && merged.enabled === false) throw new Error(`INVALID_MANIFEST: required Program ${programName} cannot be disabled`);
      validatePolicy(merged.policy, `manifest.platforms.${name}.programs.${programName}.policy`);
    }
    platformOverrides[name] = item;
  }
  const override = platformOverrides[platform] ?? {};
  const overrides = override.programs === undefined ? {} : object(override.programs, `manifest.platforms.${platform}.programs`);
  for (const [name, item] of Object.entries(overrides)) programs[name] = mergeProgram(programs[name]!, program(item, `manifest.platforms.${platform}.programs.${name}`, true) as Partial<ManifestProgram>);
  for (const [name, definition] of Object.entries(programs)) if (definition.required && definition.enabled === false) throw new Error(`INVALID_MANIFEST: required Program ${name} cannot be disabled`);
  return { version: root.version, programs, searchPath: [...((override.searchPath as string[] | undefined) ?? []), ...((root.searchPath as string[] | undefined) ?? [])], pathExt: (override.pathExt as string | undefined) ?? root.pathExt as string | undefined, allowInheritedPath: (override.allowInheritedPath as boolean | undefined) ?? root.allowInheritedPath as boolean | undefined, environment: mergeLayer(layer(root.environment, "manifest.environment"), layer(override.environment, `manifest.platforms.${platform}.environment`)), nodeResolution: root.version === 1 ? parseNodeResolution(override.nodeResolution ?? root.nodeResolution, `manifest.platforms.${platform}.nodeResolution`) : undefined, projectNode: root.version === 2 ? parseProjectNodeResolution(override.projectNode ?? root.projectNode, `manifest.platforms.${platform}.projectNode`) : undefined };
}

function get(environment: Record<string, string>, key: string, platform: NodeJS.Platform): string | undefined { return platform === "win32" ? Object.entries(environment).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] : environment[key]; }
function set(environment: Record<string, string>, key: string, value: string, platform: NodeJS.Platform): void { const actual = platform === "win32" ? Object.keys(environment).find(existing => existing.toLowerCase() === key.toLowerCase()) ?? key : key; environment[actual] = value; }
function remove(environment: Record<string, string>, key: string, platform: NodeJS.Platform): void { for (const existing of Object.keys(environment)) if (platform !== "win32" ? existing === key : existing.toLowerCase() === key.toLowerCase()) delete environment[existing]; }
function applyLayer(environment: Record<string, string>, input: NodeJS.ProcessEnv, layer: EnvironmentLayer | undefined, platform: NodeJS.Platform): void { for (const key of layer?.remove ?? []) remove(environment, key, platform); for (const [key, value] of Object.entries(layer?.set ?? {})) { if (typeof value === "string") set(environment, key, value, platform); else { const found = platform === "win32" ? Object.entries(input).find(([name]) => name.toLowerCase() === value.fromEnvironment.toLowerCase())?.[1] : input[value.fromEnvironment]; if (found === undefined) { if (value.required !== false) throw new Error(`MISSING_ENVIRONMENT_REFERENCE: ${value.fromEnvironment}`); remove(environment, key, platform); } else set(environment, key, found, platform); } } }

export interface ConfiguredResolutionPlan { manifest: ProgramManifest; environment: Record<string, string>; programEnvironment(definition: ManifestProgram): Record<string, string>; }
export function configuredResolutionPlan(value: unknown, input: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ConfiguredResolutionPlan {
  const manifest = parseProgramManifest(value, platform);
  const environment = Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const pathKey = platform === "win32" ? Object.keys(environment).find(key => key.toLowerCase() === "path") ?? "PATH" : "PATH";
  const paths = [...(manifest.searchPath ?? []), ...(manifest.allowInheritedPath ? [environment[pathKey] ?? ""] : [])].filter(Boolean);
  environment[pathKey] = paths.join(platform === "win32" ? ";" : delimiter);
  if (platform === "win32") set(environment, "PATHEXT", manifest.pathExt ?? ".COM;.EXE;.BAT;.CMD", platform);
  applyLayer(environment, input, manifest.environment, platform);
  return { manifest, environment, programEnvironment(definition) { const result = { ...environment }; applyLayer(result, input, definition.environment, platform); return result; } };
}

export async function createCommandRuntime(options: CommandRuntimeOptions): Promise<CommandRuntime> {
  if (!options.roots.length) throw new Error("ROOT_REQUIRED");
  validateRuntimeLimits(options);
  const maxConcurrentExecutions = options.maxConcurrentExecutions ?? DEFAULT_MAX_CONCURRENT_EXECUTIONS;
  const platform = options.platform ?? process.platform;
  const physicalRoots = [...new Set(await Promise.all(options.roots.map(async root => { const physical = await realpath(root); if (!(await stat(physical)).isDirectory()) throw new Error("ROOT_NOT_DIRECTORY"); return physical; })))];
  const roots = physicalRoots.filter(root => !physicalRoots.some(other => other !== root && isWithinRoot(other, root)));
  const rootIdentities = await Promise.all(roots.map(async root => { const info = await stat(root); return `${info.dev}:${info.ino}`; }));
  const input = Object.freeze(Object.fromEntries(Object.entries(options.environment ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  const configured = options.manifest !== undefined;
  const plan = configured ? configuredResolutionPlan(options.manifest, input, platform) : undefined;
  const manifest = plan?.manifest;
  const nodeResolution = manifest?.nodeResolution;
  const projectNode = manifest?.projectNode;
  const manifestDirectory = options.manifestPath ? dirname(resolve(options.manifestPath)) : options.manifestDirectory;
  const environment: Record<string, string> = plan?.environment ?? { ...input };
  const enabledProjectRoots = projectNode ? (await Promise.all(projectNode.enabledRoots.map(async configuredRoot => { const wanted = configuredRoot.startsWith("~/") ? resolve(homedir(), configuredRoot.slice(2)) : resolve(configuredRoot); let actual: string; try { actual = await realpath(wanted); if (!(await stat(actual)).isDirectory()) throw new Error(); } catch { throw new Error("PROJECT_NODE_ROOT_UNAVAILABLE"); } if (!roots.some(root => isWithinRoot(root, actual))) throw new Error("PROJECT_NODE_ROOT_NOT_AUTHORIZED"); return actual; }))).sort((left, right) => right.length - left.length || left.localeCompare(right)) : [];
  const nodeVariants: readonly NodeVariant[] = nodeResolution ? await discoverNodeVariants(nodeResolution, input, platform) : projectNode ? await discoverNodeVariants({ enabled: true, installationRoots: projectNode.installationRoots }, input, platform) : [];
  const definitions: Record<string, ManifestProgram> = manifest?.programs ?? Object.fromEntries(Object.entries(DEFAULT_ALIASES).filter(([name]) => name !== "powershell").map(([name, candidates]) => [name, { candidates: [...candidates] }]));
  const programs: Record<string, RegisteredProgram> = {};
  const policies: Record<string, ProgramPolicy> = {};
  for (const [logicalName, definition] of Object.entries(definitions)) {
    if (definition.enabled === false) continue;
    const perProgramEnvironment = plan?.programEnvironment(definition) ?? { ...environment };
    let executable: string | undefined;
    let declaredCandidate: string | undefined;
    for (const candidate of definition.candidates) {
      executable = await resolveExecutable([candidate], { platform, manifestDirectory, path: get(perProgramEnvironment, "PATH", platform), pathExt: get(perProgramEnvironment, "PATHEXT", platform) });
      if (executable) { declaredCandidate = candidate; break; }
    }
    if (!executable || !declaredCandidate) { if (definition.required) throw new Error(`REQUIRED_PROGRAM_UNAVAILABLE: ${logicalName}`); continue; }
    const kind = /\.(cmd|bat)$/i.test(executable) ? "cmd-script" : "native";
    programs[logicalName] = { logicalName, executable, declaredCandidate, kind, argumentSemantics: kind === "native" ? "literal" : "cmd-reparsed" }; policies[logicalName] = definition.policy ?? {};
  }
  if (nodeResolution?.enabled || projectNode) {
    if (!programs.node || programs.node.kind !== "native" || definitions.node?.enabled === false) throw new Error("NODE_RESOLUTION_NODE_REQUIRED");
    if (!nodeVariants.length) throw new Error("NODE_VARIANTS_UNAVAILABLE");
    if (projectNode?.defaultVersion && !nodeVariants.some(variant => variant.version === projectNode.defaultVersion)) throw new Error("PROJECT_NODE_VERSION_UNAVAILABLE: manifest#projectNode.defaultVersion");
    if (projectNode && programs.npm && nodeVariants.some(variant => !variant.npmCli)) throw new Error("PROJECT_NPM_UNAVAILABLE");
    if (projectNode && programs.npx && nodeVariants.some(variant => !variant.npxCli)) throw new Error("PROJECT_NPX_UNAVAILABLE");
  }
  if (configured && !Object.keys(programs).length) throw new Error("NO_PROGRAMS_REGISTERED");
  const artifacts = new ArtifactStore(options.artifactDirectory ?? join(tmpdir(), "system-command-mcp-artifacts"), options.artifactRetentionMs ?? 24 * 60 * 60 * 1000, options.artifactQuotaBytes ?? 1024 * 1024 * 1024, options.artifactMaxStreamBytes ?? 100 * 1024 * 1024);
  await artifacts.start();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const active = new Map<Promise<ExecuteResult>, AbortController>();
  const snapshot = (): RuntimeEnvironment => ({ platform, arch: process.arch, cwd: roots[0]!, programs: Object.fromEntries(Object.entries(programs).map(([name, definition]) => [name, name === "node" && (nodeResolution?.enabled || projectNode) ? { ...definition, variantSet: { kind: "node-project", variants: nodeVariants.map(({ version, executable, npmCli, npxCli }) => ({ version, executable, npmCli, npxCli })), fallbackExecutable: definition.executable } } : { ...definition }])), mode: configured ? "configured" : "automatic-discovery", roots: [...roots], environmentNames: Object.keys(environment).sort() });
  return { async inspectEnvironment() { return snapshot(); }, execute(request) {
    if (closing) return Promise.reject(new Error("RUNTIME_CLOSING"));
    if (active.size >= maxConcurrentExecutions) return Promise.reject(new Error("CONCURRENCY_LIMIT"));
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    const execution = (async (): Promise<ExecuteResult & { artifact: ArtifactStatus }> => {
      const definition = programs[request.program]; if (!definition) throw new Error(`PROGRAM_NOT_REGISTERED: ${request.program}`);
      const args = [...(request.args ?? [])]; if (args.length > MAX_ARGS || args.some(argument => argument.includes("\0") || Buffer.byteLength(argument) > MAX_ARG_BYTES) || args.reduce((size, argument) => size + Buffer.byteLength(argument), 0) > MAX_ARG_TOTAL_BYTES) throw new Error("INVALID_ARGUMENT");
      try { const current = await Promise.all(roots.map(async root => { const info = await stat(root); return `${info.dev}:${info.ino}`; })); if (current.some((identity, index) => identity !== rootIdentities[index])) throw new Error(); } catch { throw new Error("ROOT_UNAVAILABLE"); }
      const policy = policies[request.program] ?? {}; const timeoutMs = effectiveTimeoutMs(policy, options.defaultTimeoutMs, request.timeoutMs); if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > Math.min(policy.maxTimeoutMs ?? MAX_DEFAULT_TIMEOUT_MS, MAX_DEFAULT_TIMEOUT_MS)) throw new Error("INVALID_TIMEOUT");
      if (request.input !== undefined && (!policy.allowStdin || Buffer.byteLength(request.input) > MAX_INPUT_BYTES)) throw new Error("INVALID_INPUT");
      if (roots.length > 1 && (request.cwd === undefined || !isAbsolute(request.cwd))) throw new Error("CWD_NOT_ALLOWED");
      const wanted = request.cwd === undefined ? roots[0]! : roots.length === 1 ? resolve(roots[0]!, request.cwd) : request.cwd;
      let cwd: string; try { cwd = await realpath(wanted); } catch { throw new Error("CWD_NOT_FOUND"); }
      if (!roots.some(root => isWithinRoot(root, cwd))) throw new Error("CWD_NOT_ALLOWED");
      const baseEnvironment = plan?.programEnvironment(definitions[request.program]!) ?? { ...environment };
      const projectRoot = enabledProjectRoots.find(root => isWithinRoot(root, cwd));
      const resolveNode = (fallback: RegisteredProgram): Promise<NodeSelection> => projectNode && projectRoot ? resolveProjectNodeV2(cwd, projectRoot, nodeVariants, fallback, projectNode.defaultVersion) : nodeResolution?.enabled ? projectNodeSelection(cwd, roots.find(root => isWithinRoot(root, cwd))!, nodeVariants, fallback) : Promise.resolve({ program: fallback });
      let selection: NodeSelection = request.program === "node" ? await resolveNode(definition) : { program: definition };
      let selectedVariant = selection.variant;
      let childEnvironment: NodeJS.ProcessEnv = baseEnvironment;
      if ((request.program === "npm" || request.program === "npx") && (nodeResolution?.enabled || projectRoot) && programs.node) {
        const nodeSelection = await resolveNode(programs.node);
        if (nodeSelection.variant) {
          const cli = request.program === "npm" ? nodeSelection.variant.npmCli : nodeSelection.variant.npxCli;
          if (!cli) throw new Error(request.program === "npm" ? "PROJECT_NPM_UNAVAILABLE" : "PROJECT_NPX_UNAVAILABLE");
          selectedVariant = nodeSelection.variant;
          selection = { program: { ...nodeSelection.program, logicalName: request.program }, selection: { ...nodeSelection.selection!, logicalName: request.program, adapter: "npm-cli" } };
          args.splice(0, 0, cli);
          childEnvironment = withNodePath(baseEnvironment, nodeSelection.program, platform);
        }
      } else if (selection.variant) childEnvironment = withNodePath(baseEnvironment, selection.program, platform);
      if (selection.program.argumentSemantics === "cmd-reparsed" && args.some(argument => !cmdScriptArgumentIsSafe(argument))) throw new Error("UNSAFE_CMD_SCRIPT_ARGUMENT");
      if (selectedVariant) await revalidateNodeVariant(selectedVariant, platform);
      const artifactPolicy = policy.artifactPolicy ?? "on-truncation"; let spool: Awaited<ReturnType<typeof artifacts.spool>> | undefined; let spoolAttemptFailed = false;
      if (artifactPolicy !== "never") try { spool = await artifacts.spool(); } catch { spoolAttemptFailed = true; }
      const result = await executeProgram({ program: selection.program, args, cwd, timeoutMs, gracePeriodMs: policy.gracePeriodMs ?? options.gracePeriodMs ?? 2_000, finalTerminationWaitMs: policy.finalTerminationWaitMs ?? options.finalTerminationWaitMs ?? 5_000, signal: controller.signal, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024, inlineHeadBytes: options.inlineHeadBytes, input: request.input, environment: childEnvironment, onOutput: spool ? (stream, chunk) => spool!.append(stream, chunk) : undefined });
      const wantedArtifact = artifactPolicy === "always" || (artifactPolicy === "on-truncation" && (result.stdout.truncated || result.stderr.truncated)); let artifact: ArtifactStatus = artifactPolicy === "never" ? { status: "not-requested" } : spoolAttemptFailed ? { status: "unavailable" } : { status: "discarded" };
      if (wantedArtifact) { if (!spool || spool.failed) artifact = { status: "unavailable" }; else try { artifact = { status: "published", id: await artifacts.publish(spool) }; spool = undefined; } catch { artifact = { status: "unavailable" }; } }
      await artifacts.discard(spool); return { ...result, artifact, programSelection: selection.selection ?? { logicalName: request.program, executable: selection.program.executable } };
    })();
    active.set(execution, controller);
    return execution.finally(() => { request.signal?.removeEventListener("abort", abort); active.delete(execution); });
  }, readOutput(id, stream, offset, limit, encoding) { if (closing) return Promise.reject(new Error("RUNTIME_CLOSING")); return artifacts.read(id, stream, offset, limit, encoding); }, close() { if (!closePromise) { closing = true; for (const controller of active.values()) controller.abort(); const deadline = options.closeDeadlineMs ?? 15_000; let timer: NodeJS.Timeout | undefined; const settled = Promise.allSettled([...active.keys()]).then(() => true); const expires = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), deadline); timer.unref(); }); const closeStarted = Date.now(); closePromise = Promise.race([settled, expires]).then(async () => { if (timer) clearTimeout(timer); await artifacts.close(Math.max(0, deadline - (Date.now() - closeStarted))); }); } return closePromise; } };
}
