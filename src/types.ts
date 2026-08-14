export type ProgramKind = "native" | "cmd-script";
export type ArgumentSemantics = "literal" | "cmd-reparsed";

export interface RegisteredProgram {
  logicalName: string;
  executable: string;
  declaredCandidate: string;
  kind: ProgramKind;
  /** Native executables receive literal argv; cmd scripts are reparsed by cmd.exe. */
  argumentSemantics: ArgumentSemantics;
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
  gracePeriodMs?: number;
  finalTerminationWaitMs?: number;
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

export interface NaturalTerminationOutcome {
  reason: null;
  gracefulRequested: false;
  forceUsed: false;
  treeCleaned: null;
  diagnostics: { adapter: "natural" };
}

export interface ForcedTerminationOutcome {
  reason: "timeout" | "cancelled" | null;
  gracefulRequested: boolean;
  forceUsed: boolean;
  treeCleaned: boolean;
  cleanupError?: string;
  diagnostics: Record<string, unknown>;
}

export type TerminationOutcome = NaturalTerminationOutcome | ForcedTerminationOutcome;

export interface ExecuteResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: StreamOutput;
  stderr: StreamOutput;
  timedOut: boolean;
  cancelled: boolean;
  termination: TerminationOutcome | null;
}
