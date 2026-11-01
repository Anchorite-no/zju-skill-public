/** 课程、章节，以及一门课里能下载的文件清单（章节卡片里的附件 + 「资料」栏）。 */
import path from "node:path";
import { BadResponse, NeedsUser, ZjuError } from "../core/errors.ts";
import { abbreviates, uniqueMatch } from "../core/match.ts";
import { readJson, writeJson } from "../core/fsjson.ts";
import { paths } from "../core/paths.ts";
import { API, MOOC1, MOOC2, type Chaoxing } from "./client.ts";
import { parseCards, parseChapters, parseDataList, type CardFile, type Chapter, type DataRow } from "./parse.ts";

export interface Course {
  courseId: string;
  clazzId: string;
  /** 本人在这个班里的身份编号，几乎每个请求都要带 */
  cpi: string;
  name: string;
  teacher: string;
  className: string;
}

export type Kind = "video" | "audio" | "document";
const VIDEO = new Set(["mp4", "flv", "avi", "wmv", "mkv", "mov", "m4v", "rmvb", "rm", "webm", "mpg", "mpeg", "3gp", "ts", "f4v", "asf"]);
const AUDIO = new Set(["mp3", "m4a", "wav", "wma", "aac", "flac", "ogg"]);
export function kindOf(name: string): Kind {
  const ext = path.extname(name).slice(1).toLowerCase();
  return VIDEO.has(ext) ? "video" : AUDIO.has(ext) ? "audio" : "document";
}

export interface CourseFile {
  name: string;
  kind: Kind;
  /** 章节文件：从大章到所在节的标题；资料栏文件：「资料」加各层文件夹名 */
  location: string[];
  source: "chapter" | "data";
  /** 字节数；资料栏的文件在章节里没有同一份时，是按页面上的约数（310KB）换算的 */
  size: number | null;
  /** 章节附件的云盘对象编号 */
  objectId?: string;
  /** 资料栏文件的编号 */
  dataId?: string;
  downloadable: boolean;
}

interface Channel { cpi?: unknown; content?: { id?: unknown; name?: unknown; cpi?: unknown; course?: { data?: { id?: unknown; name?: unknown; teacherfactor?: unknown }[] } } }

/** 本人加入的课程；自己教的课、文件夹等没有 course 数据的条目不算。 */
export async function listCourses(c: Chaoxing): Promise<Course[]> {
  const data = await c.json<{ channelList?: Channel[] }>(`${API}/mycourse/backclazzdata?view=json&rss=1`);
  if (!Array.isArray(data.channelList)) throw new BadResponse("超星课程列表缺少 channelList");
  const rows: Course[] = [];
  for (const channel of data.channelList) {
    const content = channel.content, course = content?.course?.data?.[0];
    if (!content?.id || !course?.id) continue;
    rows.push({
      courseId: String(course.id), clazzId: String(content.id), cpi: String(content.cpi ?? channel.cpi ?? ""),
      name: String(course.name ?? "").trim(), teacher: String(course.teacherfactor ?? "").trim(), className: String(content.name ?? "").trim(),
    });
  }
  return rows;
}

/** 课程页面的地址。原样写进 --course 就是这门课，重名的、名字互相包含的课也分得开。 */
const courseLink = (r: Course) => `${MOOC1}/visit/stucoursemiddle?courseid=${r.courseId}&clazzid=${r.clazzId}&cpi=${r.cpi}&ismooc2=1&v=2`;
export const courseRow = (r: Course) => ({ name: r.name, teacher: r.teacher, class: r.className, link: courseLink(r) });

/** 资料栏页面上的大小约数（310KB、2.08 MB）→ 字节。 */
function roughBytes(text: string): number | null {
  const m = text.trim().match(/^([\d.]+)\s*([KMG]?)B?$/i);
  const value = m ? Number(m[1]) : NaN;
  return m && Number.isFinite(value) ? Math.round(value * 1024 ** ["", "K", "M", "G"].indexOf(m[2]!.toUpperCase())) : null;
}

/** 课程页面链接里的 courseid / clazzid / cpi。 */
function linkOf(query: string): { courseId: string; clazzId: string; cpi: string } | undefined {
  if (!/^https?:\/\//i.test(query.trim())) return undefined;
  let u: URL;
  try { u = new URL(query.trim()); } catch { return undefined; }
  const pick = (...names: string[]) => { for (const [k, v] of u.searchParams) if (names.includes(k.toLowerCase()) && /^\d+$/.test(v)) return v; return ""; };
  const courseId = pick("courseid"), clazzId = pick("clazzid", "classid"), cpi = pick("cpi");
  return courseId ? { courseId, clazzId, cpi } : undefined;
}

/** 课程名称、简称或课程页面链接 → 本人课程；不唯一时给候选。 */
export async function findCourse(c: Chaoxing, query: string): Promise<Course> {
  const rows = await listCourses(c), link = linkOf(query);
  if (link) {
    const hit = rows.find((r) => r.courseId === link.courseId && (!link.clazzId || r.clazzId === link.clazzId));
    if (hit) return hit;
    if (link.clazzId && link.cpi) return { ...link, name: `课程 ${link.courseId}`, teacher: "", className: "" };
    throw new NeedsUser("这个链接不是本人课程的页面，请给课程名称");
  }
  const short = rows.filter((r) => abbreviates(query, r.name));
  return uniqueMatch(rows, query, (r) => [r.name, ...(short.includes(r) ? [query] : [])], courseRow, "课程");
}

const stuPage = (course: Course) => `${MOOC2}/mooc2-ans/mycourse/stu?courseid=${course.courseId}&clazzid=${course.clazzId}&cpi=${course.cpi}&ut=s`;

export async function listChapters(c: Chaoxing, course: Course): Promise<Chapter[]> {
  const page = await c.page(`${MOOC2}/mooc2-ans/mycourse/studentcourse?courseid=${course.courseId}&clazzid=${course.clazzId}&cpi=${course.cpi}&ut=s&t=${Date.now()}`, { referer: stuPage(course) });
  return parseChapters(page.body);
}

/** 一个节里各张卡片的附件；卡片从 0 编号，取到没有卡片的那一页为止。 */
async function chapterCards(c: Chaoxing, course: Course, chapter: Chapter): Promise<{ notOpen: boolean; files: CardFile[] }> {
  const referer = `${MOOC1}/mooc-ans/mycourse/studentstudy?chapterId=${chapter.id}&courseId=${course.courseId}&clazzid=${course.clazzId}&cpi=${course.cpi}&mooc2=1`;
  const files: CardFile[] = [];
  for (let num = 0; num < 12; num++) {
    const page = await c.page(`${MOOC1}/mooc-ans/knowledge/cards?clazzid=${course.clazzId}&courseid=${course.courseId}&knowledgeid=${chapter.id}&num=${num}&ut=s&cpi=${course.cpi}&v=2025-0424-1038-3&mooc2=1&isMicroCourse=false&editorPreview=0`, { referer });
    const card = parseCards(page.body);
    if (card.notOpen) return { notOpen: true, files: [] };
    if (!card.found) break;
    for (const file of card.files) if (!files.some((f) => f.objectId === file.objectId)) files.push(file);
  }
  return { notOpen: false, files };
}

/** 资料栏：逐层逐页列出；文件夹要用它那一行给的 enc 打开。「教师课件」入口不在这里。 */
async function dataRows(c: Chaoxing, course: Course): Promise<{ row: DataRow; folders: string[] }[]> {
  // 课程页地址里的 enc 是资料栏根页面要的 stuenc，每次进课程现取。
  const entry = await c.page(`${MOOC1}/visit/stucoursemiddle?courseid=${course.courseId}&clazzid=${course.clazzId}&cpi=${course.cpi}&ismooc2=1&v=2`);
  const stuenc = new URL(entry.url).searchParams.get("enc") ?? "";
  const root = `${MOOC2}/mooc2-ans/coursedata/stu-datalist?courseid=${course.courseId}&clazzid=${course.clazzId}&cpi=${course.cpi}&ut=s&stuenc=${stuenc}`;
  const out: { row: DataRow; folders: string[] }[] = [];
  const walk = async (folder: DataRow | undefined, folders: string[]): Promise<void> => {
    for (let page = 1; page <= 50; page++) {
      const query = folder ? `&dataName=${encodeURIComponent(folder.name)}&dataId=${folder.dataId}&type=1&parent=&flag=0&enc=${folder.enc}&microTopicId=0&isAjax=isAjax` : "";
      const list = parseDataList((await c.page(`${root}${query}&t=${Date.now()}${page > 1 ? `&pages=${page}` : ""}`, { referer: entry.url })).body);
      for (const row of list.rows) {
        if (row.type === "afolder") { if (row.dataId && folders.length < 8) await walk(row, [...folders, row.name]); }
        else if (row.dataId && row.name) out.push({ row, folders });
      }
      if (page >= list.totalPages) return;
    }
  };
  await walk(undefined, []);
  return out;
}

interface Cache {
  version: 1;
  points: Record<string, { at: number; notOpen: boolean; files: CardFile[] }>;
  data?: { at: number; rows: { row: DataRow; folders: string[] }[] };
}
/** 清单留半小时：先看清单再下载、连着下几次时不必重读每个章节。 */
const CACHE_MS = 30 * 60 * 1000;
const cacheFile = (course: Course) => path.join(paths.cache(), "chaoxing", `${course.courseId}-${course.clazzId}.json`);

/** 以前读过的清单里（不论多旧），哪些节有名字符合的文件。只用来定位去哪一节找，文件以重新读到的为准。 */
export function seenIn(course: Course, match: (name: string) => boolean): string[] {
  const cache = readJson<Cache>(cacheFile(course));
  return Object.entries(cache?.points ?? {}).filter(([, point]) => point.files?.some((f) => match(f.name))).map(([id]) => id);
}

export interface Inventory {
  files: CourseFile[];
  /** 还没开放、读不到内容的节 */
  notOpen: string[];
  /** 资料栏读取失败时的原因；章节文件不受影响 */
  dataError?: string;
  /** 有内容来自半小时内的缓存 */
  cached: boolean;
}

/**
 * 一门课的文件清单。chapters 给了就只读这些节（不读资料栏）；fresh 不用缓存。
 */
export async function inventory(c: Chaoxing, course: Course, chapters: Chapter[], opts: { data: boolean; fresh?: boolean }): Promise<Inventory> {
  const saved = opts.fresh ? undefined : readJson<Cache>(cacheFile(course));
  const cache: Cache = saved?.version === 1 && saved.points ? saved : { version: 1, points: {} };
  const alive = (at: number) => !opts.fresh && Date.now() - at < CACHE_MS;
  const result: Inventory = { files: [], notOpen: [], cached: false };
  try {
    for (const chapter of chapters) {
      let point = cache.points[chapter.id];
      if (point && alive(point.at)) result.cached = true;
      else point = cache.points[chapter.id] = chapter.locked ? { at: Date.now(), notOpen: true, files: [] } : { at: Date.now(), ...await chapterCards(c, course, chapter) };
      if (point.notOpen) result.notOpen.push(chapter.title);
      for (const f of point.files) result.files.push({ name: f.name, kind: kindOf(f.name), location: chapter.path, source: "chapter", size: f.size, objectId: f.objectId, downloadable: true });
    }
    if (opts.data) {
      if (cache.data && alive(cache.data.at)) result.cached = true;
      else {
        try { cache.data = { at: Date.now(), rows: await dataRows(c, course) }; }
        catch (error) {
          if (!(error instanceof ZjuError) || ["AUTH_EXPIRED", "NEEDS_USER", "RATE_LIMITED"].includes(error.code)) throw error;
          result.dataError = error.message;
        }
      }
      for (const { row, folders } of cache.data?.rows ?? []) {
        if (row.type === "tch-courseware") continue;
        const name = row.type && !row.name.toLowerCase().endsWith("." + row.type) ? `${row.name}.${row.type}` : row.name;
        // 章节里有同一份时用它的准确字节数，清单里两处的大小一致。
        const same = row.objectId ? result.files.find((f) => f.source === "chapter" && f.objectId === row.objectId) : undefined;
        result.files.push({ name, kind: kindOf(name), location: ["资料", ...folders], source: "data", size: same?.size ?? roughBytes(row.size), dataId: row.dataId, ...(row.objectId ? { objectId: row.objectId } : {}), downloadable: row.downloadable });
      }
    }
  } finally {
    // 读到一半出错时，已经读到的节也留下。
    writeJson(cacheFile(course), cache);
  }
  return result;
}
