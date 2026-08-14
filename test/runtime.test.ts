import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execPath } from "node:process";
import test from "node:test";
import { createCommandRuntime, parseProgramManifest } from "../src/runtime.js";

const root = process.cwd();

function manifest(programs: Record<string, unknown>) {
  return {
    version: 1,
    programs,
    platforms: {
      [process.platform]: {
        searchPath: [execPath.slice(0, Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\")))],
      },
    },
  };
}

test("Program Manifest v1 rejects unknown fields and merges platform program fields", () => {
  assert.throws(() => parseProgramManifest({ version: 1, programs: {}, unexpected: true }), /unknown field/i);
  const parsed = parseProgramManifest({
    version: 1,
    programs: { node: { candidates: ["node"], required: true, policy: { maxTimeoutMs: 200 } } },
    platforms: { [process.platform]: { programs: { node: { policy: { defaultTimeoutMs: 100 } } } } },
  });
  assert.deepEqual(parsed.programs.node, {
    candidates: ["node"], required: true, policy: { maxTimeoutMs: 200, defaultTimeoutMs: 100 }, environment: undefined,
  });
});

test("Configured Mode uses one layered execution environment for registration and spawn", async () => {
  const runtime = await createCommandRuntime({
    roots: [root],
    manifest: manifest({ node: { candidates: ["node"], required: true, environment: { set: { MARKER: "configured" } } } }),
  });
  try {
    const environment = await runtime.inspectEnvironment();
    assert.equal(environment.mode, "configured");
    assert.ok(environment.programs.node);
    const result = await runtime.execute({
      program: "node", args: ["-e", "process.stdout.write(process.env.MARKER)"], cwd: ".", timeoutMs: 1_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.text, "configured");
  } finally {
    await runtime.close();
  }
});

test("Configured Mode requires required Programs while Optional Programs may be absent", async () => {
  await assert.rejects(createCommandRuntime({
    roots: [root], manifest: manifest({ missing: { candidates: ["definitely-missing"], required: true } }),
  }), /REQUIRED_PROGRAM_UNAVAILABLE/);
  const runtime = await createCommandRuntime({
    roots: [root], manifest: manifest({ missing: { candidates: ["definitely-missing"], required: false } }),
  });
  try {
    assert.equal((await runtime.inspectEnvironment()).programs.missing, undefined);
  } finally { await runtime.close(); }
});

test("Program Manifest validates required disabled definitions before and after platform merging", () => {
  assert.throws(() => parseProgramManifest({
    version: 1, programs: { node: { candidates: ["node"], required: true, enabled: false } },
  }), /required Program node cannot be disabled/);
  assert.throws(() => parseProgramManifest({
    version: 1,
    programs: { node: { candidates: ["node"], required: true } },
    platforms: { [process.platform]: { programs: { node: { enabled: false } } } },
  }), /required Program node cannot be disabled/);
});

test("Program Manifest requires environment references by default and validates platform search paths", () => {
  const parsed = parseProgramManifest({
    version: 1,
    searchPath: ["base"],
    programs: { node: { candidates: ["node"] } },
    platforms: { [process.platform]: { searchPath: ["platform"] } },
  });
  assert.deepEqual(parsed.searchPath, ["platform", "base"]);
  assert.throws(() => parseProgramManifest({
    version: 1, programs: { node: { candidates: ["node"] } }, platforms: { [process.platform]: { searchPath: [1] } },
  }), /INVALID_MANIFEST: .*searchPath/);
});

test("Program Manifest validates inactive platform definitions", () => {
  assert.throws(() => parseProgramManifest({
    version: 1, programs: { node: { candidates: ["node"] } }, platforms: { inactive: { searchPath: [1] } },
  }), /manifest\.platforms\.inactive\.searchPath/);
  assert.throws(() => parseProgramManifest({
    version: 1, programs: { node: { candidates: ["node"] } }, platforms: { inactive: { programs: { node: { policy: { nope: true } } } } },
  }), /unknown field/);
});

test("Command Runtime snapshots environment references", async () => {
  const environment = { PATH: execPath.slice(0, Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\"))), SECRET: "first" };
  const runtime = await createCommandRuntime({
    roots: [root], environment, manifest: manifest({ node: { candidates: ["node"], required: true, environment: { set: { SECRET: { fromEnvironment: "SECRET" } } } } }),
  });
  try {
    environment.SECRET = "second";
    const result = await runtime.execute({ program: "node", args: ["-e", "process.stdout.write(process.env.SECRET)"], cwd: ".", timeoutMs: 1_000 });
    assert.equal(result.stdout.text, "first");
  } finally { await runtime.close(); }
});

test("Command Runtime resolves manifest-relative candidates and requires their base", async () => {
  await assert.rejects(createCommandRuntime({ roots: [root], manifest: { version: 1, programs: { node: { candidates: ["./node"] } } } }), /MANIFEST_DIRECTORY_REQUIRED/);
  const runtime = await createCommandRuntime({ roots: [root], manifestDirectory: execPath.slice(0, Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\"))), manifest: { version: 1, programs: { node: { candidates: ["./" + execPath.slice(Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\")) + 1)], required: true } } } });
  try { assert.equal((await runtime.inspectEnvironment()).programs.node?.executable, resolve(execPath)); } finally { await runtime.close(); }
});

test("Command Runtime rejects missing required environment references", async () => {
  await assert.rejects(createCommandRuntime({
    roots: [root],
    environment: { PATH: execPath.slice(0, Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\"))) },
    manifest: manifest({ node: { candidates: ["node"], environment: { set: { SECRET: { fromEnvironment: "MISSING" } } } } }),
  }), /MISSING_ENVIRONMENT_REFERENCE: MISSING/);
});

test("Command Runtime revalidates roots before execution", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "system-command-mcp-"));
  const runtime = await createCommandRuntime({ roots: [temporaryRoot], manifest: manifest({ node: { candidates: ["node"], required: true } }) });
  try {
    await rm(temporaryRoot, { recursive: true });
    await assert.rejects(runtime.execute({ program: "node", args: ["--version"], cwd: ".", timeoutMs: 1_000 }), /ROOT_UNAVAILABLE/);
  } finally { await runtime.close(); }
});

test("Automatic Discovery Mode remains available and process terminal states are results", async () => {
  const runtime = await createCommandRuntime({ roots: [root], environment: { ...process.env, PATH: process.env.PATH ?? "" } });
  try {
    const result = await runtime.execute({ program: "node", args: ["-e", "process.exit(7)"], cwd: ".", timeoutMs: 1_000 });
    assert.equal((await runtime.inspectEnvironment()).mode, "automatic-discovery");
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
  } finally { await runtime.close(); }
});

test("a pre-aborted signal returns only the cancelled terminal state", async () => {
  const controller = new AbortController();
  controller.abort();
  const runtime = await createCommandRuntime({ roots: [root], manifest: manifest({ node: { candidates: ["node"], required: true } }) });
  try {
    const result = await runtime.execute({ program: "node", args: ["-e", "setTimeout(() => {}, 1000)"], cwd: ".", timeoutMs: 30, signal: controller.signal });
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
  } finally { await runtime.close(); }
});

test("Command Runtime authorizes roots, bounded arguments, and opt-in stdin", async () => {
  const runtime = await createCommandRuntime({
    roots: [root, root],
    manifest: manifest({ node: { candidates: ["node"], required: true, policy: { allowStdin: true } } }),
  });
  try {
    const result = await runtime.execute({
      program: "node", args: ["-e", "process.stdin.on('data', x => process.stdout.write(x))"], cwd: root, timeoutMs: 1_000, input: "input",
    });
    assert.equal(result.stdout.text, "input");
    await assert.rejects(runtime.execute({ program: "node", args: ["bad\0arg"], cwd: root, timeoutMs: 1_000 }), /INVALID_ARGUMENT/);
  } finally { await runtime.close(); }
});
