/**
 * 课表查询（kbcx/xskbcx）。
 *
 * 学期码：xnm="2026-2027"，xqm="1|秋" / "1|冬" / "1|短" / "1|暑" / "2|春" / "2|夏" / "2|短"（数字是上下学期，竖线后是小学期名）。
 *          列表模式（xsfs=1）里组合学期 "1|秋、冬" / "2|春、夏" 展示一整个大学期；表格模式（xsfs=0）只能单个小学期。
 * 学期枚举：POST kbcx/xskbcx_cxXueqiList.html，表单 xxqf="0"（表格）/ "1"（列表），返回 [{xxq, xqmc}]。
 * 是否开课：POST kbcx/xskbcx_cxSfkc.html?xn=…&xqm=…（无表单），返回 "OK" / 错误描述（"该学年学期课表未开放"）。
 * 课表：POST kbcx/xskbcx_cxXsKb.html?gnmkdm=N253508&su=<学号>，表单 xnm / xqm / xxqf / xsfs（xxqf=小学期分开，xsfs=显示方式），
 *       响应 {xh, xm, xn, xq, xzb, xy, zy, xkkg, kbList:[{kcb, xkkh, kcdm, ...}], kbcdList, sjkList, xskList, ywkList, jxkList, fKbList}。
 * 表格模式（xsfs=0）：kbList 每项 xqj（星期几 1–7）、djj（第几节 1–13）、skcd（占几节）、dsz（单双周 0=单 1=双 2=全）、
 *                   kcb="课程名<br>学期{第N周|N节/周|单/双周}<br>教师<br>地点zwf考试时间zwf"（zwf 是分隔符，对应原 <br>）。
 * 列表模式（xsfs=1）：kbList 每项 kcmc / kcdm / jsxm / xxq / sksj / skdd / xksj / xkzy / szjcmc（数字教材，分号分隔 url;名字）。
 * 不是正式课的放在 sjkList（实践）、xskList（线上）、ywkList（英文）、jxkList（进修）、fKbList（服从安排 tpjg 调配结果）。
 */
import { Zdbk, MODULE, BASE, openZdbk, stripRow } from "./client.ts";
import { BadResponse, ConfigError } from "../core/errors.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import { readJson, writeJson, removeFile } from "../core/fsjson.ts";
import { paths } from "../core/paths.ts";
import { credentials } from "../profile/profile.ts";

/** 学期码：上下学期 | 小学期名（秋冬短暑、春夏短）*/
export type TermCode = `${"1" | "2"}|${"秋" | "冬" | "短" | "暑" | "春" | "夏"}` | `${"1" | "2"}|${"秋、冬" | "春、夏"}`;

export interface TermOption {
  /** "1|秋" */
  code: string;
  /** "秋" */
  name: string;
}

export interface TimetableRow {
  /** 课程代码 */
  kcdm?: string;
  /** 课程名 */
  kcmc?: string;
  /** 选课课号 (2026-2027-1)-CS2055M-0017167-1 */
  xkkh?: string;
  /** 教师姓名（多位用 <br> 分隔）*/
  jsxm?: string;
  /** 教师工号 */
  jszgh?: string;
  /** 小学期（秋、冬、秋冬、短、暑、春、夏、春夏）*/
  xxq?: string;
  /** 上课时间（列表模式："周X第Y节<br>周Z第A,B节{单/双周}"；表格模式没有这个字段）*/
  sksj?: string;
  /** 上课地点（多处用 <br> 分隔）*/
  skdd?: string;
  /** 选课时间（YYYY-MM-DD HH:mm:ss）*/
  xksj?: string;
  /** 选课志愿序号 */
  xkzy?: string;
  /** 是否确定（1=蓝色，空或0=红色斜体待定）*/
  sfqd?: string;
  /** 是否英式课程 */
  sfyjskc?: string;
  /** 数字教材（"url1;名字1<br>url2;名字2" 格式）*/
  szjcmc?: string;
  /** 选课选课次数（列表独有）*/
  kbxkcs?: string;
  /** （表格模式独有）星期几 1–7 */
  xqj?: string;
  /** （表格模式独有）第几节 1–13 */
  djj?: string;
  /** （表格模式独有）占几节 */
  skcd?: string;
  /** （表格模式独有）单双周 0=单 1=双 2=全周 */
  dsz?: string;
  /** （表格模式独有）课程块 "课名<br>学期{周次}<br>教师<br>地点zwf考试zwf" */
  kcb?: string;
  [k: string]: unknown;
}

export interface Timetable {
  student: { id: string; name: string; class: string; college: string; major: string };
  term: { year: string; term: string };
  /** 选课是否开放 */
  enrollOpen: boolean;
  /** 正式课表 */
  courses: TimetableRow[];
  /** 实践课 */
  practice: TimetableRow[];
  /** 线上课 */
  online: TimetableRow[];
  /** 英文课 */
  english: TimetableRow[];
  /** 进修课 */
  training: TimetableRow[];
  /** 服从调配课 */
  arranged: TimetableRow[];
  /** 每日节次数（上午/下午/晚上）*/
  slots: number[];
}

export async function listTerms(z: Zdbk, mode: "table" | "list" = "table"): Promise<TermOption[]> {
  const res = await z.postJson<{ xxq: string; xqmc: string }[]>(z.url("kbcx/xskbcx_cxXueqiList.html", MODULE.kbcx), { xxqf: mode === "table" ? "0" : "1" });
  return res.map((t) => ({ code: t.xxq, name: t.xqmc }));
}

/** 检查学期是否开课（服务端检查，未开放时课表接口报错）*/
export async function checkTermOpen(z: Zdbk, year: string, term: string): Promise<{ open: boolean; message: string }> {
  const res = await z.postForm(z.url(`kbcx/xskbcx_cxSfkc.html?xn=${encodeURIComponent(year)}&xqm=${encodeURIComponent(term)}`, MODULE.kbcx), {});
  if (res.status !== 200) throw new BadResponse(`课表开放检查 HTTP ${res.status}`, { year, term });
  const j = res.json<string>();
  if (j === null) return { open: false, message: res.body.trim() };
  return { open: j === "OK", message: j === "OK" ? "" : j };
}

export async function getTimetable(z: Zdbk, year: string, term: string, mode: "table" | "list" = "list"): Promise<Timetable> {
  const form = { xnm: year, xqm: term, xxqf: mode === "table" ? "0" : "1", xsfs: mode === "table" ? "0" : "1" };
  const res = await z.postJson<{
    xh?: string;
    xm?: string;
    xnm?: string;
    xqm?: string;
    xzb?: string;
    xy?: string;
    zy?: string;
    xkkg?: boolean;
    kbList?: TimetableRow[];
    kbcdList?: { kbcd: number }[];
    sjkList?: TimetableRow[];
    xskList?: TimetableRow[];
    ywkList?: TimetableRow[];
    jxkList?: TimetableRow[];
    fKbList?: TimetableRow[];
  }>(z.url("kbcx/xskbcx_cxXsKb.html", MODULE.kbcx), form);
  if (!res || !Array.isArray(res.kbList)) throw new BadResponse("教务课表响应缺少 kbList，不能视为没有课程");
  const out: Timetable = {
    student: { id: String(res.xh ?? z.su), name: String(res.xm ?? ""), class: String(res.xzb ?? ""), college: String(res.xy ?? ""), major: String(res.zy ?? "") },
    term: { year: String(res.xnm ?? year), term: String(res.xqm ?? term) },
    enrollOpen: res.xkkg ?? false,
    courses: res.kbList.map((r) => stripRow(r) as TimetableRow),
    practice: (res.sjkList ?? []).map((r) => stripRow(r) as TimetableRow),
    online: (res.xskList ?? []).map((r) => stripRow(r) as TimetableRow),
    english: (res.ywkList ?? []).map((r) => stripRow(r) as TimetableRow),
    training: (res.jxkList ?? []).map((r) => stripRow(r) as TimetableRow),
    arranged: (res.fKbList ?? []).map((r) => stripRow(r) as TimetableRow),
    slots: (res.kbcdList ?? []).map((s) => s.kbcd),
  };
  return out;
}

/** 解析表格模式 kcb（"课名<br>学期{周次}<br>教师<br>地点zwf考试zwf"）成结构化字段 */
export function parseKcb(kcb: string): { name: string; term: string; weeks: string; teacher: string; location: string; exam: string } {
  const parts = kcb.split(/zwf|<br\s*\/?\s*>/i).map((s) => s.trim());
  const name = parts[0] ?? "";
  const line1 = parts[1] ?? "";
  const m = line1.match(/^(.+?)\{(.+)\}$/);
  const term = m ? m[1]!.trim() : line1;
  const weeks = m ? m[2]!.trim() : "";
  const teacher = parts[2] ?? "";
  const location = parts[3] ?? "";
  const exam = parts[4] ?? "";
  return { name, term, weeks, teacher, location, exam };
}

export { stripRow };

const TIMETABLE_PAGE = `${BASE}/kbcx/xskbcx_cxXskbcxIndex.html`;
const PERIOD_SOURCE = `${BASE}/js/comp/jwglxt/xkgl/kbcx/xskbcx.js`;
export interface PeriodTime { period: number; startTime: string; endTime: string }

/** Read the exact array used by ZDBK to render its timetable. Never execute remote JS. */
export function parsePeriodTimes(script: string): PeriodTime[] {
  const array = script.match(/\bvar\s+arrKbjcsj\s*=\s*(\[[^\]]*\])/u)?.[1];
  let values: unknown;
  try { values = JSON.parse(array ?? "null"); } catch { /* handled below */ }
  if (!Array.isArray(values) || !values.length) throw new BadResponse("教务课表页面未提供可识别的节次时刻表");
  const times = values.map((value, i) => {
    const m = typeof value === "string" ? value.match(/^([0-2]\d:[0-5]\d)\s*[—–-]\s*([0-2]\d:[0-5]\d)$/u) : null;
    if (!m || m[1]! >= m[2]! || m[2]! >= "24:00") throw new BadResponse("教务课表节次时刻格式异常");
    return { period: i + 1, startTime: m[1]!, endTime: m[2]! };
  });
  if (times.some((t, i) => i > 0 && t.startTime < times[i - 1]!.endTime)) throw new BadResponse("教务课表节次时刻顺序异常");
  return times;
}

/** Match the selected option, or the browser's first-option default. */
export function parseTimetableDefaults(html: string): { year: string; term: string } {
  const selected = (id: string) => {
    const body = html.match(new RegExp(`<select\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/select>`, "i"))?.[1];
    const options = [...(body ?? "").matchAll(/<option\b([^>]*)>/gi)];
    const attrs = (options.find(m => /\bselected(?:\s|=|$)/i.test(m[1]!)) ?? options[0])?.[1];
    return attrs?.match(/\bvalue=["']([^"']+)["']/i)?.[1];
  };
  const year = selected("xnm"), term = selected("xqm");
  if (!year || !/^\d{4}-\d{4}$/.test(year) || !term || !/^[12]\|[秋冬春夏短暑]$/.test(term)) throw new BadResponse("无法读取教务课表页面的默认学年学期");
  return { year, term };
}

interface Meeting {
  weekday: number; periods: number[]; startTime: string; endTime: string;
  location: string; weeks: string; weekPattern: string;
}

/** Full timetable with the same clock times as the official page; interpretation belongs to the caller. */
export async function getSchedule(z: Zdbk, year: string, term: string) {
  const [raw, source] = await Promise.all([getTimetable(z, year, term, "table"), z.get(PERIOD_SOURCE)]);
  if (source.status !== 200) throw new BadResponse(`读取教务课表时刻表 HTTP ${source.status}`);
  const periodTimes = parsePeriodTimes(source.body);
  const courses = new Map<string, { name: string; teacher: string; term: string; confirmed: boolean; exam: string; meetings: Meeting[] }>();
  for (const row of raw.courses) {
    if (typeof row.kcb !== "string") throw new BadResponse("课表课程块缺失，不能生成课程日程");
    const parsed = parseKcb(row.kcb), weekday = Number(row.xqj), first = Number(row.djj), count = Number(row.skcd);
    if (![weekday, first, count].every(Number.isSafeInteger) || weekday < 1 || weekday > 7 || first < 1 || count < 1 || first + count - 1 > periodTimes.length) throw new BadResponse("课表节次格式异常或缺少对应时刻");
    const key = String(row.xkkh ?? parsed.name + parsed.teacher);
    const item = courses.get(key) ?? { name: parsed.name, teacher: parsed.teacher, term: parsed.term, confirmed: row.sfqd === "1", exam: parsed.exam, meetings: [] };
    item.meetings.push({ weekday, periods: Array.from({ length: count }, (_, i) => first + i), startTime: periodTimes[first - 1]!.startTime,
      endTime: periodTimes[first + count - 2]!.endTime, location: parsed.location,
      weeks: parsed.weeks.replace(/\|\d+节\/(?:单周|双周|周)/g, ""), weekPattern: row.dsz === "0" ? "单周" : row.dsz === "1" ? "双周" : row.dsz === "2" ? "每周" : "未提供" });
    courses.set(key, item);
  }
  // The page can split one lesson into adjacent cells. Merge only identical scheduling rules.
  const sessionEnds = new Set(raw.slots.map((_, i) => raw.slots.slice(0, i + 1).reduce((sum, n) => sum + n, 0)));
  for (const course of courses.values()) {
    const groups = new Map<string, Meeting[]>();
    for (const m of course.meetings) {
      const key = JSON.stringify([m.weekday, m.location, m.weeks, m.weekPattern]);
      const group = groups.get(key) ?? []; group.push(m); groups.set(key, group);
    }
    course.meetings = [];
    for (const group of groups.values()) {
      group.sort((a, b) => a.periods[0]! - b.periods[0]!);
      let last: Meeting | undefined;
      for (const m of group) {
        if (last && !sessionEnds.has(last.periods.at(-1)!) && m.periods[0] === last.periods.at(-1)! + 1) { last.periods.push(...m.periods); last.endTime = m.endTime; }
        else { course.meetings.push(m); last = m; }
      }
    }
    course.meetings.sort((a, b) => a.weekday - b.weekday || a.periods[0]! - b.periods[0]!);
  }
  return { term: raw.term, timezone: "Asia/Shanghai", periodTimes, courses: [...courses.values()],
    otherCourses: { practice: raw.practice, online: raw.online, english: raw.english, training: raw.training, arranged: raw.arranged },
    sources: { timetable: TIMETABLE_PAGE, periodTimes: PERIOD_SOURCE } };
}

/** 本人学籍信息（学院、专业、行政班）：取自当前学期的课表响应，教务网没有单独的接口 */
export async function studentInfo(z: Zdbk): Promise<Timetable["student"]> {
  const page = await z.get(z.url(TIMETABLE_PAGE, MODULE.kbcx));
  if (page.status !== 200) throw new BadResponse(`读取教务课表页面 HTTP ${page.status}`);
  const { year, term } = parseTimetableDefaults(page.body);
  return (await getTimetable(z, year, term, "table")).student;
}

type Schedule = Awaited<ReturnType<typeof getSchedule>>;
interface ScheduleCache { version: 1; entries: Record<string, { fetchedAt: number; schedule: Schedule }> }
const CACHE_TTL_MS = 6 * 3600_000;
const STALE_LIMIT_MS = 7 * 86400_000;
const shanghaiTime = (at: number) => new Date(at + 8 * 3600_000).toISOString().replace("Z", "+08:00");
const cacheFile = (account: string) => path.join(paths.cache(), `zdbk-timetable-${createHash("sha256").update(account).digest("hex")}.json`);

export function invalidateScheduleCache(account: string): void { removeFile(cacheFile(account)); }

/** Cache lookup precedes client creation, so a warm timetable needs no authentication or network. */
export async function cachedSchedule(options: { year?: string; term?: string } = {}, open: typeof openZdbk = openZdbk, account = credentials().username) {
  const term = options.term ? ({ 秋: "1|秋", 冬: "1|冬", 春: "2|春", 夏: "2|夏", 短: "1|短", 暑: "1|暑" } as Record<string, string>)[options.term] ?? options.term : undefined;
  if (options.year && !/^\d{4}-\d{4}$/.test(options.year)) throw new ConfigError("学年格式应为 2026-2027");
  if (term && !/^[12]\|[秋冬春夏短暑]$/.test(term)) throw new ConfigError("学期应为秋、冬、春、夏、短或暑（也可指定 1|短 / 2|短）");
  const key = JSON.stringify([options.year ?? null, term ?? null]), file = cacheFile(account);
  const loaded = readJson<ScheduleCache>(file), cache: ScheduleCache = loaded?.version === 1 && loaded.entries && typeof loaded.entries === "object" ? loaded : { version: 1, entries: {} };
  const now = Date.now(), entry = cache.entries[key];
  const result = (schedule: Schedule, fetchedAt: number, hit: boolean) => ({ ...schedule, currentTime: shanghaiTime(Date.now()),
    currentWeekday: new Date(Date.now() + 8 * 3600_000).getUTCDay() || 7,
    cache: { hit, fetchedAt: shanghaiTime(fetchedAt), expiresAt: shanghaiTime(Math.min(fetchedAt + CACHE_TTL_MS, Date.parse(shanghaiTime(fetchedAt).slice(0, 10) + "T00:00:00+08:00") + 86400_000)) } });
  const usable = !!entry && now >= entry.fetchedAt && Array.isArray(entry.schedule?.courses) && Array.isArray(entry.schedule?.periodTimes) && entry.schedule.periodTimes.length > 0;
  if (entry && usable && now - entry.fetchedAt < CACHE_TTL_MS && shanghaiTime(now).slice(0, 10) === shanghaiTime(entry.fetchedAt).slice(0, 10)) return result(entry.schedule, entry.fetchedAt, true);
  let z: Zdbk | undefined;
  try {
    z = await open();
    let defaults: { year: string; term: string } | undefined;
    if (!options.year || !term) {
      const page = await z.get(z.url(TIMETABLE_PAGE, MODULE.kbcx));
      if (page.status !== 200) throw new BadResponse(`读取教务课表页面 HTTP ${page.status}`);
      defaults = parseTimetableDefaults(page.body);
    }
    const schedule = await getSchedule(z, options.year ?? defaults!.year, term ?? defaults!.term), fetchedAt = Date.now();
    cache.entries[key] = { fetchedAt, schedule };
    writeJson(file, cache);
    return result(schedule, fetchedAt, false);
  } catch (error) {
    // 课表很少变化：刷新失败时退回一周内的旧缓存并如实标明，调用方不必重试或排查登录。
    if (!entry || !usable || now - entry.fetchedAt >= STALE_LIMIT_MS) throw error;
    const reason = error instanceof Error ? error.message : String(error), fetchedAt = shanghaiTime(entry.fetchedAt);
    return { ...result(entry.schedule, entry.fetchedAt, true), cache: { hit: true, stale: true, fetchedAt, refreshError: reason },
      message: `教务网暂时无法刷新（${reason}），以下是 ${fetchedAt.slice(0, 16).replace("T", " ")} 获取的课表，可直接据此回答，无需重试或登录。` };
  } finally { z?.close(); }
}
