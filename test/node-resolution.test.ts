import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import test from "node:test";
import { createCommandRuntime, parseProgramManifest } from "../src/runtime.js";

async function node(root: string, version: string): Promise<void> {
  const path = join(root, version, "bin", process.platform === "win32" ? "node.exe" : "node");
  await mkdir(dirname(path), { recursive: true });
  try { await symlink(execPath, path, process.platform === "win32" ? "file" : undefined); } catch { await writeFile(path, "fixture"); if (process.platform !== "win32") await chmod(path, 0o755); }
}

function manifest(root: string) {
  return { version: 1, nodeResolution: { enabled: true, installationRoots: [root] }, allowInheritedPath: true, programs: { node: { candidates: [execPath], required: true } } };
}

test("node resolver selects nearest declaration, highest satisfying version, and observes changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-"));
  await node(root, "v20.1.0"); await node(root, "v22.2.0");
  const project = join(root, "project", "nested"); await mkdir(project, { recursive: true });
  await writeFile(join(root, "project", ".nvmrc"), "^20"); await writeFile(join(project, ".node-version"), "22.2.0");
  const runtime = await createCommandRuntime({ roots: [root], environment: { Path: dirname(execPath), PATH: dirname(execPath) }, manifest: manifest(root) });
  try {
    let result = await runtime.execute({ program: "node", args: ["--version"], cwd: project, timeoutMs: 1_000 });
    assert.equal(result.programSelection?.version, "22.2.0"); assert.equal(result.programSelection?.source, ".node-version");
    await writeFile(join(project, ".node-version"), "^20"); result = await runtime.execute({ program: "node", args: ["--version"], cwd: project, timeoutMs: 1_000 });
    assert.equal(result.programSelection?.version, "20.1.0");
    await writeFile(join(project, ".node-version"), "lts/* secret-requirement"); await assert.rejects(runtime.execute({ program: "node", args: ["--version"], cwd: project, timeoutMs: 1_000 }), error => { assert.ok(error instanceof Error); assert.match(error.message, /NODE_VERSION_REQUIREMENT_INVALID: \.node-version/); assert.doesNotMatch(error.message, /secret-requirement/); return true; });
    await writeFile(join(project, ".node-version"), ">=99.0.0 <100.0.0"); await assert.rejects(runtime.execute({ program: "node", args: ["--version"], cwd: project, timeoutMs: 1_000 }), error => { assert.ok(error instanceof Error); assert.match(error.message, /NODE_VERSION_UNAVAILABLE: \.node-version/); assert.doesNotMatch(error.message, />=99\.0\.0/); return true; });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("node discovery never runs an unknown-layout executable", async (t) => {
  if (process.platform === "win32") return t.skip("fixture is a POSIX executable");
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-untrusted-"));
  const marker = join(root, "marker");
  const binary = join(root, "untrusted", "v99.0.0", "bin", "node");
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, `#!/bin/sh\nprintf executed > "${marker}"\n`); await chmod(binary, 0o755);
  const runtime = await createCommandRuntime({ roots: [root], environment: { PATH: dirname(execPath) }, manifest: manifest(root) });
  try {
    const environment = await runtime.inspectEnvironment();
    assert.deepEqual(environment.programs.node?.variantSet?.variants, []);
    await assert.rejects(readFile(marker));
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("node resolver parses strict manifest fields and falls back without a declaration", async () => {
  assert.throws(() => parseProgramManifest({ version: 1, nodeResolution: { enabled: true, unexpected: true }, programs: {} }), /unknown field/);
  assert.throws(() => parseProgramManifest({ version: 1, nodeResolution: { installationRoots: ["relative"] }, programs: {} }), /installationRoots/);
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-fallback-"));
  const runtime = await createCommandRuntime({ roots: [root], environment: {}, manifest: { version: 1, nodeResolution: { enabled: true, installationRoots: [] }, programs: { node: { candidates: [execPath], required: true } } } });
  try { const fallback = (await runtime.inspectEnvironment()).programs.node!.executable; const result = await runtime.execute({ program: "node", args: ["--version"], cwd: root, timeoutMs: 1_000 }); assert.equal(result.programSelection?.executable, fallback); assert.equal(result.programSelection?.version, undefined); } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
