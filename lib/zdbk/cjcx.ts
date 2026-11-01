/**
 * 成绩查询（N5083）与成绩主修数据（N908550），按浙大发本〔2022〕24号计算五分制平均学分绩点。
 * 同一课程每次修读都计入；弃修、缓考、二级制合格不计入；缺考、无效与不及格按教务网给出的 0 绩点计入。
 */
import { type Zdbk, BASE } from "./client.ts";
import { BadResponse } from "../core/errors.ts";
import { htmlToText } from "../core/html.ts";

interface GradeRow extends Record<string, unknown> {
  xkkh?: string; kcdm?: string; kcmc?: string; cj?: string; xf?: string; jd?: string | number; bkcj?: string; xdbj?: string;
}

const GRADES = { path: "cxdy/xscjcx_cxXscjIndex.html", module: "N5083" };
const MAJOR = { path: "zycjtj/xszgkc_cxXsZgkcIndex.html", module: "N908550" };
const TERMS: Record<string, string> = { "1": "秋冬", "2": "春夏" };
const PASS = /^(优秀|良好|中等|及格|合格|[ABCDP])$/;
const RULE = "五分制平均学分绩点 = Σ(学分×绩点)/Σ学分，按浙大发本〔2022〕24号：同一课程多次修读每次都计入；弃修、缓考、二级制合格不计入；缺考、无效、不及格按 0 计入。";
const clean = (v: unknown) => htmlToText(String(v ?? "")).trim();

async function allRows(z: Zdbk, page: { path: string; module: string }, form: Record<string, string>, sort: string): Promise<GradeRow[]> {
  const url = z.url(page.path, page.module), rows: GradeRow[] = [];
  for (let n = 1; ; n++) {
    if (n > 50) throw new BadResponse("成绩列表分页超限");
    const r = await z.grid<GradeRow>(url, form, { page: n, size: 500, sort, order: "asc" });
    rows.push(...r.items);
    if (rows.length >= r.total) return rows;
    if (!r.items.length) throw new BadResponse("成绩列表提前返回空页，结果不完整", { got: rows.length, total: r.total });
  }
}

/** 单门课是否计入绩点；不计入时给出原因 */
function classify(grade: string, point: number | null): string | null {
  if (!grade) return "暂无成绩";
  if (grade.includes("弃修")) return "弃修不计入绩点";
  if (grade.includes("缓考")) return "缓考，成绩待定";
  if (/^(合格|P)$/.test(grade)) return "二级制合格不计绩点";
  if (point === null) return "教务网未给出绩点";
  return null;
}

function toCourse(r: GradeRow) {
  const grade = clean(r.cj), credits = Number(r.xf), raw = clean(r.jd), point = raw === "" || !Number.isFinite(Number(raw)) ? null : Number(raw);
  const excluded = classify(grade, point), remark = clean(r.bkcj);
  if (!Number.isFinite(credits)) throw new BadResponse("成绩行学分不是数字", { course: clean(r.kcmc), xf: r.xf });
  return { name: clean(r.kcmc), grade, credits, gradePoint: point, inGpa: !excluded,
    ...(excluded ? { note: excluded } : {}), ...(remark ? { remark } : {}),
    code: clean(r.kcdm) || clean(r.xkkh).match(/^\([^)]*\)-([^-]+)-/)?.[1] || "", termCode: clean(r.xkkh).match(/^\((\d{4}-\d{4})-(\d+)\)/) };
}
type Course = ReturnType<typeof toCourse>;

function gpa(courses: Course[]) {
  const counted = courses.filter(c => c.inGpa);
  const credits = counted.reduce((s, c) => s + c.credits, 0), points = counted.reduce((s, c) => s + c.credits * c.gradePoint!, 0);
  return { gpa: credits ? Math.round(points / credits * 1000) / 1000 : null, gpaCredits: Math.round(credits * 100) / 100 };
}

export async function getGrades(z: Zdbk) {
  const [gradeRows, majorRows, evaluation] = await Promise.all([
    allRows(z, GRADES, { xn: "", xq: "", zscjl: "", zscjr: "" }, "xkkh"),
    allRows(z, MAJOR, { xh: "", kcmc: "" }, "xkkh, kcdm"),
    // 评教状态只用于解释本学期成绩为何缺失，查询失败不影响成绩结果
    z.postJson<{ status?: string; result?: string }>(`${BASE}/xtgl/index_cxMyCosJxpj.html`, {}).catch(() => null),
  ]);
  const courses = gradeRows.map(toCourse);
  const terms = new Map<string, Course[]>();
  for (const c of courses) {
    if (!c.termCode) throw new BadResponse("成绩行选课课号无法解析学年学期", { course: c.name });
    const key = `${c.termCode[1]}|${c.termCode[2]}`;
    terms.set(key, [...(terms.get(key) ?? []), c]);
  }
  const earned = new Map<string, number>();
  for (const c of courses) if (/^\d+(\.\d+)?$/.test(c.grade) ? Number(c.grade) >= 60 : PASS.test(c.grade)) earned.set(c.code || c.name, c.credits);
  const major = majorRows.filter(r => clean(r.xdbj) === "1").map(toCourse);
  const view = ({ termCode: _t, code: _c, ...c }: Course) => c;
  return {
    summary: { ...gpa(courses), earnedCredits: Math.round([...earned.values()].reduce((s, x) => s + x, 0) * 100) / 100, courseCount: courses.length },
    major: { ...gpa(major), courseCount: major.length, courses: major.map(c => c.name), source: "教务网「成绩主修数据查询」中标记已修的课程" },
    terms: [...terms].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => {
      const [year, code] = key.split("|") as [string, string];
      return { year, term: TERMS[code] ?? `第${code}学期`, ...gpa(list), courses: list.map(view) };
    }),
    ...(evaluation?.status === "success" && evaluation.result !== "1" ? { evaluationPending: "本学期尚未完成评教，教务网暂不显示本学期成绩；完成评教后再查。" } : {}),
    rule: RULE,
    sourceUrl: `${BASE}/${GRADES.path}?gnmkdm=${GRADES.module}`,
  };
}
