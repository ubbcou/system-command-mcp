import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import koffi from "koffi";
import type { ForcedTerminationOutcome } from "./types.js";

const wait = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
const containment = "runner-created process group; descendants that create another session or process group escape containment";
const windowsContainment = "members in the per-request Job Object only; breakaway is disabled, but pre-assignment processes can escape";

export interface LifecycleAdapter {
  terminate(reason: "timeout" | "cancelled", rootClosed: Promise<void>): Promise<ForcedTerminationOutcome>;
  naturalClose(): Promise<ForcedTerminationOutcome | undefined>;
  close(): void;
}

type WindowsApis = {
  CreateJobObjectW: (securityAttributes: unknown, name: unknown) => unknown;
  OpenProcess: (access: number, inheritHandle: boolean, processId: number) => unknown;
  AssignProcessToJobObject: (job: unknown, process: unknown) => boolean;
  TerminateJobObject: (job: unknown, exitCode: number) => boolean;
  CloseHandle: (handle: unknown) => boolean;
  GetLastError: () => number;
  SetInformationJobObject: (job: unknown, class_: number, info: Buffer, length: number) => boolean;
  QueryInformationJobObject: (job: unknown, class_: number, info: Buffer, length: number, returnedLength: unknown) => boolean;
};

export interface LifecycleAdapterOptions {
  platform?: NodeJS.Platform;
  windowsApis?: Partial<WindowsApis>;
  spawnTaskkill?: typeof spawnChild;
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
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { cleaned: false, error: "FINAL_WAIT_EXPIRED" };
      await wait(Math.min(25, remaining));
    }
  };
  return {
    async terminate(reason) {
      const gracefulError = signalGroup("SIGTERM");
      const gracefulRequested = gracefulError === undefined;
      const graceful = await confirmGone(gracePeriodMs);
      if (graceful.cleaned) return { reason, gracefulRequested, forceUsed: false, treeCleaned: true, cleanupError: gracefulError, diagnostics: { adapter: "unix-process-group", containment } };
      const forceError = signalGroup("SIGKILL");
      const forced = await confirmGone(finalWaitMs);
      return { reason, gracefulRequested, forceUsed: true, treeCleaned: forced.cleaned && forceError === undefined, cleanupError: forced.error ?? forceError ?? gracefulError, diagnostics: { adapter: "unix-process-group", containment } };
    },
    async naturalClose() {
      const state = groupGone();
      if (state === true) return undefined;
      const gracefulError = signalGroup("SIGTERM");
      const gracefulRequested = gracefulError === undefined;
      const graceful = await confirmGone(gracePeriodMs);
      if (graceful.cleaned) return { reason: null, gracefulRequested, forceUsed: false, treeCleaned: true, cleanupError: gracefulError, diagnostics: { adapter: "unix-process-group", containment } };
      const forceError = signalGroup("SIGKILL");
      const forced = await confirmGone(finalWaitMs);
      return { reason: null, gracefulRequested, forceUsed: true, treeCleaned: forced.cleaned && forceError === undefined, cleanupError: forced.error ?? forceError ?? gracefulError ?? (typeof state === "string" ? state : undefined), diagnostics: { adapter: "unix-process-group", containment } };
    },
    close() {},
  };
}

const kernel32 = process.platform === "win32" ? koffi.load("kernel32.dll") : undefined;
const nativeWindowsApis: Partial<WindowsApis> = {
  CreateJobObjectW: kernel32?.func("void * __stdcall CreateJobObjectW(void * securityAttributes, const char16_t * name)"),
  OpenProcess: kernel32?.func("void * __stdcall OpenProcess(uint32_t access, bool inheritHandle, uint32_t processId)"),
  AssignProcessToJobObject: kernel32?.func("bool __stdcall AssignProcessToJobObject(void * job, void * process)"),
  TerminateJobObject: kernel32?.func("bool __stdcall TerminateJobObject(void * job, uint32_t exitCode)"),
  CloseHandle: kernel32?.func("bool __stdcall CloseHandle(void * handle)"),
  GetLastError: kernel32?.func("uint32_t __stdcall GetLastError()"),
  SetInformationJobObject: kernel32?.func("bool __stdcall SetInformationJobObject(void * job, uint32_t class_, void * info, uint32_t length)"),
  QueryInformationJobObject: kernel32?.func("bool __stdcall QueryInformationJobObject(void * job, uint32_t class_, void * info, uint32_t length, void * returnedLength)"),
};
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const windowsError = (api: string, getLastError: (() => number) | undefined): string => `${api}: ${getLastError?.() ?? "unavailable"}`;

function windowsLifecycle(child: ChildProcess, finalWaitMs: number, options: LifecycleAdapterOptions): LifecycleAdapter {
  const api = { ...nativeWindowsApis, ...options.windowsApis };
  let job: unknown;
  let processHandle: unknown;
  let closed = false;
  let setupError: string | undefined;
  if (!child.pid || !api.CreateJobObjectW || !api.OpenProcess || !api.AssignProcessToJobObject || !api.GetLastError) setupError = "WINDOWS_SETUP_UNAVAILABLE";
  else {
    job = api.CreateJobObjectW(null, null);
    if (!job) setupError = windowsError("CreateJobObjectW", api.GetLastError);
    else {
      // No BREAKAWAY_OK limit is set. KILL_ON_JOB_CLOSE terminates members if our final Job handle closes.
      const limits = Buffer.alloc(144); limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
      if (!api.SetInformationJobObject?.(job, 9, limits, limits.length)) setupError = windowsError("SetInformationJobObject(KILL_ON_JOB_CLOSE)", api.GetLastError);
      processHandle = setupError ? undefined : api.OpenProcess(0x0101, false, child.pid);
      if (!processHandle) setupError ??= windowsError("OpenProcess", api.GetLastError);
      else if (!api.AssignProcessToJobObject(job, processHandle)) setupError = windowsError("AssignProcessToJobObject", api.GetLastError);
    }
  }
  const fallback = async (): Promise<string> => {
    if (!child.pid) return "taskkill unavailable: root PID missing";
    const taskkill = options.spawnTaskkill ?? spawnChild;
    return new Promise(resolve => {
      let done = false;
      const finish = (value: string): void => { if (!done) { done = true; resolve(value); } };
      let process: ReturnType<typeof spawnChild>;
      try { process = taskkill("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { return finish(`taskkill spawn error: ${String(error)}`); }
      let stdout = ""; let stderr = "";
      process.stdout?.on("data", value => { stdout += value; }); process.stderr?.on("data", value => { stderr += value; });
      process.once("close", code => finish(`taskkill /T /F observed exit=${code}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}; exit code is diagnostic only`));
      process.once("error", error => finish(`taskkill error: ${String(error)}`));
      setTimeout(() => { try { process.kill(); } catch { /* best effort */ } finish("taskkill fallback timed out"); }, finalWaitMs).unref();
    });
  };
  const activeMembers = (): { active?: number; cleanupError?: string } => {
    if (!job || !api.QueryInformationJobObject) return { cleanupError: "JOB_ACCOUNTING_QUERY_UNAVAILABLE" };
    const info = Buffer.alloc(48);
    if (!api.QueryInformationJobObject(job, 1, info, info.length, null)) return { cleanupError: "JOB_ACCOUNTING_QUERY_FAILED" };
    return { active: info.readUInt32LE(40) };
  };
  const accounting = async (): Promise<{ active?: number; cleanupError?: string }> => {
    const deadline = Date.now() + finalWaitMs;
    for (;;) {
      const status = activeMembers();
      if (status.cleanupError || status.active === 0) return status;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...status, cleanupError: "JOB_ACTIVE_PROCESSES_REMAIN" };
      await wait(Math.min(25, remaining));
    }
  };
  return {
    async terminate(reason, rootClosed) {
      // Windows has no generic graceful tree-stop request. Force immediately; do not spend a fake grace period.
      const gracefulRequested = false;
      const rootExit = Promise.race([rootClosed.then(() => true), wait(finalWaitMs).then(() => false)]);
      if (setupError || !job || !api.TerminateJobObject) {
        const fallbackDiagnostic = await fallback();
        const rootExited = await rootExit;
        return { reason, gracefulRequested, forceUsed: true, treeCleaned: false, cleanupError: setupError ?? (rootExited ? "TASKKILL_FALLBACK_UNCONFIRMED" : "FINAL_WAIT_EXPIRED"), diagnostics: { adapter: "windows-taskkill-fallback", containment: windowsContainment, containmentRace: "pre-assignment-unverifiable", fallback: fallbackDiagnostic } };
      }
      if (!api.TerminateJobObject(job, 137)) {
        const error = windowsError("TerminateJobObject", api.GetLastError);
        const fallbackDiagnostic = await fallback();
        await rootExit;
        return { reason, gracefulRequested, forceUsed: true, treeCleaned: false, cleanupError: error, diagnostics: { adapter: "windows-job-object", containment: windowsContainment, containmentRace: "pre-assignment-unverifiable", fallback: fallbackDiagnostic } };
      }
      const rootExited = await rootExit;
      const status = await accounting();
      return { reason, gracefulRequested, forceUsed: true, treeCleaned: false, cleanupError: !rootExited ? "FINAL_WAIT_EXPIRED" : status.cleanupError, diagnostics: { adapter: "windows-job-object", containment: windowsContainment, containmentRace: "pre-assignment-unverifiable", activeProcesses: status.active } };
    },
    async naturalClose() {
      const status = activeMembers();
      const diagnostics = { adapter: "windows-job-object", containment: windowsContainment, containmentRace: "pre-assignment-unverifiable" };
      // Closing this Job may force members through KILL_ON_JOB_CLOSE, so a failed query is still forced and unverified.
      if (status.cleanupError) return { reason: null, gracefulRequested: false, forceUsed: true, treeCleaned: false, cleanupError: status.cleanupError, diagnostics };
      if (status.active === 0) return undefined;
      const terminated = !!api.TerminateJobObject?.(job, 137);
      const error = terminated ? undefined : windowsError("TerminateJobObject", api.GetLastError);
      const settled = await accounting();
      return { reason: null, gracefulRequested: false, forceUsed: true, treeCleaned: false, cleanupError: settled.cleanupError ?? error, diagnostics: { ...diagnostics, activeProcesses: settled.active } };
    },
    close() { if (closed) return; closed = true; if (processHandle) api.CloseHandle?.(processHandle); if (job) api.CloseHandle?.(job); processHandle = undefined; job = undefined; },
  };
}

export function createLifecycleAdapter(child: ChildProcess, gracePeriodMs: number, finalWaitMs: number, options: LifecycleAdapterOptions = {}): LifecycleAdapter {
  return (options.platform ?? process.platform) === "win32" ? windowsLifecycle(child, finalWaitMs, options) : unixLifecycle(child, gracePeriodMs, finalWaitMs);
}
