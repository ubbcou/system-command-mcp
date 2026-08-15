import { isAbsolute } from "node:path";

export interface ManifestProbe { args?: string[]; acceptedExitCodes?: number[]; cwd?: string; }

const LOGICAL_PROGRAM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const object = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_MANIFEST: ${path} must be an object`);
  return value as Record<string, unknown>;
};

/** Parse diagnostic-only probe declarations; normal runtime does not execute them. */
export function parseManifestProbes(value: unknown): Record<string, ManifestProbe> {
  const root = object(value, "manifest");
  if (root.probes === undefined) return {};
  const probes = object(root.probes, "manifest.probes");
  return Object.fromEntries(Object.entries(probes).map(([program, raw]) => {
    if (!LOGICAL_PROGRAM_NAME.test(program)) throw new Error(`INVALID_MANIFEST: manifest.probes.${program}`);
    const probe = object(raw, `manifest.probes.${program}`);
    for (const field of Object.keys(probe)) if (!["args", "acceptedExitCodes", "cwd"].includes(field)) throw new Error(`INVALID_MANIFEST: unknown field manifest.probes.${program}.${field}`);
    if (probe.args !== undefined && (!Array.isArray(probe.args) || !probe.args.every(value => typeof value === "string"))) throw new Error(`INVALID_MANIFEST: manifest.probes.${program}.args`);
    if (probe.acceptedExitCodes !== undefined && (!Array.isArray(probe.acceptedExitCodes) || !probe.acceptedExitCodes.every(value => Number.isSafeInteger(value)))) throw new Error(`INVALID_MANIFEST: manifest.probes.${program}.acceptedExitCodes`);
    if (probe.cwd !== undefined && (typeof probe.cwd !== "string" || !isAbsolute(probe.cwd))) throw new Error(`INVALID_MANIFEST: manifest.probes.${program}.cwd`);
    return [program, { args: probe.args as string[] | undefined, acceptedExitCodes: probe.acceptedExitCodes as number[] | undefined, cwd: probe.cwd as string | undefined }];
  }));
}
