import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { API, jsonContent, object, type Zhiyun } from "./client.ts";
import { BadResponse, ConfigError, NeedsUser } from "../core/errors.ts";
import { readJson, writeJson } from "../core/fsjson.ts";
import { paths } from "../core/paths.ts";
import { uniqueMatch } from "../core/match.ts";

export interface LiveLesson {
  courseId: string; subId: string; title: string; room: string; date: string;
  startsAt: number; endsAt: number; type: string;
}
export interface LiveCaption {
  id: string; source: "official-live"; startMs: number; endMs: number; receivedAtMs: number; text: string;
  final: boolean; fieldOrder: "normal" | "reversed";
  rawTimes: { time: number; text_begin_time: number; text_end_time: number };
}
export interface ListenInterval { start: number; end: number | null }
export interface LiveState {
  version: 1; lesson: LiveLesson; taskId: string; status: "waiting" | "connected" | "reconnecting" | "stopped" | "ended" | "failed";
  updatedAt: number; intervals: ListenInterval[]; count: number; initialCount: number; lastActivityAt: number | null;
  lastCaptionAt: number | null; latest: LiveCaption | null; error: string | null;
}
export const liveRoot = () => path.join(paths.data(), "live");
export const beijingDate = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
export const beijingTime = (time: number) => new Date(time + 8 * 3600_000).toISOString().replace("Z", "+08:00");
export function lessonDirectory(lesson: LiveLesson): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lesson.date) || !/^\d+$/.test(lesson.courseId) || !/^\d+$/.test(lesson.subId)) throw new BadResponse("直播课次存储标识无效");
  return path.join(liveRoot(), lesson.date, `${lesson.courseId}-${lesson.subId}`);
}

export async function dayLessons(client: Zhiyun, date = beijingDate()): Promise<LiveLesson[]> {
  const j = await client.json(API + "/courseapi/v2/course-live/get-my-course-day", { date });
  const groups = j.list;
  if (!groups || typeof groups !== "object") throw new BadResponse("当天课程响应缺少 list");
  const lessons: LiveLesson[] = [];
  for (const raw of Object.values(groups)) {
    const group = object(raw, "课程时段");
    if (!Array.isArray(group.course)) throw new BadResponse("课程时段缺少 course 数组");
    for (const value of group.course) {
      const r = object(value), startsAt = Number(r.course_begin) * 1000, endsAt = Number(r.course_over) * 1000;
      if (!/^\d+$/.test(String(r.course_id)) || !/^\d+$/.test(String(r.sub_id)) || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt <= 0 || endsAt <= startsAt) throw new BadResponse("当天课次标识或时间无效");
      if (!["course_live", "live", "ilive"].includes(String(r.multi_type))) continue;
      lessons.push({ courseId: String(r.course_id), subId: String(r.sub_id), title: String(r.title ?? ""), room: String(r.room_name ?? ""), date, startsAt, endsAt, type: String(r.multi_type) });
    }
  }
  return [...new Map(lessons.map(l => [l.subId, l])).values()].sort((a, b) => a.startsAt - b.startsAt);
}

export function matchLiveCourse<T extends { courseId: string; title: string }>(rows: T[], course?: string): T[] {
  if (!course) return rows;
  const courses = [...new Map(rows.map(r => [r.courseId, r])).values()];
  const chosen = uniqueMatch(courses, course, r => [r.title, r.courseId], r => ({ course: r.title, courseId: r.courseId }), "课程");
  return rows.filter(r => r.courseId === chosen.courseId);
}

export async function liveAddress(client: Zhiyun, lesson: LiveLesson): Promise<{ address: string | null; ended: boolean }> {
  const j = await client.json(API + "/courseapi/v3/portal-home-setting/get-sub-info", { course_id: lesson.courseId, sub_id: lesson.subId });
  const d = object(j.data);
  if (String(d.course_id) !== lesson.courseId || String(d.sub_id) !== lesson.subId) throw new BadResponse("实时字幕课次与请求不一致");
  const content = jsonContent(d.content);
  return { address: typeof content.trans_socket_url === "string" && content.trans_socket_url ? content.trans_socket_url : null, ended: ["3", "6"].includes(String(d.sub_status)) };
}

export function normalizeLiveCaption(value: unknown, receivedAt: number, lesson: LiveLesson): LiveCaption | undefined {
  const r = object(value, "实时字幕");
  if (r.error) throw new BadResponse("官方字幕上游报告错误");
  if (typeof r.sourcetext !== "string") throw new BadResponse("实时字幕缺少原文");
  if (!r.sourcetext.trim()) return undefined;
  if (![1, -1].includes(Number(r.end_time))) throw new BadResponse("实时字幕定稿标识无效");
  const begin = Number(r.text_begin_time), end = Number(r.text_end_time), time = Number(r.time);
  const startMs = Math.min(begin, end), endMs = Math.max(begin, end);
  if (![begin, end, time].every(Number.isSafeInteger) || startMs < lesson.startsAt - 3600_000 || endMs > lesson.endsAt + 600_000 || endMs > receivedAt + 60000 || endMs - startMs > 600000 || (time !== begin && time !== end)) {
    throw new BadResponse("实时字幕时间字段异常，未将其伪造为接收时间");
  }
  const text = r.sourcetext.trim();
  return { id: crypto.createHash("sha256").update(JSON.stringify([lesson.subId, startMs, endMs, text])).digest("hex"), source: "official-live", startMs, endMs, receivedAtMs: receivedAt, text, final: Number(r.end_time) === 1,
    fieldOrder: begin <= end ? "normal" : "reversed", rawTimes: { time, text_begin_time: begin, text_end_time: end } };
}

/** A partial tail can belong to a concurrent append; a corrupt complete line is an error. */
export function readLiveCaptions(file: string): LiveCaption[] {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const lines = text.split("\n"), captions: LiveCaption[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === lines.length - 1 && !text.endsWith("\n")) break;
    if (!lines[i]?.trim()) continue;
    let row: LiveCaption;
    try { row = JSON.parse(lines[i]!); } catch {
      if (i === lines.length - 1 && !text.endsWith("\n")) break;
      throw new BadResponse("已保存的实时字幕中有损坏行", { file, line: i + 1 });
    }
    if (!row.final || typeof row.id !== "string" || typeof row.text !== "string" || !Number.isSafeInteger(row.startMs) || !Number.isSafeInteger(row.endMs) || row.endMs < row.startMs) throw new BadResponse("已保存的实时字幕字段无效", { file, line: i + 1 });
    captions.push(row);
  }
  return captions;
}

export class LiveTranscript {
  readonly directory: string;
  readonly file: string;
  readonly state: LiveState;
  private readonly seen = new Set<string>();
  private writtenAt = 0;
  private finalizedThrough = 0;
  constructor(lesson: LiveLesson, taskId: string, now = Date.now()) {
    this.directory = lessonDirectory(lesson); this.file = path.join(this.directory, "transcript.jsonl");
    fs.mkdirSync(this.directory, { recursive: true });
    const saved = readJson<LiveState>(path.join(this.directory, "status.json"));
    const rows = readLiveCaptions(this.file);
    rows.forEach(r => this.seen.add(r.id));
    this.finalizedThrough = Math.max(0, ...rows.map(r => r.endMs));
    // Preserve a crash-truncated tail for diagnosis, then remove only that uncommitted fragment.
    if (fs.existsSync(this.file)) {
      const bytes = fs.readFileSync(this.file);
      if (bytes.length && bytes.at(-1) !== 10) {
        const end = bytes.lastIndexOf(10) + 1;
        fs.writeFileSync(path.join(this.directory, `incomplete-${now}.txt`), bytes.subarray(end), { mode: 0o600 });
        fs.truncateSync(this.file, end);
        this.seen.clear(); readLiveCaptions(this.file).forEach(r => this.seen.add(r.id));
      }
    }
    const intervals = (saved?.intervals ?? []).map(i => ({ start: i.start, end: i.end ?? saved!.updatedAt }));
    this.state = { version: 1, lesson, taskId, status: "waiting", updatedAt: now, intervals, count: this.seen.size, initialCount: this.seen.size, lastActivityAt: saved?.lastActivityAt ?? null, lastCaptionAt: rows.at(-1)?.receivedAtMs ?? null, latest: null, error: null };
    this.save(true, now);
  }
  save(force = false, now = Date.now()) {
    if (!force && now - this.writtenAt < 2000) return;
    this.state.updatedAt = now;
    writeJson(path.join(this.directory, "status.json"), this.state); this.writtenAt = now;
  }
  connect(now = Date.now()) {
    this.state.status = "connected"; this.state.error = null;
    if (this.state.intervals.at(-1)?.end !== null) this.state.intervals.push({ start: now, end: null });
    this.state.lastActivityAt = now; this.save(true, now);
  }
  activity(now = Date.now()) { this.state.lastActivityAt = now; this.save(false, now); }
  caption(value: unknown, receivedAt: number) {
    let caption: LiveCaption | undefined;
    try { caption = normalizeLiveCaption(value, receivedAt, this.state.lesson); }
    catch (e) { this.state.error = e instanceof Error ? e.message : String(e); this.save(true, receivedAt); return; }
    if (!caption) return;
    if (!caption.final) {
      // Older drafts can arrive after a final; never resurrect the finalized sentence.
      if (caption.startMs >= this.finalizedThrough && (!this.state.latest || caption.startMs >= this.state.latest.startMs)) this.state.latest = caption;
    } else {
      if (!this.seen.has(caption.id)) {
        const fd = fs.openSync(this.file, "a", 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(caption) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        this.seen.add(caption.id); this.state.count = this.seen.size;
      }
      if (!this.state.latest || this.state.latest.startMs <= caption.endMs) this.state.latest = caption;
      this.state.lastCaptionAt = receivedAt;
      this.finalizedThrough = Math.max(this.finalizedThrough, caption.endMs);
    }
    this.save(caption.final, receivedAt);
  }
  disconnect(status: LiveState["status"], error: string | null = null, now = Date.now()) {
    const open = this.state.intervals.at(-1);
    if (open?.end === null) open.end = Math.min(now, this.state.lastActivityAt ?? now);
    this.state.status = status; this.state.error = error; this.save(true, now);
  }
}

export function parseLiveTime(input?: string, now = Date.now()): number {
  if (input === undefined) return now;
  let value = input.trim();
  if (/^\d{2}:\d{2}(?::\d{2})?$/.test(value)) value = `${beijingDate(now)}T${value}+08:00`;
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) value = value.replace(" ", "T") + "+08:00";
  else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new ConfigError("--at 须为北京时间 HH:mm[:ss]、日期时间或带时区 ISO 时间");
  const time = Date.parse(value);
  const date = value.slice(0, 10), [year, month, day] = date.split("-").map(Number);
  if (!Number.isFinite(time) || new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) !== date || Number(value.slice(11, 13)) > 23) throw new ConfigError("--at 时间无效");
  return time;
}

export function savedLiveStates(start: number, end: number): LiveState[] {
  const states: LiveState[] = [];
  const first = Date.parse(beijingDate(start - 86400_000) + "T00:00:00+08:00"), last = end;
  for (let day = first; day <= last; day += 86400_000) {
    const dir = path.join(liveRoot(), beijingDate(day));
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+-\d+$/.test(entry.name)) continue;
      const s = readJson<LiveState>(path.join(dir, entry.name, "status.json"));
      if (!s || s.version !== 1 || !s.lesson || !Array.isArray(s.intervals)) throw new BadResponse("直播状态文件损坏", { directory: dir, entry: entry.name });
      if (s.lesson.startsAt - 300000 <= end && s.lesson.endsAt + 300000 >= start) states.push(s);
    }
  }
  return states;
}

export function missingIntervals(start: number, end: number, intervals: ListenInterval[], now: number): { start: number; end: number }[] {
  const gaps: { start: number; end: number }[] = []; let cursor = start;
  for (const i of [...intervals].sort((a, b) => a.start - b.start)) {
    const a = Math.max(start, i.start), b = Math.min(end, i.end ?? now);
    if (b <= cursor || a > end) continue;
    if (a > cursor) gaps.push({ start: cursor, end: a });
    cursor = Math.max(cursor, b);
  }
  if (cursor < end) gaps.push({ start: cursor, end });
  return gaps;
}

export function queryLiveText(opts: { at: number; before: number; after: number; course?: string }, now = Date.now()) {
  const start = opts.at - opts.before * 1000, end = opts.at + opts.after * 1000;
  const states = savedLiveStates(start, end);
  const matched = opts.course && states.length ? matchLiveCourse(states.map(s => ({ ...s.lesson, state: s })), opts.course).map(r => r.state) : states;
  if (matched.length > 1) {
    const error = new NeedsUser("文字窗口对应多个课次，请指定课程或缩小时间范围");
    error.detail.candidates = matched.map(s => ({ course: s.lesson.title, at: beijingTime(s.lesson.startsAt) })); throw error;
  }
  const s = matched[0];
  if (!s) return { status: "unavailable", message: "该时间窗口没有已保存的课堂字幕；晚启动不能补回此前实时文字。", window: { start: beijingTime(start), end: beijingTime(end) }, text: "", segments: [], gaps: [{ start: beijingTime(start), end: beijingTime(end) }] };
  const file = path.join(lessonDirectory(s.lesson), "transcript.jsonl");
  const rows = readLiveCaptions(file).filter(r => r.startMs <= end && r.endMs >= start);
  const latest = s.latest && !s.latest.final && s.latest.startMs <= end && s.latest.endMs >= start ? s.latest : null;
  const task = readJson<{ id: string; status: string; updatedAt: number }>(path.join(liveRoot(), "task.json"));
  const alive = task?.id === s.taskId && task.status === "running" && now - task.updatedAt < 20000;
  const receiving = alive && s.status === "connected" && now - (s.lastActivityAt ?? 0) < 45000;
  const intervals = s.intervals.map(i => ({ start: i.start, end: i.end ?? (receiving ? now : s.updatedAt) }));
  const gaps = missingIntervals(start, Math.min(end, now), intervals, now);
  const pending = end > now || (end > now - 10000 && alive);
  const status = !rows.length ? "no-text" : gaps.length || pending || end > now ? "partial" : "available";
  const detail = gaps.length ? "窗口含未监听或断线时段。" : "监听区间连续；官方字幕仍可能漏识别。";
  return { status, message: `${s.lesson.title}：${rows.length} 句已定稿文字。${detail}${end > now ? "窗口包含尚未发生的时间。" : pending ? "窗口末尾的字幕可能仍在生成。" : ""}${!alive && s.status === "connected" ? "采集进程当前不可用。" : ""}`,
    course: s.lesson.title, window: { start: beijingTime(start), end: beijingTime(end) }, text: rows.map(r => r.text).join("\n"),
    segments: rows.map(r => ({ start: beijingTime(r.startMs), end: beijingTime(r.endMs), text: r.text, receivedAt: beijingTime(r.receivedAtMs) })),
    preview: latest ? { text: latest.text, final: false } : null, pending,
    gaps: gaps.map(g => ({ start: beijingTime(g.start), end: beijingTime(g.end) })), source: "official-live", file,
  };
}
