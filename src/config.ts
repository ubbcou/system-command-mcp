export const MAX_DEFAULT_TIMEOUT_MS = 600_000;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_STREAM_BYTES = 100 * 1024 * 1024;
export const MAX_ARTIFACT_QUOTA_BYTES = 1024 * 1024 * 1024;
export const MAX_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_CONCURRENT_EXECUTIONS = 4;
export const MAX_CONCURRENT_EXECUTIONS = 1_024;

export interface RuntimeLimitOptions {
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  inlineHeadBytes?: number;
  artifactRetentionMs?: number;
  artifactQuotaBytes?: number;
  artifactMaxStreamBytes?: number;
  maxConcurrentExecutions?: number;
}

const bounded = (value: number | undefined, maximum: number, name: string): void => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > maximum)) throw new Error(`INVALID_RUNTIME_CONFIG: ${name}`);
};

export function validateRuntimeLimits(options: RuntimeLimitOptions): void {
  bounded(options.defaultTimeoutMs, MAX_DEFAULT_TIMEOUT_MS, "defaultTimeoutMs");
  bounded(options.maxOutputBytes, MAX_OUTPUT_BYTES, "maxOutputBytes");
  bounded(options.inlineHeadBytes, options.maxOutputBytes ?? MAX_OUTPUT_BYTES, "inlineHeadBytes");
  bounded(options.artifactRetentionMs, MAX_ARTIFACT_RETENTION_MS, "artifactRetentionMs");
  bounded(options.artifactQuotaBytes, MAX_ARTIFACT_QUOTA_BYTES, "artifactQuotaBytes");
  bounded(options.artifactMaxStreamBytes, MAX_ARTIFACT_STREAM_BYTES, "artifactMaxStreamBytes");
  bounded(options.maxConcurrentExecutions, MAX_CONCURRENT_EXECUTIONS, "maxConcurrentExecutions");
}
