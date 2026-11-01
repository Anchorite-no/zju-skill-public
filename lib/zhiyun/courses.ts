import { API, BASE, MY_COURSES, id, jsonContent, object, type Zhiyun } from "./client.ts";
import { abbreviates, uniqueMatch } from "../core/match.ts";
import { BadResponse, ConfigError, RemoteRejected } from "../core/errors.ts";
import type { Asset, Course, Lesson, Page, JsonObject } from "./types.ts";
import { videoHeight } from "./quality.ts";

export function positive(value: number, label: string, max = 10000): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new ConfigError(`${label}须在 1..${max} 之间`);
  return value;
}
/** 平台学期码「2026-20271」= 2026-2027 学年第 1 学期（秋冬），2 为春夏。 */
export function termName(code: string): string {
  const m = code.match(/^(\d{4}-\d{4})([12])$/);
  return m ? m[1] + (m[2] === "1" ? "秋冬" : "春夏") : code;
}
function course(value: unknown): Course {
  const c = object(value); const courseId = id(c.Id ?? c.course_id ?? c.id);
  return { id: courseId, title: String(c.Title ?? c.title ?? ""), teacher: String(c.Teacher ?? c.realname ?? c.lecturer_name ?? ""), term: termName(String(c.TermName ?? c.term_name ?? "")), url: `${BASE}/coursedetail?course_id=${courseId}` };
}
function total(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new BadResponse("分页 total 无效");
  return n;
}
export async function myCourses(client: Zhiyun, opts: { page?: number; pageSize?: number; keyword?: string } = {}): Promise<Page<Course>> {
  const pageSize = positive(opts.pageSize ?? 100, "size", 100), rows: Course[] = [], seen = new Set<string>();
  let expected = 0;
  for (let page = opts.page ?? 1; ; page++) {
    if (page > 1000) throw new BadResponse("课程分页超过上限，查询不完整");
    const data = await client.json(MY_COURSES, { nowpage: page, "per-page": pageSize, force_mycourse: 1 });
    const result = object(object(data.params).result);
    if (!Array.isArray(result.data)) throw new BadResponse("我的课程缺少 data 数组");
    expected = total(result.total);
    const batch = result.data.map(course);
    for (const item of batch) { if (seen.has(item.id)) throw new BadResponse("课程分页重复，停止避免漏查"); seen.add(item.id); rows.push(item); }
    if (opts.page !== undefined || rows.length >= expected) break;
    if (!batch.length) throw new BadResponse("课程分页提前结束，结果不完整");
  }
  const items = rows.filter(c => !opts.keyword || (c.title + " " + c.teacher + " " + c.term).toLowerCase().includes(opts.keyword.toLowerCase()));
  return { items, page: opts.page ?? 1, pageSize, total: opts.page === undefined ? items.length : expected };
}
export async function findCourses(client: Zhiyun, opts: { keyword?: string; teacher?: string; scope?: string }) {
  if (opts.scope !== 'all') {
    const result = await myCourses(client, opts);
    return result.items.filter(c => !opts.teacher || c.teacher.includes(opts.teacher));
  }
  const result = new Map<string, Course>(); let scanned = 0;
  for (let page = 1; page <= 1000; page++) {
    const batch = await searchCourses(client, { ...opts, page, pageSize: 100 });
    for (const c of batch.items) result.set(c.id, c);
    scanned += batch.matches.length;
    if (scanned >= batch.total) return [...result.values()].sort((a, b) => Number(b.id) - Number(a.id));
    if (!batch.matches.length) throw new BadResponse('全站课程搜索分页提前结束');
  }
  throw new BadResponse('全站课程搜索超过分页上限');
}
/**
 * 学期的先后：学年起始年 ×10，秋冬为 1、春夏为 2。写法有「2026-2027秋冬」和旧的「2024-2025秋,2024-2025冬」两种，
 * 认不出的返回 0。
 */
export function termOrder(term: string): number {
  const year = Number(term.match(/(\d{4})-\d{4}/)?.[1]);
  return year ? year * 10 + (/[春夏]/.test(term) ? 2 : 1) : 0;
}
/** 现在所在的学期：8 月到次年 1 月是秋冬，2 月到 7 月是春夏（按北京时间）。 */
export function currentTermOrder(now = Date.now()): number {
  const d = new Date(now + 8 * 3600_000), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  return m >= 8 ? y * 10 + 1 : m === 1 ? (y - 1) * 10 + 1 : (y - 1) * 10 + 2;
}

/**
 * 课程名（或平台课程编号）→ 课程。同名课程可用教师名区分；匹配到多门时取当前学期的，当前学期没开就取最近一次开的，
 * 不取还没开始的学期。那个学期仍有多门（不同教师）时给候选。
 */
export async function resolveCourse(client: Zhiyun, query: string, teacher?: string, now = Date.now()): Promise<{ id: string; course?: Course; otherTerms?: number; current?: boolean }> {
  if (/^\d+$/.test(query)) return { id: id(query) };
  const by = teacher ? { teacher } : {};
  let rows = await findCourses(client, { keyword: query, ...by });
  // 我的课程里按简称再找一遍（计组 → 计算机组成）。
  if (!rows.length) rows = (await findCourses(client, by)).filter(r => abbreviates(query, r.title));
  // Recordings are open to all students; courses outside "mine" come from the site-wide search, newest first.
  if (!rows.length) rows = await findCourses(client, { keyword: query, ...by, scope: "all" }).catch((error: unknown) => {
    if (error instanceof RemoteRejected && error.message.includes("没有数据")) return [];
    throw error;
  });
  if (teacher) rows = rows.filter(r => r.teacher.includes(teacher));
  const names = (r: Course) => [r.title, r.id, ...(abbreviates(query, r.title) ? [query] : [])];
  const fold = (v: string) => v.normalize("NFKC").trim().toLowerCase();
  const wanted = fold(query), exact = rows.filter(r => names(r).some(n => fold(n) === wanted));
  const matches = exact.length ? exact : rows.filter(r => names(r).some(n => fold(n).includes(wanted)));
  const describe = (r: Course) => ({ course: r.title, teacher: r.teacher, term: r.term, id: r.id });
  if (matches.length < 2) { const course = uniqueMatch(rows, query, names, describe, '课程'); return { id: course.id, course }; }
  // 多门匹配：只看已经开始的学期里最近的那一个。
  const today = currentTermOrder(now), started = matches.filter(r => { const o = termOrder(r.term); return o > 0 && o <= today; });
  const latest = Math.max(0, ...started.map(r => termOrder(r.term))), recent = started.filter(r => termOrder(r.term) === latest);
  if (recent.length === 1) return { id: recent[0]!.id, course: recent[0]!, otherTerms: matches.length - 1, current: latest === today };
  // 那个学期仍有多门（不同教师或教学班）时候选只列这几门；学期认不出时列全部匹配。
  const course = uniqueMatch(recent.length ? recent : matches, query, names, describe, '课程');
  return { id: course.id, course };
}
export async function searchCourses(client: Zhiyun, opts: { keyword?: string; teacher?: string; page?: number; pageSize?: number }): Promise<Page<Course> & { matches: { courseId: string; subId: string; title: string }[] }> {
  if (!opts.keyword?.trim() && !opts.teacher?.trim()) throw new ConfigError("需要 --keyword 或 --teacher");
  const user = await client.user();
  const page = positive(opts.page ?? 1, "page"), pageSize = positive(opts.pageSize ?? 20, "size", 100);
  const data = await client.json(BASE + "/pptnote/v1/searchlist", { tenant_id: user.tenantId, user_id: user.id, user_name: user.account, title: opts.keyword ?? "", realname: opts.teacher ?? "", page, per_page: pageSize, source: 1 });
  const result = object(data.total);
  if (!Array.isArray(result.list)) throw new BadResponse("搜索缺少 total.list");
  const rows = result.list.map(objectRow => object(objectRow));
  return { items: [...new Map(rows.map(c => { const row = course(c); return [row.id, row] as const; })).values()], matches: rows.map(c => ({ courseId: id(c.course_id), subId: id(c.sub_id), title: String(c.subject_title ?? "") })), page, pageSize, total: total(result.total) };
}
function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
}
export function assets(content: JsonObject): Asset[] {
  const result: Asset[] = [];
  const add = (kind: Asset["kind"], name: string, value: unknown) => {
    const url = webUrl(value), height = kind === "video" && url ? videoHeight(url) ?? videoHeight(name) : undefined;
    if (url && !result.some(a => a.kind === kind && a.url === url)) result.push({ kind, name, url, ...(height === undefined ? {} : { height }) });
  };
  if (content.playback && typeof content.playback === "object") add("video", "回放", object(content.playback).url);
  if (content.audio && typeof content.audio === "object") add("audio", "音频", object(content.audio).url);
  add("audio", "音频", content.audio_url);
  if (Array.isArray(content.file_list)) for (const value of content.file_list) {
    const f = object(value), url = webUrl(f.file_name); if (!url) continue;
    const ext = new URL(url).pathname.toLowerCase();
    if (/\.(mp3|m4a|aac|wav|ogg|flac)$/.test(ext)) add("audio", String(f.file_type ?? "音频"), url);
    else if (/\.(mp4|m3u8|webm|mkv)$/.test(ext)) add("video", String(f.file_type ?? "回放"), url);
  }
  if (content.download && typeof content.download === "object") for (const [key, value] of Object.entries(object(content.download))) {
    if (!value || typeof value !== "object") continue;
    const f = object(value); add("courseware", String(f.file_name ?? key), f.path_name ?? f.url);
  }
  return result;
}

/** The catalogue may contain only the original video; the player exposes alternate encodes here. */
export async function playbackAssets(client: Zhiyun, lesson: Lesson): Promise<Asset[]> {
  if (!lesson.playable) return lesson.assets;
  const response = await client.json(API + "/courseapi/v3/portal-home-setting/get-sub-info", { course_id: lesson.courseId, sub_id: lesson.subId });
  const data = object(response.data);
  if (data.course_id !== undefined && String(data.course_id) !== lesson.courseId || data.sub_id !== undefined && String(data.sub_id) !== lesson.subId) throw new BadResponse("播放器返回的课程/课次与请求不符");
  const result = lesson.assets.map(a => {
    const height = a.kind === "video" ? a.height ?? videoHeight(a.url) : undefined;
    return { ...a, ...(height === undefined ? {} : { height }) };
  });
  const urls = typeof data.playurl === "string" ? [data.playurl] : data.playurl && typeof data.playurl === "object" ? Object.values(data.playurl) : [];
  for (const value of urls) {
    const url = webUrl(value); if (!url || result.some(a => a.kind === "video" && a.url === url)) continue;
    const height = videoHeight(url);
    result.push({ kind: "video", name: height ? `回放 ${height}p` : "回放", url, ...(height === undefined ? {} : { height }) });
  }
  return result;
}
// ilive lessons (e.g. 中国古代小说鉴赏) carry the same playback and caption data as course_live.
const LESSON_TYPES = new Set(["course_live", "live", "ilive"]);
export function normalizeLessons(value: unknown, courseId: string): Lesson[] {
  if (!Array.isArray(value)) throw new BadResponse("课次目录缺少数组");
  const rows: Lesson[] = [], unknown = new Set<string>();
  for (const raw of value) {
    const r = object(raw);
    if (String(r.sub_delete ?? "0") !== "0" || r.sub_show === "no") continue;
    if (!LESSON_TYPES.has(String(r.type))) { unknown.add(String(r.type)); continue; }
    const subId = id(r.sub_id), time = Number(r.start_at);
    if (!Number.isFinite(time) || time <= 0) throw new BadResponse("课次缺少有效开课时间，无法可靠编号", { subId });
    const content = jsonContent(r.content);
    const list = assets(content);
    rows.push({ lesson: 0, courseId, subId, title: String(r.title ?? ""), teacher: String(r.lecturer_name ?? ""), startsAt: new Date(time * 1000 + 8 * 3600_000).toISOString().replace(".000Z", "+08:00"), status: String(r.status), playable: String(r.status) === "6" && list.some(a => a.kind === "video" || a.kind === "audio"), url: `${BASE}/livingroom?course_id=${courseId}&sub_id=${subId}`, assets: list });
  }
  // An empty list would read as "no lessons"; a new lesson type must surface instead.
  if (!rows.length && unknown.size) throw new BadResponse("课次目录只有未识别的类型，未能列出课次", { types: [...unknown] });
  const unique = [...new Map(rows.map(r => [r.subId, r])).values()];
  unique.sort((a, b) => a.startsAt!.localeCompare(b.startsAt!) || Number(a.subId) - Number(b.subId));
  return unique.map((r, i) => ({ ...r, lesson: i + 1 }));
}
export async function catalogue(client: Zhiyun, courseId: string): Promise<Lesson[]> {
  const data = await client.json(API + "/courseapi/v2/course/catalogue", { course_id: id(courseId) });
  return normalizeLessons(object(data.result).data, courseId);
}
export function selectLessons(rows: Lesson[], opts: { lesson?: string; subId?: string; date?: string; weekOf?: string; all?: boolean } = {}): Lesson[] {
  if ([opts.lesson, opts.subId, opts.date, opts.weekOf, opts.all].filter(Boolean).length > 1) throw new ConfigError("--lesson / --lesson-id / --date / --week-of / --all 只能选一种");
  if (opts.subId) { const selected = rows.filter(r => r.subId === id(opts.subId)); if (!selected.length) throw new ConfigError("该课次不属于所选课程"); return selected; }
  if (opts.lesson) {
    const numbers = new Set<number>();
    for (const part of opts.lesson.split(",")) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/); if (!m) throw new ConfigError("--lesson 格式为 1 或 1,3-5");
      const a = positive(Number(m[1]), "lesson"), b = positive(Number(m[2] ?? m[1]), "lesson");
      if (a > b) throw new ConfigError("lesson 范围须递增");
      for (let i = a; i <= b; i++) numbers.add(i);
    }
    for (const n of numbers) if (!rows.some(r => r.lesson === n)) throw new ConfigError(`没有第 ${n} 次课`);
    return rows.filter(r => numbers.has(r.lesson));
  }
  if (opts.date || opts.weekOf) {
    const input = (opts.date ?? opts.weekOf)!;
    const stamp = Date.parse(input + "T00:00:00+08:00");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || !Number.isFinite(stamp) || new Date(stamp + 8 * 3600_000).toISOString().slice(0, 10) !== input) throw new ConfigError("日期须为有效 YYYY-MM-DD");
    const weekday = new Date(stamp + 8 * 3600_000).getUTCDay();
    const start = opts.weekOf ? stamp - ((weekday + 6) % 7) * 86400_000 : stamp;
    const end = start + (opts.weekOf ? 7 : 1) * 86400_000;
    return rows.filter(r => r.startsAt && Date.parse(r.startsAt) >= start && Date.parse(r.startsAt) < end);
  }
  return rows;
}
