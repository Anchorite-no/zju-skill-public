/** 自主选课基础 API：常规选课与低定共用端点，本文件不实现抢课循环。 */
import { MODULE, type Zdbk } from "./client.ts";
import { BadResponse, ConfigError, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { decodeEntities, htmlToText } from "../core/html.ts";

export type SelectionPort = Pick<Zdbk, "url" | "get" | "postJson" | "postOnce">;
export type SelectionRow = Record<string, unknown> & { xkkh: string; kcdm: string };
export interface Category { dl: string; lx: string; name: string; kcbs: string; kind: "courses" | "search" | "special" }
export interface SelectionContext {
  xn: string; xq: string; nj: string; zydm: string; jxjhh: string; xnxq: string;
  ylxs: string; xkzys: number; categories: Category[];
}
export const SEARCH_FIELDS = ["kcmc", "kcdm", "jsxm", "kclb", "sksj", "skdd", "kkxy", "xxq"] as const;
export const SEARCH_OPERATORS = ["like", "notlike", "equal", "notequal", "leftlike", "notleftlike", "rightlike", "notrightlike"] as const;
export interface SearchCondition { field: typeof SEARCH_FIELDS[number]; operator?: typeof SEARCH_OPERATORS[number]; value: string }
export interface SearchOptions {
  keyword?: string; field?: typeof SEARCH_FIELDS[number]; conditions?: SearchCondition[]; relation?: "and" | "or";
  page?: number; size?: number; onlyAvailable?: boolean;
}
export interface SectionQuery {
  course: string; pool: string; category: string; search?: SearchOptions;
}
export interface SelectionTarget extends SectionQuery { xkkh: string }
export interface CoursePage { items: (SelectionRow & { query: SectionQuery })[]; page: number; size: number; hasMore: boolean }
export interface SelectionJournalEvent { at: string; action: string; stage: string; detail: Record<string, unknown> }
export interface SelectionWriteOptions {
  dryRun?: boolean; confirm?: boolean; journal?: (event: SelectionJournalEvent) => void | Promise<void>;
}
export interface SelectionWriteResult {
  action: "select" | "drop" | "reorder";
  status: "preview" | "saved" | "already_saved" | "rejected" | "unknown";
  verified: boolean; message: string; target: unknown;
  response?: unknown; requestError?: string; verificationError?: string;
  choices?: SelectionRow[];
}

const string = (v: unknown) => v === undefined || v === null ? "" : String(v);
function required(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new ConfigError(`需要 ${name}`);
  return v.trim();
}
function attrs(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map(m => [m[1]!, decodeEntities(m[3]!)]));
}
export function parseSelectionContext(html: string): SelectionContext {
  const inputs: Record<string, string> = {};
  const clean = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of clean.matchAll(/<input\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.id || a.name) inputs[(a.id || a.name)!] = a.value ?? "";
  }
  for (const k of ["xn", "xq", "nj", "zydm", "xkzys"]) {
    if (!inputs[k]) throw new BadResponse(`选课首页缺少 ${k}，可能当前不可用`);
  }
  const xkzys = Number(inputs.xkzys);
  if (!/^\d{4}-\d{4}$/.test(inputs.xn!) || !/^\d+$/.test(inputs.xq!) || !Number.isInteger(xkzys) || xkzys < 1) {
    throw new BadResponse("选课首页学期或志愿数格式异常");
  }
  // 取 onclick 中真正传给 categroyClick 的参数；某些页签 data-dl 与 onclick 不同。
  const stack: Record<string, string>[] = [], categories: Category[] = [];
  for (const m of clean.matchAll(/<li\b[^>]*>|<\/li\s*>|<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = m[0];
    if (/^<li\b/i.test(tag)) { stack.push(attrs(tag)); continue; }
    if (/^<\/li/i.test(tag)) { stack.pop(); continue; }
    const a = attrs(tag.slice(0, tag.indexOf(">") + 1));
    const call = a.onclick?.match(/categroyClick\(\s*this\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/);
    if (!call) continue;
    const parent = stack.at(-1) ?? {}, dl = call[1]!, lx = call[2]!;
    const name = parent.kclbmc || parent.title || htmlToText(tag);
    const kind = dl === "xk_9" ? "search" : ["xk_1_1", "iconyjsxk", "xk_7"].includes(dl) ? "special" : "courses";
    if (!categories.some(c => c.dl === dl && c.lx === lx && c.name === name)) categories.push({ dl, lx, name, kcbs: parent.kcbs ?? "", kind });
  }
  return { xn: inputs.xn!, xq: inputs.xq!, nj: inputs.nj!, zydm: inputs.zydm!, jxjhh: inputs.nj! + inputs.zydm!,
    xnxq: `(${inputs.xn}-${inputs.xq})-`, ylxs: inputs.ylxs ?? "", xkzys, categories };
}

const FIELDS = new Set(("xkkh kcdm xskcdm t_kcdm kcmc kcxx kcbs kcgs kclb kcxz kcxzzt kkxy sftsxxk sftyfx tsbj " +
  "jsxm jszgh jcmc tabname xf sxf xxq vxxq t_xxq sksj vsksj skdd kssj vkssj zxs skxs mxdx gjhkc jxfs " +
  "rs yxrs brs grs brl grl sfxz sxbj xkzy xkzyfz vxkzyfz zyfzByKcdm xksj jxbly hkbj xxkbj jcyd").split(" "));
function rows(value: unknown, label: string, course?: string): SelectionRow[] {
  if (!Array.isArray(value)) throw new BadResponse(`${label}未返回数组`);
  return value.map(v => {
    if (!v || typeof v !== "object" || !string(v.xkkh) || !string(v.kcdm ?? v.t_kcdm ?? course)) throw new BadResponse(`${label}记录缺少课程或教学班标识`);
    // 实际教学班响应没有 kcdm，使用该次查询的课程代码；其他列表仍必须返回代码。
    return { ...Object.fromEntries(Object.entries(v).filter(([k]) => FIELDS.has(k))), xkkh: string(v.xkkh), kcdm: string(v.kcdm ?? v.t_kcdm ?? course) };
  });
}
export function preferenceGroup(row: SelectionRow): string { return string(row.xkzyfz) || row.kcdm; }
export function selectionState(row: SelectionRow): "selected" | "pending" | "unknown" {
  return string(row.sxbj) === "1" ? "selected" : string(row.sxbj) === "0" ? "pending" : "unknown";
}
export function parseCapacity(value: unknown): { remaining: number | null; capacity: number | null } {
  const m = string(value).match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  return m ? { remaining: Number(m[1]), capacity: Number(m[2]) } : { remaining: null, capacity: null };
}
function pageForm(page = 1, size = 20): Record<string, string> {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 50) throw new ConfigError("page 必须为正整数，size 必须为 1–50");
  return { kspage: String((page - 1) * size + 1), jspage: String(page * size) };
}
function searchForm(c: SelectionContext, opts: SearchOptions): Record<string, string> {
  if (opts.keyword !== undefined && opts.conditions !== undefined) throw new ConfigError("keyword 和 conditions 只能选一种");
  const conditions = opts.conditions ?? [{ field: opts.field ?? "kcmc", value: required(opts.keyword, "keyword 或 conditions") }];
  const relation = opts.relation ?? "and";
  if (!["and", "or"].includes(relation) || !Array.isArray(conditions) || !conditions.length || conditions.length > 20) throw new ConfigError("搜索需 1–20 个条件，relation 为 and/or");
  const form: Record<string, string> = { xnxq: c.xnxq, cx_zbgx: relation, cx_ylcx: opts.onlyAvailable ? "1" : "0" };
  conditions.forEach((cond, i) => {
    if (!cond || !SEARCH_FIELDS.includes(cond.field) || !SEARCH_OPERATORS.includes(cond.operator ?? "like")) throw new ConfigError("搜索条件字段或比较方式无效");
    form[`cxtjList[${i}].cxlb`] = cond.field;
    form[`cxtjList[${i}].cxgx`] = cond.operator ?? "like";
    form[`cxtjList[${i}].cxnr`] = required(cond.value, "搜索条件 value");
  });
  return form;
}
function assertTerm(id: string, c: SelectionContext, pool = false): void {
  // 体育池实测为 4(学年-学期)-代码，普通池可为 T/A；实际教学班没有池前缀。
  const m = id.match(pool ? /^[A-Z0-9]?\((\d{4}-\d{4})-(\d+)\)-/ : /^\((\d{4}-\d{4})-(\d+)\)-/);
  if (!m || m[1] !== c.xn || m[2] !== c.xq) throw new ConfigError(`教学班／课程池不属于当前选课学期 ${c.xn}-${c.xq}`);
}
function gate(o: SelectionWriteOptions, action: string): void {
  if (o.dryRun) return;
  if (!o.confirm || !writeAllowed()) throw new WriteGateClosed(action);
  if (typeof o.journal !== "function") throw new ConfigError("选课写操作必须提供 journal");
}
function normal(row: SelectionRow): void {
  if (string(row.jxbly) === "2" || row.tabname === "jxrwbview") throw new ConfigError("补考选课不属于本接口的常规志愿操作");
}

export class Xsxk {
  readonly z: SelectionPort;
  private cached: SelectionContext | undefined;
  constructor(z: SelectionPort, context?: SelectionContext) { this.z = z; this.cached = context; }
  private url(name: string) { return this.z.url(`xsxk/zzxkghb_${name}.html`, MODULE.xsxk); }
  async context(fresh = false): Promise<SelectionContext> {
    if (!this.cached || fresh) {
      const r = await this.z.get(this.url("cxZzxkGhbIndex"));
      if (r.status !== 200) throw new BadResponse(`选课首页 HTTP ${r.status}`);
      this.cached = parseSelectionContext(r.body);
    }
    return this.cached;
  }
  async owned(): Promise<SelectionRow[]> {
    const c = await this.context();
    return rows(await this.z.postJson(this.url("cxZzxkGhbChoosed"), { xn: c.xn, xq: c.xq }), "已选志愿");
  }
  async credits(): Promise<{ total: number; regular: number; short: number }> {
    await this.context();
    const data = await this.z.postJson<{ status?: string; result?: Record<string, unknown> }>(this.url("cxZzxkYxxf"), {});
    const v = data?.result;
    if (data?.status !== "success" || !v || ["xf9", "xf91", "xf92"].some(k => v[k] === null || v[k] === undefined || v[k] === "" || !Number.isFinite(Number(v[k])) || Number(v[k]) < 0)) {
      throw new BadResponse("选课学分汇总响应不完整");
    }
    return { total: Number(v.xf9), regular: Number(v.xf91), short: Number(v.xf92) };
  }
  async courses(opts: { category?: string; name?: string; page?: number; size?: number } = {}): Promise<CoursePage> {
    const c = await this.context(), dl = opts.category ?? "xk_1";
    const matches = c.categories.filter(t => t.dl === dl && (!opts.name || t.name === opts.name));
    if (matches.length !== 1) throw new ConfigError("页签不存在或有多个同码类别，请从 context 选择 category 与 name");
    const cat = matches[0]!;
    if (cat.kind !== "courses") throw new ConfigError("此页签使用独立查询流程；搜索请用 search，补考等特殊选课暂未接入");
    const items = rows(await this.z.postJson(this.url("cxZzxkGhbKcList"), {
      dl, lx: cat.lx, xkmc: dl === "Z" ? "竺可桢学院课程" : cat.name, kcbs: cat.kcbs,
      nj: c.nj, xn: c.xn, xq: c.xq, zydm: c.zydm,
      jxjhh: dl === "xk_6" ? c.xn.slice(0, 4) + "cx01" : c.jxjhh, xnxq: c.xnxq, ...pageForm(opts.page, opts.size),
    }), "课程列表");
    return { items: items.map(row => ({ ...row, query: { course: row.kcdm, pool: row.xkkh, category: dl } })), page: opts.page ?? 1, size: opts.size ?? 20, hasMore: items.length === (opts.size ?? 20) };
  }
  async search(opts: SearchOptions): Promise<CoursePage> {
    const c = await this.context();
    const items = rows(await this.z.postJson(this.url("cxZzxkGhbDdkcList"), { ...searchForm(c, opts), ...pageForm(opts.page, opts.size) }), "搜索结果");
    return { items: items.map(row => ({ ...row, query: { course: row.kcdm, pool: row.xkkh, category: "xk_9", search: opts } })), page: opts.page ?? 1, size: opts.size ?? 20, hasMore: items.length === (opts.size ?? 20) };
  }
  async sections(query: SectionQuery): Promise<(SelectionRow & { remaining: number | null; capacity: number | null; choice: SelectionTarget })[]> {
    const c = await this.context();
    const course = required(query.course, "course"), pool = required(query.pool, "pool"), dl = required(query.category, "category");
    assertTerm(pool, c, true);
    if (!c.categories.some(cat => cat.dl === dl && cat.kind !== "special")) throw new ConfigError("此查询页签不在当前普通选课页签中");
    if (dl === "xk_9" && !query.search) throw new ConfigError("搜索结果展开教学班时须保留原 search 条件");
    const items = rows(await this.z.postJson(this.url("cxZzxkGhbJxbList"), {
      dl, xn: c.xn, xq: c.xq, kcdm: course, xkkh: pool, ylxs: c.ylxs,
      ...(dl === "xk_9" ? searchForm(c, query.search!) : {}),
    }), "教学班列表", course);
    return items.map(row => ({ ...row, ...parseCapacity(row.rs), choice: { ...query, xkkh: row.xkkh } }));
  }

  private async mutate(action: SelectionWriteResult["action"], name: string, form: Record<string, string>, target: unknown,
    opts: SelectionWriteOptions, verify: (items: SelectionRow[]) => boolean): Promise<SelectionWriteResult> {
    // journal 必须在发包前完成；落盘失败不能发写请求。
    await opts.journal!({ at: new Date().toISOString(), action, stage: "before", detail: { form, target } });
    let response: unknown, requestError: string | undefined;
    try {
      const r = await this.z.postOnce(this.url(name), form, { headers: { Referer: this.url("cxZzxkGhbIndex") } });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      response = r.json();
      if (response === null) throw new Error("写接口未返回有效 JSON");
    } catch (e) { requestError = (e as Error).message; }
    let choices: SelectionRow[] | undefined, verificationError: string | undefined;
    try { choices = await this.owned(); } catch (e) { verificationError = (e as Error).message; }
    const verified = choices !== undefined && verify(choices);
    const rejected = !!response && typeof response === "object" && string((response as Record<string, unknown>).flag) === "0";
    const result: SelectionWriteResult = { action, target, verified,
      status: verified ? "saved" : rejected ? "rejected" : "unknown",
      message: verified ? (action === "select" ? "志愿已保存，常规选课需等待学校筛选" : action === "reorder" ? "志愿顺序已保存" : "退选已回查确认")
        : rejected ? string((response as Record<string, unknown>).msg) || "服务器拒绝操作" : "未能核实写入结果；请查询已选志愿，不要自动重试",
      ...(response !== undefined ? { response } : {}), ...(requestError ? { requestError } : {}),
      ...(verificationError ? { verificationError } : {}), ...(choices ? { choices } : {}),
    };
    await opts.journal!({ at: new Date().toISOString(), action, stage: "after", detail: { result } });
    return result;
  }
  async select(target: SelectionTarget, opts: SelectionWriteOptions): Promise<SelectionWriteResult> {
    gate(opts, "教务网选课");
    const c = await this.context(true), xkkh = required(target.xkkh, "xkkh");
    assertTerm(xkkh, c);
    const before = await this.owned();
    // 只对同一教学班去重，不能阻止同课的第二、第三志愿。
    const exists = before.find(r => r.xkkh === xkkh);
    if (exists) { normal(exists); return { action: "select", status: opts.dryRun ? "preview" : "already_saved", verified: true, message: "该教学班已在志愿中，无需重复提交", target: exists, choices: before }; }
    const candidates = await this.sections(target), candidate = candidates.find(r => r.xkkh === xkkh);
    if (!candidate) throw new ConfigError("目标教学班不在当前查询结果中，请重新查询");
    normal(candidate);
    const tabname = required(candidate.tabname, "教学班返回的 tabname");
    const preview = { context: { xn: c.xn, xq: c.xq, xkzys: c.xkzys }, candidate,
      note: "提交保存一个教学班志愿；同课可有多个志愿，时间冲突与资格由服务器校验。已选上／预置课程改选可能重新参与筛选。" };
    if (opts.dryRun) return { action: "select", status: "preview", verified: false, message: "只读预览，未提交", target: preview, choices: before };
    return this.mutate("select", "xkBcZyZzxkGhb", { xn: c.xn, xq: c.xq, nj: c.nj, xkkh, tabname, xkzys: String(c.xkzys) }, preview, opts, items => items.some(r => r.xkkh === xkkh));
  }
  async reorder(xkkhs: string[], opts: SelectionWriteOptions): Promise<SelectionWriteResult> {
    gate(opts, "教务网志愿排序");
    if (!Array.isArray(xkkhs) || !xkkhs.length || new Set(xkkhs).size !== xkkhs.length) throw new ConfigError("xkkhs 必须是无重复的非空教学班数组");
    const c = await this.context(true);
    xkkhs.forEach(id => { required(id, "xkkhs"); assertTerm(id, c); });
    const before = await this.owned(), selected = xkkhs.map(id => before.find(r => r.xkkh === id));
    if (selected.some(r => !r)) throw new ConfigError("排序含不存在的志愿，请重新查询 selected");
    selected.forEach(r => normal(r!));
    const group = preferenceGroup(selected[0]!);
    if (selected.some(r => preferenceGroup(r!) !== group)) throw new ConfigError("一次仅能排列同一志愿组");
    const members = before.filter(r => preferenceGroup(r) === group);
    if (members.length !== xkkhs.length) throw new ConfigError("必须提交该志愿组的完整教学班顺序，不能遗漏现有志愿");
    const verify = (items: SelectionRow[]) => {
      const current = items.filter(r => preferenceGroup(r) === group);
      return current.length === xkkhs.length && xkkhs.every((id, i) => current.some(r => r.xkkh === id && Number(r.xkzy) === i + 1));
    };
    const target = { group, xkkhs, before: members, note: "调整已选上／预置课程志愿顺序会重新参与筛选" };
    if (opts.dryRun) return { action: "reorder", status: "preview", verified: false, message: "只读排序预览，未提交", target };
    if (verify(before)) return { action: "reorder", status: "already_saved", verified: true, message: "志愿顺序已符合要求", target, choices: before };
    return this.mutate("reorder", "xkBcZypxZzxkGhb", { xkkhs: xkkhs.join(","), zypxs: xkkhs.map((_, i) => i + 1).join(",") }, target, opts, verify);
  }
  async drop(xkkh: string, opts: SelectionWriteOptions): Promise<SelectionWriteResult> {
    gate(opts, "教务网退选");
    const c = await this.context(true);
    required(xkkh, "xkkh"); assertTerm(xkkh, c);
    const before = await this.owned(), target = before.find(r => r.xkkh === xkkh);
    if (!target) return { action: "drop", status: opts.dryRun ? "preview" : "already_saved", verified: true, message: "该教学班已不在志愿中", target: { xkkh }, choices: before };
    normal(target);
    if (opts.dryRun) return { action: "drop", status: "preview", verified: false, message: "只读退选预览；已选上／预置课退选后不能保证重新选上", target, choices: before };
    return this.mutate("drop", "tuikBcZzxkGhb", { xkkh }, target, opts, items => !items.some(r => r.xkkh === xkkh)
      && before.filter(r => r.xkkh !== xkkh).every(r => items.some(current => current.xkkh === r.xkkh)));
  }
}
