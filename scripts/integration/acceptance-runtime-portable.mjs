import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "system-command-acceptance-"));
const manifest = join(root, "manifest.json");
const artifacts = join(root, "artifacts");
const cli = resolve("dist/src/cli.js");
try {
  await writeFile(manifest, JSON.stringify({ version: 1, allowInheritedPath: false, programs: { node: { candidates: [process.execPath], required: true, policy: { artifactPolicy: "always", defaultTimeoutMs: 500, maxTimeoutMs: 1_000 } } } }, null, 2));
  const doctor = spawnSync(process.execPath, [cli, "doctor", "--manifest", manifest, "--root", root, "--artifact-dir", artifacts], { encoding: "utf8" });
  if (doctor.status !== 0) throw new Error(`doctor failed (${doctor.status})\n${doctor.stdout}${doctor.stderr}`);
  console.log(JSON.stringify({ root: "$ROOT", manifest: "$MANIFEST", artifactDirectory: "$ARTIFACT_DIR", doctor: "ok" }));
} finally {
  await rm(root, { recursive: true, force: true });
}
