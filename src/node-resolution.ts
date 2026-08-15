import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import semver from "semver";
import { isWithinRoot } from "./path-policy.js";
import type { ProgramSelection, RegisteredProgram } from "./types.js";

const PACKAGE_LIMIT = 1024 * 1024;
export interface NodeResolution { enabled: boolean; installationRoots?: string[]; }
export interface NodeVariant { version: string; executable: string; }
export interface NodeSelection { program: RegisteredProgram; selection?: ProgramSelection; }

const version = (value: string): string | undefined => semver.valid(value.trim().replace(/^v/, "")) ?? undefined;

export function parseNodeResolution(value: unknown, path: string): NodeResolution | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_MANIFEST: ${path} must be an object`);
  const item = value as Record<string, unknown>;
  for (const key of Object.keys(item)) if (key !== "enabled" && key !== "installationRoots") throw new Error(`INVALID_MANIFEST: unknown field ${path}.${key}`);
  if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error(`INVALID_MANIFEST: ${path}.enabled`);
  if (item.installationRoots !== undefined && (!Array.isArray(item.installationRoots) || !item.installationRoots.every(root => typeof root === "string" && (isAbsolute(root) || root.startsWith("~/"))))) throw new Error(`INVALID_MANIFEST: ${path}.installationRoots`);
  return { enabled: item.enabled ?? false, installationRoots: item.installationRoots === undefined ? undefined : [...item.installationRoots as string[]] };
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

async function executable(path: string, platform: NodeJS.Platform): Promise<string | undefined> {
  try { await access(path, platform === "win32" ? constants.F_OK : constants.X_OK); return await realpath(path); } catch { return undefined; }
}

function layoutVersion(root: string, executablePath: string, platform: NodeJS.Platform): string | undefined {
  const relativeSegments = relative(root, executablePath).split(/[\\/]+/).filter(Boolean);
  const binary = platform === "win32" ? "node.exe" : "node";
  const nvm = relativeSegments.length === 3 && relativeSegments[1] === "bin" && relativeSegments[2]?.toLowerCase() === binary;
  const fnm = relativeSegments.length === 4 && relativeSegments[1] === "installation" && relativeSegments[2] === "bin" && relativeSegments[3]?.toLowerCase() === binary;
  const windowsNvm = platform === "win32" && relativeSegments.length === 2 && relativeSegments[1]?.toLowerCase() === binary;
  return nvm || fnm || windowsNvm ? version(relativeSegments[0]!) : undefined;
}

async function scan(root: string, platform: NodeJS.Platform): Promise<NodeVariant[]> {
  const found: NodeVariant[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 5) return;
    let entries: import("node:fs").Dirent[]; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase() === (platform === "win32" ? "node.exe" : "node")) {
        const candidate = layoutVersion(root, path, platform);
        if (!candidate) continue;
        const actual = await executable(path, platform);
        if (actual) found.push({ version: candidate, executable: actual });
      }
    }
  }
  await visit(root, 0);
  return found;
}

export async function discoverNodeVariants(configuration: NodeResolution, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<readonly NodeVariant[]> {
  if (!configuration.enabled) return [];
  const variants = (await Promise.all(roots(configuration, environment, platform).map(root => scan(root, platform)))).flat();
  const unique = new Map<string, NodeVariant>();
  for (const item of variants) if (!unique.has(`${item.version}:${item.executable}`)) unique.set(`${item.version}:${item.executable}`, item);
  return Object.freeze([...unique.values()].sort((a, b) => semver.rcompare(a.version, b.version) || a.executable.localeCompare(b.executable)).map(item => Object.freeze({ ...item })));
}

async function file(path: string, limit: number): Promise<string | undefined> {
  try { if (!(await lstat(path)).isFile()) return undefined; const data = await readFile(path, "utf8"); return Buffer.byteLength(data) <= limit ? data : undefined; } catch { return undefined; }
}
function packageRequirement(text: string): { requirement: string; source: string } | undefined {
  try {
    const pkg = JSON.parse(text) as { devEngines?: { runtime?: unknown }; volta?: { node?: unknown }; engines?: { node?: unknown } };
    const runtime = pkg.devEngines?.runtime;
    const dev = Array.isArray(runtime) ? runtime.find(item => !!item && typeof item === "object" && (item as { name?: unknown }).name === "node") : runtime;
    if (dev && typeof dev === "object" && (dev as { name?: unknown }).name === "node" && typeof (dev as { version?: unknown }).version === "string") return { requirement: (dev as { version: string }).version, source: "package.json#devEngines.runtime" };
    if (typeof pkg.volta?.node === "string") return { requirement: pkg.volta.node, source: "package.json#volta.node" };
    if (typeof pkg.engines?.node === "string") return { requirement: pkg.engines.node, source: "package.json#engines.node" };
  } catch { /* invalid package declaration is ignored; it is not a Node requirement */ }
  return undefined;
}
async function declaration(directory: string): Promise<{ requirement: string; source: string } | undefined> {
  const pkg = await file(join(directory, "package.json"), PACKAGE_LIMIT);
  if (pkg) { const parsed = packageRequirement(pkg); if (parsed?.source === "package.json#devEngines.runtime" || parsed?.source === "package.json#volta.node") return parsed; }
  for (const name of [".nvmrc", ".node-version"]) { const text = await file(join(directory, name), 4096); if (text?.trim()) return { requirement: text.trim(), source: name }; }
  return pkg ? packageRequirement(pkg) : undefined;
}
export async function projectNodeSelection(cwd: string, root: string, variants: readonly NodeVariant[], fallback: RegisteredProgram): Promise<NodeSelection> {
  let directory = cwd;
  while (isWithinRoot(root, directory)) {
    const found = await declaration(directory);
    if (found) {
      const requirement = found.requirement.trim();
      if (["lts/*", "node", "stable"].includes(requirement.toLowerCase()) || !semver.validRange(requirement)) throw new Error(`NODE_VERSION_REQUIREMENT_INVALID: ${found.source}`);
      const selected = variants.find(item => semver.satisfies(item.version, requirement, { includePrerelease: /-/.test(requirement) }));
      if (!selected) throw new Error(`NODE_VERSION_UNAVAILABLE: ${found.source}`);
      return { program: { ...fallback, executable: selected.executable, kind: "native", argumentSemantics: "literal" }, selection: { logicalName: fallback.logicalName, executable: selected.executable, version: selected.version, requirement, source: found.source } };
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
