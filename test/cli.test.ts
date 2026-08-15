import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCli } from "../src/cli.js";
import { codexSnippet, dshSnippet } from "../src/management.js";

const cli = ["dist/src/cli.js"];
const run = (args: string[]) => spawnSync(process.execPath, [...cli, ...args], { cwd: process.cwd(), encoding: "utf8" });

test("CLI parses serve and preserves legacy direct flags", () => {
  assert.equal(parseCli(["serve", "--root", ".", "--root", ".."]).command, "serve");
  const legacy = parseCli(["--root", "."]);
  assert.equal(legacy.command, "serve");
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.options.roots.length, 1);
  assert.equal(parseCli(["doctor", "--execute"]).execute, true);
  assert.equal(parseCli(["init", "--yes", "--force"]).force, true);
  const configured = run(["print-config", "dsh", "--manifest", "missing.json"]);
  assert.equal(configured.status, 1);
  assert.match(configured.stderr, /ROOT_REQUIRED/);
});

test("init writes a deterministic manifest and never overwrites it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-command-cli-"));
  const path = join(directory, "manifest.json");
  try {
    const first = run(["init", path]);
    assert.equal(first.status, 0);
    assert.match(first.stdout, /\[mcp_servers\.system-command\]/);
    assert.match(first.stdout, /- id: system-command/);
    const content = await readFile(path, "utf8");
    const second = run(["init", path, "--yes"]);
    assert.equal(second.status, 1);
    assert.equal(await readFile(path, "utf8"), content);
    const forced = run(["init", path, "--yes", "--force"]);
    assert.equal(forced.status, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("doctor validates configured runtime statically and executes only declared probes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-command-cli-"));
  const path = join(directory, "manifest.json");
  try {
    await writeFile(path, JSON.stringify({ version: 1, programs: { absent: { candidates: ["definitely-not-installed"], required: true } } }));
    const unavailable = run(["doctor", "--manifest", path, "--root", directory]);
    assert.equal(unavailable.status, 1);
    await writeFile(path, JSON.stringify({ version: 1, allowInheritedPath: true, programs: { node: { candidates: ["node"], required: true } }, probes: { node: { args: ["-e", "process.exit(7)"], acceptedExitCodes: [7] } } }));
    const staticResult = run(["doctor", "--manifest", path, "--root", directory]);
    assert.equal(staticResult.status, 0);
    assert.match(staticResult.stderr, /no programs executed/);
    const execute = run(["doctor", "--execute", "--manifest", path, "--root", directory]);
    assert.equal(execute.status, 0);
    assert.match(execute.stderr, /executed 1 declared probe/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("configuration snippets use Codex 30/300 and the DSH rc.6 plugin row", () => {
  const options = { roots: ["C:\\work dir\\quoted\\\"root"], manifestPath: "C:\\configs\\manifest.json" };
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "C:\\custom-codex-home";
  try {
    const codex = codexSnippet(options);
    assert.match(codex, /\$CODEX_HOME\/config\.toml/);
    assert.match(codex, /effective: C:\\custom-codex-home\//);
    assert.match(codex, /startup_timeout_sec = 30/);
    assert.match(codex, /tool_timeout_sec = 300/);
    assert.match(codex, /codex mcp list --json.*codex mcp get system-command --json/);
    assert.match(codex, /C:\\\\work dir/);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
  const dsh = dshSnippet(options);
  assert.match(dsh, /^- id: system-command/m);
  assert.match(dsh, /name: "@deepseek-ai\/dsh-mcp-client"/);
  assert.match(dsh, /serverName: system-command/);
  assert.match(dsh, /transport: stdio/);
  assert.match(dsh, /toolCallTimeoutMs: 30000/);
  assert.match(dsh, /failOnStartupError: true/);
  assert.match(dsh, /reconnect:\n      enabled: true\n      initialDelayMs: 500\n      maxDelayMs: 30000\n      maxAttempts: 10/);
  assert.doesNotMatch(dsh, /mcpServers:|reconnect: true/);
});

test("print-config uses stdout and management logs use stderr", () => {
  const result = run(["print-config", "dsh", "--root", process.cwd()]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^- id: system-command\n/);
  assert.equal(result.stderr, "");
});
