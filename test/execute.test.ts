import assert from "node:assert/strict";
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

test("executeProgram rejects stdin pipe errors", async () => {
  await assert.rejects(executeProgram({
    program: nodeProgram, args: ["-e", "process.stdin.destroy()"], cwd: process.cwd(), timeoutMs: 5_000, maxOutputBytes: 1024, input: "x".repeat(1024 * 1024),
  }));
});

test("executeProgram reports timeouts", async () => {
  const result = await executeProgram({
    program: nodeProgram, args: ["-e", "setTimeout(() => {}, 10_000)"],
    cwd: process.cwd(), timeoutMs: 30, maxOutputBytes: 1024,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("executeProgram does not let a late abort relabel a natural exit", async () => {
  const controller = new AbortController();
  const result = await executeProgram({
    program: nodeProgram, args: ["-e", "process.exit(0)"],
    cwd: process.cwd(), timeoutMs: 1_000, maxOutputBytes: 1024, signal: controller.signal,
  });
  controller.abort();
  assert.equal(result.exitCode, 0);
  assert.equal(result.cancelled, false);
  assert.equal(result.timedOut, false);
});

test("executeProgram lets a natural exit claim the terminal state before a timeout", async () => {
  const result = await executeProgram({
    program: nodeProgram, args: ["-e", "process.exit(0)"],
    cwd: process.cwd(), timeoutMs: 1_000, maxOutputBytes: 1024,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});
