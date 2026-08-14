import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execPath } from "node:process";
import test from "node:test";
import { executeProgram } from "../src/execute.js";

const nodeProgram = { logicalName: "node", executable: execPath, kind: "native" as const };

test("executeProgram passes arguments literally without a shell", async () => {
  const values = ["$HOME", "*.ts", "a && b", "中文 空格"];
  const result = await executeProgram({
    program: nodeProgram,
    args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...values],
    cwd: process.cwd(), timeoutMs: 5_000, maxOutputBytes: 1024,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout.text), values);
});

test("executeProgram keeps only the output tail", async () => {
  const result = await executeProgram({
    program: nodeProgram, args: ["-e", "process.stdout.write('abcdefghij')"],
    cwd: process.cwd(), timeoutMs: 5_000, maxOutputBytes: 4,
  });
  assert.equal(result.stdout.text, "ghij");
  assert.equal(result.stdout.totalBytes, 10);
  assert.equal(result.stdout.truncated, true);
});

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { end(input: string, encoding: string, callback: () => void): void }; killed: boolean; kill(): void } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { end(input: string, encoding: string, callback: () => void): void }; killed: boolean; kill(): void };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end: () => {} });
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

for (const stream of ["stdout", "stderr"] as const) {
  test(`executeProgram rejects and kills on ${stream} errors`, async () => {
    const child = fakeChild();
    const result = executeProgram({
      program: nodeProgram, args: [], cwd: process.cwd(), timeoutMs: 1_000, maxOutputBytes: 1024,
    }, { spawn: (() => child as never) as unknown as NonNullable<Parameters<typeof executeProgram>[1]>["spawn"] });
    const error = new Error(`${stream} failure`);
    child[stream].emit("error", error);
    await assert.rejects(result, error);
    assert.equal(child.killed, true);
  });
}

test("executeProgram rejects and kills on stdin errors", async () => {
  const child = fakeChild();
  const result = executeProgram({
    program: nodeProgram, args: [], cwd: process.cwd(), timeoutMs: 1_000, maxOutputBytes: 1024, input: "input",
  }, { spawn: (() => child as never) as unknown as NonNullable<Parameters<typeof executeProgram>[1]>["spawn"] });
  const error = new Error("stdin failure");
  child.stdin.emit("error", error);
  await assert.rejects(result, error);
  assert.equal(child.killed, true);
});

test("executeProgram reports timeouts", async () => {
  const result = await executeProgram({
    program: nodeProgram, args: ["-e", "setTimeout(() => {}, 10_000)"],
    cwd: process.cwd(), timeoutMs: 30, maxOutputBytes: 1024,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("executeProgram lets exit claim completion before aborting prior to close", async () => {
  const controller = new AbortController();
  const child = new EventEmitter() as EventEmitter & { stdout: undefined; stderr: undefined; stdin: undefined; killed: boolean; kill(): void };
  child.stdout = undefined; child.stderr = undefined; child.stdin = undefined; child.killed = false;
  child.kill = () => { child.killed = true; };
  const result = executeProgram({
    program: nodeProgram, args: [], cwd: process.cwd(), timeoutMs: 1_000, maxOutputBytes: 1024, signal: controller.signal,
  }, { spawn: (() => child as never) as unknown as NonNullable<Parameters<typeof executeProgram>[1]>["spawn"] });
  child.emit("exit", 0, null);
  controller.abort();
  child.emit("close", 0, null);
  const outcome = await result;
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.timedOut, false);
});

test("executeProgram lets a natural exit claim the terminal state before a timeout", async () => {
  const result = await executeProgram({
    program: nodeProgram, args: ["-e", "process.exit(0)"],
    cwd: process.cwd(), timeoutMs: 1_000, maxOutputBytes: 1024,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});
