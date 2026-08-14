import assert from "node:assert/strict";
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

test("Configured Mode requires Core Programs while Optional Programs may be absent", async () => {
  await assert.rejects(createCommandRuntime({
    roots: [root], manifest: manifest({ missing: { candidates: ["definitely-missing"], required: true } }),
  }), /CORE_PROGRAM_UNAVAILABLE/);
  const runtime = await createCommandRuntime({
    roots: [root], manifest: manifest({ missing: { candidates: ["definitely-missing"], required: false } }),
  });
  try {
    assert.equal((await runtime.inspectEnvironment()).programs.missing, undefined);
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
