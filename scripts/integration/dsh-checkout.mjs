import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const defaultCheckout = new URL("../../acceptance/dsh", import.meta.url);
const usage = "SKIP: DSH unavailable. Run npm ci --prefix acceptance/dsh, set DSH_CHECKOUT to that directory/a checkout, or install DSH locally.";

function modulesAt(root) {
  const modules = join(root, "node_modules");
  return existsSync(join(modules, "@deepseek-ai", "dsh-mcp-client", "lib", "index.js")) ? modules : undefined;
}

export function dshModules() {
  const checkout = process.env.DSH_CHECKOUT ?? fileURLToPath(defaultCheckout);
  const checkoutModules = modulesAt(resolve(checkout));
  if (checkoutModules) return checkoutModules;
  if (process.env.DSH_CHECKOUT) throw new Error(`${usage}\nDSH_CHECKOUT=${process.env.DSH_CHECKOUT}`);
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
