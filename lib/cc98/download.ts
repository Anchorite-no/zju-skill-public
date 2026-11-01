/**
 * CC98 帖内文件（图片、视频、音频、附件）下载。
 *
 * 文件都在 file.cc98.org（10.10.98.77，只在校网），不需要 CC98 token；按模块传输到达（默认 WebVPN），
 * 流式落盘到 data/output/cc98/<原路径>。上传文件名是随机生成的，内容不变，已下载过的直接复用。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DEFAULT_UA } from "../core/http.ts";
import { BadResponse, ConfigError, RemoteRejected, TransportError, ZjuError } from "../core/errors.ts";
import { paths } from "../core/paths.ts";
import { WEBVPN_HOST } from "../webvpn/client.ts";
import { stripQuotes } from "./api.ts";
import type { Cc98Session } from "./index.ts";

const FILE_HOST = "file.cc98.org";
const TIMEOUT_MS = 10 * 60_000;
const CONCURRENCY = 3;

export interface DownloadedFile {
  url: string;
  path: string;
  bytes: number;
  contentType?: string;
  /** 本地已有同一文件，未重新下载 */
  existing?: true;
}

export interface DownloadResult {
  topicId?: number;
  floor?: number;
  files: DownloadedFile[];
  failed?: { url: string; error: string }[];
}

/**
 * 楼层自己发的 file.cc98.org 链接（UBB [img]/[video]/[upload]、Markdown、裸链接都覆盖），按出现顺序去重。
 * 引用块里是被引用楼的文件，不算本楼：UBB [quote]（可嵌套）与 Markdown 的 > 行先去掉。
 */
export function fileLinks(content: string, markdown = false): string[] {
  let own = stripQuotes(content);
  if (markdown) own = own.replace(/^[ \t]*>.*$/gm, "");
  return [...new Set([...own.matchAll(/https?:\/\/file\.cc98\.org\/[\w\-.~/%]+/gi)].map((m) => m[0]))];
}

export async function download(s: Cc98Session, target: { url: string } | { topicId: number; floor: number }): Promise<DownloadResult> {
  if ("url" in target) {
    let u: URL | undefined;
    try { u = new URL(target.url); } catch { /* 下面统一报错 */ }
    if (!u || !/^https?:$/.test(u.protocol) || u.hostname.toLowerCase() !== FILE_HOST) {
      throw new ConfigError(`只下载 ${FILE_HOST} 上的 CC98 文件：${target.url}`, "帖子里的文件用 --id 主题ID [--floor 楼层]");
    }
    return { files: [await downloadOne(s, u.href)] };
  }
  const post = await s.api.postByFloor(target.topicId, target.floor);
  if (post.isDeleted) throw new RemoteRejected(`CC98：主题 ${target.topicId} 第 ${target.floor} 楼已删除`);
  const urls = fileLinks(post.content, post.contentType !== 0);
  if (!urls.length) throw new ConfigError(`主题 ${target.topicId} 第 ${target.floor} 楼没有图片、视频或附件`, "文件在其他楼层时加 --floor 楼层号");
  const results = new Array<DownloadedFile | { url: string; error: unknown }>(urls.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
    while (next < urls.length) {
      const i = next++, url = urls[i]!;
      results[i] = await downloadOne(s, url).catch((error: unknown) => ({ url, error }));
    }
  }));
  const files = results.filter((r): r is DownloadedFile => !("error" in r));
  const failed = results.filter((r): r is { url: string; error: unknown } => "error" in r);
  if (!files.length) throw failed[0]!.error;
  return { topicId: target.topicId, floor: target.floor, files, ...(failed.length ? { failed: failed.map((f) => ({ url: f.url, error: f.error instanceof Error ? f.error.message : String(f.error) })) } : {}) };
}

function destination(u: URL): string {
  const parts = u.pathname.split("/").filter(Boolean).map((p) => /^\.+$/.test(p) ? "_" : p.replace(/[<>:"\\|?*\x00-\x1f]/g, "_"));
  if (!parts.length) throw new ConfigError(`不是文件链接：${u.href}`);
  return path.join(paths.output(), "cc98", ...parts);
}

async function downloadOne(s: Cc98Session, url: string): Promise<DownloadedFile> {
  const out = destination(new URL(url));
  const old = await fs.promises.stat(out).catch(() => undefined);
  if (old?.isFile() && old.size > 0) return { url, path: out, bytes: old.size, existing: true };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const res = await open(s, url, signal);
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  const temporary = `${out}.${crypto.randomUUID()}.part`;
  let bytes = 0;
  const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(res.body as never), counter, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    const advertised = res.headers.get("content-length");
    if (advertised && bytes !== Number(advertised)) throw new TransportError("CC98 文件下载不完整", { url, bytes, expected: Number(advertised) });
    if (!bytes) throw new BadResponse("CC98 文件内容为空", { url });
    await fs.promises.rename(temporary, out);
  } catch (err) {
    if (err instanceof ZjuError) throw err;
    throw new TransportError(`CC98 文件下载中断：${err instanceof Error ? err.message : String(err)}`, { url }, err);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
  return { url, path: out, bytes, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

/** 打开文件流：真实 URL 经 ctx.resolve 重写；WebVPN 返回登录页时重登一次再取 */
async function open(s: Cc98Session, url: string, signal: AbortSignal): Promise<Response> {
  let current = url, relogged = false;
  for (let hop = 0; hop < 8; hop++) {
    const target = s.ctx.resolve(current);
    const cookie = s.ctx.http.jar.getCookieHeader(target);
    const res = await fetch(target, { redirect: "manual", signal, headers: { "User-Agent": DEFAULT_UA, "Accept-Encoding": "identity", ...(cookie ? { Cookie: cookie } : {}) } }).catch((err: unknown) => {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new TransportError(`连不上 CC98 文件服务器：${cause?.message ?? (err instanceof Error ? err.message : String(err))}`, { url, transport: s.ctx.transport, code: cause?.code }, err);
    });
    const location = res.headers.get("location");
    const next = location ? new URL(location, target) : undefined;
    const html = /text\/html/i.test(res.headers.get("content-type") ?? "");
    const vpnLogin = (next?.hostname === WEBVPN_HOST && next.pathname === "/login") || (res.ok && html);
    if (s.ctx.webvpn && vpnLogin && !relogged) {
      await res.body?.cancel();
      relogged = true;
      await s.ctx.webvpn.login(true);
      continue;
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && next) {
      await res.body?.cancel();
      current = next.href;
      continue;
    }
    if (!res.ok || !res.body || html) {
      await res.body?.cancel();
      if ([403, 404, 410].includes(res.status)) throw new RemoteRejected(`CC98 文件不存在或已删除（HTTP ${res.status}）`, { url });
      if (html) throw new BadResponse("CC98 文件链接返回了网页", { url, status: res.status });
      throw new TransportError(`CC98 文件服务器 HTTP ${res.status}`, { url });
    }
    return res;
  }
  throw new BadResponse("CC98 文件重定向过多", { url });
}
