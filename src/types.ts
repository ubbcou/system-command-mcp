export type ProgramKind = "native" | "cmd-script";

export interface RegisteredProgram {
  logicalName: string;
  executable: string;
  kind: ProgramKind;
}

export interface EnvironmentSnapshot {
  platform: NodeJS.Platform;
  arch: string;
  cwd: string;
  programs: Record<string, RegisteredProgram>;
}

export interface ExecuteRequest {
  program: RegisteredProgram;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes: number;
  input?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface StreamOutput {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

export interface ExecuteResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: StreamOutput;
  stderr: StreamOutput;
  timedOut: boolean;
  cancelled: boolean;
}
