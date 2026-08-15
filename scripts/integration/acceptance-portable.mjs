import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "system-command-acceptance-"));
const manifest = join(root, "manifest.json");
const cli = resolve("dist/src/cli.js");
const run = (file, args = [], environment = {}) => {
  const result = spawnSync(process.execPath, [file, ...args], { cwd: process.cwd(), env: { ...process.env, ...environment }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${file} failed (${result.status})\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
};
try {
  await writeFile(manifest, JSON.stringify({ version: 1, allowInheritedPath: false, programs: { node: { candidates: [process.execPath], required: true } } }, null, 2));
  run(cli, ["doctor", "--manifest", manifest, "--root", root]);
  const smoke = run("scripts/integration/dsh-mcp-smoke.mjs", [], { SYSTEM_COMMAND_MANIFEST: manifest, SYSTEM_COMMAND_ROOT: root });
  console.log(JSON.stringify({ root: "$ROOT", manifest: "$MANIFEST", doctor: "ok", mcp: JSON.parse(smoke) }));
} finally {
  await rm(root, { recursive: true, force: true });
}
