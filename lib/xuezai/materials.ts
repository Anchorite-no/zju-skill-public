import fs from "node:fs";
import path from "node:path";
import { RemoteRejected, TransportError, ZjuError } from "../core/errors.ts";
import { paths } from "../core/paths.ts";
import { fileSize, log } from "../core/output.ts";
import { Transfer, downloadFile, pool } from "../zhiyun/download.ts";
import type { Xuezai } from "./client.ts";
import { getCourseContent, listActivities } from "./courses.ts";
import type { Activity, CourseModule, Upload } from "./types.ts";

export interface Material extends Upload {
  activities: { id: number; title: string; type: string; moduleId: number | null; syllabusId: number | null }[];
}

export function collectMaterials(activities: Activity[]): Material[] {
  const files = new Map<number, Material>();
  for (const activity of activities) for (const upload of activity.uploads ?? []) {
    if (!files.has(upload.id)) files.set(upload.id, { ...upload, activities: [] });
    files.get(upload.id)!.activities.push({ id: activity.id, title: activity.title, type: activity.type, moduleId: activity.module_id ?? null, syllabusId: activity.syllabus_id ?? null });
  }
  return [...files.values()];
}

/** 文件在课程的哪一章、哪一节（章节的名称）；没有归到章里的两样都没有。挂在几个活动上的按第一个算。 */
export function placeOf(m: Material, modules: CourseModule[]): { chapter?: string; section?: string } {
  for (const activity of m.activities) {
    const module = modules.find((row) => row.id === Number(activity.moduleId));
    if (!module) continue;
    const section = module.syllabuses?.find((row) => row.id === Number(activity.syllabusId));
    return { chapter: module.name, ...(section ? { section: section.name } : {}) };
  }
  return {};
}

/** 文件清单的一行：下载用 name 即可，平台存储字段不外露。给了 modules 时带上它在哪一章、哪一节。 */
export function materialRow(m: Material, modules?: CourseModule[]) {
  return {
    name: m.name, size: fileSize(m.size), ...(modules ? placeOf(m, modules) : {}), activity: m.activities.map((a) => a.title).join("；"),
    ...(m.type === "video" ? { video: true } : {}), ...(m.link ? { link: m.link } : {}),
  };
}

export async function listMaterials(client: Xuezai, courseId: number | string): Promise<Material[]> {
  return collectMaterials(await listActivities(client, courseId));
}

/** 一门课的全部文件连同章节：文件照课程里的先后排（章、节、活动各按平台的顺序），没有归到章里的排在最后。 */
export async function courseMaterials(client: Xuezai, courseId: number | string): Promise<{ materials: Material[]; modules: CourseModule[] }> {
  const { modules, unassigned } = await getCourseContent(client, courseId);
  const ordered = [...modules.flatMap((module) => [...module.activities, ...module.syllabuses.flatMap((syllabus) => syllabus.activities)]), ...unassigned];
  return { materials: collectMaterials(ordered), modules };
}

export function safeFileName(name: string): string {
  let value = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 180);
  if (!value || /^\.+$/.test(value)) value = "file";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = "_" + value;
  return value;
}

/** 一组文件里重名的（各章都叫「课件.pdf」）在文件名后带上平台编号，互不覆盖。 */
function localName(file: Upload, all: Upload[]): string {
  const name = safeFileName(file.name);
  if (all.filter((m) => m.name === file.name).length < 2) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${file.id})${ext}`;
}

/** 同时下载几个文件；每个文件内部按 4 MB 分块并行，全部连接数由 CONNECTIONS 封顶。 */
const FILES_AT_ONCE = 3;
const CONNECTIONS = 6;

async function download(client: Xuezai, transfer: Transfer, file: Upload, destination: string, reuse: boolean) {
  // 下载过且大小一致的直接复用；其余的本地同名文件是旧内容，换掉。
  const existing = await fs.promises.stat(destination).catch(() => undefined);
  if (reuse && existing?.isFile() && existing.size === file.size) return { name: file.name, path: destination, size: fileSize(existing.size), reused: true };
  if (existing) await fs.promises.rm(destination);
  for (let round = 0; ; round++) {
    const url = new URL(await client.fileUrl(file.id));
    try {
      // 签名每小时换一次，续传按存储上的文件路径认同一个文件。
      const done = await downloadFile(transfer, url.href, { out: destination, source: url.origin + url.pathname });
      return { name: file.name, path: destination, size: fileSize(done.bytes) };
    } catch (e) {
      // 存储中途拒绝（如签名过期）时重新取地址接着下，已下好的分块留着。
      if (e instanceof RemoteRejected && round < 2) continue;
      if (e instanceof ZjuError || transfer.options.signal?.aborted) throw e;
      throw new TransportError("下载多次中断或超时", {}, e);
    }
  }
}

/**
 * 把若干平台文件存到 dir，几个文件一起下，结果仍按给出的顺序；个别文件失败不影响其余，列在 failed。
 * 没下完的文件留下「文件名.parts」，下次接着下。
 * reuse 为 false 时不看本地已有文件（同名文件内容可能换过，如重交的作业）。
 */
export async function saveUploads(client: Xuezai, dir: string, wanted: Upload[], opts: { all?: Upload[]; reuse?: boolean; signal?: AbortSignal } = {}) {
  // tcmedia 的新连接不时在建立时被断开，同一块连着断两次也遇到过，所以比默认多试两次。
  const transfer = new Transfer({ threads: CONNECTIONS, retries: 4, transfer: client.transfer, ...(opts.signal ? { signal: opts.signal } : {}) });
  let finished = 0;
  const saved = await pool(wanted, FILES_AT_ONCE, async (file) => {
    const row = await download(client, transfer, file, path.join(dir, localName(file, opts.all ?? wanted)), opts.reuse !== false)
      .catch((e: unknown) => ({ name: file.name, reason: e instanceof Error ? e.message : String(e) }));
    if (wanted.length > 1) log(`学在：${++finished}/${wanted.length} ${file.name}`);
    return row;
  });
  return { files: saved.filter((r) => "path" in r), failed: saved.filter((r) => "reason" in r) };
}

/**
 * 下载一门课的若干文件到 outDir（默认 data/output/xuezai/<课程名>/）。
 * 结果总是 files 列表；个别文件失败不影响其余，列在 failed。
 */
export async function downloadMaterials(client: Xuezai, course: string, all: Material[], wanted: Material[], opts: { outDir?: string; signal?: AbortSignal } = {}) {
  const dir = path.resolve(opts.outDir ?? path.join(paths.output(), "xuezai", safeFileName(course)));
  const { files, failed } = await saveUploads(client, dir, wanted, { all, ...(opts.signal ? { signal: opts.signal } : {}) });
  const result = { count: files.length, files, ...(failed.length ? { failed } : {}) };
  if (!files.length && failed.length) throw new RemoteRejected(failed.length === 1 ? failed[0]!.reason : "文件都没有下载成功", { result });
  return result;
}
