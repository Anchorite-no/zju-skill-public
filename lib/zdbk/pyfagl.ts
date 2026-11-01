/**
 * 培养方案查询（pyfagl/pyfaxxcx）。
 *
 * 列表：POST pyfagl/pyfaxxcx_cxPyfaxscxIndex.html?doType=query&gnmkdm=N153020&su=<学号>，
 *       表单 synj（入学年份）、xydm（学院代码）、gjzydm（国际专业代码，可空）、zydm（专业代码，可空）、dlbs（类别，可空）、jxjhh（教学计划号模糊搜）+ queryModel.*，
 *       响应 grid page，每项 jxjhh（教学计划号=pyfaxx_id）、zymc（专业名）、xymc（学院名）、zdbyxf（最低毕业学分）、syxw（授予学位）、
 *            zyhxkc（核心课，<br>分隔）、qywkc（前沿课，<br>分隔）、xz（学制）、xqmc（校区）、dlbsmc（类别名）等。
 * 专业下拉：POST xtgl/comm_cxPyfaZyxxList.html?rangeType=ggxydm&rangeable=false&gnmkdm=N153020&su=<学号>，
 *         表单 njdm_id（年级）、jg_id（学院id），响应 [{zydm, zyh_id, zymc}]（zyh_id=zydm）。
 * PDF 下载：GET pyfagl/pyfayl_cxPyfaylPdf.html?id=<jxjhh>&doType=query&gnmkdm=N153020&su=<学号>，响应 PDF 二进制（iText 生成）。
 *          id=教学计划号（jxjhh，和 pyfaxx_id 同值），文件名通常空（`inline;filename=""`），实测 334 KB。
 *
 * 从首页推本人方案：GET xsxk/zzxkghb_cxZzxkGhbIndex.html?gnmkdm=N253530&su=<学号> 里的 <input id="nj" value="…"> / <input id="zydm" value="…">，
 *                   jxjhh=nj+zydm（如 20252112），用这个 id 查列表或直接下 PDF。
 */
import { Zdbk, MODULE, stripRow } from "./client.ts";
import fs from "node:fs";
import path from "node:path";
import { BadResponse, ConfigError, NeedsUser } from "../core/errors.ts";
import { inputValue } from "../core/http.ts";
import { uniqueMatch } from "../core/match.ts";
import { paths } from "../core/paths.ts";

export interface PlanRow {
  /** 教学计划号（=pyfaxx_id，也是 PDF 的 id）*/
  jxjhh: string;
  pyfaxx_id?: string;
  /** 专业代码 */
  zydm?: string;
  /** 专业名称 */
  zymc: string;
  /** 学院代码 */
  xydm?: string;
  /** 学院名称 */
  xymc: string;
  /** 入学年份 */
  synj?: string;
  /** 最低毕业学分 */
  zdbyxf?: string;
  /** 授予学位 */
  syxw?: string;
  /** 学制 */
  xz?: string;
  /** 校区 */
  xqmc?: string;
  /** 类别（专业/辅修/…）*/
  dlbsmc?: string;
  /** 专业核心课（<br> 分隔）*/
  zyhxkc?: string;
  /** 前沿课（<br> 分隔）*/
  qywkc?: string;
  /** 培养目标 */
  pymb?: string;
  /** 培养要求 */
  pyyq?: string;
  [k: string]: unknown;
}

export interface Plan {
  id: string;
  major: string;
  college: string;
  year: string;
  credits: string;
  degree: string;
  duration: string;
  campus: string;
  category: string;
  coreCourses: string[];
  frontierCourses: string[];
  pdfUrl: string;
}

export interface Major {
  code: string;
  name: string;
}

export interface ListPlansOptions {
  year?: string;
  college?: string;
  major?: string;
  category?: string;
  keyword?: string;
  page?: number;
  size?: number;
}

export function toPlan(r: PlanRow): Plan {
  const id = String(r.jxjhh ?? r.pyfaxx_id ?? "");
  return {
    id,
    major: String(r.zymc ?? ""),
    college: String(r.xymc ?? ""),
    year: String(r.synj ?? ""),
    credits: String(r.zdbyxf ?? ""),
    degree: String(r.syxw ?? ""),
    duration: String(r.xz ?? ""),
    campus: String(r.xqmc ?? ""),
    category: String(r.dlbsmc ?? ""),
    // zyhxkc/qywkc 实测是"课A  课B  课C"双空格分隔（有的行用 <br>），两种都切开
    coreCourses: (r.zyhxkc ?? "").split(/<br\s*\/?>|\s{2,}/i).map((s) => s.trim()).filter(Boolean),
    frontierCourses: (r.qywkc ?? "").split(/<br\s*\/?>|\s{2,}/i).map((s) => s.trim()).filter(Boolean),
    pdfUrl: pdfUrl(id),
  };
}

export function pdfUrl(id: string): string {
  return `https://zdbk.zju.edu.cn/jwglxt/pyfagl/pyfayl_cxPyfaylPdf.html?id=${encodeURIComponent(id)}&doType=query&gnmkdm=N153020`;
}

export async function listPlans(z: Zdbk, opts: ListPlansOptions = {}): Promise<{ plans: Plan[]; total: number; page: number; size: number; totalPages: number }> {
  const form = { synj: opts.year ?? "", xydm: opts.college ?? "", gjzydm: "", zydm: opts.major ?? "", dlbs: opts.category ?? "", jxjhh: opts.keyword ?? "" };
  const page: Parameters<Zdbk["grid"]>[2] = { sort: "synj desc, xymc, jxjhh" };
  if (opts.page !== undefined) page.page = opts.page;
  if (opts.size !== undefined) page.size = opts.size;
  const r = await z.grid<PlanRow>(z.url("pyfagl/pyfaxxcx_cxPyfaxscxIndex.html", MODULE.pyfa), form, page);
  return { plans: r.items.map(toPlan), total: r.total, page: r.page, size: r.size, totalPages: r.totalPages };
}

export async function listMajors(z: Zdbk, year: string, college: string): Promise<Major[]> {
  const res = await z.postJson<{ zydm: string; zyh_id: string; zymc: string }[]>(z.url("xtgl/comm_cxPyfaZyxxList.html?rangeType=ggxydm&rangeable=false", MODULE.pyfa), { njdm_id: year, jg_id: college });
  return res.map((m) => ({ code: m.zydm, name: m.zymc }));
}

/** 下载 PDF（返回原始字节，调用方自己存盘或转文本）*/
export async function downloadPdf(z: Zdbk, id: string): Promise<Buffer> {
  const res = await z.get(pdfUrl(id) + `&su=${z.su}`);
  if (res.status !== 200) throw new BadResponse(`培养方案 PDF HTTP ${res.status}`, { id });
  if (!res.contentType.includes("pdf")) throw new BadResponse(`培养方案 ${id} 未返回 PDF`, { contentType: res.contentType });
  return res.raw;
}

/** 从选课首页推导本人的教学计划号（nj + zydm）*/
export async function getMyPlanId(z: Zdbk): Promise<{ id: string; year: string; major: string } | null> {
  const res = await z.get(z.url("xsxk/zzxkghb_cxZzxkGhbIndex.html", MODULE.xsxk));
  if (res.status !== 200) return null;
  const nj = inputValue(res.body, "nj");
  const zydm = inputValue(res.body, "zydm");
  if (!nj || !zydm) return null;
  return { id: nj + zydm, year: nj, major: zydm };
}

// ----- 按名称的任务入口：一个年级的方案约 150 个，一次取全后在本地按学院、专业名筛选 -----

async function plansOfYear(z: Zdbk, year: string): Promise<Plan[]> {
  if (!/^\d{4}$/.test(year)) throw new ConfigError("入学年份应为四位数字，如 2025");
  const first = await listPlans(z, { year, size: 500 });
  const plans = [...first.plans];
  for (let page = 2; page <= first.totalPages; page++) plans.push(...(await listPlans(z, { year, size: 500, page })).plans);
  return plans;
}
async function myPlan(z: Zdbk) {
  const mine = await getMyPlanId(z);
  if (!mine) throw new BadResponse("选课首页没有年级、专业信息，无法确定本人的培养方案");
  return mine;
}
const planRow = (p: Plan) => ({ major: p.major, college: p.college, year: p.year, category: p.category, credits: p.credits, degree: p.degree, duration: p.duration });

/** 某一年级的培养方案，可按学院名、专业名筛选；年级默认本人入学年。 */
export async function findPlans(z: Zdbk, opts: { year?: string; college?: string; major?: string } = {}) {
  const year = opts.year ?? (await myPlan(z)).year;
  const has = (value: string, wanted?: string) => !wanted || value.includes(wanted.trim());
  const plans = (await plansOfYear(z, year)).filter((p) => has(p.college, opts.college) && has(p.major, opts.major));
  return { year, count: plans.length, plans: plans.map(planRow) };
}

/** 本人或指定专业的培养方案：基本信息、核心课，并把完整 PDF 存到本地（课程表在 PDF 里）。 */
export async function viewPlan(z: Zdbk, opts: { major?: string; year?: string } = {}) {
  let plan: Plan | undefined;
  if (opts.major) {
    plan = uniqueMatch(await plansOfYear(z, opts.year ?? (await myPlan(z)).year), opts.major, (p) => [p.major], planRow, "专业");
  } else {
    const mine = await myPlan(z), id = (opts.year ?? mine.year) + mine.major;
    plan = (await listPlans(z, { keyword: id })).plans.find((p) => p.id === id);
    if (!plan) throw new NeedsUser(`没有找到 ${opts.year ?? mine.year} 级本专业的培养方案`);
  }
  const file = path.join(paths.output(), "zdbk", `培养方案-${plan.year}-${plan.major.replace(/[<>:"/\\|?*]/g, "_")}.pdf`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await downloadPdf(z, plan.id));
  return { ...planRow(plan), campus: plan.campus, coreCourses: plan.coreCourses, frontierCourses: plan.frontierCourses, file,
    note: "file 是完整培养方案 PDF（各学期课程与学分要求），用 doc text --file 读取。" };
}

export { stripRow };
