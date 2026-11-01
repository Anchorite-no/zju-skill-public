/** Official personal exam query: midterms and finals, including unpublished arrangements. */
import { type Zdbk, MODULE } from "./client.ts";
import { BadResponse, ConfigError } from "../core/errors.ts";
import { selectOptions, htmlToText } from "../core/html.ts";

interface ExamRow extends Record<string, unknown> {
  xkkh?: string; kcmc?: string; xf?: string; xxq?: string; bz?: string;
  kssj?: string; jsmc?: string; zwxh?: string;
  qzkssj?: string; qzjsmc?: string; qzzwxh?: string;
}
const PAGE = "xskscx/kscx_cxXsgrksIndex.html";
const clean = (v: unknown) => htmlToText(String(v ?? "")).trim();

/** 一场考试的安排：未公布时只有 status；已公布时给日期与起止时间，考场、座位号公布后才出现。 */
export function examArrangement(time: unknown, room: unknown, seat: unknown) {
  const text = clean(time), location = clean(room), seatNumber = clean(seat);
  if (!text) return { status: "未公布" as const };
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*[（(](\d{1,2}:\d{2})\s*[-—–]\s*(\d{1,2}:\d{2})[）)]/);
  return { status: "已公布" as const,
    ...(m ? { date: `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`, startTime: m[4]!.padStart(5, "0"), endTime: m[5]!.padStart(5, "0") } : { time: text }),
    ...(location ? { location } : {}), ...(seatNumber ? { seat: seatNumber } : {}) };
}

export async function getExams(z: Zdbk, options: { year?: string; term?: string; course?: string } = {}) {
  const url = z.url(PAGE, MODULE.exams);
  const page = await z.get(url);
  if (page.status !== 200) throw new BadResponse(`考试查询页面 HTTP ${page.status}`);
  const years = selectOptions(page.body, "xnSelect"), terms = selectOptions(page.body, "xxqSelect");
  const year = options.year ?? (years.find(y => y.selected) ?? years[0])?.value;
  const term = options.term ? terms.find(t => t.value === options.term || t.label === options.term)?.value
    : (terms.find(t => t.selected) ?? terms[0])?.value;
  if (!term && options.term) throw new ConfigError(`学期不在教务页面的可选范围内：${options.term}`);
  if (!year || !term) throw new BadResponse("无法读取考试查询的学年学期", { requested: options });
  if (!/^\d{4}-\d{4}$/.test(year)) throw new ConfigError("学年格式应为 2026-2027");
  const rows: ExamRow[] = [], seen = new Set<string>();
  for (let pageNumber = 1; ; pageNumber++) {
    if (pageNumber > 100) throw new BadResponse("考试查询分页超限");
    const r = await z.grid<ExamRow>(url, { xxq: term.slice(2), xnxq: `(${year}-${term[0]})-` }, { page: pageNumber, size: 100, sort: "xkkh", order: "asc" });
    for (const row of r.items) {
      if (!row.xkkh || !row.kcmc || seen.has(row.xkkh)) throw new BadResponse("考试列表缺少课程标识或分页重复，无法确认完整结果");
      seen.add(row.xkkh); rows.push(row);
    }
    if (rows.length >= r.total) break;
    if (!r.items.length) throw new BadResponse("考试列表提前返回空页，结果不完整");
  }
  const courses = rows.filter(r => !options.course || clean(r.kcmc).includes(options.course)).map(r => {
    const remarks = clean(r.bz);
    return { name: clean(r.kcmc), term: clean(r.xxq), credits: clean(r.xf),
      midterm: examArrangement(r.qzkssj, r.qzjsmc, r.qzzwxh), final: examArrangement(r.kssj, r.jsmc, r.zwxh), ...(remarks ? { remarks } : {}) };
  });
  const day = (c: typeof courses[number]) => "date" in c.final ? c.final.date : "9999";
  courses.sort((a, b) => day(a).localeCompare(day(b)) || a.name.localeCompare(b.name, "zh-CN"));
  return { term: { year, term: terms.find(t => t.value === term)!.label }, count: courses.length, courses,
    note: "期中、期末分开列出，按期末日期排序。未公布表示平台还没有发布这场考试的时间，不代表无需考试；已公布但没有 location、seat 表示考场和座位号还没出。" };
}
