import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
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

export async function resolveExecutable(
  candidates: readonly string[],
  options: Pick<RegistryOptions, "path" | "pathExt" | "platform"> = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const directories = (options.path ?? process.env.PATH ?? "").split(pathDelimiter).filter(Boolean);
  const extensions = executableExtensions(platform, options.pathExt ?? process.env.PATHEXT);

  for (const candidate of candidates) {
    if (isAbsolute(candidate) && await isExecutable(candidate, platform)) return candidate;
    for (const directory of directories) {
      if (platform === "win32" && extname(candidate)) {
        const path = join(directory, candidate);
        if (await isExecutable(path, platform)) return path;
        continue;
      }
      for (const extension of extensions) {
        const path = join(directory, platform === "win32" ? candidate + extension : candidate);
        if (await isExecutable(path, platform)) return path;
      }
    }
  }
  return undefined;
}

export async function inspectEnvironment(options: RegistryOptions): Promise<EnvironmentSnapshot> {
  const platform = options.platform ?? process.platform;
  const programs: Record<string, RegisteredProgram> = {};
  for (const [logicalName, candidates] of Object.entries(options.aliases ?? DEFAULT_ALIASES)) {
    const executable = await resolveExecutable(candidates, {
      platform, path: options.path, pathExt: options.pathExt,
    });
    if (executable) programs[logicalName] = { logicalName, executable, kind: classifyProgram(executable) };
  }
  return { platform, arch: process.arch, cwd: options.cwd, programs };
}
