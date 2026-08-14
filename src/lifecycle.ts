import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import koffi from "koffi";
import type { TerminationOutcome } from "./types.js";

const wait = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

export interface LifecycleAdapter {
  terminate(reason: "timeout" | "cancelled", rootClosed: Promise<void>): Promise<TerminationOutcome>;
  close(): void;
}

function unixLifecycle(child: ChildProcess, gracePeriodMs: number, finalWaitMs: number): LifecycleAdapter {
  const pid = child.pid;
  const signalGroup = (signal: NodeJS.Signals): string | undefined => {
    if (!pid) return "process group has no root PID";
    try { process.kill(-pid, signal); return undefined; }
    catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === "ESRCH" ? undefined : `process.kill(${signal}): ${code ?? String(error)}`; }
  };
  const groupGone = (): boolean | string => {
    if (!pid) return "process group has no root PID";
    try { process.kill(-pid, 0); return false; }
    catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === "ESRCH" ? true : `process.kill(0): ${code ?? String(error)}`; }
  };
  const confirmGone = async (deadlineMs: number): Promise<{ cleaned: boolean; error?: string }> => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const state = groupGone();
      if (state === true) return { cleaned: true };
      if (typeof state === "string") return { cleaned: false, error: state };
      if (Date.now() >= deadline) return { cleaned: false };
      await wait(Math.min(25, deadline - Date.now()));
    }
  };
  return {
    async terminate(reason) {
      const gracefulError = signalGroup("SIGTERM");
      const gracefulRequested = gracefulError === undefined;
      const graceful = await confirmGone(gracePeriodMs);
      if (graceful.cleaned) return { reason, gracefulRequested, forceUsed: false, treeCleaned: true, cleanupError: gracefulError, diagnostics: { adapter: "unix-process-group", containment: "runner-created process group; descendants that create another session or process group escape containment" } };
      const forceError = signalGroup("SIGKILL");
      const forced = await confirmGone(finalWaitMs);
      return { reason, gracefulRequested, forceUsed: true, treeCleaned: forced.cleaned && forceError === undefined, cleanupError: forced.error ?? forceError ?? gracefulError, diagnostics: { adapter: "unix-process-group", containment: "runner-created process group; descendants that create another session or process group escape containment" } };
    },
    close() {},
  };
}

const kernel32 = process.platform === "win32" ? koffi.load("kernel32.dll") : undefined;
const CreateJobObjectW = kernel32?.func("void * __stdcall CreateJobObjectW(void * securityAttributes, const char16_t * name)");
const OpenProcess = kernel32?.func("void * __stdcall OpenProcess(uint32_t access, bool inheritHandle, uint32_t processId)");
const AssignProcessToJobObject = kernel32?.func("bool __stdcall AssignProcessToJobObject(void * job, void * process)");
const TerminateJobObject = kernel32?.func("bool __stdcall TerminateJobObject(void * job, uint32_t exitCode)");
const CloseHandle = kernel32?.func("bool __stdcall CloseHandle(void * handle)");
const GetLastError = kernel32?.func("uint32_t __stdcall GetLastError()");
const SetInformationJobObject = kernel32?.func("bool __stdcall SetInformationJobObject(void * job, uint32_t class_, void * info, uint32_t length)");
const QueryInformationJobObject = kernel32?.func("bool __stdcall QueryInformationJobObject(void * job, uint32_t class_, void * info, uint32_t length, void * returnedLength)");
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

function windowsLifecycle(child: ChildProcess, gracePeriodMs: number, finalWaitMs: number): LifecycleAdapter {
  let job: unknown;
  let processHandle: unknown;
  let setupError: string | undefined;
  if (!child.pid || !CreateJobObjectW || !OpenProcess || !AssignProcessToJobObject || !GetLastError) setupError = "Job Object APIs unavailable";
  else {
    job = CreateJobObjectW(null, null);
    if (!job) setupError = `CreateJobObjectW: ${GetLastError()}`;
    else {
      // No BREAKAWAY_OK limit is set: Job members cannot intentionally break away through this Job.
      // KILL_ON_JOB_CLOSE makes an unexpected runtime crash close the final handle and terminate Job members.
      const limits = Buffer.alloc(144); limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
      if (!SetInformationJobObject?.(job, 9, limits, limits.length)) setupError = `SetInformationJobObject(KILL_ON_JOB_CLOSE): ${GetLastError()}`;
      processHandle = setupError ? undefined : OpenProcess(0x0101, false, child.pid);
      if (!processHandle) setupError = `OpenProcess: ${GetLastError()}`;
      else if (!AssignProcessToJobObject(job, processHandle)) setupError = `AssignProcessToJobObject: ${GetLastError()}`;
    }
  }
  const fallback = async (): Promise<string> => {
    if (!child.pid) return "taskkill unavailable: root PID missing";
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const taskkill = spawnChild("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      taskkill.stdout.on("data", value => { stdout += value; }); taskkill.stderr.on("data", value => { stderr += value; });
      taskkill.once("close", code => resolve({ code, stdout, stderr }));
      taskkill.once("error", error => resolve({ code: null, stdout, stderr: String(error) }));
    });
    return `taskkill /T /F observed exit=${result.code}; stdout=${JSON.stringify(result.stdout)}; stderr=${JSON.stringify(result.stderr)}; exit code is diagnostic only`;
  };
  return {
    async terminate(reason, rootClosed) {
      // Windows child.kill() is abrupt, not a graceful tree-stop operation; do not call it here.
      // Job Objects have no portable graceful-stop API, so this is only a cooperative grace window.
      const gracefulRequested = false;
      await Promise.race([rootClosed, wait(gracePeriodMs)]);
      if (setupError || !job || !TerminateJobObject || !GetLastError) {
        const fallbackDiagnostic = await fallback();
        await Promise.race([rootClosed, wait(finalWaitMs)]);
        return { reason, gracefulRequested, forceUsed: true, treeCleaned: false, cleanupError: setupError, diagnostics: { adapter: "windows-taskkill-fallback", containment: "unconfirmed fallback traversal; no durable containment membership", fallback: fallbackDiagnostic } };
      }
      if (!TerminateJobObject(job, 137)) {
        const error = `TerminateJobObject: ${GetLastError()}`;
        const fallbackDiagnostic = await fallback();
        await Promise.race([rootClosed, wait(finalWaitMs)]);
        return { reason, gracefulRequested, forceUsed: true, treeCleaned: false, cleanupError: error, diagnostics: { adapter: "windows-job-object", containment: "members in the per-request Job Object only; breakaway is disabled, but pre-assignment processes can escape", fallback: fallbackDiagnostic } };
      }
      const rootExited = await Promise.race([rootClosed.then(() => true), wait(finalWaitMs).then(() => false)]);
      const accounting = Buffer.alloc(48);
      const queried = !!QueryInformationJobObject?.(job, 1, accounting, accounting.length, null);
      const activeProcesses = queried ? accounting.readUInt32LE(40) : undefined;
      return { reason, gracefulRequested, forceUsed: true, treeCleaned: rootExited && activeProcesses === 0, cleanupError: queried ? undefined : `QueryInformationJobObject: ${GetLastError?.() ?? "unavailable"}`, diagnostics: { adapter: "windows-job-object", containment: "members in the per-request Job Object only; breakaway is disabled, but pre-assignment processes can escape", activeProcesses } };
    },
    close() { if (processHandle) CloseHandle?.(processHandle); if (job) CloseHandle?.(job); },
  };
}

export function createLifecycleAdapter(child: ChildProcess, gracePeriodMs: number, finalWaitMs: number): LifecycleAdapter {
  return process.platform === "win32" ? windowsLifecycle(child, gracePeriodMs, finalWaitMs) : unixLifecycle(child, gracePeriodMs, finalWaitMs);
}
