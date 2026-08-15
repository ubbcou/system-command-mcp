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
function manifestV2(root: string, projectRoot = root, defaultVersion?: string, programs: Record<string, unknown> = { node: { candidates: [execPath], required: true } }) { return { version: 2, projectNode: { enabledRoots: [projectRoot], installationRoots: [root], ...(defaultVersion ? { defaultVersion } : {}) }, allowInheritedPath: true, programs }; }

async function runtime(root: string, programs?: Record<string, unknown>) { return createCommandRuntime({ roots: [root], environment: { Path: dirname(execPath), PATH: dirname(execPath) }, manifest: manifest(root, programs) }); }
async function runtimeV2(root: string, projectRoot = root, defaultVersion?: string, programs?: Record<string, unknown>) { return createCommandRuntime({ roots: [root], environment: { Path: dirname(execPath), PATH: dirname(execPath) }, manifest: manifestV2(root, projectRoot, defaultVersion, programs) }); }

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
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-untrusted-")); await node(root, "v20.1.0"); const marker = join(root, "marker"); const binary = join(root, "untrusted", "v99.0.0", "bin", "node"); await mkdir(dirname(binary), { recursive: true }); await writeFile(binary, `#!/bin/sh\nprintf executed > "${marker}"\n`); await chmod(binary, 0o755);
  const escaped = join(root, "v22.0.0", "bin", "node"); await mkdir(dirname(escaped), { recursive: true }); await symlink(execPath, escaped);
  const instance = await runtime(root);
  try { assert.deepEqual((await instance.inspectEnvironment()).programs.node?.variantSet?.variants.map(item => item.version), ["20.1.0"]); await assert.rejects(readFile(marker)); } finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
});

test("declaration files fail closed and precedence does not bypass invalid files", async (t) => {
  if (process.platform === "win32") return t.skip("symlink fixture needs elevated privilege on this host");
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-declarations-")); await node(root, "v22.2.0"); const project = join(root, "project"); await mkdir(project); const instance = await runtime(root);
  try {
    for (const [name, content] of [[".nvmrc", ""], [".node-version", "not-a-range"], ["package.json", "{"]] as [string, string][]) { await rm(join(project, ".nvmrc"), { force: true }); await rm(join(project, ".node-version"), { force: true }); await rm(join(project, "package.json"), { force: true }); await writeFile(join(project, name), content); await assert.rejects(instance.execute({ program: "node", cwd: project }), /NODE_(DECLARATION|VERSION_REQUIREMENT)_INVALID/, `${name} must fail closed`); }
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
  assert.throws(() => parseProgramManifest({ version: 2, projectNode: { enabledRoots: ["/x"], installationRoots: ["/x"] }, programs: {} }), /defaultVersion/);
  for (const value of ["22", "^22", ">=22"]) assert.throws(() => parseProgramManifest({ version: 2, projectNode: { enabledRoots: ["/x"], installationRoots: ["/x"], defaultVersion: value }, programs: {} }), /defaultVersion/);
  assert.throws(() => parseProgramManifest({ version: 2, nodeResolution: { enabled: true }, programs: {} }), /nodeResolution/);
});

test("v2 selects exact nearest declaration, checks ancestor engines, and defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-v2-")); await node(root, "v20.1.0"); await node(root, "v22.2.0");
  const project = join(root, "project"); const nested = join(project, "nested"); await mkdir(nested, { recursive: true }); await writeFile(join(project, "package.json"), JSON.stringify({ engines: { node: ">=22 <23" } })); await writeFile(join(nested, ".nvmrc"), "v22.2.0");
  const instance = await runtimeV2(root, root, "v20.1.0");
  try {
    let result = await instance.execute({ program: "node", cwd: nested }); assert.equal(result.programSelection?.source, ".nvmrc"); assert.equal(result.programSelection?.requirement, "22.2.0");
    await rm(join(nested, ".nvmrc")); await assert.rejects(instance.execute({ program: "node", cwd: nested }), /PROJECT_NODE_RANGE_UNSATISFIED/);
    await writeFile(join(project, "package.json"), "{}"); result = await instance.execute({ program: "node", cwd: nested }); assert.equal(result.programSelection?.source, "manifest#projectNode.defaultVersion");
  } finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
});

test("v2 devEngines runtime selects only exact Node entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-v2-dev-engines-")); await node(root, "v20.1.0"); await node(root, "v22.2.0"); const project = join(root, "project"); await mkdir(project); const instance = await runtimeV2(root, project, "20.1.0");
  const execute = async (runtime: unknown) => { await writeFile(join(project, "package.json"), JSON.stringify({ devEngines: { runtime } })); return instance.execute({ program: "node", cwd: project }); };
  try {
    assert.equal((await execute({ name: "bun", version: "1.2.3" })).programSelection?.version, "20.1.0");
    assert.equal((await execute([{ name: "bun", version: "1.2.3" }])).programSelection?.version, "20.1.0");
    assert.equal((await execute({ name: "node", version: "22.2.0" })).programSelection?.version, "22.2.0");
    await assert.rejects(execute({ name: "node", version: "22" }), /NODE_VERSION_REQUIREMENT_INVALID: package.json#devEngines.runtime/);
    assert.equal((await execute([{ name: "node", version: "22.2.0" }, { name: "node", version: "22.2.0" }])).programSelection?.version, "22.2.0");
    await assert.rejects(execute([{ name: "node", version: "20.1.0" }, { name: "node", version: "22.2.0" }]), /PROJECT_NODE_DECLARATION_CONFLICT/);
    await assert.rejects(execute([{ name: "node", version: "22.2.0" }, { name: "node", version: "22" }]), /NODE_VERSION_REQUIREMENT_INVALID: package.json#devEngines.runtime/);
  } finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
});

test("v2 conflicts fail closed and keeps outside enabled roots static", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-v2-conflict-")); await node(root, "v22.2.0"); const project = join(root, "project"); const outside = join(root, "outside"); await mkdir(project); await mkdir(outside); await writeFile(join(project, ".nvmrc"), "22.2.0"); await writeFile(join(project, ".node-version"), "20.1.0");
  const instance = await runtimeV2(root, project, "v22.2.0");
  try { await assert.rejects(instance.execute({ program: "node", cwd: project }), /PROJECT_NODE_DECLARATION_CONFLICT/); await rm(join(project, ".node-version")); await writeFile(join(project, ".nvmrc"), "22"); await assert.rejects(instance.execute({ program: "node", cwd: project }), /NODE_VERSION_REQUIREMENT_INVALID: \.nvmrc/); const result = await instance.execute({ program: "node", cwd: outside }); assert.equal(result.programSelection?.version, undefined); } finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
});

test("v2 chooses the deepest overlapping enabled root", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-v2-overlap-")); await node(root, "v20.1.0"); await node(root, "v22.2.0");
  const outer = join(root, "projects"); const nested = join(outer, "nested"); const cwd = join(nested, "app"); await mkdir(cwd, { recursive: true });
  await writeFile(join(outer, ".nvmrc"), "20.1.0"); await writeFile(join(outer, "package.json"), JSON.stringify({ engines: { node: "<21" } }));
  const instance = await createCommandRuntime({ roots: [root], environment: { Path: dirname(execPath), PATH: dirname(execPath) }, manifest: { version: 2, projectNode: { enabledRoots: [outer, nested], installationRoots: [root], defaultVersion: "22.2.0" }, allowInheritedPath: true, programs: { node: { candidates: [execPath], required: true } } } });
  try { const result = await instance.execute({ program: "node", args: ["--version"], cwd }); assert.equal(result.programSelection?.version, "22.2.0"); assert.equal(result.programSelection?.source, "manifest#projectNode.defaultVersion"); }
  finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
});

test("v2 requires paired npm and npx across every selectable variant", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-v2-pairs-")); await node(root, "v20.1.0"); await node(root, "v22.2.0");
  try {
    await rm(join(root, "v20.1.0", "node_modules", "npm", "bin", "npm-cli.js"));
    await assert.rejects(runtimeV2(root, root, "22.2.0", { node: { candidates: [execPath], required: true }, npm: { candidates: [execPath] } }), /PROJECT_NPM_UNAVAILABLE/);
    await writeFile(join(root, "v20.1.0", "node_modules", "npm", "bin", "npm-cli.js"), "");
    await rm(join(root, "v20.1.0", "node_modules", "npm", "bin", "npx-cli.js"));
    await assert.rejects(runtimeV2(root, root, "22.2.0", { node: { candidates: [execPath], required: true }, npx: { candidates: [execPath] } }), /PROJECT_NPX_UNAVAILABLE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("paired native npm accepts literal metacharacters and selected fallback prepends PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-v2-literal-")); await node(root, "v22.2.0"); const project = join(root, "project"); await mkdir(project);
  const selected = await realpath(join(root, "v22.2.0", "bin", binaryName));
  const wrapper = join(root, "npm.cmd"); await writeFile(wrapper, ""); if (process.platform !== "win32") await chmod(wrapper, 0o755);
  const instance = await runtimeV2(root, project, "22.2.0", { node: { candidates: [selected], required: true }, npm: { candidates: [wrapper], required: true } });
  try {
    const npm = await instance.execute({ program: "npm", args: ["a&b", "%HOME%"], cwd: project }); assert.equal(npm.stdout.text, `${process.version} a&b,%HOME%\n`);
    await assert.rejects(instance.execute({ program: "npm", args: ["a&b"], cwd: root }), /UNSAFE_CMD_SCRIPT_ARGUMENT/);
    const path = await instance.execute({ program: "node", args: ["-e", "process.stdout.write(process.env.PATH ?? process.env.Path ?? '')"], cwd: project }); assert.equal(path.stdout.text.split(process.platform === "win32" ? ";" : ":")[0], dirname(selected));
  } finally { await instance.close(); await rm(root, { recursive: true, force: true }); }
});

test("v2 authorizes roots and supports platform override", async () => {
  const root = await mkdtemp(join(tmpdir(), "system-command-mcp-node-v2-root-")); await node(root, "v22.2.0");
  try {
    await assert.rejects(createCommandRuntime({ roots: [root], manifest: manifestV2(root, join(root, "missing"), "v22.2.0") }), /PROJECT_NODE_ROOT_UNAVAILABLE/);
    const parsed = parseProgramManifest({ version: 2, projectNode: { enabledRoots: ["/base"], installationRoots: ["/nodes"], defaultVersion: "v20.1.0" }, programs: {}, platforms: { [process.platform]: { projectNode: { enabledRoots: ["/override"], installationRoots: ["/nodes"], defaultVersion: "v22.2.0" } } } }); assert.deepEqual(parsed.projectNode?.enabledRoots, ["/override"]); assert.equal(parsed.projectNode?.defaultVersion, "22.2.0");
  } finally { await rm(root, { recursive: true, force: true }); }
});
