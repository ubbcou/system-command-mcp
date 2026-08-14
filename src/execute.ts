import spawn from "cross-spawn";
import { createLifecycleAdapter } from "./lifecycle.js";
import type { ExecuteRequest, ExecuteResult, StreamOutput, ForcedTerminationOutcome, TerminationOutcome } from "./types.js";

class TailBuffer {
  private chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;
  constructor(private readonly limit: number) {}
  append(chunk: Buffer): void {
    this.totalBytes += chunk.length; this.chunks.push(chunk); this.retainedBytes += chunk.length;
    while (this.retainedBytes > this.limit && this.chunks.length > 0) {
      const overflow = this.retainedBytes - this.limit; const first = this.chunks[0]!;
      if (first.length <= overflow) { this.chunks.shift(); this.retainedBytes -= first.length; }
      else { this.chunks[0] = first.subarray(overflow); this.retainedBytes -= overflow; }
    }
  }
  result(): StreamOutput { return { text: Buffer.concat(this.chunks).toString("utf8"), truncated: this.totalBytes > this.retainedBytes, totalBytes: this.totalBytes }; }
}

export async function executeProgram(request: ExecuteRequest, options: { spawn?: typeof spawn } = {}): Promise<ExecuteResult> {
  const spawnProcess = options.spawn ?? spawn;
  const stdout = new TailBuffer(request.maxOutputBytes);
  const stderr = new TailBuffer(request.maxOutputBytes);
  let reason: "timeout" | "cancelled" | undefined;
  let settled = false;
  return new Promise<ExecuteResult>((resolve, reject) => {
    const child = spawnProcess(request.program.executable, [...request.args], {
      cwd: request.cwd, env: request.environment, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const adapter = createLifecycleAdapter(child, request.gracePeriodMs ?? 2_000, request.finalTerminationWaitMs ?? 5_000);
    let exited = false;
    let termination: Promise<ForcedTerminationOutcome> | undefined;
    let resolveRootExit!: () => void;
    const rootClosed = new Promise<void>(resolveRoot => { resolveRootExit = resolveRoot; });
    const onStdoutData = (chunk: Buffer): void => stdout.append(chunk);
    const onStderrData = (chunk: Buffer): void => stderr.append(chunk);
    child.stdout?.on("data", onStdoutData); child.stderr?.on("data", onStderrData);
    const cleanup = (): void => { clearTimeout(timer); request.signal?.removeEventListener("abort", onAbort); child.stdout?.removeListener("data", onStdoutData); child.stderr?.removeListener("data", onStderrData); adapter.close(); };
    const settleRejected = async (error: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      reason ??= "cancelled";
      termination ??= adapter.terminate(reason, rootClosed);
      try { await termination; } catch { /* preserve the original child/stdio failure */ }
      cleanup();
      reject(error);
    };
    const internalFailure = (error: Error): void => { void settleRejected(error); };
    const claimTermination = (claimed: "timeout" | "cancelled"): void => {
      if (reason || exited || settled) return;
      reason = claimed;
      termination = adapter.terminate(claimed, rootClosed);
      void termination.then(outcome => {
        // A child close event can be lost after a stream or process failure. The bounded adapter settlement owns the terminal result.
        if (settled) return;
        settled = true; cleanup();
        resolve({ exitCode: null, signal: null, stdout: stdout.result(), stderr: stderr.result(), timedOut: reason === "timeout", cancelled: reason === "cancelled", termination: outcome });
      }, error => { void settleRejected(error instanceof Error ? error : new Error(String(error))); });
    };
    const onAbort = (): void => claimTermination("cancelled");
    const timer = setTimeout(() => claimTermination("timeout"), request.timeoutMs); timer.unref();
    request.signal?.addEventListener("abort", onAbort, { once: true }); if (request.signal?.aborted) onAbort();
    child.once("exit", () => { exited = true; resolveRootExit(); });
    child.on("error", internalFailure); child.stdout?.on("error", internalFailure); child.stderr?.on("error", internalFailure);
    if (request.input !== undefined && child.stdin) { child.stdin.on("error", internalFailure); child.stdin.end(request.input, "utf8", () => {}); }
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      void (async () => {
        try {
          const outcome: TerminationOutcome = termination ? await termination : { reason: null, gracefulRequested: false, forceUsed: false, treeCleaned: null, diagnostics: { adapter: "natural" } };
          if (settled) return;
          settled = true; cleanup();
          resolve({ exitCode, signal, stdout: stdout.result(), stderr: stderr.result(), timedOut: reason === "timeout", cancelled: reason === "cancelled", termination: outcome });
        } catch (error) { await settleRejected(error instanceof Error ? error : new Error(String(error))); }
      })();
    });
  });
}
