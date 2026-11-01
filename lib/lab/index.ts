/**
 * 实验课选课平台（"浙江大学实验选课系统"，http://10.203.16.55:86/lab-course/selectCourse）。
 * 与教务网选课（zdbk xsxk）是两套独立系统：这个只管实验课（大学物理实验等），账号是平台本地的（默认同学号）。
 *
 * 结构（2026-09-18 从 SPA app.js 逆向 + 本人账号实测）：
 *   - 86 端口是 Vue SPA 静态页；API 在 http://10.203.16.55:8098/lab-course/api/*（HTTP，校内 IP，走 WebVPN 重写 http-8098）。
 *   - 登录：POST /api/login {username, password}（无 Authorization）→ data{token:{access_token(JWT), token_type:bearer}, name, role, roles}。
 *     JWT 有效期 48h（exp-nbf）。多角色时前端让用户选（/api/change_role {roles:roleId, username} 换发 token）；学生角色 id=1。
 *   - 每个请求都要带 app_key + timestamp(ms) + sign，与业务参数混在一起（GET 进 query，POST 进表单体）：
 *       sign = md5(secret + path + 排序后(按参数名)的 k+v（跳过空值和对象） + timestamp + " " + secret)
 *     app_key/secret 是前端混淆常量解码出来的（base64→hex），写死在下面。
 *   - 请求头 Authorization: <token_type> <access_token>（登录除外）。
 *   - 响应信封 {code, message, data}：200 成功；401 无权限；408 token 失效（前端跳登录）；其它把 message 报错。
 *   - 选课：POST /api/course/lab/students {courseId, courseLabId, uid, termId, selectWeek}；退选 POST /api/course/lab/students/del/{记录id}。
 *     selectWeek 取班次 openWeek（JSON 数组字符串，如 ["1,2","3,4"]）中的一个元素（周次段）。
 */
import type { ModuleRequirements } from "../core/module.ts";
import { openContext, type Context, type OpenOptions } from "../webvpn/transport.ts";
import { SessionStore } from "../zjuam/session.ts";
import { readProfile, credentials } from "../profile/profile.ts";
import { AuthExpired, BadResponse, ConfigError, RemoteRejected, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { log, debug } from "../core/output.ts";
import { htmlToText } from "../core/html.ts";
import crypto from "node:crypto";
import { fileJournal } from "../core/journal.ts";
import { uniqueMatch } from "../core/match.ts";

export const LAB_HOST = "10.203.16.55";
export const API_PORT = 8098;
export const API_BASE = `http://${LAB_HOST}:${API_PORT}/lab-course`;
export const SITE_URL = `http://${LAB_HOST}:86/lab-course/selectCourse`;
/** 前端 app.js 里混淆常量解码结果（base64→hex），写死 */
export const APP_KEY = "eb8c68399de7483abb2d8abaea0d039f";
export const APP_SECRET = "7cd476ab866b49d7a9788ad9f4789495";
export const ROLE_STUDENT = 1;

export const requirements: ModuleRequirements = {
  name: "lab",
  title: "实验课选课平台",
  hosts: [LAB_HOST],
  auth: "own",
  network: "campus",
  writes: true,
};

/** sign = md5(secret + path + 按参数名排序的 k+v（跳过空值和对象） + timestamp + " " + secret) */
export function apiSign(path: string, timestamp: number, data: Record<string, string | number | undefined>): string {
  let n = APP_SECRET + path;
  for (const k of Object.keys(data).sort()) {
    const v = data[k];
    if (v !== "" && v !== undefined && v !== null && typeof v !== "object") n += k + String(v);
  }
  n += timestamp + " " + APP_SECRET;
  return crypto.createHash("md5").update(n).digest("hex");
}

// ---------- 类型 ----------

export interface Term {
  id: number;
  name: string;
  currentTerm?: number;
  stadate?: string;
  enddate?: string;
}

export interface Course {
  id: number;
  courseName?: string;
  name?: string;
  [k: string]: unknown;
}

export interface LabSection {
  /** 班次 id（courseLabId） */
  id: number;
  courseId: number;
  termId: number;
  labName: string;
  /** 容量 */
  contain: number;
  /** 已选人数 */
  counts: number;
  /** 可选周次段，解析自 openWeek（JSON 数组字符串），selectWeek 取其中一个 */
  weeks: string[];
  /** 星期几 1–7 */
  week?: number;
  /** 1=上午 2=下午（推测） */
  time?: number;
  teacherName?: string;
  teacherId?: string;
  address?: string;
  /** 开始时刻，如 "10:00" */
  times?: string;
  isMust?: number;
  [k: string]: unknown;
}

export interface LabJournalEvent { type: "submit" | "reconcile"; at: number; detail: Record<string, unknown> }
export type LabJournal = (event: LabJournalEvent) => void | Promise<void>;

function selectionMatches(s: Selection, target: { lab: number; week: string }, courseId: number, termId: number): boolean {
  const week = (value: string) => value.split(",").map(Number).sort((a, b) => a - b).join(",");
  return Number(s.courseLabId) === target.lab && week(String(s.selectWeek ?? "")) === week(target.week)
    && (s.courseId === undefined || Number(s.courseId) === courseId)
    && (s.termId === undefined || Number(s.termId) === termId);
}

export interface Selection {
  id: number;
  courseLabId: number;
  courseId?: number;
  termId?: number;
  selectWeek?: string;
  labName?: string;
  teacherName?: string;
  uid?: string;
  [k: string]: unknown;
}

export interface OpenWindow {
  id: number;
  termId: number;
  courseName: string;
  /** 每门课可选实验个数上限 */
  count: number;
  /** 选课窗口（毫秒时间戳） */
  startDate: number;
  endDate: number;
  week?: number;
  time?: number;
  [k: string]: unknown;
}

/** 我的课表里的一次实验课；sequence 是平台"周次"（绪论后的实验序号，不是校历周），date 缺失时为 null */
export interface LabSession {
  date: string | null;
  /** 开始时刻，如 "10:00" */
  start: string;
  course: string;
  experiment: string;
  room: string;
  teacher: string;
  sequence: string;
}

/** 每次实验的报告分；未出分为 null，不代表未提交报告。 */
export interface LabGrade {
  course: string;
  experiment: string;
  teacher: string;
  sequence: string;
  score: number | null;
  status: "已评分" | "未出分";
}

export interface LabNotice {
  id: number;
  title: string;
  /** 正文纯文本 */
  text: string;
  publishedAt?: string;
  [k: string]: unknown;
}

// ---------- 会话 ----------

export interface LabAuth {
  username: string;
  name: string;
  role: number;
  token: string;
  tokenType: string;
  /** JWT exp（毫秒） */
  expiresAt: number;
}

/** 解 JWT payload 的 exp（秒→毫秒）；解不开返回 undefined */
export function jwtExpiresAt(token: string): number | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const p = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: number };
    return typeof p.exp === "number" ? p.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function labSession(username: string): SessionStore {
  return new SessionStore({ system: "lab-course", username, ttlMs: 48 * 3600 * 1000 });
}
export function labSessionStatus(username: string) {
  const store = labSession(username), extra = store.load()?.extra;
  const expiresAt = typeof extra?.expiresAt === "number" ? extra.expiresAt : 0;
  const cached = typeof extra?.token === "string" && !!extra.token && expiresAt > Date.now() + 60_000;
  return { username, file: store.file, cached, ...(cached ? { name: String(extra?.name ?? ""), role: Number(extra?.role ?? ROLE_STUDENT), expiresAt } : {}) };
}

function labCredentials(): { username: string; password: string } {
  const p = readProfile();
  const username = p.lab_username || credentials().username;
  if (!p.lab_password) throw new ConfigError("缺少实验课平台密码", `在 profile.env 填 lab_username / lab_password（账号默认同学号 ${username}）`);
  return { username, password: p.lab_password };
}

export class LabCourse {
  readonly ctx: Context;
  readonly username: string;
  readonly store: SessionStore;
  private auth: LabAuth | undefined;
  private loginPromise: Promise<LabAuth> | undefined;

  constructor(ctx: Context, username: string) {
    this.ctx = ctx;
    this.username = username;
    this.store = labSession(username);
    const cached = this.store.load();
    const token = typeof cached?.extra.token === "string" ? cached.extra.token : undefined;
    const tokenType = typeof cached?.extra.tokenType === "string" ? cached.extra.tokenType : "bearer";
    const expiresAt = typeof cached?.extra.expiresAt === "number" ? cached.extra.expiresAt : undefined;
    if (token && expiresAt && expiresAt > Date.now() + 60_000) {
      this.auth = { username, name: String(cached?.extra.name ?? ""), role: Number(cached?.extra.role ?? ROLE_STUDENT), token, tokenType, expiresAt };
      debug("lab: 复用缓存 token");
    }
  }

  get hasToken(): boolean {
    return !!this.auth;
  }

  login(force = false): Promise<LabAuth> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.doLogin(force).finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private async doLogin(force: boolean): Promise<LabAuth> {
    if (this.auth && !force) return this.auth;
    const { username, password } = labCredentials();
    const d = await this.raw<{ token: { access_token: string; token_type?: string }; name: string; role: number; roles?: { id: number; name: string }[]; username?: string }>("/api/login", { username, password }, "POST", false);
    let auth: LabAuth = { username, name: String(d.name ?? ""), role: Number(d.role ?? 0), token: d.token.access_token, tokenType: d.token.token_type || "bearer", expiresAt: jwtExpiresAt(d.token.access_token) ?? Date.now() + 48 * 3600 * 1000 };
    // 多角色：默认切到学生角色（换发 token）
    if (Array.isArray(d.roles) && d.roles.length > 1 && auth.role !== ROLE_STUDENT) {
      const d2 = await this.raw<{ token: { access_token: string; token_type?: string }; name: string; role: number }>("/api/change_role", { roles: ROLE_STUDENT, username }, "POST", false);
      auth = { ...auth, token: d2.token.access_token, tokenType: d2.token.token_type || auth.tokenType, role: Number(d2.role ?? ROLE_STUDENT), expiresAt: jwtExpiresAt(d2.token.access_token) ?? auth.expiresAt };
    }
    this.auth = auth;
    this.store.save(this.ctx.http.jar, { token: auth.token, tokenType: auth.tokenType, name: auth.name, role: auth.role, expiresAt: auth.expiresAt });
    log(`实验课平台登录成功：${auth.name || username}（角色 ${auth.role}，token 到 ${new Date(auth.expiresAt).toLocaleString()}）`);
    return auth;
  }

  /**
   * 签名请求。GET：参数全进 query；POST：参数全进表单体。
   * 响应信封 code=200 → data；401/408 重登一次再重放；其余按远端拒绝报错。
   */
  async raw<T>(path: string, data: Record<string, string | number | undefined> = {}, method: "GET" | "POST" = "GET", withAuth = true, retried = false): Promise<T> {
    const ts = Date.now();
    const sign = apiSign(path, ts, data);
    const params: Record<string, string> = { app_key: APP_KEY, timestamp: String(ts), sign };
    for (const [k, v] of Object.entries(data)) if (v !== "" && v !== undefined && v !== null) params[k] = String(v);
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const headers: Record<string, string> = {};
    if (withAuth && this.auth) headers["Authorization"] = `${this.auth.tokenType} ${this.auth.token}`;
    const res = await this.ctx.fetch(method === "GET" ? `${API_BASE}${path}?${qs}` : API_BASE + path, method === "POST" ? { method, headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body: qs } : { method, headers });
    const j = res.json<{ code: number; message?: string; data?: T }>();
    if (j === null) throw new BadResponse(`实验课平台响应不是 JSON（HTTP ${res.status}）`, { path, body: res.body.slice(0, 200) });
    if (j.code === 200) return j.data as T;
    if ((j.code === 401 || j.code === 408) && withAuth && !retried) {
      debug(`lab: token 失效（code=${j.code}），重新登录`);
      this.auth = undefined;
      await this.login(true);
      return this.raw<T>(path, data, method, withAuth, true);
    }
    if (j.code === 401 || j.code === 408) throw new AuthExpired("lab-course", `实验课平台登录态失效（code=${j.code}${j.message ? " " + j.message : ""}）`);
    throw new RemoteRejected(j.message || `实验课平台返回 code=${j.code}`, j);
  }

  private async call<T>(path: string, data: Record<string, string | number | undefined> = {}, method: "GET" | "POST" = "GET"): Promise<T> {
    await this.login();
    return this.raw<T>(path, data, method);
  }

  // ---------- 读 ----------

  async terms(): Promise<Term[]> {
    const d = await this.call<{ content: Term[] }>("/api/terms");
    if (!Array.isArray(d?.content)) throw new BadResponse("实验课学期响应缺少 content 数组");
    return d.content;
  }

  /** 只使用服务端唯一的当前学期标记，不以列表顺序猜测。 */
  async currentTerm(): Promise<Term> {
    const list = await this.terms();
    if (!list.length) throw new BadResponse("实验课平台没有学期数据");
    const current = list.filter(t => t.currentTerm === 1);
    if (current.length !== 1) throw new BadResponse("实验课当前学期标记不唯一，请明确指定 --term");
    return current[0]!;
  }

  async termId(term?: number | string): Promise<number> {
    if (term !== undefined && term !== "") return Number(term);
    return (await this.currentTerm()).id;
  }

  /** 我这个学期的实验课（选课页左侧课程列表） */
  async myCourses(term?: number | string): Promise<Course[]> {
    const id = await this.termId(term);
    const d = await this.call<Course[]>("/api/courses/uid", { page: -1, size: -1, termId: id, uid: this.username });
    if (!Array.isArray(d)) throw new BadResponse("实验课程响应不是数组，不能视为没有课程");
    return d;
  }

  /** 某门课的实验班次；openWeek（JSON 数组字符串）解析成 weeks */
  async labs(courseId: number | string): Promise<LabSection[]> {
    const d = await this.call<LabSection[] | { content: LabSection[] }>(`/api/courseId/${Number(courseId)}/course/labs`);
    const list = Array.isArray(d) ? d : d?.content;
    if (!Array.isArray(list)) throw new BadResponse("实验班次响应缺少数组，不能视为没有班次");
    return list.map((l) => ({ ...l, weeks: parseOpenWeek(l.openWeek as unknown as string) }));
  }

  /** 各班次各周次已选人数："班次id_周次段" → 人数 */
  async weekStatus(term?: number | string): Promise<Record<string, number>> {
    const id = await this.termId(term);
    const d = await this.call<Record<string, number>>("/api/course/labs/status", { termId: id, studentUid: this.username });
    if (!d || typeof d !== "object" || Array.isArray(d) || Object.values(d).some(n =>
      !["number", "string"].includes(typeof n) || String(n).trim() === "" || !Number.isFinite(Number(n)) || Number(n) < 0)) throw new BadResponse("实验班次人数响应异常，不能据此判断余量");
    return Object.fromEntries(Object.entries(d).map(([key, value]) => [key, Number(value)]));
  }

  /** 我的已选实验 */
  async mySelections(term?: number | string): Promise<Selection[]> {
    const id = await this.termId(term);
    const d = await this.call<{ content?: Selection[] }>("/api/course/lab/students", { termId: id, uid: this.username, page: -1, size: -1 });
    if (!Array.isArray(d?.content)) throw new BadResponse("实验课已选列表缺少 content 数组，不能据此确认选课结果");
    return d.content;
  }

  /** 与学生端“查看成绩”同源；课表接口的 total_score/final_score 不关联报告评分。 */
  async myGrades(term?: number | string): Promise<LabGrade[]> {
    const termId = await this.termId(term);
    const rows = await this.call<unknown>("/api/teacher/evaluates/studentfull", { termId, uid: this.username });
    if (!Array.isArray(rows)) throw new BadResponse("实验报告成绩响应不是数组，不能视为没有成绩");
    return rows.map((row: unknown): LabGrade => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new BadResponse("实验报告成绩记录格式异常");
      const r = row as Record<string, unknown>;
      if (typeof r.course_name !== "string" || !r.course_name.trim() || typeof r.lab_name !== "string" || !r.lab_name.trim()
        || !["string", "number"].includes(typeof r.select_week) || !String(r.select_week).trim() || !Object.hasOwn(r, "score")) {
        throw new BadResponse("实验报告成绩记录缺少课程、实验、序号或分数字段");
      }
      const empty = r.score === null || (typeof r.score === "string" && !r.score.trim());
      if (!empty && (!["string", "number"].includes(typeof r.score) || !Number.isFinite(Number(r.score)) || Number(r.score) < 0 || Number(r.score) > 100)) {
        throw new BadResponse("实验报告分数格式异常，不能当作未出分", { experiment: r.lab_name });
      }
      const score = empty ? null : Number(r.score);
      return { course: r.course_name, experiment: r.lab_name, teacher: typeof r.teacher_name === "string" ? r.teacher_name : "",
        sequence: String(r.select_week), score, status: score === null ? "未出分" : "已评分" };
    }).sort((a, b) => a.course.localeCompare(b.course, "zh-CN") || a.sequence.localeCompare(b.sequence, "zh-CN", { numeric: true }));
  }

  /** 同时读取窗口与服务器毫秒时间戳，供定时执行校准。 */
  async openStatusWithClock(): Promise<{ windows: OpenWindow[]; timestamp?: number }> {
    const d = await this.call<{ openstatus?: OpenWindow[]; timestamp?: number }>("/api/course/open_status");
    if (!Array.isArray(d?.openstatus)) throw new BadResponse("实验课选课窗口缺少 openstatus 数组");
    return { windows: d.openstatus, ...(typeof d.timestamp === "number" ? { timestamp: d.timestamp } : {}) };
  }

  /** 选课窗口（可按学期过滤） */
  async openStatus(term?: number | string): Promise<OpenWindow[]> {
    const { windows: list } = await this.openStatusWithClock();
    if (term === undefined || term === "") return list;
    const id = Number(term);
    return list.filter((x) => x.termId === id);
  }

  /** 平台公告（正文转纯文本） */
  async notices(): Promise<LabNotice[]> {
    const d = await this.call<Record<string, unknown>[]>("/api/notices/student", { uid: this.username });
    if (!Array.isArray(d)) throw new BadResponse("实验课通知响应不是数组");
    return d.map((n) => ({
      ...n,
      id: Number(n.id),
      title: String(n.title ?? ""),
      text: htmlToText(String(n.content ?? "")),
      publishedAt: typeof n.gmtCreate === "number" ? new Date(n.gmtCreate).toISOString() : undefined,
    })) as LabNotice[];
  }

  /**
   * 我的课表：与网页"我的课表"同源（/api/course/lab/students/full），每个已选实验展开成按日期的一次课。
   * 行里缺 dates 时按网页做法查 /api/courseLabTimes/date（键 "班次id_周次段"，多个日期换行分隔）。
   */
  async myTimetable(term?: number | string): Promise<LabSession[]> {
    const termId = await this.termId(term);
    const courses = await this.myCourses(termId);
    const rows = (await Promise.all(courses.map(async (c) => {
      const d = await this.call<{ content?: Record<string, unknown>[] }>("/api/course/lab/students/full", { termId, uid: this.username, courseId: c.id, page: -1, size: -1 });
      if (!Array.isArray(d?.content)) throw new BadResponse("实验课表响应缺少 content 数组，不能视为没有排课");
      return d.content;
    }))).flat();
    const dateMaps = new Map<number, Record<string, string>>();
    for (const courseId of new Set(rows.filter((r) => !splitDates(r.dates).length).map((r) => Number(r.course_id))))
      dateMaps.set(courseId, (await this.call<Record<string, string>>("/api/courseLabTimes/date", { courseId })) ?? {});
    return rows.flatMap((r): LabSession[] => {
      const dates = splitDates(r.dates).length ? splitDates(r.dates) : splitDates(dateMaps.get(Number(r.course_id))?.[`${r.id}_${r.select_week}`]);
      const base = { start: String(r.times ?? ""), course: String(r.course_name ?? ""), experiment: String(r.lab_name ?? ""),
        room: String(r.address ?? "").replace(/[,，\s]+$/, ""), teacher: String(r.teacher_name ?? ""), sequence: String(r.select_week ?? "") };
      return dates.length ? dates.map((date) => ({ date, ...base })) : [{ date: null, ...base }];
    }).sort((a, b) => `${a.date ?? "9999"} ${a.start}`.localeCompare(`${b.date ?? "9999"} ${b.start}`));
  }

  /** 个人资料（平台里的 password 字段是哈希，剥掉不外传） */
  async myInfo(): Promise<Record<string, unknown>> {
    const d = await this.call<Record<string, unknown>>(`/api/uid/${this.username}/students`);
    if (d && typeof d === "object") delete d.password;
    return d ?? {};
  }

  // ---------- 写（写闸）----------

  private gate(confirm: boolean, action: string): void {
    if (!confirm || !writeAllowed()) throw new WriteGateClosed(action);
  }

  /** 已校验目标的单次提交。写前落 journal；只表示请求返回，不代表最终选上。 */
  async submitSelection(opts: { courseId: number; labId: number; termId: number; week: string; confirm: boolean; journal: LabJournal }): Promise<unknown> {
    this.gate(opts.confirm, "实验课提交");
    if (typeof opts.journal !== "function") throw new ConfigError("submitSelection 必须提供 journal");
    if (![opts.courseId, opts.labId, opts.termId].every((n) => Number.isSafeInteger(n) && n > 0) || !/^\d+(,\d+)*$/.test(opts.week)) throw new ConfigError("提交参数无效");
    await opts.journal({ type: "submit", at: Date.now(), detail: { courseId: opts.courseId, lab: opts.labId, termId: opts.termId, week: opts.week } });
    return this.call("/api/course/lab/students", { courseId: opts.courseId, courseLabId: opts.labId, uid: this.username, termId: opts.termId, selectWeek: opts.week }, "POST");
  }

  /**
   * 选实验班次。selectWeek 必须是该班次 weeks 之一。
   * 先检查容量（contain vs counts + 各周已选），满了直接拒绝不发包。
   */
  async select(opts: { courseId: number | string; labId: number | string; week: string; term?: number | string; confirm: boolean; journal?: LabJournal; journalFile?: string }): Promise<{ done: true; labName: string; teacherName: string; week: string; selections: Selection[]; journalFile?: string }> {
    this.gate(opts.confirm, "实验课选课");
    const termId = await this.termId(opts.term);
    const labs = await this.labs(opts.courseId);
    const lab = labs.find((l) => l.id === Number(opts.labId));
    if (!lab) throw new RemoteRejected(`班次 ${opts.labId} 不存在（课程 ${opts.courseId}）`, { labs: labs.length });
    if (!lab.weeks.includes(opts.week)) throw new RemoteRejected(`周次 ${opts.week} 不在可选范围（可选：${lab.weeks.join(" / ") || "无"}）`, { labId: lab.id });
    const status = await this.weekStatus(termId);
    const taken = Number(status[`${lab.id}_${opts.week}`] ?? 0);
    if (lab.contain && taken >= lab.contain) throw new RemoteRejected(`该班次 ${opts.week} 周次已满（${taken}/${lab.contain}）`, { labId: lab.id, week: opts.week });
    const sink = fileJournal<Parameters<LabJournal>[0]>("lab", opts.journalFile), journal = opts.journal ?? sink.append;
    await this.submitSelection({ courseId: Number(lab.courseId), labId: lab.id, termId, week: opts.week, confirm: opts.confirm, journal });
    const selections = await this.mySelections(termId);
    const verified = selections.some(row => selectionMatches(row, { lab: lab.id, week: opts.week }, Number(lab.courseId), termId));
    await journal({ type: "reconcile", at: Date.now(), detail: { action: "select", lab: lab.id, week: opts.week, verified } });
    if (!verified) throw new BadResponse("选课请求已返回，但回查未找到目标班次和周次", { labId: lab.id, week: opts.week, journalFile: sink.file });
    return { done: true, labName: lab.labName ?? "", teacherName: lab.teacherName ?? "", week: opts.week, selections, ...(!opts.journal ? { journalFile: sink.file } : {}) };
  }

  /** 退选：recordId 来自 mySelections（已选列表里的 id） */
  async cancel(opts: { recordId: number | string; term?: number | string; confirm: boolean; journal?: LabJournal; journalFile?: string }): Promise<{ done: true; selections: Selection[]; journalFile?: string }> {
    this.gate(opts.confirm, "实验课退选");
    const termId = await this.termId(opts.term);
    const recordId = Number(opts.recordId);
    if (!Number.isSafeInteger(recordId) || recordId <= 0) throw new ConfigError("退选记录 ID 必须是正整数");
    const before = await this.mySelections(termId);
    if (!before.some(row => Number(row.id) === recordId)) throw new ConfigError("已选列表中没有该退选记录");
    const sink = fileJournal<Parameters<LabJournal>[0]>("lab", opts.journalFile), journal = opts.journal ?? sink.append;
    await journal({ type: "submit", at: Date.now(), detail: { action: "cancel", recordId, termId } });
    await this.raw(`/api/course/lab/students/del/${Number(opts.recordId)}`, {}, "POST");
    const selections = await this.mySelections(termId);
    const verified = !selections.some(row => Number(row.id) === recordId) && before.filter(row => Number(row.id) !== recordId).every(row => selections.some(after => Number(after.id) === Number(row.id)));
    await journal({ type: "reconcile", at: Date.now(), detail: { action: "cancel", recordId, verified } });
    if (!verified) throw new BadResponse("退选请求已返回，但回查未确认目标移除及其他记录保留", { recordId, journalFile: sink.file });
    return { done: true, selections, ...(!opts.journal ? { journalFile: sink.file } : {}) };
  }

  // ---------- 会话管理 ----------

  status(): { username: string; name?: string; role?: number; file: string; cached: boolean; expiresAt?: string } {
    const out: ReturnType<LabCourse["status"]> = { username: this.username, file: this.store.file, cached: this.hasToken };
    if (this.auth) {
      out.name = this.auth.name;
      out.role = this.auth.role;
      out.expiresAt = new Date(this.auth.expiresAt).toISOString();
    }
    return out;
  }

  logout(): boolean {
    this.auth = undefined;
    return this.store.clear();
  }

  close(): void {
    this.ctx.close();
  }
}

/** 平台日期字段可能是逗号或换行分隔的多个 YYYY-MM-DD */
function splitDates(raw: unknown): string[] {
  return typeof raw === "string" ? raw.split(/[\s,，]+/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
}

/** openWeek 是 JSON 数组字符串（如 ["1,2","3,4"]）；解析失败返回 [] */
export function parseOpenWeek(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw.replace(/'/g, '"'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export interface LabOptions extends OpenOptions {
  fresh?: boolean;
}

/** 组装：WebVPN 上下文 + lab 平台会话（token 缓存复用，失效自动重登） */
export async function openLab(opts: LabOptions = {}): Promise<LabCourse> {
  const ctx = await openContext(requirements, opts);
  const p = readProfile();
  const username = p.lab_username || credentials().username;
  const lab = new LabCourse(ctx, username);
  if (opts.fresh) lab.logout();
  return lab;
}

/** 学期名 → 平台学期编号；不给时为当前学期。「2025-2026春夏」可以匹配「2025-2026学年春夏学期」。 */
export async function termOf(client: LabCourse, name: unknown): Promise<number> {
  if (typeof name !== "string" || !name.trim()) return client.termId();
  return uniqueMatch(await client.terms(), name, (t) => [t.name, t.name.replace(/学年|学期/g, "")], (t) => t.name, "学期").id;
}

export async function resolveLabCourseInfo(client: LabCourse, query: string, term?: number): Promise<Course> {
  const rows = await client.myCourses(term);
  return uniqueMatch(rows, query, r => [String(r.id), r.courseName ?? r.name ?? ""],
    r => ({ id: r.id, name: r.courseName ?? r.name }), "实验课程");
}
export async function resolveLabCourse(client: LabCourse, query: string, term?: number): Promise<number> {
  return (await resolveLabCourseInfo(client, query, term)).id;
}
export async function resolveLabTarget(client: LabCourse, target: { course: string; lab: string; week: string; term?: number; teacher?: string }) {
  const termId = await client.termId(target.term), courseId = await resolveLabCourse(client, target.course, termId);
  const rows = (await client.labs(courseId)).filter(r => (!target.teacher || r.teacherName?.includes(target.teacher)) && r.weeks.includes(target.week));
  const selected = uniqueMatch(rows, target.lab, r => [String(r.id), r.labName],
    r => ({ id: r.id, name: r.labName, teacher: r.teacherName, weeks: r.weeks, time: r.times }), "实验班次");
  return { courseId, labId: selected.id, labName: selected.labName, termId, week: target.week };
}
