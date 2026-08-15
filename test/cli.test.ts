import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CliUsageError, parseCli, selectDetectedPrograms } from "../src/cli.js";
import { codexSnippet, dshSnippet } from "../src/management.js";
import { parseProgramManifest } from "../src/runtime.js";
import { resolveExecutableMatches } from "../src/program-registry.js";

const cli = ["dist/src/cli.js"];
const run = (args: string[]) => spawnSync(process.execPath, [...cli, ...args], { cwd: process.cwd(), encoding: "utf8" });

const manifest = (programs: Record<string, unknown>, probes?: Record<string, unknown>) => JSON.stringify({ version: 1, allowInheritedPath: true, programs, ...(probes ? { probes } : {}) });

test("CLI parses commands and reports invocation failures as typed usage errors", () => {
  assert.equal(parseCli(["serve", "--root", ".", "--root", ".."]).command, "serve");
  assert.equal(parseCli(["doctor", "--execute", "--all"]).all, true);
  assert.throws(() => parseCli(["doctor", "--all"]), CliUsageError);
  assert.throws(() => parseCli(["bogus"]), CliUsageError);
  assert.throws(() => parseCli(["serve", "--default-timeout-ms", "0"]), CliUsageError);
  assert.equal(run(["doctor", "--all"]).status, 2);
  assert.equal(run(["serve", "--unknown"]).status, 2);
  const configured = run(["print-config", "dsh", "--manifest", "missing.json"]);
  assert.equal(configured.status, 1);
  assert.match(configured.stderr, /ROOT_REQUIRED/);
});

test("init selection makes --yes optional and supports deterministic core selection", async () => {
  const source = JSON.stringify({ version: 1, programs: { git: { candidates: ["git"], required: false }, node: { candidates: ["node"], required: false } } });
  const selected = JSON.parse(await selectDetectedPrograms(source, async name => name === "git")) as { programs: Record<string, { required: boolean }> };
  assert.equal(selected.programs.git!.required, true);
  assert.equal(selected.programs.node!.required, false);
  const directory = await mkdtemp(join(tmpdir(), "system-command-cli-")); const path = join(directory, "manifest.json");
  try {
    const nonInteractive = run(["init", path]);
    assert.equal(nonInteractive.status, 2); assert.match(nonInteractive.stderr, /use --yes/);
    const first = run(["init", path, "--yes"]); assert.equal(first.status, 0);
    const content = await readFile(path, "utf8");
    assert.match(first.stdout, /\[mcp_servers\.system-command\]/); assert.match(first.stdout, /- id: system-command/);
    const second = run(["init", path, "--yes"]); assert.equal(second.status, 1); assert.equal(await readFile(path, "utf8"), content);
    assert.equal(run(["init", path, "--yes", "--force"]).status, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("doctor executes required probes by default and optional probes only with --all", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-command-cli-")); const path = join(directory, "manifest.json");
  try {
    await writeFile(path, manifest({ node: { candidates: ["node"], required: true }, optional: { candidates: ["node"], required: false } }, {
      node: { args: ["-e", "process.exit(0)"] }, optional: { args: ["-e", "process.exit(9)"], acceptedExitCodes: [9] },
    }));
    assert.match(run(["doctor", "--manifest", path, "--root", directory]).stderr, /no programs executed/);
    const required = run(["doctor", "--execute", "--manifest", path, "--root", directory]); assert.equal(required.status, 0); assert.match(required.stderr, /executed 1 declared probe.*required/);
    const all = run(["doctor", "--execute", "--all", "--manifest", path, "--root", directory]); assert.equal(all.status, 0); assert.match(all.stderr, /executed 2 declared probe.*including optional/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("probe declarations are strict runtime manifest fields and multi-root probes require an authorized absolute cwd", async () => {
  assert.throws(() => parseProgramManifest(JSON.parse(manifest({ node: { candidates: ["node"] } }, { "bad name": {} }))), /manifest\.probes\.bad name/);
  assert.throws(() => parseProgramManifest(JSON.parse(manifest({ node: { candidates: ["node"] } }, { node: { extra: true } }))), /unknown field/);
  assert.throws(() => parseProgramManifest(JSON.parse(manifest({ node: { candidates: ["node"] } }, { node: { cwd: "relative" } }))), /cwd/);
  const directory = await mkdtemp(join(tmpdir(), "system-command-cli-")); const other = await mkdtemp(join(tmpdir(), "system-command-cli-")); const path = join(directory, "manifest.json");
  try {
    await writeFile(path, manifest({ node: { candidates: ["node"], required: true } }, { node: { args: ["-e", "process.exit(0)"] } }));
    const noCwd = run(["doctor", "--execute", "--manifest", path, "--root", directory, "--root", other]); assert.equal(noCwd.status, 1); assert.match(noCwd.stderr, /cwd is required/);
    await writeFile(path, manifest({ node: { candidates: ["node"], required: true } }, { node: { args: ["-e", "process.exit(0)"], cwd: directory } }));
    assert.equal(run(["doctor", "--execute", "--manifest", path, "--root", directory, "--root", other]).status, 0);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test("resolver diagnostics retain winner and shadowed executable matches", async () => {
  const first = await mkdtemp(join(tmpdir(), "system-command-path-")); const second = await mkdtemp(join(tmpdir(), "system-command-path-"));
  try {
    for (const directory of [first, second]) { const file = join(directory, "tool"); await writeFile(file, "#!/bin/sh\nexit 0\n"); await chmod(file, 0o755); }
    const matches = await resolveExecutableMatches(["tool"], { path: `${first}:${second}`, platform: "linux" });
    assert.deepEqual(matches, [join(first, "tool"), join(second, "tool")]);
  } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); }
});

test("configuration snippets use Codex 30/300 and the DSH rc.6 plugin row", () => {
  const options = { roots: ["C:\\work dir\\quoted\\\"root"], manifestPath: "C:\\configs\\manifest.json" };
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = "C:\\custom-codex-home";
  try { const codex = codexSnippet(options); assert.match(codex, /\$CODEX_HOME\/config\.toml/); assert.match(codex, /effective: C:\\custom-codex-home\//); assert.match(codex, /startup_timeout_sec = 30/); assert.match(codex, /tool_timeout_sec = 300/); } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
  const dsh = dshSnippet(options); assert.match(dsh, /^- id: system-command/m); assert.match(dsh, /name: "@deepseek-ai\/dsh-mcp-client"/); assert.match(dsh, /toolCallTimeoutMs: 30000/); assert.doesNotMatch(dsh, /mcpServers:|reconnect: true/);
});

test("print-config uses stdout and management logs use stderr", () => { const result = run(["print-config", "dsh", "--root", process.cwd()]); assert.equal(result.status, 0); assert.match(result.stdout, /^- id: system-command\n/); assert.equal(result.stderr, ""); });
