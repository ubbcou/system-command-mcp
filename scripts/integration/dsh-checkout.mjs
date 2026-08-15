import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const usage = "SKIP: DSH unavailable. Set DSH_CHECKOUT to a checkout or npx root containing node_modules/@deepseek-ai/dsh-mcp-client.";

function modulesAt(root) {
  const modules = join(root, "node_modules");
  return existsSync(join(modules, "@deepseek-ai", "dsh-mcp-client", "lib", "index.js")) ? modules : undefined;
}

export function dshModules() {
  if (process.env.DSH_CHECKOUT) {
    const modules = modulesAt(resolve(process.env.DSH_CHECKOUT));
    if (!modules) throw new Error(`${usage}\nDSH_CHECKOUT=${process.env.DSH_CHECKOUT}`);
    return modules;
  }
  try {
    const dsh = require.resolve("@deepseek-ai/dsh/package.json");
    const modules = dirname(dirname(dirname(dsh)));
    if (modulesAt(dirname(modules))) return modules;
  } catch {}
  const executable = process.platform === "win32" ? "where.exe" : "which";
  const found = spawnSync(executable, ["dsh"], { encoding: "utf8" });
  if (found.status === 0) {
    const bin = realpathSync(found.stdout.trim().split(/\r?\n/)[0]);
    const modules = dirname(dirname(bin));
    if (existsSync(join(modules, "@deepseek-ai", "dsh-mcp-client", "lib", "index.js"))) return modules;
  }
  throw new Error(usage);
}

export async function dshImport(modules, path) {
  return import(pathToFileURL(join(modules, path)).href);
}
