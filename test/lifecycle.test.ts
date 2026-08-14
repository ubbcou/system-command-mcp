import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createLifecycleAdapter } from "../src/lifecycle.js";

function child(pid = 123): EventEmitter & { pid: number } { return Object.assign(new EventEmitter(), { pid }); }

const rootClosed = Promise.resolve();

test("Windows lifecycle preserves exact setup API error and configures kill on close", async () => {
  const calls: string[] = [];
  const adapter = createLifecycleAdapter(child() as never, 500, 20, {
    platform: "win32",
    windowsApis: {
      CreateJobObjectW: () => "job",
      SetInformationJobObject: (_job, _class, limits) => { calls.push(`limits:${limits.readUInt32LE(16)}`); return true; },
      OpenProcess: () => "process",
      AssignProcessToJobObject: () => false,
      GetLastError: () => 5,
      CloseHandle: () => true,
    },
    spawnTaskkill: (() => { const result = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): void }; result.stdout = new EventEmitter(); result.stderr = new EventEmitter(); queueMicrotask(() => result.emit("close", 0)); result.kill = () => {}; return result as never; }) as never,
  });
  const outcome = await adapter.terminate("timeout", rootClosed);
  assert.deepEqual(calls, ["limits:8192"]);
  assert.equal(outcome.cleanupError, "AssignProcessToJobObject: 5");
  assert.equal(outcome.treeCleaned, false);
  assert.equal(outcome.gracefulRequested, false);
  assert.equal(outcome.diagnostics.containmentRace, "pre-assignment-unverifiable");
  adapter.close(); adapter.close();
});

test("Windows Job accounting zero still never reports tree clean", async () => {
  let queries = 0;
  const adapter = createLifecycleAdapter(child() as never, 500, 20, {
    platform: "win32",
    windowsApis: {
      CreateJobObjectW: () => "job", SetInformationJobObject: () => true, OpenProcess: () => "process", AssignProcessToJobObject: () => true,
      TerminateJobObject: () => true, GetLastError: () => 123, CloseHandle: () => true,
      QueryInformationJobObject: (_job, _class, info) => { queries++; info.writeUInt32LE(0, 40); return true; },
    },
  });
  const outcome = await adapter.terminate("cancelled", rootClosed);
  assert.equal(queries, 1);
  assert.equal(outcome.treeCleaned, false);
  assert.equal(outcome.cleanupError, undefined);
  assert.equal(outcome.diagnostics.containmentRace, "pre-assignment-unverifiable");
  adapter.close();
});

test("Windows lifecycle bounds failed Job termination fallback", async () => {
  const adapter = createLifecycleAdapter(child() as never, 500, 15, {
    platform: "win32",
    windowsApis: {
      CreateJobObjectW: () => "job", SetInformationJobObject: () => true, OpenProcess: () => "process", AssignProcessToJobObject: () => true,
      TerminateJobObject: () => false, GetLastError: () => 87, CloseHandle: () => true,
    },
    spawnTaskkill: (() => { const result = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): void }; result.stdout = new EventEmitter(); result.stderr = new EventEmitter(); result.kill = () => {}; return result as never; }) as never,
  });
  const started = Date.now();
  const outcome = await adapter.terminate("timeout", rootClosed);
  assert.ok(Date.now() - started < 200);
  assert.equal(outcome.cleanupError, "TerminateJobObject: 87");
  assert.match(String(outcome.diagnostics.fallback), /timed out/);
  adapter.close();
});
