import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import semver from "semver";
import { isWithinRoot } from "./path-policy.js";
import type { ProgramSelection, RegisteredProgram } from "./types.js";

const PACKAGE_LIMIT = 1024 * 1024;
const VERSION_FILE_LIMIT = 4096;
export interface NodeResolution { enabled: boolean; installationRoots?: string[]; }
export interface ProjectNodeResolution { enabledRoots: string[]; installationRoots: string[]; defaultVersion: string; }
type NodeIdentity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint };
export interface NodeVariant { version: string; versionDirectory: string; versionDirectoryIdentity: NodeIdentity; executable: string; executableIdentity: NodeIdentity; npmCli?: string; npmCliIdentity?: NodeIdentity; npxCli?: string; npxCliIdentity?: NodeIdentity; }
export interface NodeSelection { program: RegisteredProgram; selection?: ProgramSelection; variant?: NodeVariant; }

const version = (value: string): string | undefined => semver.valid(value.trim().replace(/^v/, "")) ?? undefined;
const binaryName = (platform: NodeJS.Platform): string => platform === "win32" ? "node.exe" : "node";

export function parseNodeResolution(value: unknown, path: string): NodeResolution | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_MANIFEST: ${path} must be an object`);
  const item = value as Record<string, unknown>;
  for (const key of Object.keys(item)) if (key !== "enabled" && key !== "installationRoots") throw new Error(`INVALID_MANIFEST: unknown field ${path}.${key}`);
  if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error(`INVALID_MANIFEST: ${path}.enabled`);
  if (item.installationRoots !== undefined && (!Array.isArray(item.installationRoots) || !item.installationRoots.every(root => typeof root === "string" && (isAbsolute(root) || root.startsWith("~/"))))) throw new Error(`INVALID_MANIFEST: ${path}.installationRoots`);
  return { enabled: item.enabled ?? false, installationRoots: item.installationRoots === undefined ? undefined : [...item.installationRoots as string[]] };
}

export function parseProjectNodeResolution(value: unknown, path: string): ProjectNodeResolution | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_MANIFEST: ${path} must be an object`);
  const item = value as Record<string, unknown>;
  for (const key of Object.keys(item)) if (!['enabledRoots', 'installationRoots', 'defaultVersion'].includes(key)) throw new Error(`INVALID_MANIFEST: unknown field ${path}.${key}`);
  const paths = (key: 'enabledRoots' | 'installationRoots'): string[] => {
    const entries = item[key];
    if (!Array.isArray(entries) || !entries.length || !entries.every(root => typeof root === 'string' && (isAbsolute(root) || root.startsWith('~/')))) throw new Error(`INVALID_MANIFEST: ${path}.${key}`);
    return [...entries];
  };
  const defaultVersion = item.defaultVersion;
  if (typeof defaultVersion !== 'string' || !version(defaultVersion)) throw new Error(`INVALID_MANIFEST: ${path}.defaultVersion`);
  return { enabledRoots: paths('enabledRoots'), installationRoots: paths('installationRoots'), defaultVersion: version(defaultVersion)! };
}

function roots(configuration: NodeResolution, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const configured = configuration.installationRoots;
  if (configured !== undefined) return [...new Set(configured.map(root => root.startsWith("~/") ? resolve(homedir(), root.slice(2)) : resolve(root)))];
  const home = homedir();
  const defaults = platform === "win32"
    ? [environment.NVM_HOME, join(home, "AppData", "Roaming", "nvm"), join(home, ".volta", "tools", "image", "node")]
    : [join(home, ".nvm", "versions", "node"), join(home, ".volta", "tools", "image", "node"), join(home, ".fnm", "node-versions"), join(home, ".asdf", "installs", "nodejs")];
  return [...new Set(defaults.filter((root): root is string => Boolean(root)).map(root => root.startsWith("~/") ? resolve(home, root.slice(2)) : resolve(root)))];
}

async function regularRealpath(path: string, boundary: string, platform: NodeJS.Platform, executable = false): Promise<string | undefined> {
  try {
    if (executable) await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    const actual = await realpath(path);
    if (!isWithinRoot(boundary, actual) || !(await lstat(actual)).isFile()) return undefined;
    return actual;
  } catch { return undefined; }
}

function layoutVersion(root: string, executablePath: string, platform: NodeJS.Platform): { version: string; directory: string } | undefined {
  const segments = relative(root, executablePath).split(/[\\/]+/).filter(Boolean);
  const binary = binaryName(platform).toLowerCase();
  const nvm = segments.length === 3 && segments[1] === "bin" && segments[2]?.toLowerCase() === binary;
  const fnm = segments.length === 4 && segments[1] === "installation" && segments[2] === "bin" && segments[3]?.toLowerCase() === binary;
  const windowsNvm = platform === "win32" && segments.length === 2 && segments[1]?.toLowerCase() === binary;
  const found = (nvm || fnm || windowsNvm) && version(segments[0]!);
  return found ? { version: found, directory: join(root, segments[0]!) } : undefined;
}

function identity(info: import("node:fs").BigIntStats): NodeIdentity { return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs }; }
function sameIdentity(left: NodeIdentity, right: NodeIdentity): boolean { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs; }

async function trustedFile(path: string, directory: string, platform: NodeJS.Platform, executable = false): Promise<{ path: string; identity: NodeIdentity } | undefined> {
  try {
    const link = await lstat(path, { bigint: true }); if (!link.isFile() || link.isSymbolicLink()) return undefined;
    if (executable) await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    const actual = await realpath(path); if (!isWithinRoot(directory, actual) || actual !== path) return undefined;
    const info = await stat(path, { bigint: true }); if (!info.isFile() || !sameIdentity(identity(link), identity(info))) return undefined;
    return { path: actual, identity: identity(info) };
  } catch { return undefined; }
}

async function pairedCli(variantDirectory: string, name: "npm" | "npx", platform: NodeJS.Platform): Promise<{ path: string; identity: NodeIdentity } | undefined> {
  return trustedFile(join(variantDirectory, "node_modules", "npm", "bin", `${name}-cli.js`), variantDirectory, platform);
}

async function scan(root: string, platform: NodeJS.Platform): Promise<NodeVariant[]> {
  let canonicalRoot: string; try { canonicalRoot = await realpath(root); } catch { return []; }
  let entries: import("node:fs").Dirent[]; try { entries = await readdir(canonicalRoot, { withFileTypes: true }); } catch { return []; }
  const found: NodeVariant[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !version(entry.name)) continue;
    const directory = join(canonicalRoot, entry.name);
    let directoryInfo: import("node:fs").BigIntStats; try { directoryInfo = await lstat(directory, { bigint: true }); } catch { continue; }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || await realpath(directory) !== directory || !isWithinRoot(canonicalRoot, directory)) continue;
    const directoryIdentity = identity(directoryInfo);
    const candidates = [join(directory, "bin", binaryName(platform)), join(directory, "installation", "bin", binaryName(platform))];
    if (platform === "win32") candidates.push(join(directory, binaryName(platform)));
    for (const candidate of candidates) {
      const layout = layoutVersion(canonicalRoot, candidate, platform); if (!layout) continue;
      const executable = await trustedFile(candidate, directory, platform, true); if (!executable) continue;
      const npmCli = await pairedCli(directory, "npm", platform); const npxCli = await pairedCli(directory, "npx", platform);
      let after: import("node:fs").BigIntStats; try { after = await lstat(directory, { bigint: true }); } catch { continue; }
      if (!after.isDirectory() || after.isSymbolicLink() || await realpath(directory) !== directory || !sameIdentity(directoryIdentity, identity(after))) continue;
      found.push({ version: layout.version, versionDirectory: directory, versionDirectoryIdentity: directoryIdentity, executable: executable.path, executableIdentity: executable.identity, npmCli: npmCli?.path, npmCliIdentity: npmCli?.identity, npxCli: npxCli?.path, npxCliIdentity: npxCli?.identity });
      break;
    }
  }
  return found;
}

export async function revalidateNodeVariant(variant: NodeVariant, platform: NodeJS.Platform): Promise<void> {
  try {
    const directory = await lstat(variant.versionDirectory, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(variant.versionDirectory) !== variant.versionDirectory || !sameIdentity(variant.versionDirectoryIdentity, identity(directory))) throw new Error();
    for (const [path, expected] of [[variant.executable, variant.executableIdentity], [variant.npmCli, variant.npmCliIdentity], [variant.npxCli, variant.npxCliIdentity]] as const) {
      if (!path || !expected) continue;
      const file = await lstat(path, { bigint: true }); if (!file.isFile() || file.isSymbolicLink() || await realpath(path) !== path || !sameIdentity(expected, identity(file))) throw new Error();
    }
  } catch { throw new Error("NODE_VARIANT_CHANGED"); }
}

export async function discoverNodeVariants(configuration: NodeResolution, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<readonly NodeVariant[]> {
  if (!configuration.enabled) return [];
  const variants = (await Promise.all(roots(configuration, environment, platform).map(root => scan(root, platform)))).flat();
  const unique = new Map<string, NodeVariant>();
  for (const item of variants) if (!unique.has(`${item.version}:${item.executable}`)) unique.set(`${item.version}:${item.executable}`, item);
  return Object.freeze([...unique.values()].sort((a, b) => semver.rcompare(a.version, b.version) || a.executable.localeCompare(b.executable)).map(item => Object.freeze({ ...item })));
}

type Declaration = { requirement: string; source: string };
function declarationError(source: string): never { throw new Error(`NODE_DECLARATION_INVALID: ${source}`); }
function requirementError(source: string): never { throw new Error(`NODE_VERSION_REQUIREMENT_INVALID: ${source}`); }

async function declarationFile(path: string, source: string, limit: number): Promise<string | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(path); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; declarationError(source); }
  if (!info.isFile() || info.size > limit) declarationError(source);
  try { return await readFile(path, "utf8"); } catch { return declarationError(source); }
}

function packageRequirement(text: string): Declaration | undefined {
  let pkg: Record<string, unknown>;
  try { const value: unknown = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) declarationError("package.json"); pkg = value as Record<string, unknown>; } catch (error) { if (error instanceof Error && error.message.startsWith("NODE_DECLARATION_INVALID:")) throw error; return declarationError("package.json"); }
  const devEngines = pkg.devEngines;
  if (devEngines !== undefined) {
    if (!devEngines || typeof devEngines !== "object" || Array.isArray(devEngines)) requirementError("package.json#devEngines.runtime");
    const runtime = (devEngines as Record<string, unknown>).runtime;
    if (runtime !== undefined) {
      const candidate = Array.isArray(runtime) ? runtime.find(item => !!item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).name === "node") : runtime;
      if (candidate !== undefined) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) requirementError("package.json#devEngines.runtime");
        const entry = candidate as Record<string, unknown>; const requirement = entry.version;
        if (entry.name !== "node" || typeof requirement !== "string" || !requirement.trim()) requirementError("package.json#devEngines.runtime");
        return { requirement: requirement.trim(), source: "package.json#devEngines.runtime" };
      }
    }
  }
  const volta = pkg.volta;
  if (volta !== undefined) {
    if (!volta || typeof volta !== "object" || Array.isArray(volta)) requirementError("package.json#volta.node");
    const node = (volta as Record<string, unknown>).node;
    if (node !== undefined && (typeof node !== "string" || !node.trim())) requirementError("package.json#volta.node");
    if (typeof node === "string") return { requirement: node.trim(), source: "package.json#volta.node" };
  }
  const engines = pkg.engines;
  if (engines !== undefined) {
    if (!engines || typeof engines !== "object" || Array.isArray(engines)) requirementError("package.json#engines.node");
    const node = (engines as Record<string, unknown>).node;
    if (node !== undefined && (typeof node !== "string" || !node.trim())) requirementError("package.json#engines.node");
    if (typeof node === "string") return { requirement: node.trim(), source: "package.json#engines.node" };
  }
  return undefined;
}

async function declaration(directory: string): Promise<Declaration | undefined> {
  const pkg = await declarationFile(join(directory, "package.json"), "package.json", PACKAGE_LIMIT);
  if (pkg !== undefined) { const found = packageRequirement(pkg); if (found?.source !== "package.json#engines.node") return found; }
  for (const name of [".nvmrc", ".node-version"]) { const text = await declarationFile(join(directory, name), name, VERSION_FILE_LIMIT); if (text !== undefined) { if (!text.trim()) requirementError(name); return { requirement: text.trim(), source: name }; } }
  return pkg === undefined ? undefined : packageRequirement(pkg);
}

export async function resolveProjectNodeV2(cwd: string, root: string, variants: readonly NodeVariant[], fallback: RegisteredProgram, defaultVersion: string): Promise<NodeSelection> {
  let directory = cwd;
  const ranges: Declaration[] = [];
  let nearestExact: Declaration[] | undefined;
  while (isWithinRoot(root, directory)) {
    const pkg = await declarationFile(join(directory, 'package.json'), 'package.json', PACKAGE_LIMIT);
    const exact: Declaration[] = [];
    if (pkg !== undefined) {
      let parsed: Record<string, unknown>;
      try { const value: unknown = JSON.parse(pkg); if (!value || typeof value !== 'object' || Array.isArray(value)) declarationError('package.json'); parsed = value as Record<string, unknown>; } catch (error) { if (error instanceof Error && error.message.startsWith('NODE_DECLARATION_INVALID:')) throw error; return declarationError('package.json'); }
      const dev = parsed.devEngines;
      if (dev !== undefined) { if (!dev || typeof dev !== 'object' || Array.isArray(dev)) declarationError('package.json#devEngines.runtime'); const runtime = (dev as Record<string, unknown>).runtime; const entry = Array.isArray(runtime) ? runtime.find(x => !!x && typeof x === 'object' && !Array.isArray(x) && (x as Record<string, unknown>).name === 'node') : runtime; if (entry !== undefined) { if (!entry || typeof entry !== 'object' || Array.isArray(entry) || (entry as Record<string, unknown>).name !== 'node' || typeof (entry as Record<string, unknown>).version !== 'string') declarationError('package.json#devEngines.runtime'); exact.push({ requirement: (entry as Record<string, unknown>).version as string, source: 'package.json#devEngines.runtime' }); } }
      const volta = parsed.volta;
      if (volta !== undefined) { if (!volta || typeof volta !== 'object' || Array.isArray(volta)) declarationError('package.json#volta.node'); const found = (volta as Record<string, unknown>).node; if (found !== undefined) { if (typeof found !== 'string') declarationError('package.json#volta.node'); exact.push({ requirement: found, source: 'package.json#volta.node' }); } }
      const engines = parsed.engines;
      if (engines !== undefined) { if (!engines || typeof engines !== 'object' || Array.isArray(engines)) declarationError('package.json#engines.node'); const found = (engines as Record<string, unknown>).node; if (found !== undefined) { if (typeof found !== 'string' || !semver.validRange(found)) declarationError('package.json#engines.node'); ranges.push({ requirement: found, source: 'package.json#engines.node' }); } }
    }
    for (const name of ['.nvmrc', '.node-version']) { const text = await declarationFile(join(directory, name), name, VERSION_FILE_LIMIT); if (text !== undefined) exact.push({ requirement: text.trim(), source: name }); }
    if (exact.length && !nearestExact) nearestExact = exact;
    if (directory === root) break;
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  if (nearestExact) {
    const normalized = nearestExact.map(found => ({ ...found, requirement: version(found.requirement) }));
    if (normalized.some(found => !found.requirement)) throw new Error(`NODE_VERSION_REQUIREMENT_INVALID: ${nearestExact[0]!.source}`);
    if (new Set(normalized.map(found => found.requirement)).size !== 1) throw new Error('PROJECT_NODE_DECLARATION_CONFLICT');
    const found = normalized[0]!; const selected = variants.find(item => item.version === found.requirement);
    if (!selected) throw new Error(`PROJECT_NODE_VERSION_UNAVAILABLE: ${found.source}`);
    if (ranges.some(range => !semver.satisfies(selected.version, range.requirement))) throw new Error('PROJECT_NODE_RANGE_UNSATISFIED');
    return { program: { ...fallback, executable: selected.executable, kind: 'native', argumentSemantics: 'literal' }, variant: selected, selection: { logicalName: fallback.logicalName, executable: selected.executable, version: selected.version, requirement: selected.version, source: found.source } };
  }
  if (!defaultVersion) return { program: fallback };
  const selected = variants.find(item => item.version === defaultVersion);
  if (!selected) throw new Error('PROJECT_NODE_VERSION_UNAVAILABLE: manifest#projectNode.defaultVersion');
  if (ranges.some(range => !semver.satisfies(selected.version, range.requirement))) throw new Error('PROJECT_NODE_RANGE_UNSATISFIED');
  return { program: { ...fallback, executable: selected.executable, kind: 'native', argumentSemantics: 'literal' }, variant: selected, selection: { logicalName: fallback.logicalName, executable: selected.executable, version: selected.version, requirement: selected.version, source: 'manifest#projectNode.defaultVersion' } };
}

export async function projectNodeSelection(cwd: string, root: string, variants: readonly NodeVariant[], fallback: RegisteredProgram): Promise<NodeSelection> {
  let directory = cwd;
  while (isWithinRoot(root, directory)) {
    const found = await declaration(directory);
    if (found) {
      const requirement = found.requirement.trim();
      if (["lts/*", "node", "stable"].includes(requirement.toLowerCase()) || !semver.validRange(requirement)) requirementError(found.source);
      const selected = variants.find(item => semver.satisfies(item.version, requirement));
      if (!selected) throw new Error(`NODE_VERSION_UNAVAILABLE: ${found.source}`);
      return { program: { ...fallback, executable: selected.executable, kind: "native", argumentSemantics: "literal" }, variant: selected, selection: { logicalName: fallback.logicalName, executable: selected.executable, version: selected.version, requirement, source: found.source } };
    }
    if (directory === root) break;
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  return { program: fallback };
}

export function withNodePath(environment: NodeJS.ProcessEnv, selected: RegisteredProgram, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const result = { ...environment }; const key = platform === "win32" ? Object.keys(result).find(name => name.toLowerCase() === "path") ?? "PATH" : "PATH";
  result[key] = [dirname(selected.executable), result[key]].filter(Boolean).join(platform === "win32" ? ";" : delimiter); return result;
}
