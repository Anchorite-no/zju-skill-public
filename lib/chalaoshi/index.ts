/**
 * 查老师（chalaoshi.de）。
 *
 * 站点没有搜索接口：首页把 /static/json/search.json（≈1 MB，10295 位教师）整个下载后在浏览器里过滤。
 * 本模块照做：索引缓存在 data/cache/chalaoshi-index.json，用 ETag / Last-Modified 做条件 GET（304 不传体），
 * 搜索纯本地（<1ms）；只有教师详情、评论、课程绩点表才打站点。
 *
 * 声明：auth=none。network 写 public 但 chalaoshi.de 在国内公网被墙（2026-09-17 外部主机实测不通，
 * 两个 ip6.arpa 镜像已死），需要本机自己有出海路径；WebVPN 帮不上忙（不是校内站）。
 *
 * 2026-09-17 实测：索引 1.7–3.0s；教师页 0.5–1.8s；api 子域评论 0.7–1.2s（全部评论一次返回）；gpa 表 1.2s。
 */
import type { ModuleRequirements } from "../core/module.ts";
import { openContext, type Context } from "../webvpn/transport.ts";
import { readJson, writeJson } from "../core/fsjson.ts";
import { paths } from "../core/paths.ts";
import path from "node:path";
import { BadResponse, ConfigError, RemoteRejected, TransportError } from "../core/errors.ts";
import { log, debug } from "../core/output.ts";
import { requireReachable } from "../core/reach.ts";

export const SITE = "https://chalaoshi.de";
export const API = "https://api.chalaoshi.de";

export const requirements: ModuleRequirements = {
  name: "chalaoshi",
  title: "查老师",
  hosts: ["chalaoshi.de"],
  auth: "none",
  network: "public",
  writes: false,
  sessionProbe: `${SITE}/`,
};

/**
 * 站点在国内被墙：只在真正要联网前探一次（索引缓存新鲜时 search 完全不联网，不探）。
 * 通了缓存 10 分钟；不通抛 TransportError 说明需要出海。
 */
let preflightDone = false;
async function preflight(): Promise<void> {
  if (preflightDone) return;
  await requireReachable(["chalaoshi.de"]);
  preflightDone = true;
}

// ---------- 索引 ----------

export interface IndexTeacher {
  id: number;
  name: string;
  /** 全拼 */
  py: string;
  /** 首字母 */
  sx: string;
  /** 学院 id */
  xy: number;
  hot: number;
  /** "9.4" / "0.0"（无评分）/ "N/A" */
  rate: string;
}

export interface IndexFile {
  version: 1;
  fetchedAt: number;
  etag?: string;
  lastModified?: string;
  colleges: { id: number; name: string }[];
  teachers: IndexTeacher[];
}

/** 索引本地缓存视为新鲜的时长；过期后下次用前做一次条件 GET */
const INDEX_TTL_MS = 7 * 24 * 3600 * 1000;

export function indexFile(): string {
  return path.join(paths.cache(), "chalaoshi-index.json");
}

export function loadIndex(): IndexFile | undefined {
  const f = readJson<IndexFile>(indexFile());
  return f && f.version === 1 && Array.isArray(f.teachers) ? f : undefined;
}

export interface SyncResult {
  source: "cache" | "not-modified" | "downloaded";
  teachers: number;
  colleges: number;
  fetchedAt: number;
  ageMs: number;
  lastModified?: string;
}

/** 确保索引可用：缓存新鲜直接用；否则条件 GET；--fresh 强制重下 */
export async function ensureIndex(ctx: Context, opts: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<{ index: IndexFile; sync: SyncResult }> {
  const cached = loadIndex();
  const maxAge = opts.maxAgeMs ?? INDEX_TTL_MS;
  const summary = (index: IndexFile, source: SyncResult["source"]): SyncResult => {
    const s: SyncResult = { source, teachers: index.teachers.length, colleges: index.colleges.length, fetchedAt: index.fetchedAt, ageMs: Date.now() - index.fetchedAt };
    if (index.lastModified) s.lastModified = index.lastModified;
    return s;
  };
  if (cached && !opts.fresh && Date.now() - cached.fetchedAt < maxAge) return { index: cached, sync: summary(cached, "cache") };

  const headers: Record<string, string> = { Accept: "application/json" };
  if (cached && !opts.fresh) {
    if (cached.etag) headers["If-None-Match"] = cached.etag;
    if (cached.lastModified) headers["If-Modified-Since"] = cached.lastModified;
  }
  let res;
  try {
    await preflight();
    res = await ctx.fetch(`${SITE}/static/json/search.json`, { headers, timeout: 30000 });
  } catch (err) {
    if (cached) {
      log(`查老师索引刷新失败（${(err as Error).message}），沿用 ${Math.round((Date.now() - cached.fetchedAt) / 3600000)} 小时前的缓存`);
      return { index: cached, sync: summary(cached, "cache") };
    }
    throw err;
  }
  if (res.status === 304 && cached) {
    cached.fetchedAt = Date.now();
    writeJson(indexFile(), cached);
    return { index: cached, sync: summary(cached, "not-modified") };
  }
  if (res.status !== 200) throw new TransportError(`查老师索引 HTTP ${res.status}`, { status: res.status });
  const body = res.json<{ colleges?: unknown; teachers?: unknown }>();
  if (!body || !Array.isArray(body.teachers) || !Array.isArray(body.colleges)) throw new BadResponse("查老师索引不是预期的 {colleges, teachers}");
  const index: IndexFile = { version: 1, fetchedAt: Date.now(), colleges: body.colleges as IndexFile["colleges"], teachers: body.teachers as IndexTeacher[] };
  const etag = res.headers["etag"];
  const lm = res.headers["last-modified"];
  if (typeof etag === "string") index.etag = etag;
  if (typeof lm === "string") index.lastModified = lm;
  writeJson(indexFile(), index);
  log(`查老师索引已更新：${index.teachers.length} 位教师`);
  return { index, sync: summary(index, "downloaded") };
}

// ---------- 本地搜索 ----------
// 线性扫 10295 条约 0.15 ms（读+解析 1 MB 缓存约 6 ms），不需要建索引；值得做的是排序质量。

export type TeacherSort = "score" | "rate" | "hot" | "name";

export interface SearchOptions {
  /** 学院名（子串）或学院 id */
  college?: string | number;
  /** score：按匹配得分（默认）；rate / hot / name：只在得分档相同时才起作用 → 改为整体按该键 */
  sort?: TeacherSort;
  limit?: number;
  /** 只要有评分的 */
  ratedOnly?: boolean;
}

export type MatchKind = "name" | "name-prefix" | "name-part" | "name-fuzzy" | "initials" | "initials-prefix" | "pinyin" | "pinyin-prefix" | "pinyin-part";

export interface TeacherHit extends IndexTeacher {
  college: string;
  /** 数值评分；无评分为 null */
  rating: number | null;
  match: MatchKind;
  /** 是否姓名完全相等（同名消歧用） */
  exact: boolean;
  score: number;
  url: string;
}

export function parseRate(rate: string): number | null {
  const n = Number(rate);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function norm(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** 按顺序出现但可不连续（"王辉" ⊂ "王伟辉"），只用于 ≥2 个汉字的查询 */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (const ch of s) if (ch === q[i] && ++i === q.length) return true;
  return false;
}

/** 单个 token 对单个教师的匹配得分（0 = 不匹配） */
function scoreToken(t: IndexTeacher, q: string): { score: number; match: MatchKind } | null {
  const name = norm(t.name);
  if (name === q) return { score: 100, match: "name" };
  const ascii = /^[a-z0-9]+$/.test(q);
  if (!ascii) {
    if (name.startsWith(q)) return { score: 80, match: "name-prefix" };
    if (name.includes(q)) return { score: 60, match: "name-part" };
    if (q.length >= 2 && /^[\p{Script=Han}]+$/u.test(q) && isSubsequence(q, name)) return { score: 30, match: "name-fuzzy" };
    return null;
  }
  const sx = t.sx.toLowerCase();
  const py = t.py.toLowerCase();
  if (py === q) return { score: 90, match: "pinyin" };
  if (sx === q) return { score: 70, match: "initials" };
  if (name.includes(q)) return { score: 60, match: "name-part" }; // 外教英文名
  if (py.startsWith(q)) return { score: q.length >= 4 ? 55 : 45, match: "pinyin-prefix" };
  if (sx.startsWith(q)) return { score: 40, match: "initials-prefix" };
  if (q.length >= 4 && py.includes(q)) return { score: 25, match: "pinyin-part" };
  return null;
}

/** 把查询拆成 token；能对上学院名的 token 转成学院过滤（"王伟 数学"、"ww 计算机"） */
function splitQuery(index: IndexFile, raw: string): { tokens: string[]; collegeIds?: Set<number> } {
  const parts = raw
    .normalize("NFKC")
    .split(/[\s,，、/|]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const tokens: string[] = [];
  let collegeIds: Set<number> | undefined;
  for (const part of parts) {
    const hit = index.colleges.filter((c) => c.name.includes(part));
    // 多 token 时 ≥2 字对上学院名就当学院过滤；单 token ≥3 字对上学院名就是"按学院浏览"（不再当姓名）
    if (hit.length && ((parts.length > 1 && part.length >= 2) || (parts.length === 1 && part.length >= 3))) {
      collegeIds = new Set([...(collegeIds ?? []), ...hit.map((c) => c.id)]);
      continue;
    }
    tokens.push(norm(part));
  }
  const out: { tokens: string[]; collegeIds?: Set<number> } = { tokens: tokens.filter(Boolean) };
  if (collegeIds) out.collegeIds = collegeIds;
  return out;
}

/**
 * 打分制：每个 token 取最佳匹配方式的分，多 token 全部要命中（取均值）；
 * 再加小额加成：有评分 +3，人气 hot 按 0–3 线性，评分越高 +0–2（同分档时把好老师排前）。
 * 支持"姓名 学院"混合查询；同名教师由 exact 标出，调用方按学院消歧。
 */
export function searchIndex(index: IndexFile, query: string, opts: SearchOptions = {}): TeacherHit[] {
  const { tokens, collegeIds } = splitQuery(index, query);
  const collegeName = new Map(index.colleges.map((c) => [c.id, c.name]));
  let collegeFilter: ((xy: number) => boolean) | undefined;
  if (opts.college !== undefined && opts.college !== "") {
    const c = opts.college;
    if (typeof c === "number" || /^\d+$/.test(String(c))) {
      const id = Number(c);
      collegeFilter = (xy) => xy === id;
    } else {
      const ids = new Set(index.colleges.filter((x) => x.name.includes(String(c))).map((x) => x.id));
      collegeFilter = (xy) => ids.has(xy);
    }
  } else if (collegeIds) collegeFilter = (xy) => collegeIds.has(xy);
  if (!tokens.length && !collegeFilter) return [];

  const maxHot = Math.max(1, ...index.teachers.map((t) => t.hot));
  const hits: TeacherHit[] = [];
  for (const t of index.teachers) {
    if (collegeFilter && !collegeFilter(t.xy)) continue;
    let sum = 0;
    let best: { score: number; match: MatchKind } | undefined;
    let ok = true;
    for (const q of tokens) {
      const m = scoreToken(t, q);
      if (!m) {
        ok = false;
        break;
      }
      sum += m.score;
      if (!best || m.score > best.score) best = m;
    }
    if (!ok) continue;
    const rating = parseRate(t.rate);
    if (opts.ratedOnly && rating === null) continue;
    const base = tokens.length ? sum / tokens.length : 0;
    const bonus = (rating !== null ? 3 + (rating / 10) * 2 : 0) + (t.hot / maxHot) * 3;
    hits.push({ ...t, college: collegeName.get(t.xy) ?? `学院${t.xy}`, rating, match: best?.match ?? "name-part", exact: best?.match === "name", score: Math.round((base + bonus) * 10) / 10, url: `${SITE}/t/${t.id}/` });
  }
  const sort = opts.sort ?? "score";
  hits.sort((a, b) => {
    if (sort === "rate") return (b.rating ?? -1) - (a.rating ?? -1) || b.score - a.score;
    if (sort === "hot") return b.hot - a.hot || b.score - a.score;
    if (sort === "name") return a.name.localeCompare(b.name, "zh") || b.score - a.score;
    return b.score - a.score || (b.rating ?? -1) - (a.rating ?? -1) || b.hot - a.hot;
  });
  return hits.slice(0, opts.limit ?? 20);
}

// ---------- 教师详情 ----------

export interface CourseGpa {
  course: string;
  gpa: number;
  /** "500+" 这类保留原文 */
  sampleText: string;
  sample: number;
}

export interface TeacherDetail {
  id: number;
  name: string;
  school: string;
  college: string;
  rating: number | null;
  ratingCount: number;
  /** 认为会点名的比例（0–100），页面没写则 null */
  attendancePct: number | null;
  commentCount: number;
  courses: CourseGpa[];
  url: string;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

export function parseTeacherPage(id: number, html: string): TeacherDetail {
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
  const tm = title.match(/^(.+?)老师\s*([\d.]+)分\s*(\d+)人打分/);
  const left = html.match(/<div class="teacher">[\s\S]*?<div class="left">([\s\S]*?)<\/div>/)?.[1] ?? "";
  const ps = [...left.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, "")));
  const name = decode(left.match(/<h3>([^<]*)<\/h3>/)?.[1] ?? tm?.[1] ?? "");
  if (!name) throw new BadResponse("查老师教师页解析失败（没有姓名）", { id, title });
  const attendance = html.match(/([\d.]+)%的人认为该老师会点名/)?.[1];
  const ratingText = html.match(/<div class="right">\s*<h2>([^<]*)<\/h2>\s*<p>(\d+)人参与评分/);
  const courses: CourseGpa[] = [];
  for (const m of html.matchAll(/<p class="course_name">([^<]*)<\/p>[\s\S]*?<p>([\d.]+)\/(\d+\+?)<\/p>/g)) {
    courses.push({ course: decode(m[1]!), gpa: Number(m[2]), sampleText: m[3]!, sample: Number(m[3]!.replace("+", "")) });
  }
  const rating = Number(ratingText?.[1] ?? tm?.[2]);
  const d: TeacherDetail = {
    id,
    name,
    school: ps[0] ?? "",
    college: ps[1] ?? "",
    rating: Number.isFinite(rating) && rating > 0 ? rating : null,
    ratingCount: Number(ratingText?.[2] ?? tm?.[3] ?? 0),
    attendancePct: attendance !== undefined ? Number(attendance) : null,
    commentCount: Number(html.match(/(\d+)个评论/)?.[1] ?? 0),
    courses,
    url: `${SITE}/t/${id}/`,
  };
  return d;
}

export interface Comment {
  id: number;
  text: string;
  likes: number;
  date: string;
}

/** api 子域评论 HTML → 结构化。全部评论一次返回，已按 sort 排好序。 */
export function parseComments(html: string): Comment[] {
  const out: Comment[] = [];
  for (const m of html.matchAll(/<div class="hidden" id="comment-page">([\s\S]*?)<hr>\s*<\/div>/g)) {
    const block = m[1]!;
    const text = [...block.matchAll(/<div class="left">\s*<p>([\s\S]*?)<\/p>/g)].map((x) => decode(x[1]!.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))).join("\n");
    const id = Number(block.match(/id="like_(\d+)"/)?.[1] ?? 0);
    const likes = Number(decode(block.match(/class="\d+-count">([\s\S]*?)<\/p>/)?.[1] ?? "0"));
    const date = block.match(/发布于&nbsp;([\d.]+)/)?.[1] ?? "";
    if (text) out.push({ id, text, likes: Number.isFinite(likes) ? likes : 0, date });
  }
  return out;
}

export interface CourseTeacherGpa {
  teacher: string;
  gpa: number;
  sd: number | null;
  sampleText: string;
  sample: number;
}

/** api /gpa?course= 的表格：教这门课的所有老师的平均绩点 */
export function parseGpaTable(html: string): CourseTeacherGpa[] {
  const out: CourseTeacherGpa[] = [];
  for (const m of html.matchAll(/<tr[^>]*>\s*<td class="course_name">([^<]*)<\/td>\s*<td>([\d.]+)(?:<span[^>]*>±([\d.]+)<\/span>)?<\/td>\s*<td>(\d+\+?)<\/td>/g)) {
    out.push({ teacher: decode(m[1]!), gpa: Number(m[2]), sd: m[3] !== undefined ? Number(m[3]) : null, sampleText: m[4]!, sample: Number(m[4]!.replace("+", "")) });
  }
  return out;
}

// ---------- 客户端 ----------

const MIN_GAP_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Chalaoshi {
  readonly ctx: Context;
  private lastAt = 0;
  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** 站点在海外、链路不稳：传输错误与 5xx 重试 2 次（0.8s / 1.6s） */
  private async get(url: string): Promise<string> {
    await preflight();
    for (let attempt = 0; ; attempt++) {
      const gap = MIN_GAP_MS - (Date.now() - this.lastAt);
      if (gap > 0) await sleep(gap);
      let res;
      try {
        res = await this.ctx.fetch(url, { headers: { Accept: "text/html,application/json,*/*" }, timeout: 20000 });
      } catch (err) {
        this.lastAt = Date.now();
        if (attempt >= 2) throw err;
        debug(`chalaoshi 重试 ${attempt + 1}：${(err as Error).message}`);
        await sleep(800 * (attempt + 1));
        continue;
      }
      this.lastAt = Date.now();
      debug(`chalaoshi ${res.status} ${url} ${res.elapsedMs}ms`);
      if (res.status === 404) throw new RemoteRejected(`查老师：不存在（${url.replace(SITE, "").replace(API, "api")}）`);
      if (res.status >= 500 && attempt < 2) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (res.status !== 200) throw new TransportError(`查老师 HTTP ${res.status}`, { url, status: res.status });
      return res.body;
    }
  }

  async teacher(id: number): Promise<TeacherDetail> {
    if (!Number.isInteger(id) || id <= 0) throw new ConfigError("教师 id 必须是正整数");
    return parseTeacherPage(id, await this.get(`${SITE}/teacher/${id}/`));
  }

  /** sort: rate 人气（默认，站点默认）/ time 最新 */
  async comments(id: number, sort: "rate" | "time" = "rate"): Promise<Comment[]> {
    return parseComments(await this.get(`${API}/comments/${id}?sort=${sort}`));
  }

  async courseGpa(course: string): Promise<CourseTeacherGpa[]> {
    return parseGpaTable(await this.get(`${API}/gpa?course=${encodeURIComponent(course)}`));
  }
}

export async function openChalaoshi(): Promise<{ ctx: Context; client: Chalaoshi; close(): void }> {
  const ctx = await openContext(requirements, { timeout: 20000 });
  return { ctx, client: new Chalaoshi(ctx), close: () => ctx.close() };
}
