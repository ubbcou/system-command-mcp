import spawn from "cross-spawn";
import type { ExecuteRequest, ExecuteResult, StreamOutput } from "./types.js";

class TailBuffer {
  private chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;
  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    this.chunks.push(chunk);
    this.retainedBytes += chunk.length;
    while (this.retainedBytes > this.limit && this.chunks.length > 0) {
      const overflow = this.retainedBytes - this.limit;
      const first = this.chunks[0];
      if (!first) break;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.retainedBytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.retainedBytes -= overflow;
      }
    }
  }

  result(): StreamOutput {
    return {
      text: Buffer.concat(this.chunks).toString("utf8"),
      truncated: this.totalBytes > this.retainedBytes,
      totalBytes: this.totalBytes,
    };
  }
}

export async function executeProgram(request: ExecuteRequest): Promise<ExecuteResult> {
  const stdout = new TailBuffer(request.maxOutputBytes);
  const stderr = new TailBuffer(request.maxOutputBytes);
  let termination: "timeout" | "cancelled" | undefined;

  return new Promise<ExecuteResult>((resolve, reject) => {
    const child = spawn(request.program.executable, [...request.args], {
      cwd: request.cwd, env: request.environment, shell: false, windowsHide: true, stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    if (request.input !== undefined) child.stdin?.end(request.input, "utf8");
    const stop = (): void => { if (!child.killed) child.kill(); };
    const timer = setTimeout(() => { if (!termination) { termination = "timeout"; stop(); } }, request.timeoutMs);
    timer.unref();
    const onAbort = (): void => { if (!termination) { termination = "cancelled"; stop(); } };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, signal, stdout: stdout.result(), stderr: stderr.result(), timedOut: termination === "timeout", cancelled: termination === "cancelled" });
    });
  });
}
