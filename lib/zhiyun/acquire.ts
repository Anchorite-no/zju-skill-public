import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ConfigError, RemoteRejected, ZjuError } from "../core/errors.ts";
import { writeJson, readJson } from "../core/fsjson.ts";
import { paths } from "../core/paths.ts";
import { log } from "../core/output.ts";
import { BASE, type Zhiyun } from "./client.ts";
import { Transfer, downloadFile, pool, safeName, exists } from "./download.ts";
import { downloadMedia, extractLocalAudio, type AudioFormat } from "./media.ts";
import { slides, transcript } from "./materials.ts";
import { sha256 } from "./cache.ts";
import { publicLesson, type ResourceKind } from "./selection.ts";
import type { Lesson, Asset, Caption } from "./types.ts";
import { playbackAssets } from "./courses.ts";
import { selectQuality } from "./quality.ts";

export interface AcquiredFile { kind: ResourceKind; name: string; path: string; bytes: number; sha256: string; sourceKey: string; seconds?: number; sourceHeight?: number }
export interface AcquiredLesson extends ReturnType<typeof publicLesson> { files: AcquiredFile[] }
export interface DownloadManifest {
  version: 2; type: "zhiyun-download"; courseId: string; title: string; kinds: ResourceKind[];
  lessons: AcquiredLesson[]; status: "running" | "complete" | "failed";
  skipped: { lessonId: string; kind: ResourceKind; reason: string }[]; updatedAt: string;
}
type Task = { lesson: Lesson; kind: ResourceKind; name: string; out: string; sourceKey: string; asset?: Asset; captions?: Caption[]; fromVideo?: string };
export interface AcquireOptions { kinds: ResourceKind[]; outDir?: string; title?: string; format?: AudioFormat; threads?: number; retries?: number; timeoutMs?: number; resume?: boolean; dryRun?: boolean; signal?: AbortSignal }
export interface AcquireOperations { downloadFile: typeof downloadFile; downloadMedia: typeof downloadMedia; extractLocalAudio: typeof extractLocalAudio; slides: typeof slides; transcript: typeof transcript; playbackAssets: typeof playbackAssets }
const key = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export async function acquire(client: Zhiyun, lessons: Lesson[], opts: AcquireOptions, overrides: Partial<AcquireOperations> = {}) {
  if (!lessons.length) throw new ConfigError("所选范围没有课次");
  const ops = { downloadFile, downloadMedia, extractLocalAudio, slides, transcript, playbackAssets, ...overrides };
  const courseId = lessons[0]!.courseId;
  if (lessons.some(l => l.courseId !== courseId)) throw new ConfigError("一次下载须属于同一课程");
  const identity = lessons.map(l => l.subId).sort();
  const dir = path.resolve(opts.outDir ?? path.join(paths.output(), "zhiyun", courseId, lessons.length === 1 ? `${String(lessons[0]!.lesson).padStart(3, "0")}-${lessons[0]!.subId}` : `batch-${key(identity).slice(0, 10)}`));
  const manifestPath = path.join(dir, "download.json"), tasks: Task[] = [];
  const skipped: DownloadManifest["skipped"] = [];
  for (const lesson of lessons) {
    const folder = lessons.length === 1 ? dir : path.join(dir, `${String(lesson.lesson).padStart(3, "0")}-${lesson.subId}`);
    const media = opts.kinds.some(k => k === "video" || k === "audio") ? await ops.playbackAssets(client, lesson) : lesson.assets;
    const videos = media.filter(a => a.kind === "video");
    const video = selectQuality(videos, 1080);
    const audio = media.find(a => a.kind === "audio") ?? (opts.kinds.includes("video") ? video : selectQuality(videos, 360));
    const ext = video ? path.extname(new URL(video.url).pathname) : "";
    const videoPath = path.join(folder, `video${[".mp4", ".mkv", ".webm", ".mov"].includes(ext) ? ext : ".mp4"}`);
    for (const kind of opts.kinds) {
      const before = tasks.length;
      const add = (name: string, out: string, data: Partial<Task>) => tasks.push({ lesson, kind, name, out, sourceKey: key({ kind: kind === "ppt" ? "courseware" : kind, url: data.asset?.url, captions: data.captions, format: kind === "audio" ? opts.format ?? "m4a" : null,
        ...(data.asset?.kind === "video" && /\.m3u8$/i.test(new URL(data.asset.url).pathname) ? { qualityPolicy: kind === "audio" && !data.fromVideo ? "360p-v1" : "1080p-v1" } : {}) }), ...data });
      if (kind === "video" && lesson.playable && video) add("视频", videoPath, { asset: video });
      if (kind === "audio" && lesson.playable && audio) {
        add("音频", path.join(folder, `audio.${opts.format ?? "m4a"}`), { asset: audio,
          ...(opts.kinds.includes("video") && video?.url === audio.url ? { fromVideo: videoPath } : {}) });
      }
      if (kind === "ppt" || kind === "courseware") lesson.assets.filter(a => a.kind === "courseware").forEach((asset, i) => add(asset.name, path.join(folder, "materials", `${i + 1}-${safeName(asset.name)}`), { asset }));
      if (kind === "slides") (await ops.slides(client, courseId, lesson.subId)).forEach((asset, i) => add(asset.name, path.join(folder, "slides", `${i + 1}-${asset.seconds}s.jpg`), { asset }));
      if (kind === "subtitles") {
        // 这次课还没有字幕（当天的课课后才有）时站点是拒绝而不是给空表：按没有此类资源记，不让整批失败。
        const captions = await ops.transcript(client, courseId, lesson.subId).catch((error: unknown) => {
          if (error instanceof RemoteRejected && error.message.includes("未查询到语音数据")) return [];
          throw error;
        });
        if (captions.length) {
          add("站点字幕 JSON", path.join(folder, "subtitles.json"), { captions });
          add("站点字幕 TXT", path.join(folder, "subtitles.txt"), { captions });
        }
      }
      if (tasks.length === before) skipped.push({ lessonId: lesson.subId, kind, reason: "该课次没有可用的此类资源" });
    }
  }
  const plan = { courseId, kinds: opts.kinds, outDir: dir, manifest: manifestPath, tasks: tasks.map(t => ({ lessonId: t.lesson.subId, lessonNumber: t.lesson.lesson, kind: t.kind, path: t.out, ...(t.asset ? { url: t.asset.url } : {}), ...(t.fromVideo ? { audioFrom: t.fromVideo } : {}),
    ...(t.asset?.kind === "video" ? { preferredHeight: t.kind === "audio" && !t.fromVideo ? 360 : 1080, sourceHeight: t.asset.height ?? null } : {}) })), skipped };
  if (opts.dryRun) return { ...plan, dryRun: true };
  if (!tasks.length) throw new ConfigError("没有可下载的资源");
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, "download.lock"), handle = await fs.open(lock, "wx", 0o600).catch(() => { throw new ConfigError(`下载目录已锁定：${lock}`); });
  try {
    const previous = readJson<DownloadManifest>(manifestPath);
    if (!previous && await exists(manifestPath)) throw new ConfigError("download.json 损坏，请使用新目录");
    if (previous && (previous.version !== 2 || previous.type !== "zhiyun-download" || previous.courseId !== courseId || JSON.stringify(previous.lessons.map(l => l.lessonId).sort()) !== JSON.stringify(identity))) throw new ConfigError("输出目录属于不同课程或课次范围，请使用新目录");
    const state: DownloadManifest = { version: 2, type: "zhiyun-download", courseId, title: opts.title ?? previous?.title ?? `课程 ${courseId}`, kinds: opts.kinds,
      lessons: lessons.map(l => ({ ...publicLesson(l), files: previous?.lessons.find(p => p.lessonId === l.subId)?.files ?? [] })), status: "running", skipped, updatedAt: new Date().toISOString() };
    const save = () => { state.updatedAt = new Date().toISOString(); writeJson(manifestPath, state); }; save();
    const transfer = new Transfer({ threads: opts.threads ?? 4, retries: opts.retries ?? 2, timeoutMs: opts.timeoutMs ?? 120000, ...(opts.signal ? { signal: opts.signal } : {}), headers: url => {
      const cookie = ["classroom.zju.edu.cn", "yjapi.cmc.zju.edu.cn"].includes(new URL(url).hostname) ? client.ctx.http.jar.getCookieHeader(url) : "";
      return { Referer: BASE + "/", ...(cookie ? { Cookie: cookie } : {}) };
    } });
    const failures: { lessonId: string; kind: ResourceKind; path: string; error: string }[] = [], completed = new Set<string>();
    const perform = async (task: Task) => {
      try {
        const row = state.lessons.find(l => l.lessonId === task.lesson.subId)!;
        const old = row.files.find(f => f.path === task.out);
        if (await exists(task.out)) {
          if (old?.sourceKey !== task.sourceKey || old.bytes !== (await fs.stat(task.out)).size || old.sha256 !== await sha256(task.out)) throw new ConfigError(`已有文件与来源/哈希不符，保留原文件：${task.out}`);
          completed.add(task.out); return;
        }
        await fs.mkdir(path.dirname(task.out), { recursive: true });
        log(`第 ${task.lesson.lesson} 次课：${task.name}`);
        if (task.fromVideo) {
          if (!completed.has(task.fromVideo)) throw new ConfigError("所依赖的视频未下载成功，音频暂不提取");
          await ops.extractLocalAudio(task.fromVideo, task.out, opts.format ?? "m4a", opts.signal);
        } else if (task.captions) {
          const body = task.out.endsWith(".json") ? JSON.stringify({ courseId, lessonId: task.lesson.subId, captions: task.captions }, null, 2) : task.captions.map(c => `[${c.start.toFixed(1)}s] ${c.text}`).join("\n");
          await fs.writeFile(task.out, body + "\n", { flag: "wx", mode: 0o600 });
        } else if (task.kind === "video" || task.kind === "audio") await ops.downloadMedia(transfer, task.asset!, { out: task.out, audioOnly: task.kind === "audio", audioFormat: opts.format ?? "m4a", resume: opts.resume ?? true });
        else await ops.downloadFile(transfer, task.asset!.url, { out: task.out, resume: opts.resume ?? true });
        const file: AcquiredFile = { kind: task.kind, name: task.name, path: task.out, bytes: (await fs.stat(task.out)).size, sha256: await sha256(task.out), sourceKey: task.sourceKey, ...(task.asset?.seconds === undefined ? {} : { seconds: task.asset.seconds }), ...(task.asset?.height === undefined ? {} : { sourceHeight: task.asset.height }) };
        row.files = row.files.filter(f => f.path !== task.out).concat(file); save(); completed.add(task.out);
      } catch (e) { failures.push({ lessonId: task.lesson.subId, kind: task.kind, path: task.out, error: e instanceof Error ? e.message : String(e) }); }
    };
    await pool(tasks.filter(t => !t.fromVideo), Math.min(opts.threads ?? 4, 4), perform);
    await pool(tasks.filter(t => t.fromVideo), Math.min(opts.threads ?? 4, 4), perform);
    // File order is stable even when download completion order is not.
    for (const row of state.lessons) {
      for (const file of row.files) if (file.kind === "courseware") file.kind = "ppt";
      row.files.sort((a, b) => a.kind.localeCompare(b.kind) || (a.seconds ?? 0) - (b.seconds ?? 0) || a.path.localeCompare(b.path));
    }
    state.status = failures.length ? "failed" : "complete"; save();
    if (failures.length) throw new ZjuError("TRANSPORT", "部分下载失败，已完成文件可校验复用", { detail: { manifest: manifestPath, failures } });
    return { ...plan, dryRun: false, lessons: state.lessons, status: state.status };
  } finally { await handle.close(); await fs.unlink(lock).catch(() => {}); }
}
