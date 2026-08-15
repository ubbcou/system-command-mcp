import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export type ArtifactPolicy = "never" | "on-truncation" | "always";
export type ArtifactStatus = { status: "discarded" | "published" | "unavailable"; id?: string };
export type OutputStream = "stdout" | "stderr";
export type OutputEncoding = "utf8" | "base64";
export interface OutputPage { bytes: number; nextOffset: number; eof: boolean; encoding: OutputEncoding; text?: string; base64?: string; lossyUtf8?: boolean; }

const validId = /^[a-f0-9]{32}$/;
export class ArtifactStore {
  constructor(private readonly directory: string, private readonly retentionMs: number, private readonly quotaBytes: number) {}
  async start(): Promise<void> { try { await mkdir(this.directory, { recursive: true, mode: 0o700 }); } catch { return; } for (const name of await readdir(this.directory).catch(() => [] as string[])) if (name.startsWith(".spool-")) await rm(join(this.directory, name), { recursive: true, force: true }).catch(() => {}); await this.cleanup(); }
  async spool(): Promise<ArtifactSpool> { const name = `.spool-${randomBytes(16).toString("hex")}`; const path = join(this.directory, name); await mkdir(path, { mode: 0o700 }); await writeFile(join(path, "stdout"), "", { mode: 0o600 }); await writeFile(join(path, "stderr"), "", { mode: 0o600 }); return new ArtifactSpool(path); }
  async publish(spool: ArtifactSpool): Promise<string> { const id = randomBytes(16).toString("hex"); const target = join(this.directory, id); await this.cleanup(); await writeFile(join(spool.path, "meta.json"), JSON.stringify({ version: 1, publishedAt: Date.now() }), { mode: 0o600 }); await rename(spool.path, target); await this.cleanup(); return id; }
  async discard(spool: ArtifactSpool | undefined): Promise<void> { await spool?.remove(); }
  async read(id: string, stream: OutputStream, offset: number, limit: number, encoding: OutputEncoding): Promise<OutputPage> {
    if (!validId.test(id)) throw new Error("ARTIFACT_NOT_FOUND");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit <= 0 || limit > 1024 * 1024) throw new Error("INVALID_OUTPUT_PAGE");
    const file = join(this.directory, id, stream);
    let bytes: Buffer; try { bytes = await readFile(file); } catch { throw new Error("ARTIFACT_NOT_FOUND"); }
    if (offset > bytes.length) throw new Error("INVALID_OUTPUT_OFFSET");
    const page = bytes.subarray(offset, offset + limit); const eof = offset + page.length === bytes.length;
    if (encoding === "base64") return { bytes: page.length, nextOffset: offset + page.length, eof, encoding, base64: page.toString("base64") };
    let text: string; let lossyUtf8 = false; try { text = new TextDecoder("utf-8", { fatal: true }).decode(page); } catch { text = page.toString("utf8"); lossyUtf8 = true; }
    return { bytes: page.length, nextOffset: offset + page.length, eof, encoding, text, lossyUtf8 };
  }
  private async cleanup(): Promise<void> {
    const now = Date.now(); const entries = await readdir(this.directory, { withFileTypes: true }).catch(() => []); const published: { name: string; time: number; size: number }[] = [];
    for (const entry of entries) if (entry.isDirectory() && validId.test(entry.name)) { const path = join(this.directory, entry.name); const meta = await stat(join(path, "meta.json")).catch(() => undefined); if (!meta) { await rm(path, { recursive: true, force: true }).catch(() => {}); continue; } if (now - meta.mtimeMs > this.retentionMs) { await rm(path, { recursive: true, force: true }).catch(() => {}); continue; } const files = await Promise.all(["stdout", "stderr", "meta.json"].map(x => stat(join(path, x)).catch(() => undefined))); published.push({ name: entry.name, time: meta.mtimeMs, size: files.reduce((n, x) => n + (x?.size ?? 0), 0) }); }
    let total = published.reduce((n, x) => n + x.size, 0); for (const item of published.sort((a, b) => a.time - b.time)) { if (total <= this.quotaBytes) break; await rm(join(this.directory, item.name), { recursive: true, force: true }).catch(() => {}); total -= item.size; }
  }
}
export class ArtifactSpool {
  failed = false;
  constructor(readonly path: string) {}
  async append(stream: OutputStream, chunk: Buffer): Promise<void> { if (this.failed) return; try { const { appendFile } = await import("node:fs/promises"); await appendFile(join(this.path, stream), chunk); } catch { this.failed = true; } }
  async remove(): Promise<void> { await rm(this.path, { recursive: true, force: true }).catch(() => {}); }
}
