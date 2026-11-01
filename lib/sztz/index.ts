/**
 * 浙江大学大学生素质拓展数智平台（sztz.zju.edu.cn/dekt）：第二、三、四课堂的活动、项目、记点与成绩单；活动的报名、取消报名和收藏。
 *
 * 声明：auth=cas network=campus writes=true。主机只解析到校内地址（10.203.15.167），经 WebVPN。
 * 登录：GET login/getLoginUrl?returnUrl=<BASE>/ 返回 CAS 地址（service=<BASE>/），zjuam.loginService(service) 回跳后会话生效。
 *       经 WebVPN 时站点 cookie 由网关代持，不另存本地会话。未登录时个人接口返回 code=-1「没有数据【…】访问权限!」，
 *       活动列表可匿名读但负责人信息是 ****、不带本人报名状态；遇到这两种情况登录后重取一次。
 * 接口：都在 <BASE>/ 下，GET 带查询串，POST 为表单；响应 {code, msg, data, extend, count, totalPages}，code=0 成功。
 * 时间字段是 UTC 的 ISO 串，输出换成北京时间。
 * 写：报名 hdbm、取消报名 hdqxbm、收藏开关 hdsc，都是 GET 加活动 id。写闸、写前日志；写请求只发一次，之后用本人列表回查。
 * 已读记录：data/sztz/seen.json，只有 activity new 读写。
 */
import path from "node:path";
import { paths } from "../core/paths.ts";
import { readJson, writeJson } from "../core/fsjson.ts";
import type { ModuleRequirements } from "../core/module.ts";
import { openContext, type Context } from "../webvpn/transport.ts";
import { AuthExpired, BadResponse, ConfigError, NeedsUser, RemoteRejected, TransportError, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { fileJournal } from "../core/journal.ts";
import { uniqueMatch } from "../core/match.ts";
import { htmlToText } from "../core/html.ts";

export const HOST = "sztz.zju.edu.cn";
const BASE = `https://${HOST}/dekt`;
export const requirements: ModuleRequirements = { name: "sztz", title: "素质拓展数智平台（二三四课堂）", hosts: [HOST], auth: "cas", network: "campus", writes: true };

interface Reply<T> { code: number; msg: string | null; data: T; extend?: Record<string, unknown>; count?: number; totalPages?: number }
type Params = Record<string, string | number | undefined>;
const denied = (r: Reply<unknown>) => r.code === -1 && /访问权限/.test(r.msg ?? "");

export class Sztz {
  readonly ctx: Context;
  private login: Promise<void> | undefined;
  constructor(ctx: Context) { this.ctx = ctx; }

  private async send<T>(method: "GET" | "POST", path: string, params: Params, resend = true): Promise<Reply<T>> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) form.set(key, String(value));
    const query = form.toString();
    const once = () => method === "GET"
      ? this.ctx.fetchFollow(`${BASE}/${path}${query ? `?${query}` : ""}`, { headers: { "X-Requested-With": "XMLHttpRequest" } })
      : this.ctx.fetchFollow(`${BASE}/${path}`, { method, body: query, headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } });
    // 查询（包括这里的 POST）在连接断开或无响应时可以重发；写请求不重发
    const res = await once().catch((err: unknown) => { if (resend && err instanceof TransportError) return once(); throw err; });
    if (res.status !== 200) throw new TransportError(`素质拓展平台 HTTP ${res.status}`, { path });
    const reply = res.json<Reply<T>>();
    if (!reply || typeof reply.code !== "number") throw new BadResponse("素质拓展平台没有返回 JSON", { path, body: res.body.slice(0, 120) });
    return reply;
  }

  /** 统一身份认证委托登录；并发调用合并 */
  signIn(): Promise<void> {
    return (this.login ??= (async () => {
      if (!this.ctx.zjuam) throw new AuthExpired("zjuam", "素质拓展平台需要统一身份认证");
      const entry = await this.send<string>("GET", "login/getLoginUrl", { returnUrl: `${BASE}/`, _auth_provider_: "" });
      const service = typeof entry.data === "string" ? new URL(entry.data).searchParams.get("service") : null;
      if (!service) throw new BadResponse("素质拓展平台没有给出统一认证登录地址", { data: entry.data });
      await this.ctx.zjuam.loginService(service);
    })());
  }

  /** 个人接口未登录时登录后重试一次；业务失败抛出平台给的原因 */
  async call<T>(method: "GET" | "POST", path: string, params: Params = {}): Promise<Reply<T>> {
    let reply = await this.send<T>(method, path, params);
    if (denied(reply)) {
      await this.signIn();
      reply = await this.send<T>(method, path, params);
      if (denied(reply)) throw new AuthExpired("sztz", "登录后素质拓展平台仍然拒绝访问，这个账号可能不是在读学生");
    }
    if (reply.code !== 0) throw new RemoteRejected(`素质拓展平台：${reply.msg ?? "请求失败"}`, { path });
    return reply;
  }

  /** 写请求只发一次：没有回应时不知道平台是否已经处理，由调用方回查。业务结果原样返回 */
  async write(path: string, id: number): Promise<Reply<unknown>> {
    const reply = await this.send<unknown>("GET", path, { id }, false);
    if (denied(reply)) throw new AuthExpired("sztz", "素质拓展平台的登录在提交时失效了，没有提交成功");
    return reply;
  }

  close(): void { this.ctx.close(); }
}

export async function openSztz(): Promise<Sztz> {
  return new Sztz(await openContext(requirements, { timeout: 20_000 }));
}

// ---------- 活动与项目 ----------

interface Named { mc?: string }
/** 活动（lx=2，报名参加）和项目（lx=1，个人申请认定）是同一种记录 */
interface Project {
  id: number; mc: string; zxfs: number; zdfs: number;
  hdkssj: string; hdjssj: string; bmkssj: string; bmjssj: string;
  fzr?: string | null; lxdh?: string | null; dzyx?: string | null;
  xmfl?: Named | null; xmlb?: Named | null; xmlx?: Named | null; lxdw?: Named | null; flowStartUser?: string | null;
  hddd?: string | null; zmrs?: number | null; bmrs?: number | null; lxsx?: string | null; hdzysx?: string | null;
  bmfs?: { label?: string } | null; jtbmfs?: string | null; ksqnj?: string | null; sfbm?: boolean | null;
}

const beijing = (iso: unknown) => typeof iso === "string" && Number.isFinite(Date.parse(iso))
  ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) : undefined;
const clean = (html: unknown) => typeof html === "string" ? htmlToText(html) : "";
const points = (p: Project) => p.zxfs === p.zdfs ? String(p.zxfs) : `${p.zxfs}–${p.zdfs}`;
const category = (p: Project) => [p.xmfl?.mc, p.xmlb?.mc].filter(Boolean).join("·");

const STATUSES = ["报名中", "未开始报名", "报名已截止", "进行中", "已结束"] as const;
type Status = (typeof STATUSES)[number];
type Times = Pick<Project, "hdkssj" | "hdjssj" | "bmkssj" | "bmjssj">;
/** 以活动结束时间为准判断是否结束：平台上有开始时间填错年份的活动 */
function statusOf(p: Times, now: number): Status {
  if (now > Date.parse(p.hdjssj)) return "已结束";
  if (now < Date.parse(p.bmkssj)) return "未开始报名";
  if (now <= Date.parse(p.bmjssj)) return "报名中";
  return now < Date.parse(p.hdkssj) ? "报名已截止" : "进行中";
}

/** 本人报名的和收藏的活动编号。列表记录不带收藏状态（页面是逐个活动另查的），报名状态也以本人列表为准 */
interface Mine { signedUp: Set<number>; favorites: Set<number> }

function activityView(p: Project, now: number, mine: Mine) {
  const contact = [p.fzr, p.lxdh, p.dzyx].filter((v) => v && v !== "****").join(" "), how = clean(p.jtbmfs), intro = clean(p.lxsx), notes = clean(p.hdzysx);
  return { name: p.mc.trim(), status: statusOf(p, now), ...(p.sfbm || mine.signedUp.has(p.id) ? { signedUp: true } : {}), ...(mine.favorites.has(p.id) ? { favorite: true } : {}),
    organizer: p.lxdw?.mc || p.flowStartUser || "", category: category(p), ...(p.xmlx?.mc ? { type: p.xmlx.mc } : {}), points: points(p),
    startTime: beijing(p.hdkssj), endTime: beijing(p.hdjssj), ...(p.hddd ? { place: p.hddd } : {}),
    signupOpens: beijing(p.bmkssj), signupCloses: beijing(p.bmjssj), signupMethod: p.bmfs?.label ?? "", ...(how ? { signupHow: how } : {}),
    ...(p.zmrs != null ? { quota: p.zmrs } : {}), ...(p.bmrs != null ? { signedCount: p.bmrs } : {}),
    ...(intro ? { intro } : {}), ...(notes && notes !== "无" ? { notes } : {}), ...(contact ? { contact } : {}) };
}

const PAGE = 50, MAX_PAGES = 20;
/** 活动按开始时间由新到旧排列；找还没结束的活动时往回读到这么多天前开始的为止（长期活动开始得早） */
const BACK_DAYS = 90;

/** 逐页读取，直到读完、读够或 stop 说够了 */
async function projectPages(s: Sztz, params: Params, stop: (all: Project[], page: Project[]) => boolean): Promise<{ rows: Project[]; total: number; complete: boolean }> {
  const rows: Project[] = [];
  for (let page = 1; ; page++) {
    const r = await s.call<Project[]>("GET", "student/home/getXmList", { ...params, page, limit: PAGE, finished: "false" });
    const got = r.data ?? [];
    rows.push(...got);
    if (!got.length || page >= (r.totalPages ?? 1)) return { rows, total: r.count ?? rows.length, complete: true };
    if (stop(rows, got) || page >= MAX_PAGES) return { rows, total: r.count ?? rows.length, complete: false };
  }
}

export interface ActivityQuery { keyword?: string; date?: string; includeEnded?: boolean; limit?: number }

/** 活动中心。默认只给还没结束的：报名中、未开始报名、报名已截止、进行中 */
export async function listActivities(s: Sztz, opts: ActivityQuery = {}) {
  if (opts.date && (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date) || !Number.isFinite(Date.parse(opts.date)))) throw new ConfigError("日期应为 YYYY-MM-DD");
  const limit = opts.limit ?? 30, now = Date.now(), floor = now - BACK_DAYS * 86_400_000;
  const params: Params = { keyword: opts.keyword ?? "", ...(opts.date ? { date: opts.date } : {}), lx: 2 };
  const stop = (all: Project[], page: Project[]) => opts.date ? false
    : opts.includeEnded ? all.length >= limit : Date.parse(page.at(-1)!.hdkssj) < floor;
  // 先读本人的两个列表：它们是个人接口，没登录时会在这里登录，后面的活动列表就带负责人信息
  const mine = await mineOf(s);
  let read = await projectPages(s, params, stop);
  // 匿名读到的列表负责人是 ****
  if (read.rows.some((p) => p.fzr === "****")) { await s.signIn(); read = await projectPages(s, params, stop); }
  const order = (p: Project) => STATUSES.indexOf(statusOf(p, now));
  const when = (p: Project) => { const st = statusOf(p, now); return st === "报名中" ? Date.parse(p.bmjssj) : st === "未开始报名" ? Date.parse(p.bmkssj) : st === "已结束" ? -Date.parse(p.hdkssj) : Date.parse(p.hdkssj); };
  const matched = read.rows.filter((p) => opts.includeEnded || statusOf(p, now) !== "已结束").sort((a, b) => order(a) - order(b) || when(a) - when(b));
  const byStatus = Object.fromEntries(STATUSES.map((st) => [st, matched.filter((p) => statusOf(p, now) === st).length]).filter(([, n]) => n));
  return { activities: matched.slice(0, limit).map((p) => activityView(p, now, mine)), count: Math.min(matched.length, limit), matched: matched.length, byStatus,
    hasMore: matched.length > limit || (Boolean(opts.includeEnded) && !read.complete), currentTime: beijing(new Date(now).toISOString()),
    note: "按报名中（截止早的在前）、未开始报名、报名已截止、进行中排列；points 是参加可得的记点范围。signupMethod 为「不在本平台报名」的按 signupHow 或联系人报名；"
      + "signedUp、favorite 是本人已报名、已收藏。" + (opts.includeEnded ? "" : "已结束的活动没有列出，要看加 --include-ended。") };
}

/** 项目库：可以申请认定记点的项目（学科竞赛、社会实践等） */
export async function listProjects(s: Sztz, opts: { keyword?: string; category?: string } = {}) {
  const { rows } = await projectPages(s, { keyword: opts.keyword ?? "", nj: "", lx: 1 }, () => false);
  const wanted = opts.category?.trim();
  const matched = rows.filter((p) => !wanted || [category(p), p.xmlx?.mc ?? ""].some((c) => c.includes(wanted)));
  return { projects: matched.map((p) => {
      const intro = clean(p.lxsx), notes = clean(p.hdzysx);
      return { name: p.mc.trim(), category: category(p), ...(p.xmlx?.mc ? { type: p.xmlx.mc } : {}), points: points(p), ...(p.ksqnj ? { grades: p.ksqnj } : {}),
        ...(p.bmrs != null ? { applicants: p.bmrs } : {}), ...(intro ? { intro } : {}), ...(notes && notes !== "无" ? { notes } : {}) };
    }), count: matched.length,
    note: "这些是自己提交材料申请认定的项目，不是报名参加的活动；points 是认定后可得的记点范围，grades 是可以申请的年级。申请在平台网页上办理。" };
}

// ---------- 新出现的活动 ----------

/** 活动在平台上的页面：活动中心带着活动编号打开，平台首页点一个活动就是这样跳的（路由是 # 后面那一段） */
const pageOf = (p: Project) => `${BASE}/#/index/hdzx?xmmc=${encodeURIComponent(p.mc.trim())}&xmId=${p.id}`;
const seenFile = () => path.join(paths.data(), "sztz", "seen.json");
/** 上次查看的时间，和见过的活动（编号 → 报名截止时间） */
interface SeenState { checkedAt?: string; seen?: Record<string, string> }
/** 报名截止这么久以后，已读记录里不再留它 */
const SEEN_KEEP_MS = 7 * 86_400_000;

/**
 * 还能报名或还没开始报名的活动里哪些没见过，以及读完以后的已读记录。不联网。
 * 报名已截止、进行中的不算新的，也不记：它们不会再变回能报名的。
 */
export function freshActivities<T extends Times & { id: number }>(rows: T[], seen: Record<string, string>, now: number): { fresh: T[]; seen: Record<string, string> } {
  const open = rows.filter((p) => { const st = statusOf(p, now); return st === "报名中" || st === "未开始报名"; });
  const kept = Object.entries(seen).filter(([, closes]) => Date.parse(closes) >= now - SEEN_KEEP_MS);
  return { fresh: open.filter((p) => !(String(p.id) in seen)), seen: Object.fromEntries([...kept, ...open.map((p): [string, string] => [String(p.id), p.bmjssj])]) };
}

/** 上次查看之后新出现、还能报名或还没开始报名的活动。只读活动列表，不读本人的报名和收藏，所以不用登录统一身份认证 */
export async function newActivities(s: Sztz) {
  const now = Date.now(), state = readJson<SeenState>(seenFile()) ?? {};
  const { fresh, seen } = freshActivities(await unfinished(s, now), state.seen ?? {}, now);
  const result = { activities: fresh.sort((a, b) => Date.parse(a.bmjssj) - Date.parse(b.bmjssj)).map((p) => ({ name: title(p), status: statusOf(p, now),
      organizer: p.lxdw?.mc || p.flowStartUser || "", category: category(p), points: points(p), startTime: beijing(p.hdkssj), endTime: beijing(p.hdjssj), ...(p.hddd ? { place: p.hddd } : {}),
      signupOpens: beijing(p.bmkssj), signupCloses: beijing(p.bmjssj), signupMethod: p.bmfs?.label ?? "", url: pageOf(p) })), count: fresh.length,
    ...(state.checkedAt ? { lastChecked: beijing(state.checkedAt) } : {}),
    note: (state.checkedAt ? "上次查看之后新出现的活动" : "第一次查看，给出现在还能报名或还没开始报名的全部活动") + "，报名截止早的在前；只有概要，要看简介、注意事项和联系人用 sztz activity list --keyword 活动名。" };
  writeJson(seenFile(), { checkedAt: new Date(now).toISOString(), seen });
  return result;
}

// ---------- 本人 ----------

interface MyInfo {
  dektJf?: number; dsktJf?: number; dsiktJf?: number; dektXf?: number; dsktXf?: number; dsiktXf?: number;
  dektDj?: string; dsktDj?: string; dsiktDj?: string; dektTg?: boolean; dsktTg?: boolean; dsiktTg?: boolean; myTg?: boolean; lyTg?: boolean;
}
interface Record_ { jd?: number | null; xm?: Project | null; cyrshzt?: { label?: string } | null; czsj?: string | null; qksm?: string | null; sfyc?: boolean | null }

/** 本人二、三、四课堂的记点与学分，和成绩单里的每一条记录 */
export async function myCredits(s: Sztz) {
  const info = ((await s.call<null>("GET", "student/home/getMyInfo")).extend?.["myInfo"] ?? {}) as MyInfo;
  const records: Record_[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await s.call<Record_[]>("POST", "student/home/getZdySqjl", { pageIndex: page, pageSize: 100 });
    records.push(...(r.data ?? []));
    if (page >= (r.totalPages ?? 1)) break;
  }
  const row = (points?: number, credits?: number, level?: string, passed?: boolean) => ({ points: points ?? 0, credits: credits ?? 0, level: level ?? "", passed: Boolean(passed) });
  return { summary: { second: row(info.dektJf, info.dektXf, info.dektDj, info.dektTg), third: row(info.dsktJf, info.dsktXf, info.dsktDj, info.dsktTg),
      fourth: row(info.dsiktJf, info.dsiktXf, info.dsiktDj, info.dsiktTg), aestheticPassed: Boolean(info.myTg), laborPassed: Boolean(info.lyTg) },
    records: records.map((r) => {
      const note = clean(r.qksm);
      return { name: r.xm?.mc?.trim() ?? "", category: r.xm ? category(r.xm) : "", ...(r.xm?.xmlx?.mc ? { type: r.xm.xmlx.mc } : {}), points: r.jd ?? 0,
        ...(r.cyrshzt?.label ? { status: r.cyrshzt.label } : {}), ...(r.xm ? { activityTime: beijing(r.xm.hdkssj) } : {}), recordedAt: beijing(r.czsj),
        ...(r.sfyc ? { hiddenOnTranscript: true } : {}), ...(note ? { note } : {}) };
    }), count: records.length,
    note: "summary 里 second、third、fourth 是第二、三、四课堂：points 是累计记点，credits 是折算出的学分，level 是等级，passed 是平台判定是否达标；"
      + "aestheticPassed、laborPassed 是美育、劳育是否达标。达标要求以培养方案和平台为准，这里只转述平台给出的结果。records 是成绩单上的每一条认定记录。" };
}

/** 本人的活动列表：0 报名的、1 收藏的、2 已认定的。个人接口，未登录时会先登录 */
async function myList(s: Sztz, action: 0 | 1 | 2): Promise<Project[]> {
  const rows: Project[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await s.call<Project[]>("POST", "student/home/getWdhdList", { action, page, limit: PAGE });
    rows.push(...(r.data ?? []));
    if (page >= (r.totalPages ?? 1)) break;
  }
  return rows;
}

const ids = (rows: Project[]) => new Set(rows.map((p) => p.id));
async function mineOf(s: Sztz): Promise<Mine> {
  return { signedUp: ids(await myList(s, 0)), favorites: ids(await myList(s, 1)) };
}

/** 本人报名的、收藏的和已认定的活动 */
export async function myActivities(s: Sztz) {
  const now = Date.now(), lists = [await myList(s, 0), await myList(s, 1), await myList(s, 2)] as const;
  const mine: Mine = { signedUp: ids(lists[0]), favorites: ids(lists[1]) };
  const view = (rows: Project[]) => rows.map((p) => activityView(p, now, mine));
  const signedUp = view(lists[0]), favorites = view(lists[1]), recognized = view(lists[2]);
  return { signedUp, favorites, recognized, counts: { signedUp: signedUp.length, favorites: favorites.length, recognized: recognized.length },
    note: "signedUp 是在平台上报了名的，favorites 是收藏的，recognized 是已经认定记点的；不在平台报名的活动不会出现在 signedUp 里。" };
}

// ---------- 报名、取消报名、收藏（写） ----------

export interface WriteOptions { confirm: boolean; /** 只做到提交之前，供开发验证；不需要写闸 */ dryRun?: boolean; journalFile?: string }
type SztzEvent = { type: "submit" | "rejected" | "reconcile"; at: number; detail: Record<string, unknown> };

const OFF_PLATFORM = "不在本平台报名";
const gate = (o: WriteOptions, action: string) => { if (!o.dryRun && (!o.confirm || !writeAllowed())) throw new WriteGateClosed(action); };
const title = (p: Project) => p.mc.trim();
const contactOf = (p: Project) => [p.fzr, p.lxdh, p.dzyx].filter((v) => v && v !== "****").join(" ");
const brief = (p: Project) => ({ name: title(p), organizer: p.lxdw?.mc || p.flowStartUser || "", points: points(p), startTime: beijing(p.hdkssj), endTime: beijing(p.hdjssj),
  ...(p.hddd ? { place: p.hddd } : {}), signupCloses: beijing(p.bmjssj) });
const candidate = (now: number) => (p: Project) => ({ name: title(p), status: statusOf(p, now), startTime: beijing(p.hdkssj) });

/** 还没结束的活动（原始记录） */
async function unfinished(s: Sztz, now: number): Promise<Project[]> {
  const floor = now - BACK_DAYS * 86_400_000;
  const { rows } = await projectPages(s, { keyword: "", lx: 2 }, (_all, page) => Date.parse(page.at(-1)!.hdkssj) < floor);
  return rows.filter((p) => statusOf(p, now) !== "已结束");
}

/**
 * 发一次写请求并回查，返回日志文件。list 是回查用的本人列表（0 报名的、1 收藏的），want 是写完后这个活动应不应该在列表里。
 * 写请求不重发：平台没有回应时结果未知，以回查为准；收藏是开关，重发会把状态翻回去。
 */
async function commit(s: Sztz, o: WriteOptions, action: string, label: string, path: string, p: Project, list: 0 | 1, want: boolean): Promise<string> {
  const sink = fileJournal<SztzEvent>("sztz", o.journalFile), target = { action, id: p.id, name: title(p) };
  sink.append({ type: "submit", at: Date.now(), detail: target });
  let reply: Reply<unknown> | undefined, lost: TransportError | undefined;
  try { reply = await s.write(path, p.id); }
  catch (err) { if (!(err instanceof TransportError)) throw err; lost = err; }
  if (reply && reply.code !== 0) {
    sink.append({ type: "rejected", at: Date.now(), detail: { ...target, code: reply.code, msg: reply.msg } });
    throw new RemoteRejected(`${label}没有成功，素质拓展平台的答复：${reply.msg ?? "操作失败"}`, { ...target, journalFile: sink.file });
  }
  let present: boolean;
  try { present = (await myList(s, list)).some((row) => row.id === p.id); }
  catch (err) {
    sink.append({ type: "reconcile", at: Date.now(), detail: { ...target, verified: null, answered: !lost } });
    throw new TransportError(`${label}请求${lost ? "没有收到平台回应" : "平台已答复成功"}，但回查没有读到结果，是否生效没有确认；用 sztz mine 查看`, { ...target, journalFile: sink.file }, err);
  }
  sink.append({ type: "reconcile", at: Date.now(), detail: { ...target, verified: present === want, answered: !lost } });
  if (present === want) return sink.file;
  if (lost) throw new TransportError(`${label}请求没有收到平台回应，回查显示没有生效，可以再试一次`, { ...target, journalFile: sink.file }, lost);
  throw new BadResponse(`平台答复${label}成功，但回查显示没有生效`, { ...target, journalFile: sink.file });
}

/** 在平台上报名一个活动。只提交报名中、且在本平台报名的活动；名额、年级等由平台判定，平台拒绝时转述它给的原因 */
export async function signUp(s: Sztz, name: string, o: WriteOptions) {
  gate(o, "二课活动报名");
  const now = Date.now(), mine = await myList(s, 0);
  const p = uniqueMatch(await unfinished(s, now), name, (row) => [row.mc], candidate(now), "活动");
  const activity = brief(p), canCancel = `报名截止（${activity.signupCloses}）前可以取消。`;
  if (mine.some((row) => row.id === p.id)) return { done: true, verified: true, status: "already-signed-up", activity, message: `之前已经报过名，没有重复提交。${canCancel}` };
  if (p.bmfs?.label === OFF_PLATFORM) {
    const how = clean(p.jtbmfs), contact = contactOf(p);
    throw new NeedsUser(`「${title(p)}」不在本平台报名，要按活动写明的方式报：${how || "活动没有写明方式"}${contact ? `；联系人 ${contact}` : ""}`);
  }
  const st = statusOf(p, now);
  if (st !== "报名中") throw new RemoteRejected(st === "未开始报名" ? `「${title(p)}」的报名还没开始，${beijing(p.bmkssj)} 开始` : `「${title(p)}」的报名已在 ${beijing(p.bmjssj)} 截止`, { status: st });
  if (o.dryRun) return { done: false, verified: false, status: "ready", activity, message: "可以报名，没有提交。" };
  const journalFile = await commit(s, o, "signup", "报名", "student/home/hdbm", p, 0, true);
  return { done: true, verified: true, status: "signed-up", activity, message: `已报名，并在「我报名的活动」里查到。${canCancel}`, journalFile };
}

/** 取消本人在平台上的报名。平台页面只在报名截止前提供取消，这里同样只在截止前提交 */
export async function cancelSignUp(s: Sztz, name: string, o: WriteOptions) {
  gate(o, "二课活动取消报名");
  const now = Date.now(), mine = await myList(s, 0);
  if (!mine.length) throw new RemoteRejected("你在平台上没有已报名的活动；不在平台报名的活动要按它自己的渠道取消");
  const open = mine.filter((row) => now <= Date.parse(row.bmjssj)), wanted = name.trim();
  // 同名的往期活动不参与匹配，除非还能取消的里面没有这个名字
  const p = uniqueMatch(open.some((row) => row.mc.includes(wanted)) ? open : mine, name, (row) => [row.mc], candidate(now), "已报名的活动");
  if (now > Date.parse(p.bmjssj)) {
    const contact = contactOf(p);
    throw new RemoteRejected(`「${title(p)}」的报名已在 ${beijing(p.bmjssj)} 截止，平台上不能再取消，需要联系举办单位${contact ? `（${contact}）` : ""}`, { status: statusOf(p, now) });
  }
  const activity = brief(p);
  if (o.dryRun) return { done: false, verified: false, status: "ready", activity, message: "可以取消报名，没有提交。" };
  const journalFile = await commit(s, o, "cancel", "取消报名", "student/home/hdqxbm", p, 0, false);
  return { done: true, verified: true, status: "cancelled", activity, message: "已取消报名，「我报名的活动」里不再有它。", journalFile };
}

/** 收藏或取消收藏一个活动。平台的收藏是开关接口，所以先读本人收藏列表，状态已经符合时不提交 */
export async function setFavorite(s: Sztz, name: string, o: WriteOptions & { cancel?: boolean }) {
  gate(o, o.cancel ? "二课活动取消收藏" : "二课活动收藏");
  const now = Date.now(), favorites = await myList(s, 1);
  if (o.cancel) {
    if (!favorites.length) throw new RemoteRejected("你在平台上没有收藏的活动");
    const p = uniqueMatch(favorites, name, (row) => [row.mc], candidate(now), "收藏的活动"), activity = brief(p);
    if (o.dryRun) return { done: false, verified: false, status: "ready", activity, message: "可以取消收藏，没有提交。" };
    const journalFile = await commit(s, o, "unfavorite", "取消收藏", "student/home/hdsc", p, 1, false);
    return { done: true, verified: true, status: "unfavorited", activity, message: "已取消收藏，「我收藏的活动」里不再有它。", journalFile };
  }
  const p = uniqueMatch(await unfinished(s, now), name, (row) => [row.mc], candidate(now), "活动"), activity = brief(p);
  if (favorites.some((row) => row.id === p.id)) return { done: true, verified: true, status: "already-favorite", activity, message: "之前已经收藏过，没有重复提交。" };
  if (o.dryRun) return { done: false, verified: false, status: "ready", activity, message: "可以收藏，没有提交。" };
  const journalFile = await commit(s, o, "favorite", "收藏", "student/home/hdsc", p, 1, true);
  return { done: true, verified: true, status: "favorite", activity, message: "已收藏，并在「我收藏的活动」里查到。", journalFile };
}

interface Bulletin { mc?: string; fbsj?: string; nr?: string; fjmc?: string | null; fjid?: string | null }

/** 平台通知：审核时间、记点申请流程等，量很少，一次给全 */
export async function listBulletins(s: Sztz) {
  const r = await s.call<Bulletin[]>("GET", "student/tzgg/ajaxList", { pageIndex: 1, pageSize: 100, mc: "" });
  return { notices: (r.data ?? []).map((b) => {
      const names = (b.fjmc ?? "").split(",").map((n) => n.trim()).filter(Boolean), ids = (b.fjid ?? "").split(",").map((n) => n.trim()).filter(Boolean);
      return { title: (b.mc ?? "").trim(), date: beijing(b.fbsj), text: clean(b.nr), ...(ids.length ? { attachments: ids.map((id, i) => ({ text: names[i] ?? "附件", url: `${BASE}/common/file/download?id=${id}` })) } : {}) };
    }), count: r.data?.length ?? 0 };
}
