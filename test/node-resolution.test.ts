import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import test from "node:test";
import { createCommandRuntime, parseProgramManifest } from "../src/runtime.js";

const binaryName = process.platform === "win32" ? "node.exe" : "node";
async function node(root: string, version: string, npm = true): Promise<void> {
  const path = join(root, version, "bin", binaryName);
  await mkdir(dirname(path), { recursive: true }); await cp(execPath, path); if (process.platform !== "win32") await chmod(path, 0o755);
  if (npm) { const cli = join(root, version, "node_modules", "npm", "bin"); await mkdir(cli, { recursive: true }); await writeFile(join(cli, "npm-cli.js"), "console.log(process.version, process.argv.slice(2).join(','))"); await writeFile(join(cli, "npx-cli.js"), "console.log(process.version, process.argv.slice(2).join(','))"); }
}
function manifest(root: string, programs: Record<string, unknown> = { node: { candidates: [execPath], required: true } }) { return { version: 1, nodeResolution: { enabled: true, installationRoots: [root] }, allowInheritedPath: true, programs }; }

async function runtime(root: string, programs?: Record<string, unknown>) { return createCommandRuntime({ roots: [root], environment: { Path: dirname(execPath), PATH: dirname(execPath) }, manifest: manifest(root, programs) }); }

test("node resolver selects nearest declaration, highest satisfying version, and observes changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-")); await node(root, "v20.1.0"); await node(root, "v22.2.0");
  const project = join(root, "project", "nested"); await mkdir(project, { recursive: true }); await writeFile(join(root, "project", ".nvmrc"), "^20"); await writeFile(join(project, ".node-version"), "22.2.0");
  const instance = await runtime(root);
  try {
    let result = await instance.execute({ program: "node", args: ["--version"], cwd: project, timeoutMs: 1_000 }); assert.equal(result.programSelection?.version, "22.2.0"); assert.equal(result.programSelection?.source, ".node-version");
    await writeFile(join(project, ".node-version"), "^20"); result = await instance.execute({ program: "node", args: ["--version"], cwd: project, timeoutMs: 1_000 }); assert.equal(result.programSelection?.version, "20.1.0");
    await writeFile(join(project, ".node-version"), "lts/* secret-requirement"); await assert.rejects(instance.execute({ program: "node", args: ["--version"], cwd: project }), /NODE_VERSION_REQUIREMENT_INVALID: \.node-version/);
    await writeFile(join(project, ".node-version"), ">=99.0.0 <100.0.0"); await assert.rejects(instance.execute({ program: "node", args: ["--version"], cwd: project }), /NODE_VERSION_UNAVAILABLE: \.node-version/);
  } finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
});

test("discovery does not execute unknown layouts and rejects realpath escape", async (t) => {
  if (process.platform === "win32") return t.skip("symlink fixture needs elevated privilege on this host");
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-untrusted-")); const marker = join(root, "marker"); const binary = join(root, "untrusted", "v99.0.0", "bin", "node"); await mkdir(dirname(binary), { recursive: true }); await writeFile(binary, `#!/bin/sh\nprintf executed > "${marker}"\n`); await chmod(binary, 0o755);
  const escaped = join(root, "v22.0.0", "bin", "node"); await mkdir(dirname(escaped), { recursive: true }); await symlink(execPath, escaped);
  const instance = await runtime(root);
  try { assert.deepEqual((await instance.inspectEnvironment()).programs.node?.variantSet?.variants, []); await assert.rejects(readFile(marker)); } finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
});

test("declaration files fail closed and precedence does not bypass invalid files", async (t) => {
  if (process.platform === "win32") return t.skip("symlink fixture needs elevated privilege on this host");
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-declarations-")); await node(root, "v22.2.0"); const project = join(root, "project"); await mkdir(project); const instance = await runtime(root);
  try {
    for (const [name, content] of [[".nvmrc", ""], [".node-version", "x"], ["package.json", "{"]] as [string, string][]) { await rm(join(project, ".nvmrc"), { force: true }); await rm(join(project, ".node-version"), { force: true }); await rm(join(project, "package.json"), { force: true }); await writeFile(join(project, name), content); await assert.rejects(instance.execute({ program: "node", cwd: project }), /NODE_(DECLARATION|VERSION_REQUIREMENT)_INVALID/); }
    await rm(join(project, "package.json")); await writeFile(join(project, ".node-version"), "22"); await symlink(join(root, "outside"), join(project, ".nvmrc")); await assert.rejects(instance.execute({ program: "node", cwd: project }), /NODE_DECLARATION_INVALID: \.nvmrc/);
    await rm(join(project, ".nvmrc")); await writeFile(join(project, "package.json"), "x".repeat(1024 * 1024 + 1)); await assert.rejects(instance.execute({ program: "node", cwd: project }), /NODE_DECLARATION_INVALID: package.json/);
  } finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
});

test("node resolution requires a native node fallback and variants", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-startup-"));
  try {
    await assert.rejects(runtime(root), /NODE_VARIANTS_UNAVAILABLE/);
    await node(root, "v22.2.0"); await assert.rejects(runtime(root, { npm: { candidates: [execPath], required: true } }), /NODE_RESOLUTION_NODE_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("npm and npx use the project node pair; missing pair fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-npm-")); await node(root, "v22.2.0"); const project = join(root, "project"); await mkdir(project); await writeFile(join(project, ".nvmrc"), "22");
  const instance = await runtime(root, { node: { candidates: [execPath], required: true }, npm: { candidates: [execPath], required: true }, npx: { candidates: [execPath], required: true } });
  try { const result = await instance.execute({ program: "npm", args: ["one", "two"], cwd: project }); assert.equal(result.stdout.text, `${process.version} one,two\n`); assert.equal(result.programSelection?.adapter, "npm-cli"); assert.equal(result.programSelection?.executable, await realpath(join(root, "v22.2.0", "bin", binaryName))); } finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
  const missing = await mkdtemp(join(tmpdir(), "system-command-mcp-node-npm-missing-")); await node(missing, "v22.2.0", false); const missingProject = join(missing, "project"); await mkdir(missingProject); await writeFile(join(missingProject, ".nvmrc"), "22"); const unavailable = await runtime(missing, { node: { candidates: [execPath], required: true }, npm: { candidates: [execPath], required: true } });
  try { await assert.rejects(unavailable.execute({ program: "npm", cwd: missingProject }), /PROJECT_NPM_UNAVAILABLE/); } finally { await unavailable.close(); await rm(missing, { recursive: true, force: true }); }
});

test("node resolver revalidates selected variants", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-revalidate-")); await node(root, "v22.2.0"); const project = join(root, "project"); await mkdir(project); await writeFile(join(project, ".nvmrc"), "22"); const instance = await runtime(root);
  try {
    const executable = join(root, "v22.2.0", "bin", binaryName); await rename(executable, `${executable}.old`); await cp(execPath, executable); await assert.rejects(instance.execute({ program: "node", cwd: project }), /NODE_VARIANT_CHANGED/);
  } finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
  if (process.platform === "win32") return t.skip("directory symlink fixture needs elevated privilege on this host");
  const linkedRoot = await mkdtemp(join(tmpdir(), "system-command-mcp-node-revalidate-link-")); await node(linkedRoot, "v22.2.0"); const linkedProject = join(linkedRoot, "project"); await mkdir(linkedProject); await writeFile(join(linkedProject, ".nvmrc"), "22"); const linked = await runtime(linkedRoot);
  try { const directory = join(linkedRoot, "v22.2.0"); await rename(directory, `${directory}.old`); await symlink(`${directory}.old`, directory); await assert.rejects(linked.execute({ program: "node", cwd: linkedProject }), /NODE_VARIANT_CHANGED/); } finally { await linked.close(); await rm(linkedRoot, { recursive: true, force: true }); }
});

test("node resolver excludes prereleases from composite stable ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-prerelease-")); await node(root, "v20.1.0"); await node(root, "v20.2.0-beta.1"); const project = join(root, "project"); await mkdir(project); await writeFile(join(project, ".nvmrc"), ">=20 <21"); const instance = await runtime(root);
  try { const result = await instance.execute({ program: "node", args: ["--version"], cwd: project }); assert.equal(result.programSelection?.version, "20.1.0"); } finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
});

test("node resolver parses strict manifest fields", () => {
  assert.throws(() => parseProgramManifest({ version: 1, nodeResolution: { enabled: true, unexpected: true }, programs: {} }), /unknown field/);
  assert.throws(() => parseProgramManifest({ version: 1, nodeResolution: { installationRoots: ["relative"] }, programs: {} }), /installationRoots/);
});
