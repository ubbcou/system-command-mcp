export type ProgramKind = "native" | "cmd-script";
export type ArgumentSemantics = "literal" | "cmd-reparsed";

/** A concrete executable and version available for a dynamically resolved Logical Program. */
export interface ProgramVariant { version: string; executable: string; }
/** The immutable startup snapshot of Program Variants available to a Registered Program. */
export interface ProgramVariantSet { kind: "node-project"; variants: readonly ProgramVariant[]; fallbackExecutable: string; }

export interface RegisteredProgram {
  logicalName: string;
  /** Static fallback executable selected from the Program Manifest at startup. */
  executable: string;
  /** The Manifest Program Candidate that selected the static fallback executable. */
  declaredCandidate: string;
  kind: ProgramKind;
  /** Native executables receive literal argv; cmd scripts are reparsed by cmd.exe. */
  argumentSemantics: ArgumentSemantics;
  /** Optional immutable startup variants; a request can select one without changing this registration. */
  variantSet?: ProgramVariantSet;
}

/** The actual executable selected for one Execution Request. */
export interface ProgramSelection {
  logicalName: string;
  executable: string;
  version?: string;
  /** Requirement read from an authorized project's declaration for this request only. */
  requirement?: string;
  /** Declaration kind, not its path. */
  source?: string;
}

export interface EnvironmentSnapshot {
  platform: NodeJS.Platform;
  arch: string;
  cwd: string;
  /** Registered Programs, including any immutable Program Variant Sets. */
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
  inlineHeadBytes?: number;
  input?: string;
  environment?: NodeJS.ProcessEnv;
  onOutput?: (stream: "stdout" | "stderr", chunk: Buffer) => void | Promise<void>;
}

export interface StreamOutput {
  text: string;
  truncated: boolean;
  totalBytes: number;
  omittedBytes: number;
  lossyUtf8: boolean;
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
  programSelection?: ProgramSelection;
}
