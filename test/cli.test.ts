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
});

test("init writes a deterministic manifest and never overwrites it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-command-cli-"));
  const path = join(directory, "manifest.json");
  try {
    const first = run(["init", path]);
    assert.equal(first.status, 0);
    assert.match(first.stdout, /\[mcp_servers\.system-command\]/);
    assert.match(first.stdout, /mcpServers:/);
    const content = await readFile(path, "utf8");
    const second = run(["init", path]);
    assert.equal(second.status, 1);
    assert.equal(await readFile(path, "utf8"), content);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("doctor is static unless probe is explicit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-command-cli-"));
  const path = join(directory, "manifest.json");
  try {
    await writeFile(path, JSON.stringify({ version: 1, programs: { absent: { candidates: ["definitely-not-installed"] } } }));
    const staticResult = run(["doctor", "--manifest", path, "--root", directory]);
    assert.equal(staticResult.status, 0);
    assert.match(staticResult.stderr, /no programs executed/);
    const probe = run(["doctor", "--probe", "--manifest", path, "--root", directory]);
    assert.equal(probe.status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("configuration snippets escape Windows paths and include host settings", () => {
  const options = { roots: ["C:\\work dir\\quoted\\\"root"], manifestPath: "C:\\configs\\manifest.json" };
  const codex = codexSnippet(options);
  assert.match(codex, /CODEX_HOME|\.codex/);
  assert.match(codex, /startup_timeout_sec = 10/);
  assert.match(codex, /tool_timeout_sec = 60/);
  assert.match(codex, /C:\\\\work dir/);
  const dsh = dshSnippet(options);
  assert.match(dsh, /toolCallTimeoutMs: 60000/);
  assert.match(dsh, /failOnStartupError: true/);
  assert.match(dsh, /reconnect: true/);
});

test("print-config uses stdout and management logs use stderr", () => {
  const result = run(["print-config", "dsh", "--root", process.cwd()]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^mcpServers:/);
  assert.equal(result.stderr, "");
});
