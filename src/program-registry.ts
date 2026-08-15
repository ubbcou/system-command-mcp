import { constants } from "node:fs";
import { access, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { EnvironmentSnapshot, RegisteredProgram } from "./types.js";

export const DEFAULT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  git: ["git"], node: ["node"], npm: ["npm"], pnpm: ["pnpm"],
  yarn: ["yarn"], bun: ["bun"], python: ["python3", "python"],
  ripgrep: ["rg"], powershell: ["pwsh", "powershell"],
};

export interface RegistryOptions {
  cwd: string;
  aliases?: Readonly<Record<string, readonly string[]>>;
  path?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
  manifestDirectory?: string;
}

function executableExtensions(platform: NodeJS.Platform, pathExt?: string): string[] {
  if (platform !== "win32") return [""];
  return (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((value) => value.toLowerCase());
}

function classifyProgram(path: string): RegisteredProgram["kind"] {
  const extension = extname(path).toLowerCase();
  return extension === ".cmd" || extension === ".bat" ? "cmd-script" : "native";
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolvedExecutable(path: string, platform: NodeJS.Platform): Promise<string | undefined> {
  if (!await isExecutable(path, platform)) return undefined;
  try { return await realpath(path); } catch { return undefined; }
}

async function windowsPath(path: string): Promise<string | undefined> {
  try {
    const name = (await readdir(dirname(path))).find(name => name.toLowerCase() === basename(path).toLowerCase());
    return name && join(dirname(path), name);
  } catch {
    return undefined;
  }
}

export async function resolveExecutableMatches(
  candidates: readonly string[],
  options: Pick<RegistryOptions, "path" | "pathExt" | "platform" | "manifestDirectory"> = {},
): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const directories = (options.path ?? process.env.PATH ?? "").split(pathDelimiter).filter(Boolean);
  const extensions = executableExtensions(platform, options.pathExt);
  const matches: string[] = [];
  for (const candidate of candidates) {
    const manifestRelative = candidate.startsWith("./") || candidate.startsWith("../");
    if (manifestRelative && !options.manifestDirectory) throw new Error("MANIFEST_DIRECTORY_REQUIRED");
    const file = candidate.startsWith("~/") ? resolve(homedir(), candidate.slice(2)) : manifestRelative ? resolve(options.manifestDirectory!, candidate) : candidate;
    const locations = isAbsolute(file) || manifestRelative ? [file] : directories.flatMap(directory => platform === "win32" && !extname(file) ? extensions.map(extension => join(directory, file + extension)) : [join(directory, file)]);
    for (const location of locations) {
      const actual = platform === "win32" ? await windowsPath(location) : location;
      if (actual) { const resolved = await resolvedExecutable(actual, platform); if (resolved && !matches.includes(resolved)) matches.push(resolved); }
    }
  }
  return matches;
}

export async function resolveExecutable(
  candidates: readonly string[],
  options: Pick<RegistryOptions, "path" | "pathExt" | "platform" | "manifestDirectory"> = {},
): Promise<string | undefined> { return (await resolveExecutableMatches(candidates, options))[0]; }

export async function inspectEnvironment(options: RegistryOptions): Promise<EnvironmentSnapshot> {
  const platform = options.platform ?? process.platform;
  const programs: Record<string, RegisteredProgram> = {};
  for (const [logicalName, candidates] of Object.entries(options.aliases ?? DEFAULT_ALIASES)) {
    for (const declaredCandidate of candidates) {
      const executable = await resolveExecutable([declaredCandidate], {
        platform, path: options.path, pathExt: options.pathExt,
      });
      if (executable) {
        const kind = classifyProgram(executable);
        programs[logicalName] = { logicalName, executable, declaredCandidate, kind, argumentSemantics: kind === "native" ? "literal" : "cmd-reparsed" };
        break;
      }
    }
  }
  return { platform, arch: process.arch, cwd: options.cwd, programs };
}
