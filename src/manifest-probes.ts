export interface ManifestProbe { args?: string[]; acceptedExitCodes?: number[]; }

const object = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`INVALID_MANIFEST: ${path} must be an object`);
  return value as Record<string, unknown>;
};

/** Parse diagnostic-only probe declarations; normal runtime never imports this module. */
export function parseManifestProbes(value: unknown): Record<string, ManifestProbe> {
  const root = object(value, "manifest");
  if (root.probes === undefined) return {};
  const probes = object(root.probes, "manifest.probes");
  return Object.fromEntries(Object.entries(probes).map(([program, raw]) => {
    const probe = object(raw, `manifest.probes.${program}`);
    for (const field of Object.keys(probe)) if (field !== "args" && field !== "acceptedExitCodes") throw new Error(`INVALID_MANIFEST: unknown field manifest.probes.${program}.${field}`);
    if (probe.args !== undefined && (!Array.isArray(probe.args) || !probe.args.every(value => typeof value === "string"))) throw new Error(`INVALID_MANIFEST: manifest.probes.${program}.args`);
    if (probe.acceptedExitCodes !== undefined && (!Array.isArray(probe.acceptedExitCodes) || !probe.acceptedExitCodes.every(value => Number.isSafeInteger(value)))) throw new Error(`INVALID_MANIFEST: manifest.probes.${program}.acceptedExitCodes`);
    return [program, { args: probe.args as string[] | undefined, acceptedExitCodes: probe.acceptedExitCodes as number[] | undefined }];
  }));
}
