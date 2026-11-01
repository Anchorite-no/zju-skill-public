import { BadResponse, NeedsUser } from "../core/errors.ts";
import { uniqueMatch } from "../core/match.ts";
import { htmlToText } from "../core/html.ts";
import { preferenceGroup, selectionState, type Xsxk, type SearchOptions, type SelectionRow, type SelectionContext, type Category, type SelectionWriteResult } from "./xsxk.ts";

export interface CourseTarget { course: string; teacher?: string; time?: string; section?: string }

// ----- 输出视图：平台字段（kcmc、jsxm、sksj…）只留在 API 层；多值的 <br> 换成顿号或分号，「--」视为没有 -----
const text = (v: unknown, joiner = "、") => htmlToText(String(v ?? "")).split("\n").map(x => x.trim()).filter(x => x && x !== "--").join(joiner);
const put = (key: string, value: string | number | null | undefined) => value === "" || value === null || value === undefined ? {} : { [key]: value };

/** 一个教学班：班号 section 用于消歧（--section），remaining/capacity 为余量与容量。 */
export const sectionView = (r: Record<string, unknown>) => ({
  ...put("course", text(r.kcmc)), code: String(r.kcdm ?? ""), section: String(r.xkkh ?? ""), ...put("teacher", text(r.jsxm)),
  ...put("time", text(r.sksj, "；")), ...put("location", text(r.skdd, "；")), ...put("term", text(r.xxq)), ...put("exam", text(r.kssj ?? r.vkssj)),
  ...put("remaining", r.remaining as number | null), ...put("capacity", r.capacity as number | null),
});
/** 课程（未展开教学班）：kcxx 形如「0~3.0~3.0-0.0」，第二段是学分。 */
export const courseView = (r: Record<string, unknown>) => ({
  course: text(r.kcmc), code: String(r.kcdm ?? ""), ...put("credits", String(r.xf ?? String(r.kcxx ?? "").split("~")[1] ?? "")),
  ...put("category", text(r.kclb)), ...put("college", text(r.kkxy)), ...put("term", text(r.xxq)),
});
/** 本人的一个志愿：order 是组内志愿次序，state 为 已选上 / 待筛选。 */
export const ownedView = (r: SelectionRow) => {
  const state = selectionState(r), group = preferenceGroup(r);
  return { ...sectionView(r), ...put("credits", String(r.xf ?? "")), order: Number(r.xkzy) || null,
    state: state === "selected" ? "已选上" : state === "pending" ? "待筛选" : "未知",
    ...(group !== r.kcdm ? { group } : {}), ...put("savedAt", String(r.xksj ?? "").slice(0, 16)) };
};
/** 页签名称：重名的「全部课程」和页面上显示为 qbkc 的那一项，带上它下面第一个子类以示区分。 */
export function categoryNames(context: SelectionContext): { name: string; category: Category }[] {
  const list = context.categories.filter(c => c.kind === "courses");
  return list.map((category, i) => {
    const plain = category.name === "qbkc" ? "全部课程" : category.name;
    const child = list[i + 1]?.lx === "zl" && category.lx === "bl" ? list[i + 1]!.name : "";
    const repeated = list.filter(c => (c.name === "qbkc" ? "全部课程" : c.name) === plain).length > 1;
    return { name: repeated && child ? `${plain}（${child}等）` : plain, category };
  });
}
/** 写操作结果：结论、目标教学班和本人当前全部志愿；平台原始响应只进 journal。 */
export function writeView(r: SelectionWriteResult) {
  const t = r.target as Record<string, unknown> | undefined;
  const target = !t ? undefined : t.candidate ? { ...sectionView(t.candidate as Record<string, unknown>), note: t.note }
    : Array.isArray(t.before) ? { order: t.xkkhs, before: (t.before as SelectionRow[]).map(ownedView), note: t.note }
    : t.kcdm ? ownedView(t as SelectionRow) : { section: t.xkkh };
  return { action: r.action, status: r.status, verified: r.verified, message: r.message, ...(target ? { target } : {}),
    ...(r.requestError ? { requestError: r.requestError } : {}), ...(r.verificationError ? { verificationError: r.verificationError } : {}),
    ...(r.choices ? { choices: r.choices.map(ownedView) } : {}) };
}

export async function searchAll(xk: Xsxk, options: SearchOptions) {
  const rows: Awaited<ReturnType<Xsxk["search"]>>["items"] = [], seen = new Set<string>();
  for (let page = 1; page <= 1000; page++) {
    const result = await xk.search({ ...options, page, size: 50 });
    for (const row of result.items) {
      const key = row.query.course + ":" + row.query.pool;
      if (seen.has(key)) throw new BadResponse("选课查询分页重复，无法确认完整结果");
      seen.add(key); rows.push(row);
    }
    if (!result.hasMore) return rows;
  }
  throw new BadResponse("选课查询超过分页上限");
}
function filter(rows: SelectionRow[], target: CourseTarget) {
  return rows.filter(r => (!target.teacher || String(r.jsxm ?? "").includes(target.teacher))
    && (!target.time || String(r.sksj ?? "").includes(target.time)) && (!target.section || r.xkkh === target.section));
}
function courseMatch<T extends SelectionRow>(rows: T[], query: string): T {
  const courses = [...new Map(rows.map(r => [r.kcdm, r])).values()];
  return uniqueMatch(courses, query, r => [r.kcdm, String(r.kcmc ?? "")], r => ({ name: r.kcmc, code: r.kcdm }), "课程");
}
export async function taskSections(xk: Xsxk, target: CourseTarget) {
  const found = await searchAll(xk, { keyword: target.course, field: /^[A-Za-z]+[0-9]/.test(target.course) ? "kcdm" : "kcmc" });
  const selected = courseMatch(found, target.course);
  const sections = new Map<string, Awaited<ReturnType<Xsxk["sections"]>>[number]>();
  for (const row of found.filter(r => r.kcdm === selected.kcdm)) {
    // 教学班响应里没有课程名，沿用课程行的。
    for (const section of await xk.sections(row.query)) sections.set(section.xkkh, { kcmc: row.kcmc, ...section });
  }
  const allowed = new Set(filter([...sections.values()], target).map(r => r.xkkh));
  return [...sections.values()].filter(r => allowed.has(r.xkkh));
}
export async function ownedTarget(xk: Xsxk, target: CourseTarget) {
  const rows = await xk.owned(), selected = courseMatch(rows, target.course);
  return filter(rows.filter(r => r.kcdm === selected.kcdm), target);
}
export function oneSection<T extends SelectionRow>(rows: T[]): T {
  if (rows.length === 1) return rows[0]!;
  const error = new NeedsUser(rows.length ? "教学班不唯一，请明确教师、上课时间或候选班号" : "没有符合条件的教学班");
  error.detail.candidates = rows.map(sectionView); throw error;
}
