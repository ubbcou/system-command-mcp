import { isAbsolute, relative } from "node:path";

/** True when a canonical path is the root itself or a descendant. */
export function isWithinRoot(root: string, candidate: string): boolean {
  const part = relative(root, candidate);
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
}
