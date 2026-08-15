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
  private readonly spoolCreations = new Set<Promise<ArtifactSpool>>();
  private heartbeat: NodeJS.Timeout | undefined;
  private closeCleanup: Promise<void> | undefined;
  private closed = false;
  private unavailable = false;
  constructor(private readonly directory: string, private readonly retentionMs: number, private readonly quotaBytes: number, private readonly maxStreamBytes = 100 * 1024 * 1024, private readonly spoolStage?: (stage: "mkdir") => Promise<void>) {}
  async start(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 }); if (this.closed) return;
      await this.withLock(async () => { await this.recover(); if (this.closed) return; await this.cleanup(); }); if (this.closed) return;
      this.heartbeat = setInterval(() => { void this.touchSpools(); }, Math.max(1_000, Math.floor(LOCK_STALE_MS / 3))); if (this.closed) { clearInterval(this.heartbeat); this.heartbeat = undefined; return; }
      this.heartbeat.unref();
    } catch { this.unavailable = true; }
  }
  async spool(): Promise<ArtifactSpool> {
    let creation!: Promise<ArtifactSpool>;
    creation = (async () => {
      if (this.closed || this.unavailable) throw new Error("ARTIFACT_UNAVAILABLE");
      const path = join(this.directory, `.spool-${this.runtimeId}-${randomBytes(16).toString("hex")}`);
      const staging = `${path}.new`;
      const owner: Owner = { runtimeId: this.runtimeId, token: randomBytes(16).toString("hex"), leaseUntil: Date.now() + LOCK_STALE_MS };
      await mkdir(staging, { mode: 0o700 }); if (this.closed) { await rm(staging, { recursive: true, force: true }); throw new Error("ARTIFACT_UNAVAILABLE"); } await this.spoolStage?.("mkdir");
      try { if (this.closed) throw new Error("ARTIFACT_UNAVAILABLE"); await this.writeOwner(staging, owner); if (this.closed) throw new Error("ARTIFACT_UNAVAILABLE"); await writeFile(join(staging, "stdout"), "", { mode: 0o600 }); if (this.closed) throw new Error("ARTIFACT_UNAVAILABLE"); await writeFile(join(staging, "stderr"), "", { mode: 0o600 }); if (this.closed) throw new Error("ARTIFACT_UNAVAILABLE"); await rename(staging, path); }
      catch (error) { await rm(staging, { recursive: true, force: true }); await rm(path, { recursive: true, force: true }); throw error; }
      const spool = new ArtifactSpool(path, this.maxStreamBytes, owner, () => this.spools.delete(spool));
      if (this.closed) { await spool.remove(); throw new Error("ARTIFACT_UNAVAILABLE"); }
      this.spools.add(spool);
      if (this.closed) { await spool.remove(); throw new Error("ARTIFACT_UNAVAILABLE"); }
      return spool;
    })();
    this.spoolCreations.add(creation);
    try { return await creation; } finally { this.spoolCreations.delete(creation); }
  }
  async publish(spool: ArtifactSpool): Promise<string> {
    if (this.closed || this.unavailable || spool.failed) throw new Error("ARTIFACT_UNAVAILABLE");
    await spool.finish();
    if (this.closed || this.unavailable || spool.failed) throw new Error("ARTIFACT_UNAVAILABLE");
    const id = randomBytes(16).toString("hex"); const target = join(this.directory, id);
    try {
      await this.withLock(async () => {
        await spool.finish();
        if (this.closed || this.unavailable || spool.failed) throw new Error("ARTIFACT_UNAVAILABLE");
        const size = spool.stdoutBytes + spool.stderrBytes;
        if (size > this.quotaBytes) throw new Error("ARTIFACT_QUOTA");
        await this.cleanup(size);
        if (this.closed || this.unavailable || spool.failed) throw new Error("ARTIFACT_UNAVAILABLE");
        if (await this.publishedSize() + size > this.quotaBytes) throw new Error("ARTIFACT_QUOTA");
        await writeFile(join(spool.path, "meta.json"), JSON.stringify({ version: 1, state: "published", publishedAt: Date.now(), stdoutBytes: spool.stdoutBytes, stderrBytes: spool.stderrBytes } satisfies Metadata), { mode: 0o600 });
        await spool.finish();
        if (this.closed || this.unavailable || spool.failed) throw new Error("ARTIFACT_UNAVAILABLE");
        await rm(join(spool.path, "owner.json"), { force: true });
        if (this.closed || this.unavailable || spool.failed) throw new Error("ARTIFACT_UNAVAILABLE");
        await rename(spool.path, target);
        this.spools.delete(spool);
      });
      return id;
    } catch (error) { await spool.remove(); throw error; }
  }
  async discard(spool: ArtifactSpool | undefined): Promise<void> { await spool?.remove(); }
  async close(deadlineMs = LOCK_WAIT_MS): Promise<void> {
    this.closed = true;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    if (this.closeCleanup) { await this.closeCleanup; return; }
    const cleanup = this.closeCleanup = Promise.allSettled([...this.spoolCreations]).then(() => Promise.all([...this.spools].map(spool => spool.remove()))).then(() => {}, () => {});
    let deadline: NodeJS.Timeout | undefined;
    const expires = new Promise<void>(resolve => { deadline = setTimeout(resolve, Math.max(0, deadlineMs)); deadline.unref(); });
    await Promise.race([cleanup, expires]);
    if (deadline) clearTimeout(deadline);
  }
  async read(id: string, stream: OutputStream, offset: number, limit: number, encoding: OutputEncoding): Promise<OutputPage> {
    if (!validId.test(id)) throw new Error("ARTIFACT_NOT_FOUND");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit <= 0 || limit > 1024 * 1024) throw new Error("INVALID_OUTPUT_PAGE");
    const path = join(this.directory, id); const meta = await this.validMeta(path);
    if (!meta || Date.now() - meta.publishedAt > this.retentionMs) { if (meta) await rm(path, { recursive: true, force: true }).catch(() => {}); throw new Error("ARTIFACT_NOT_FOUND"); }
    const total = meta[stream === "stdout" ? "stdoutBytes" : "stderrBytes"];
    if (offset > total) throw new Error("INVALID_OUTPUT_OFFSET");
    const handle = await open(join(path, stream), "r").catch(() => undefined);
    if (!handle) throw new Error("ARTIFACT_NOT_FOUND");
    let page: Buffer;
    try { if ((await handle.stat()).size !== total) throw new Error(); page = Buffer.alloc(Math.min(limit, total - offset)); const { bytesRead } = await handle.read(page, 0, page.length, offset); if (bytesRead !== page.length) throw new Error(); }
    catch { throw new Error("ARTIFACT_NOT_FOUND"); } finally { await handle.close().catch(() => {}); }
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
        await this.writeOwner(path, owner); // Claim immediately after atomic mkdir.
        let chain = Promise.resolve();
        const pulse = (): void => { owner.leaseUntil = Date.now() + LOCK_STALE_MS; chain = chain.then(() => this.writeOwner(path, owner)); };
        const heartbeat = setInterval(pulse, Math.max(1_000, Math.floor(LOCK_STALE_MS / 3))); heartbeat.unref();
        try { return await action(); } finally { clearInterval(heartbeat); pulse(); await chain.catch(() => {}); await this.removeOwned(path, owner); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.removeStaleLock(path);
        if (Date.now() >= deadline) throw new Error("ARTIFACT_LOCK_TIMEOUT");
        await delay(20);
      }
    }
  }
  private async writeOwner(path: string, owner: Owner): Promise<void> { const target = join(path, "owner.json"); const temporary = `${target}.${randomBytes(16).toString("hex")}.tmp`; try { await writeFile(temporary, JSON.stringify(owner), { mode: 0o600 }); await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; } }
  private validOwner(value: Partial<Owner>): value is Owner { return /^[a-f0-9]{32}$/.test(value.runtimeId ?? "") && /^[a-f0-9]{32}$/.test(value.token ?? "") && typeof value.leaseUntil === "number" && Number.isSafeInteger(value.leaseUntil); }
  private async removeOwned(path: string, owner: Owner): Promise<void> { try { const current = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Partial<Owner>; if (current.runtimeId === owner.runtimeId && current.token === owner.token && current.leaseUntil === owner.leaseUntil) await rm(path, { recursive: true, force: true }); } catch { /* ownership changed or absent */ } }
  private async touchSpools(): Promise<void> { await Promise.all([...this.spools].map(spool => spool.heartbeat(path => this.writeOwner(path, spool.owner)))); }
  private async old(path: string): Promise<boolean> { try { const first = await stat(path); if (Date.now() - first.mtimeMs < LOCK_STALE_MS) return false; const second = await stat(path); return second.mtimeMs === first.mtimeMs && Date.now() - second.mtimeMs >= LOCK_STALE_MS; } catch { return false; } }
  private async removeStaleLock(path: string): Promise<void> { try { const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Partial<Owner>; if (this.validOwner(owner) && owner.leaseUntil < Date.now()) await this.removeOwned(path, owner); } catch { if (await this.old(path)) await rm(path, { recursive: true, force: true }).catch(() => {}); } }
  private async removeStaleSpool(path: string): Promise<void> { try { const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Partial<Owner>; if (this.validOwner(owner) && owner.leaseUntil < Date.now()) await this.removeOwned(path, owner); } catch { if (path.endsWith(".new") && await this.old(path)) await rm(path, { recursive: true, force: true }).catch(() => {}); } }
  private async recover(): Promise<void> { for (const entry of await readdir(this.directory, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith(".spool-")) await this.removeStaleSpool(join(this.directory, entry.name)); }
  private async publishedSize(): Promise<number> { let total = 0; for (const entry of await readdir(this.directory, { withFileTypes: true })) if (entry.isDirectory() && validId.test(entry.name)) { const meta = await this.validMeta(join(this.directory, entry.name)); if (meta) total += meta.stdoutBytes + meta.stderrBytes; } return total; }
  private async validMeta(path: string): Promise<Metadata | undefined> { try { const meta = JSON.parse(await readFile(join(path, "meta.json"), "utf8")) as Partial<Metadata>; return meta.version === 1 && meta.state === "published" && Number.isSafeInteger(meta.publishedAt) && meta.publishedAt! >= 0 && Number.isSafeInteger(meta.stdoutBytes) && meta.stdoutBytes! >= 0 && Number.isSafeInteger(meta.stderrBytes) && meta.stderrBytes! >= 0 ? meta as Metadata : undefined; } catch { return undefined; } }
  private async cleanup(reserve = 0): Promise<void> { const now = Date.now(); const published: { path: string; time: number; size: number }[] = []; for (const entry of await readdir(this.directory, { withFileTypes: true })) if (entry.isDirectory() && validId.test(entry.name)) { const path = join(this.directory, entry.name); const meta = await this.validMeta(path); if (!meta || now - meta.publishedAt > this.retentionMs) { await rm(path, { recursive: true, force: true }).catch(() => {}); continue; } const files = await Promise.all([stat(join(path, "stdout")).catch(() => undefined), stat(join(path, "stderr")).catch(() => undefined)]); if (files[0]?.size !== meta.stdoutBytes || files[1]?.size !== meta.stderrBytes) { await rm(path, { recursive: true, force: true }).catch(() => {}); continue; } published.push({ path, time: meta.publishedAt, size: meta.stdoutBytes + meta.stderrBytes }); } let total = published.reduce((sum, item) => sum + item.size, 0); for (const item of published.sort((a, b) => a.time - b.time)) { if (total + reserve <= this.quotaBytes) break; await rm(item.path, { recursive: true, force: true }).catch(() => {}); total -= item.size; } }
}

export class ArtifactSpool {
  failed = false; stdoutBytes = 0; stderrBytes = 0;
  private readonly chains: Record<OutputStream, Promise<void>> = { stdout: Promise.resolve(), stderr: Promise.resolve() };
  private heartbeatChain = Promise.resolve();
  private removedYet = false;
  constructor(readonly path: string, private readonly maxStreamBytes: number, readonly owner: Owner, private readonly removed: () => void) {}
  append(stream: OutputStream, chunk: Buffer): Promise<void> { const work = async (): Promise<void> => { if (this.failed || this.removedYet) throw new Error("ARTIFACT_UNAVAILABLE"); const bytes = stream === "stdout" ? this.stdoutBytes : this.stderrBytes; if (bytes + chunk.length > this.maxStreamBytes) { this.failed = true; throw new Error("ARTIFACT_STREAM_CAP"); } try { await appendFile(join(this.path, stream), chunk); if (stream === "stdout") this.stdoutBytes += chunk.length; else this.stderrBytes += chunk.length; } catch (error) { this.failed = true; throw error; } }; const next = this.chains[stream].then(work, work); this.chains[stream] = next.catch(() => {}); return next; }
  heartbeat(write: (path: string) => Promise<void>): Promise<void> { if (this.removedYet || this.failed) return this.heartbeatChain; this.owner.leaseUntil = Date.now() + LOCK_STALE_MS; this.heartbeatChain = this.heartbeatChain.then(() => write(this.path)).catch(() => { this.failed = true; }); return this.heartbeatChain; }
  async finish(): Promise<void> { await Promise.all([...Object.values(this.chains), this.heartbeatChain]); }
  async remove(): Promise<void> { this.removedYet = true; await this.finish(); await rm(this.path, { recursive: true, force: true }).catch(() => {}); this.removed(); }
}
