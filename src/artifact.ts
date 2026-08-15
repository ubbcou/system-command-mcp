import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export type ArtifactPolicy = "never" | "on-truncation" | "always";
export type ArtifactStatus = { status: "not-requested" | "discarded" | "published" | "unavailable"; id?: string };
export type OutputStream = "stdout" | "stderr";
export type OutputEncoding = "utf8" | "base64";
export interface OutputPage { bytes: number; nextOffset: number; eof: boolean; encoding: OutputEncoding; text?: string; base64?: string; lossyUtf8?: boolean; }

const validId = /^[a-f0-9]{32}$/;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5_000;
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
type Metadata = { version: 1; state: "published"; publishedAt: number; stdoutBytes: number; stderrBytes: number };
type Owner = { runtimeId: string; token: string; leaseUntil: number };

export class ArtifactStore {
  private readonly runtimeId = randomBytes(16).toString("hex");
  private readonly spools = new Set<ArtifactSpool>();
  private heartbeat: NodeJS.Timeout | undefined;
  private closed = false;
  private unavailable = false;
  constructor(private readonly directory: string, private readonly retentionMs: number, private readonly quotaBytes: number, private readonly maxStreamBytes = 100 * 1024 * 1024) {}
  async start(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.withLock(async () => { await this.recover(); await this.cleanup(0); });
      this.heartbeat = setInterval(() => { void this.touchSpools(); }, Math.max(1_000, Math.floor(LOCK_STALE_MS / 3)));
      this.heartbeat.unref();
    } catch { this.unavailable = true; }
  }
  async spool(): Promise<ArtifactSpool> {
    if (this.closed || this.unavailable) throw new Error("ARTIFACT_UNAVAILABLE");
    const name = `.spool-${this.runtimeId}-${randomBytes(16).toString("hex")}`;
    const path = join(this.directory, name);
    const staging = `${path}.new`;
    await mkdir(staging, { mode: 0o700 });
    try {
      await writeFile(join(staging, "owner.json"), JSON.stringify({ runtimeId: this.runtimeId, leaseUntil: Date.now() + LOCK_STALE_MS }), { mode: 0o600 });
      await writeFile(join(staging, "stdout"), "", { mode: 0o600 });
      await writeFile(join(staging, "stderr"), "", { mode: 0o600 });
      await rename(staging, path);
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
    const spool = new ArtifactSpool(path, this.maxStreamBytes, () => this.spools.delete(spool));
    this.spools.add(spool);
    return spool;
  }
  async publish(spool: ArtifactSpool): Promise<string> {
    if (this.closed || this.unavailable || spool.failed) throw new Error("ARTIFACT_UNAVAILABLE");
    await spool.finish();
    if (this.closed || this.unavailable || spool.failed) throw new Error("ARTIFACT_UNAVAILABLE");
    const id = randomBytes(16).toString("hex");
    const target = join(this.directory, id);
    try {
      await this.withLock(async () => {
        if (this.closed || this.unavailable || spool.failed) throw new Error("ARTIFACT_UNAVAILABLE");
        const size = spool.stdoutBytes + spool.stderrBytes;
        if (size > this.quotaBytes) throw new Error("ARTIFACT_QUOTA");
        await this.cleanup(size);
        if (this.closed || this.unavailable || spool.failed) throw new Error("ARTIFACT_UNAVAILABLE");
        if (await this.publishedSize() + size > this.quotaBytes) throw new Error("ARTIFACT_QUOTA");
        const meta: Metadata = { version: 1, state: "published", publishedAt: Date.now(), stdoutBytes: spool.stdoutBytes, stderrBytes: spool.stderrBytes };
        await writeFile(join(spool.path, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
        await rm(join(spool.path, "owner.json"), { force: true });
        if (this.closed || this.unavailable || spool.failed) throw new Error("ARTIFACT_UNAVAILABLE");
        await rename(spool.path, target);
        if (this.closed || this.unavailable) { await rm(target, { recursive: true, force: true }); throw new Error("ARTIFACT_UNAVAILABLE"); }
        this.spools.delete(spool);
      });
      return id;
    } catch (error) { await spool.remove(); throw error; }
  }
  async discard(spool: ArtifactSpool | undefined): Promise<void> { await spool?.remove(); }
  async close(): Promise<void> { this.closed = true; if (this.heartbeat) clearInterval(this.heartbeat); await Promise.all([...this.spools].map(spool => spool.remove())); }
  async read(id: string, stream: OutputStream, offset: number, limit: number, encoding: OutputEncoding): Promise<OutputPage> {
    if (!validId.test(id)) throw new Error("ARTIFACT_NOT_FOUND");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit <= 0 || limit > 1024 * 1024) throw new Error("INVALID_OUTPUT_PAGE");
    const path = join(this.directory, id);
    const meta = await this.validMeta(path);
    const total = meta?.[stream === "stdout" ? "stdoutBytes" : "stderrBytes"];
    if (total === undefined) throw new Error("ARTIFACT_NOT_FOUND");
    if (offset > total) throw new Error("INVALID_OUTPUT_OFFSET");
    const handle = await open(join(path, stream), "r").catch(() => undefined);
    if (!handle) throw new Error("ARTIFACT_NOT_FOUND");
    let page: Buffer;
    try {
      if ((await handle.stat()).size !== total) throw new Error();
      page = Buffer.alloc(Math.min(limit, total - offset));
      const { bytesRead } = await handle.read(page, 0, page.length, offset);
      if (bytesRead !== page.length) throw new Error();
    } catch { throw new Error("ARTIFACT_NOT_FOUND"); } finally { await handle.close().catch(() => {}); }
    const eof = offset + page.length === total;
    if (encoding === "base64") return { bytes: page.length, nextOffset: offset + page.length, eof, encoding, base64: page.toString("base64") };
    let text: string; let lossyUtf8 = false;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(page); } catch { text = page.toString("utf8"); lossyUtf8 = true; }
    return { bytes: page.length, nextOffset: offset + page.length, eof, encoding, text, lossyUtf8 };
  }
  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const path = join(this.directory, ".lock"); const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      const owner: Owner = { runtimeId: this.runtimeId, token: randomBytes(16).toString("hex"), leaseUntil: Date.now() + LOCK_STALE_MS };
      try {
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
        const heartbeat = setInterval(() => { owner.leaseUntil = Date.now() + LOCK_STALE_MS; void writeFile(join(path, "owner.json"), JSON.stringify(owner), { mode: 0o600 }); }, Math.max(1_000, Math.floor(LOCK_STALE_MS / 3)));
        heartbeat.unref();
        try { return await action(); } finally { clearInterval(heartbeat); await this.removeOwned(path, owner); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.removeStaleLock(path);
        if (Date.now() >= deadline) throw new Error("ARTIFACT_LOCK_TIMEOUT");
        await delay(20);
      }
    }
  }
  private async removeOwned(path: string, owner: Owner): Promise<void> {
    try { const current = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Partial<Owner>; if (current.runtimeId === owner.runtimeId && current.token === owner.token) await rm(path, { recursive: true, force: true }); } catch { /* ownership changed or lock already gone */ }
  }
  private async touchSpools(): Promise<void> { await Promise.all([...this.spools].map(async spool => { try { await writeFile(join(spool.path, "owner.json"), JSON.stringify({ runtimeId: this.runtimeId, leaseUntil: Date.now() + LOCK_STALE_MS }), { mode: 0o600 }); } catch { spool.failed = true; } })); }
  private async removeStaleLock(path: string): Promise<void> {
    try { const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Partial<Owner>; if (typeof owner.token === "string" && typeof owner.leaseUntil === "number" && Number.isSafeInteger(owner.leaseUntil) && owner.leaseUntil < Date.now()) await this.removeOwned(path, owner as Owner); } catch { /* malformed lock is not ours to remove */ }
  }
  private async recover(): Promise<void> {
    for (const entry of await readdir(this.directory, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith(".spool-")) {
      const path = join(this.directory, entry.name);
      try {
        const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Partial<Owner>;
        if (typeof owner.token === "string" && typeof owner.leaseUntil === "number" && Number.isSafeInteger(owner.leaseUntil) && owner.leaseUntil >= Date.now()) continue;
      } catch { /* ownerless or malformed spool is stale */ }
      await rm(path, { recursive: true, force: true });
    }
  }
  private async publishedSize(): Promise<number> { let total = 0; for (const entry of await readdir(this.directory, { withFileTypes: true })) if (entry.isDirectory() && validId.test(entry.name)) { const meta = await this.validMeta(join(this.directory, entry.name)); if (meta) total += meta.stdoutBytes + meta.stderrBytes; } return total; }
  private async validMeta(path: string): Promise<Metadata | undefined> { try { const raw: unknown = JSON.parse(await readFile(join(path, "meta.json"), "utf8")); const meta = raw as Partial<Metadata>; const publishedAt = meta?.publishedAt; const stdoutBytes = meta?.stdoutBytes; const stderrBytes = meta?.stderrBytes; return meta?.version === 1 && meta.state === "published" && typeof publishedAt === "number" && Number.isSafeInteger(publishedAt) && publishedAt >= 0 && typeof stdoutBytes === "number" && Number.isSafeInteger(stdoutBytes) && stdoutBytes >= 0 && typeof stderrBytes === "number" && Number.isSafeInteger(stderrBytes) && stderrBytes >= 0 ? meta as Metadata : undefined; } catch { return undefined; } }
  private async cleanup(reserve = 0): Promise<void> { const now = Date.now(); const published: { path: string; time: number; size: number }[] = []; for (const entry of await readdir(this.directory, { withFileTypes: true })) if (entry.isDirectory() && validId.test(entry.name)) { const path = join(this.directory, entry.name); const meta = await this.validMeta(path); if (!meta || now - meta.publishedAt > this.retentionMs) { await rm(path, { recursive: true, force: true }).catch(() => {}); continue; } const files = await Promise.all([stat(join(path, "stdout")), stat(join(path, "stderr"))].map(promise => promise.catch(() => undefined))); if (files[0]?.size !== meta.stdoutBytes || files[1]?.size !== meta.stderrBytes) { await rm(path, { recursive: true, force: true }).catch(() => {}); continue; } published.push({ path, time: meta.publishedAt, size: meta.stdoutBytes + meta.stderrBytes }); } let total = published.reduce((sum, item) => sum + item.size, 0); for (const item of published.sort((a, b) => a.time - b.time)) { if (total + reserve <= this.quotaBytes) break; await rm(item.path, { recursive: true, force: true }).catch(() => {}); total -= item.size; } }
}

export class ArtifactSpool {
  failed = false; stdoutBytes = 0; stderrBytes = 0;
  private chains: Record<OutputStream, Promise<void>> = { stdout: Promise.resolve(), stderr: Promise.resolve() };
  constructor(readonly path: string, private readonly maxStreamBytes: number, private readonly removed: () => void) {}
  async append(stream: OutputStream, chunk: Buffer): Promise<void> { const chain = this.chains[stream] = this.chains[stream].then(async () => { if (this.failed) return; const bytes = stream === "stdout" ? this.stdoutBytes : this.stderrBytes; if (bytes + chunk.length > this.maxStreamBytes) { this.failed = true; return; } try { await appendFile(join(this.path, stream), chunk); if (stream === "stdout") this.stdoutBytes += chunk.length; else this.stderrBytes += chunk.length; } catch { this.failed = true; } }); return chain; }
  async finish(): Promise<void> { await Promise.all(Object.values(this.chains)); }
  async remove(): Promise<void> { await this.finish(); await rm(this.path, { recursive: true, force: true }).catch(() => {}); this.removed(); }
}
