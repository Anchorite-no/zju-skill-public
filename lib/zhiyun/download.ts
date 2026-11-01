import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BadResponse, ConfigError, RemoteRejected, TransportError } from "../core/errors.ts";
import { DEFAULT_UA } from "../core/http.ts";
import { positive } from "./courses.ts";

export async function pool<T, R>(items: readonly T[], concurrency: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  positive(concurrency, "threads", 32);
  const results = new Array<R>(items.length); let cursor = 0, failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed) {
      const index = cursor++; if (index >= items.length) break;
      try { results[index] = await work(items[index]!, index); } catch (e) { if (!failed) { failed = true; failure = e; } }
    }
  }));
  if (failed) throw failure;
  return results;
}
export function safeName(value: string): string {
  let s = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[ .]+$/g, "").slice(0, 140);
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)) s = "_" + s;
  return s && s !== "." && s !== ".." ? s : "unnamed";
}
export async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }
export async function publish(temp: string, out: string): Promise<void> {
  // Hard-link publishes a complete file atomically and never replaces an existing output.
  try { await fs.link(temp, out); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ConfigError(`文件已存在：${out}`);
    throw e;
  }
  await fs.unlink(temp);
}
export interface TransferOptions {
  threads?: number;
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  transfer?: typeof fetch;
  headers?: (url: string) => Record<string, string>;
}
export class Transfer {
  readonly threads: number;
  readonly retries: number;
  readonly options: TransferOptions;
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(opts: TransferOptions = {}) {
    this.options = opts; this.threads = positive(opts.threads ?? 4, "threads", 32);
    this.retries = opts.retries ?? 2;
    if (!Number.isInteger(this.retries) || this.retries < 0 || this.retries > 5) throw new ConfigError("retries 须在 0..5 之间");
    positive(opts.timeoutMs ?? 120_000, "timeoutMs", 3600_000);
  }
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.threads) await new Promise<void>(resolve => this.queue.push(resolve));
    else this.active++;
    try { this.options.signal?.throwIfAborted(); return await fn(); }
    finally { const next = this.queue.shift(); if (next) next(); else this.active--; }
  }
  async request<T>(url: string, init: RequestInit, consume: (res: Response, finalUrl: string) => Promise<T>): Promise<T> {
    return this.slot(async () => {
      for (let attempt = 0; ; attempt++) {
        this.options.signal?.throwIfAborted();
        const signal = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? 120_000), ...(this.options.signal ? [this.options.signal] : [])]);
        try {
          let current = url; const initialOrigin = new URL(url).origin;
          for (let hop = 0; hop <= 8; hop++) {
            const u = new URL(current);
            if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new ConfigError("下载 URL 无效");
            const headers = new Headers({ "User-Agent": DEFAULT_UA, "Accept-Encoding": "identity", ...(this.options.headers?.(current) ?? {}) });
            new Headers(init.headers).forEach((v, k) => headers.set(k, v));
            if (u.origin !== initialOrigin) for (const key of ["cookie", "authorization", "proxy-authorization"]) headers.delete(key);
            const res = await (this.options.transfer ?? fetch)(current, { ...init, headers, signal, redirect: "manual" });
            if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
              const next = new URL(res.headers.get("location")!, current);
              await res.body?.cancel();
              if (u.protocol === "https:" && next.protocol !== "https:") throw new BadResponse("拒绝下载重定向降低为 HTTP");
              current = next.href; continue;
            }
            try {
              if (res.status === 429 || res.status >= 500) throw new TransportError(`下载 HTTP ${res.status}`);
              if (!res.ok) throw new RemoteRejected(`下载 HTTP ${res.status}`, { host: u.hostname, path: u.pathname });
              return await consume(res, current);
            } finally { if (res.body && !res.body.locked) await res.body.cancel().catch(() => {}); }
          }
          throw new BadResponse("下载重定向过多");
        } catch (e) {
          if (this.options.signal?.aborted || e instanceof ConfigError || e instanceof BadResponse || e instanceof RemoteRejected || attempt >= this.retries) throw e;
          await new Promise(resolve => setTimeout(resolve, Math.min(4000, 250 * 2 ** attempt)));
        }
      }
    });
  }
  async text(url: string): Promise<{ text: string; url: string }> {
    return this.request(url, {}, async (res, finalUrl) => {
      if (!res.body) throw new BadResponse("清单为空");
      const reader = res.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 4 * 1024 * 1024) throw new BadResponse("媒体清单超过 4MB"); chunks.push(r.value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return { text: Buffer.concat(chunks).toString("utf8"), url: finalUrl };
    });
  }
}
async function streamFile(res: Response, file: string, expected?: number): Promise<number> {
  if (!res.body || /text\/html|application\/json/i.test(res.headers.get("content-type") ?? "")) throw new BadResponse("下载返回了网页/JSON 或空响应");
  let bytes = 0;
  const counter = new Transform({ transform(chunk: Buffer, _encoding, cb) {
    bytes += chunk.length;
    if (expected !== undefined && bytes > expected) cb(new BadResponse("下载超过预期长度")); else cb(null, chunk);
  } });
  await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(file, { flags: "w", mode: 0o600 }));
  if (bytes === 0 || (expected !== undefined && bytes !== expected)) throw new TransportError("下载长度不完整", { expected, bytes });
  return bytes;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
/** The lock records its owner's pid, so a download killed midway does not block the next run: a lock whose owner is gone is taken over. */
async function acquireLock(lock: string, out: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      const file = await fs.open(lock, "wx", 0o600);
      await file.writeFile(String(process.pid));
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = Number((await fs.readFile(lock, "utf8").catch(() => "")).trim());
      // A lock without a pid (written by an older version, or still being created) is treated as held.
      if (attempt > 0 || !Number.isSafeInteger(owner) || owner <= 0 || owner === process.pid || alive(owner)) throw new ConfigError(`已有下载占用目标：${out}`, "确认没有运行中的下载后，删除对应 .lock 再重试");
      await fs.unlink(lock).catch(() => {});
    }
  }
}
export interface DownloadOptions {
  out: string; chunkBytes?: number; resume?: boolean;
  /** Identity of the file for resuming. Defaults to the URL; pass a stable one when the URL carries a signature that differs on every request. */
  source?: string;
}
export interface DownloadResult { path: string; bytes: number; chunks: number; resumedChunks: number }
interface ResumeState { version: 1; sourceHash: string; size: number; validator: string; chunkBytes: number }
export async function downloadFile(transfer: Transfer, url: string, opts: DownloadOptions): Promise<DownloadResult> {
  const out = path.resolve(opts.out);
  if (await exists(out)) throw new ConfigError(`文件已存在：${out}`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const chunkBytes = positive(opts.chunkBytes ?? 4 * 1024 * 1024, "chunkBytes", 64 * 1024 * 1024);
  // A GET probe also handles servers which reject HEAD or advertise broken Range support.
  const probe = await transfer.request(url, { headers: { Range: "bytes=0-0" } }, async res => {
    const match = res.headers.get("content-range")?.match(/^bytes 0-0\/(\d+)$/);
    const size = match ? Number(match[1]) : 0;
    const etag = res.headers.get("etag");
    return { range: res.status === 206 && Number.isSafeInteger(size) && size > 0, size, validator: etag && !etag.startsWith("W/") ? etag : res.headers.get("last-modified") ?? "" };
  });
  const parts = out + ".parts", temp = out + ".assembling";
  const lock = out + ".lock";
  const lockFile = await acquireLock(lock, out);
  try {
    if (!probe.range) {
      const bytes = await transfer.request(url, {}, async res => {
        if (res.status !== 200) throw new BadResponse("整文件下载预期 HTTP 200");
        const length = res.headers.get("content-length");
        return streamFile(res, temp, length !== null ? Number(length) : undefined);
      });
      await publish(temp, out); return { path: out, bytes, chunks: 1, resumedChunks: 0 };
    }
    await fs.mkdir(parts, { recursive: true });
    const state: ResumeState = { version: 1, sourceHash: createHash("sha256").update(opts.source ?? url).digest("hex"), size: probe.size, validator: probe.validator, chunkBytes };
    let old: unknown;
    try { old = JSON.parse(await fs.readFile(path.join(parts, "state.json"), "utf8")); } catch { /* new download */ }
    const reuse = opts.resume !== false && !!state.validator && JSON.stringify(old) === JSON.stringify(state);
    if (!reuse) for (const name of await fs.readdir(parts)) {
      if (/^\d+\.bin(?:\.tmp)?$/.test(name)) await fs.unlink(path.join(parts, name));
    }
    await fs.writeFile(path.join(parts, "state.json"), JSON.stringify(state), { mode: 0o600 });
    const count = Math.ceil(probe.size / chunkBytes); let resumedChunks = 0;
    await pool(Array.from({ length: count }, (_, i) => i), transfer.threads, async i => {
      const start = i * chunkBytes, end = Math.min(start + chunkBytes, probe.size) - 1, size = end - start + 1;
      const part = path.join(parts, `${i}.bin`), partial = part + ".tmp";
      if (reuse && await exists(part) && (await fs.stat(part)).size === size) { resumedChunks++; return; }
      await transfer.request(url, { headers: { Range: `bytes=${start}-${end}`, ...(probe.validator ? { "If-Range": probe.validator } : {}) } }, async res => {
        if (res.status !== 206 || res.headers.get("content-range") !== `bytes ${start}-${end}/${probe.size}`) throw new BadResponse("服务器未正确返回字节范围，源文件可能已改变");
        const returned = probe.validator.startsWith('"') ? res.headers.get("etag") : res.headers.get("last-modified");
        if (probe.validator && returned && returned !== probe.validator) throw new BadResponse("分块下载期间源文件已改变");
        await streamFile(res, partial, size);
      });
      await fs.rename(partial, part);
    });
    const dest = await fs.open(temp, "w", 0o600);
    try { for (let i = 0; i < count; i++) { const buffer = await fs.readFile(path.join(parts, `${i}.bin`)); let offset = 0; while (offset < buffer.length) offset += (await dest.write(buffer, offset)).bytesWritten; } await dest.sync(); }
    finally { await dest.close(); }
    if ((await fs.stat(temp)).size !== probe.size) throw new BadResponse("分块合并长度不匹配");
    await publish(temp, out);
    // Only remove files this invocation owns; never recursively delete a computed directory.
    for (let i = 0; i < count; i++) await fs.unlink(path.join(parts, `${i}.bin`));
    await fs.unlink(path.join(parts, "state.json")); await fs.rmdir(parts).catch(() => {});
    return { path: out, bytes: probe.size, chunks: count, resumedChunks };
  } finally { await lockFile.close(); await fs.unlink(lock).catch(() => {}); await fs.unlink(temp).catch(() => {}); }
}
