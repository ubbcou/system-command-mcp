import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { CliUsageError, parseCli, selectDetectedPrograms } from "../src/cli.js";
import { codexSnippet, doctor, dshSnippet } from "../src/management.js";
import { parseProgramManifest } from "../src/runtime.js";

const cli = ["dist/src/cli.js"];
const run = (args: string[]) => spawnSync(process.execPath, [...cli, ...args], { cwd: process.cwd(), encoding: "utf8" });

const manifest = (programs: Record<string, unknown>, probes?: Record<string, unknown>) => JSON.stringify({ version: 1, allowInheritedPath: true, programs, ...(probes ? { probes } : {}) });

test("CLI parses commands and reports invocation failures as typed usage errors", () => {
  assert.equal(parseCli(["serve", "--root", ".", "--root", ".."]).command, "serve");
  assert.equal(parseCli(["doctor", "--execute", "--all", "--manifest", "manifest.json", "--root", "."]).all, true);
  assert.throws(() => parseCli(["doctor", "--all"]), CliUsageError);
  assert.throws(() => parseCli(["bogus"]), CliUsageError);
  assert.throws(() => parseCli(["serve", "--default-timeout-ms", "0"]), CliUsageError);
  assert.equal(run(["doctor", "--all"]).status, 2);
  assert.equal(run(["doctor"]).status, 2);
  assert.equal(run(["serve", "--unknown"]).status, 2);
  assert.equal(run(["serve", "--manifest", "missing.json"]).status, 2);
  assert.equal(run(["doctor", "--manifest", "missing.json"]).status, 2);
  assert.equal(run(["print-config", "dsh", "--manifest", "missing.json"]).status, 2);
  const invalidBounds: [string, string][] = [["--default-timeout-ms", "600001"], ["--max-output-bytes", String(8 * 1024 * 1024 + 1)], ["--inline-head-bytes", "2"], ["--artifact-max-stream-bytes", String(100 * 1024 * 1024 + 1)], ["--artifact-retention-ms", String(24 * 60 * 60 * 1000 + 1)], ["--artifact-quota-bytes", String(1024 * 1024 * 1024 + 1)], ["--max-concurrent-executions", "1025"]];
  for (const [flag, value] of invalidBounds) assert.throws(() => parseCli(["serve", "--root", process.cwd(), "--max-output-bytes", "1", flag, value]), CliUsageError);
  assert.equal(parseCli(["serve", "--root", process.cwd(), "--max-concurrent-executions", "4"]).options.maxConcurrentExecutions, 4);
  assert.throws(() => parseCli(["serve", "--root", process.cwd(), "--inline-head-bytes", "2", "--max-output-bytes", "1"]), CliUsageError);
  const invalid = run(["serve", "--manifest", "missing.json", "--root", process.cwd()]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /MANIFEST_READ_FAILED/);
  const configured = run(["print-config", "dsh", "--manifest", "missing.json"]);
  assert.equal(configured.status, 2);
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

test("doctor executes enabled required probes by default, enabled optional probes with --all, and skips disabled probes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-command-cli-")); const path = join(directory, "manifest.json");
  try {
    await writeFile(path, manifest({ node: { candidates: ["node"], required: true }, optional: { candidates: ["node"], required: false }, disabled: { candidates: ["node"], enabled: false } }, {
      node: { args: ["-e", "process.exit(0)"] }, optional: { args: ["-e", "process.exit(9)"], acceptedExitCodes: [9] }, disabled: { args: ["-e", "process.exit(1)"] },
    }));
    assert.match(run(["doctor", "--manifest", path, "--root", directory]).stderr, /no programs executed/);
    const required = run(["doctor", "--execute", "--manifest", path, "--root", directory]); assert.equal(required.status, 0); assert.match(required.stderr, /executed 1 declared probe.*required.*skipped disabled probes: disabled/);
    const all = run(["doctor", "--execute", "--all", "--manifest", path, "--root", directory]); assert.equal(all.status, 0); assert.match(all.stderr, /executed 2 declared probe.*including optional.*skipped disabled probes: disabled/);
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

test("doctor reports unavailable optional Programs without making configuration unusable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-command-cli-")); const path = join(directory, "manifest.json");
  try {
    await writeFile(path, manifest({ node: { candidates: [process.execPath], required: true }, unavailable: { candidates: ["definitely-missing-a", "definitely-missing-b"], required: false } }));
    const result = run(["doctor", "--manifest", path, "--root", directory]);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /optional-unavailable: unavailable \(candidates: definitely-missing-a, definitely-missing-b\)/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("doctor rejects invalid supplied runtime configuration with unusable exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-command-cli-")); const path = join(directory, "manifest.json");
  try {
    await writeFile(path, manifest({ node: { candidates: [process.execPath], required: true } }));
    await assert.rejects(doctor({ manifestPath: path, roots: [directory], maxOutputBytes: 1, inlineHeadBytes: 2 }), /INVALID_RUNTIME_CONFIG/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("doctor validates every enabled Program's effective default timeout without registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-command-cli-")); const path = join(directory, "manifest.json");
  try {
    await writeFile(path, manifest({ node: { candidates: [process.execPath], required: true }, unavailable: { candidates: ["definitely-missing"], required: false, policy: { maxTimeoutMs: 100 } }, disabled: { candidates: ["definitely-missing"], enabled: false, policy: { maxTimeoutMs: 100 } } }));
    const invalid = run(["doctor", "--manifest", path, "--root", directory, "--default-timeout-ms", "200"]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /INVALID_RUNTIME_CONFIG: Program unavailable effective defaultTimeoutMs 200 exceeds maxTimeoutMs 100/);
    const skipped = run(["doctor", "--manifest", path, "--root", directory, "--default-timeout-ms", "100"]);
    assert.equal(skipped.status, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("doctor shadows use the program's effective environment layer", async () => {
  const first = await mkdtemp(join(tmpdir(), "system-command-path-")); const second = await mkdtemp(join(tmpdir(), "system-command-path-")); const path = join(first, "manifest.json");
  try {
    const filename = process.platform === "win32" ? "tool.exe" : "tool";
    for (const directory of [first, second]) { const file = join(directory, filename); await writeFile(file, "#!/bin/sh\nexit 0\n"); await chmod(file, 0o755); }
    await writeFile(path, JSON.stringify({ version: 1, environment: { set: { PATH: first } }, programs: { tool: { candidates: [filename], environment: { set: { PATH: `${second}${delimiter}${first}` } } } } }));
    const result = await doctor({ manifestPath: path, roots: [first] });
    assert.ok(result.message.includes(`tool: winner ${join(second, filename)}`));
    assert.ok(result.message.includes(`shadowed ${join(first, filename)}`));
  } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); }
});

test("configuration snippets preserve every serve execution option", () => {
  const options = { roots: ["C:\\work dir\\quoted\\\"root", "C:\\second root"], manifestPath: "C:\\configs\\manifest.json", artifactDirectory: "C:\\artifacts", artifactRetentionMs: 1, artifactQuotaBytes: 2, artifactMaxStreamBytes: 3, maxOutputBytes: 5, inlineHeadBytes: 5, defaultTimeoutMs: 6, maxConcurrentExecutions: 4 };
  const parsed = parseCli((JSON.parse(`[${codexSnippet(options).match(/args = \[(.*)\]/)![1]}]`) as string[]).slice(1));
  assert.deepEqual(parsed.options, { ...options, roots: options.roots.map(root => join(root)), manifestPath: join(options.manifestPath), artifactDirectory: join(options.artifactDirectory) });
  const dshArgs = [...dshSnippet(options).matchAll(/^      - (".*")$/gm)].map(match => JSON.parse(match[1]!));
  assert.deepEqual(parseCli(dshArgs.slice(1)).options, parsed.options);
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = "C:\\custom-codex-home";
  try { const codex = codexSnippet(options); assert.match(codex, /\$CODEX_HOME\/config\.toml/); assert.match(codex, /effective: C:\\custom-codex-home\//); assert.match(codex, /startup_timeout_sec = 30/); assert.match(codex, /tool_timeout_sec = 300/); } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
  const dsh = dshSnippet(options); assert.match(dsh, /^- id: system-command/m); assert.match(dsh, /name: "@deepseek-ai\/dsh-mcp-client"/); assert.match(dsh, /toolCallTimeoutMs: 30000/); assert.doesNotMatch(dsh, /mcpServers:|reconnect: true/);
});

test("print-config uses stdout and management logs use stderr", () => { const result = run(["print-config", "dsh", "--root", process.cwd()]); assert.equal(result.status, 0); assert.match(result.stdout, /^- id: system-command\n/); assert.equal(result.stderr, ""); });
