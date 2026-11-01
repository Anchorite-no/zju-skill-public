/** 把课程文件存到本地：章节附件经云盘对象状态接口取地址，资料栏文件经 downloadData 跳转取地址。 */
import fs from "node:fs";
import path from "node:path";
import { RemoteRejected } from "../core/errors.ts";
import { fileSize, log } from "../core/output.ts";
import { paths } from "../core/paths.ts";
import { Transfer, downloadFile } from "../zhiyun/download.ts";
import { safeFileName } from "../xuezai/materials.ts";
import { MOOC1, MOOC2, type Chaoxing } from "./client.ts";
import type { Course, CourseFile } from "./courses.ts";

/** 同时下载几个文件；每个文件内部按 4 MB 分块并行，全部连接数由 CONNECTIONS 封顶。 */
const FILES_AT_ONCE = 3;
const CONNECTIONS = 6;
/** 文件地址（cldisk、ananas）不带这个 Referer 会 403。 */
const FILE_REFERER = `${MOOC1}/`;
const https = (url: string) => url.replace(/^http:\/\/([^/]*(?:chaoxing\.com|cldisk\.com))/i, "https://$1");

interface ObjectStatus { status?: string; msg?: string; filename?: string; length?: number; download?: string; http?: string; httphd?: string; httpmd?: string; pdf?: string }

/** original 老师上传的原文件；playback 平台转码后在网页上播放的视频；preview 文档预览用的 PDF。 */
type Variant = "original" | "playback" | "preview";
interface Source { url: string; variant: Variant; size?: number; note?: string }

/** 本地文件名：原文件用平台上的名字；播放版、预览 PDF 另起名字，和原文件分开存、互不顶替。 */
function variantName(base: string, variant: Variant): string {
  if (variant === "playback") return `${base.replace(/\.[^.]+$/, "")}（播放版）.mp4`;
  if (variant === "preview") return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
  return base;
}

/** 章节附件的下载地址。默认取原文件；playback 时视频取播放版。要的那种平台没有给时取另一种，并在 note 里说明。 */
async function objectSource(c: Chaoxing, file: CourseFile, playback: boolean): Promise<Source> {
  const s = await c.json<ObjectStatus>(`${MOOC1}/ananas/status/${file.objectId}?k=${c.fid}&flag=normal&_dc=${Date.now()}`, { referer: `${MOOC1}/ananas/modules/video/index.html?v=2025-0725-1842` });
  if (s.status !== "success") throw new RemoteRejected(`超星没有给出这个文件：${s.msg || s.status || "状态未知"}`);
  const original: Source | undefined = s.download ? { url: https(s.download), variant: "original", ...(typeof s.length === "number" && s.length > 0 ? { size: s.length } : {}) } : undefined;
  // 文档的 http 是在线阅读页，不是文件；只有视频的 http 是播放版。
  const stream = file.kind === "video" ? s.http || s.httphd || s.httpmd : undefined;
  const played: Source | undefined = stream ? { url: https(stream), variant: "playback" } : undefined;
  if (playback && played) return played;
  if (original) return playback && file.kind === "video" ? { ...original, note: "平台没有这个视频的播放版，保存的是原文件" } : original;
  if (played) return { ...played, note: "平台没有给原文件，保存的是播放版" };
  if (s.pdf) return { url: https(s.pdf), variant: "preview", note: "平台没有给原文件，保存的是预览用的 PDF" };
  throw new RemoteRejected("超星没有给出这个文件的下载地址");
}

async function dataSource(c: Chaoxing, course: Course, file: CourseFile): Promise<Source> {
  if (!file.downloadable) throw new RemoteRejected("老师没有开放这个文件的下载");
  const url = await c.redirect(`${MOOC1}/coursedata/downloadData?dataId=${file.dataId}&classId=${course.clazzId}&cpi=${course.cpi}&courseId=${course.courseId}&ut=s`,
    `${MOOC2}/mooc2-ans/coursedata/stu-datalist?courseid=${course.courseId}&clazzid=${course.clazzId}&cpi=${course.cpi}&ut=s`);
  return { url: https(url), variant: "original" };
}

/** 同一位置里重名的文件在名字后带一段编号，互不覆盖。 */
function localName(file: CourseFile, all: CourseFile[]): string {
  const name = safeFileName(file.name);
  if (all.filter((f) => f.name === file.name && f.location.join("/") === file.location.join("/")).length < 2) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${(file.objectId ?? file.dataId ?? "").slice(0, 6)})${ext}`;
}

/** 已有文件的字节数；没有为 0。空文件是上次没写成的，先删掉。 */
async function sizeOf(file: string): Promise<number> {
  const stat = await fs.promises.stat(file).catch(() => undefined);
  if (stat?.isFile() && !stat.size) await fs.promises.rm(file);
  return stat?.isFile() ? stat.size : 0;
}

async function saveOne(c: Chaoxing, transfer: Transfer, course: Course, file: CourseFile, dir: string, base: string, playback: boolean) {
  const row = (name: string, bytes: number, extra: { reused?: true; note?: string } = {}) => ({ name, path: path.join(dir, name), size: fileSize(bytes), ...extra });
  // 下载过的直接复用，不再问平台。章节里的原文件按清单的字节数核对；播放版和资料栏文件事先不知道准确大小，有就用。
  const asked: Variant = playback && file.kind === "video" && file.source === "chapter" ? "playback" : "original";
  const expected = variantName(base, asked), have = await sizeOf(path.join(dir, expected));
  const sized = asked === "original" && file.source === "chapter";
  if (have && (!sized || file.size === have || (file.size === null && file.kind !== "video"))) return row(expected, have, { reused: true });
  const source = file.source === "data" ? await dataSource(c, course, file) : await objectSource(c, file, playback);
  const name = variantName(base, source.variant), out = path.join(dir, name), note = source.note ? { note: source.note } : {};
  const existing = name === expected ? have : await sizeOf(out);
  if (existing) {
    if (source.size === undefined || source.size === existing) return row(name, existing, { reused: true, ...note });
    await fs.promises.rm(out);
  }
  const done = await downloadFile(transfer, source.url, { out });
  return row(name, done.bytes, note);
}

/**
 * 下载若干课程文件到 outDir（默认 data/output/chaoxing/<课程名>/），按章节或资料栏文件夹分目录。
 * playback 为真时视频下平台的播放版（体积小得多），否则下原文件。
 * 结果总是 files 列表；个别文件失败不影响其余，列在 failed。
 */
export async function saveFiles(c: Chaoxing, course: Course, wanted: CourseFile[], all: CourseFile[], opts: { outDir?: string; playback?: boolean; signal?: AbortSignal } = {}) {
  const root = path.resolve(opts.outDir ?? path.join(paths.output(), "chaoxing", safeFileName(course.name)));
  const transfer = new Transfer({
    threads: CONNECTIONS, ...(opts.signal ? { signal: opts.signal } : {}),
    headers: (url) => { const cookie = new URL(url).hostname.endsWith("chaoxing.com") ? c.cookieHeader(url) : ""; return { Referer: FILE_REFERER, ...(cookie ? { Cookie: cookie } : {}) }; },
  });
  // 几个文件一起下，结果仍按给出的顺序；一个失败不影响其余。取地址的请求仍由客户端排队，不并行。
  const saved = new Array<Awaited<ReturnType<typeof saveOne>> | { name: string; reason: string }>(wanted.length);
  let next = 0, finished = 0;
  await Promise.all(Array.from({ length: Math.min(FILES_AT_ONCE, wanted.length) }, async () => {
    while (next < wanted.length) {
      const index = next++, file = wanted[index]!;
      saved[index] = await saveOne(c, transfer, course, file, path.join(root, ...file.location.map(safeFileName)), localName(file, all), opts.playback === true)
        .catch((e: unknown) => ({ name: file.name, reason: e instanceof Error ? e.message : String(e) }));
      log(`超星：${++finished}/${wanted.length} ${file.name}`);
    }
  }));
  const files = saved.filter((r) => "path" in r), failed = saved.filter((r) => "reason" in r);
  const result = { count: files.length, files, ...(failed.length ? { failed } : {}) };
  if (!files.length && failed.length) throw new RemoteRejected(failed.length === 1 ? failed[0]!.reason : "文件都没有下载成功", { result });
  return result;
}
