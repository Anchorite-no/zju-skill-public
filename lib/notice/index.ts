/**
 * 校内通知公告：各单位公开发布的通知，按来源表（sources.ts）读取、合并、去重。
 *
 * 声明：auth=cas network=campus writes=false。部处官网只在校内可解析，经 WebVPN；个别栏目（信息技术中心）要统一身份认证，
 * 落到 CAS 登录页时按该页的 service 做一次委托后重取。教务网通知借用 zdbk 的会话（公网直连）。
 * 只查某个来源时不打开其他来源的会话；一个来源读取失败，其余照常返回，结果标 partial。
 * 已读记录：data/notice/seen.json，只有 notice new 读写。
 */
import path from "node:path";
import type { ModuleRequirements } from "../core/module.ts";
import type { HttpResponse } from "../core/http.ts";
import { AuthExpired, BadResponse, ConfigError, NeedsUser, TransportError } from "../core/errors.ts";
import { splitPhrases } from "../core/match.ts";
import { paths } from "../core/paths.ts";
import { readJson, writeJson } from "../core/fsjson.ts";
import { openContext, type Context } from "../webvpn/transport.ts";
import { unwrapUrl } from "../webvpn/client.ts";
import { openZdbk, ZDBK_HOST, type Zdbk } from "../zdbk/client.ts";
import { SOURCES } from "./sources.ts";
import { catalogInfo, colleges, findCollege, identity, levelOf, type Identity, type Level } from "./identity.ts";
import { attachmentDetail, isAttachment, parseArticle } from "./article.ts";
import { articleId, listColumn } from "./adapters/webplus.ts";
import { listZdbk, withFullTitles, zdbkDetail } from "./adapters/zdbk.ts";
import { kyjsNotice } from "./adapters/kyjs.ts";
import { patiently } from "./read.ts";
import type { Column, ListQuery, ListResult, Notice, NoticeDetail, Source } from "./types.ts";

/** 逐站标注表（hosts.json，scripts/notice/hosts.ts 从校外实测生成）：每个通知网站是公网可达还是只在校园网 */
const hostNotes = (readJson<{ hosts: Record<string, { network: string; cas?: boolean }> }>(path.join(paths.root, "lib/notice/hosts.json"))?.hosts ?? {});
/** 一个网站从校外能不能直接访问；表里没有的按只在校园网算 */
const networkOf = (site: string): "public" | "campus" => hostNotes[new URL(site).host]?.network === "public" ? "public" : "campus";
// 条目会外链到其他校内站点，整个 zju.edu.cn 都经 WebVPN，只有标注表里公网可达的网站直连；统一认证主机由 zjuam 组件直连。
export const requirements: ModuleRequirements = { name: "notice", title: "校内通知公告", hosts: ["zju.edu.cn"], auth: "cas", network: "campus", writes: false,
  publicHosts: Object.keys(hostNotes).filter((host) => hostNotes[host]!.network === "public") };

const today = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(Date.now() + offsetDays * 86_400_000);
const message = (err: unknown) => err instanceof Error ? err.message : String(err);

/** 一次命令里按需打开的两种会话：教务网，以及校内站点（公网可达的直连，其余经 WebVPN） */
class Session {
  private z: Promise<Zdbk> | undefined;
  private c: Promise<Context> | undefined;
  private cas = new Map<string, Promise<unknown>>();
  private i: Promise<Identity> | undefined;
  zdbk = (): Promise<Zdbk> => (this.z ??= openZdbk());
  /** 使用者的类别和学院；学院第一次要问教务网，之后读本地记录 */
  who = (): Promise<Identity> => (this.i ??= identity(this.zdbk));
  campus = (): Promise<Context> => (this.c ??= openContext(requirements, { maxSockets: 8 }));

  /** 校内页面：只读请求最多发三次，卡住时早换连接（见 read.ts）；落到统一认证登录页时完成该站的委托后重取 */
  get = async (url: string): Promise<HttpResponse> => {
    const ctx = await this.campus();
    const fetch = () => patiently((opts) => ctx.fetchFollow(url, opts));
    const service = (res: HttpResponse) => {
      const u = new URL(unwrapUrl(res.url));
      return u.hostname === "zjuam.zju.edu.cn" && u.pathname.startsWith("/cas/login") ? u.searchParams.get("service") : null;
    };
    let res = await fetch(), wanted = service(res);
    if (wanted) {
      if (!ctx.zjuam) throw new AuthExpired("zjuam", "该页面需要统一身份认证");
      const host = new URL(wanted).hostname;
      // 同一站点的并发请求共用一次委托
      if (!this.cas.has(host)) this.cas.set(host, ctx.zjuam.loginService(wanted));
      await this.cas.get(host);
      res = await fetch();
      if ((wanted = service(res))) { await ctx.zjuam.loginService(wanted); res = await fetch(); }
      if (service(res)) throw new AuthExpired(host, `${host} 完成统一身份认证后仍要求登录`);
    }
    if (res.status !== 200) throw new BadResponse(`页面 HTTP ${res.status}`, { url });
    return res;
  };

  async close(): Promise<void> {
    for (const opened of [this.z, this.c]) (await opened?.catch(() => undefined))?.close();
  }
}

// ---------- 来源选择 ----------

interface Pick { source: Source; columns: Column[] }
interface Selection { picks: Pick[]; who?: Identity }
const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();
const label = (source: Source, column: Column) => `${source.name}·${column.name}`;
const fits = (level: Level) => (c: Column) => !c.audience || c.audience === level;
/** 「学院」「我的学院」指本人学院 */
const MINE = /^(?:本人|我的|我们|本)?(?:学院|院系)$|^本院$/;

/**
 * 不给名字时取默认集或增量集：来源表里标了的栏目加本人学院的栏目，只面向本科生或研究生的按使用者的类别取。
 * 给了名字可以是来源名、栏目名或学院名，先按全名和别名，再按包含。只点名来源表里的来源时不去识别学院。
 */
async function select(session: Session, raw: string | undefined, scope: "default" | "feed" | "known"): Promise<Selection> {
  const of = (sources: Source[], keep: (c: Column) => boolean | undefined) => sources.map(source => ({ source, columns: source.columns.filter(keep) })).filter(p => p.columns.length);
  const fit = fits(levelOf());
  if (raw === undefined) {
    const who = await session.who();
    // 本人学院排最前：学院转发校级通知时会加上院内的安排和截止时间，重复时留学院的那条
    return { who, picks: [...(who.college ? of([who.college], fit) : []), ...of(SOURCES, c => (scope === "known" ? c.default || c.feed : c[scope]) && fit(c))] };
  }
  const phrases = splitPhrases(raw).map(norm);
  if (!phrases.length) throw new ConfigError("需要通知来源名称");
  if (phrases.some(p => p === "全部" || p === "所有")) {
    const who = await session.who();
    return { who, picks: [...of(SOURCES, () => true), ...(who.college ? of([who.college], fit) : [])] };
  }
  const chosen = new Set<Column>(), named: Source[] = [];
  let who: Identity | undefined;
  for (const phrase of phrases) {
    const hit = (pool: Source[], test: (name: string) => boolean) => pool.flatMap(source => [source.name, source.id, ...(source.aliases ?? [])].some(n => test(norm(n))) ? source.columns
      : source.columns.filter(c => [c.name, ...(c.aliases ?? [])].some(n => test(norm(n)))));
    let found = MINE.test(phrase) ? [] : hit(SOURCES, n => n === phrase);
    if (!found.length && !MINE.test(phrase)) found = hit(SOURCES, n => n.includes(phrase));
    if (!found.length) {
      // 学院：本人学院，或按名字从名录里找；再不行按栏目名在本人学院里找
      who ??= await session.who();
      const mine = who.college;
      if (MINE.test(phrase) && !mine) throw new ConfigError(who.hint ?? "没有识别出你的学院");
      const colleges = MINE.test(phrase) ? [mine!] : findCollege(phrase);
      named.push(...colleges);
      found = colleges.flatMap(c => c.columns.filter(fit));
      if (!found.length && mine) { named.push(mine); found = mine.columns.filter(c => norm(c.name) === phrase); if (!found.length) found = mine.columns.filter(c => norm(c.name).includes(phrase)); }
    }
    if (!found.length) throw new ConfigError(`没有叫「${phrase}」的通知来源`, `已接入：${SOURCES.map(s => s.name).join("、")}，以及各学院官网（写学院名，本人学院写「学院」）；也可以写栏目名，见 notice sources`);
    for (const c of found) chosen.add(c);
  }
  return { ...(who ? { who } : {}), picks: of([...SOURCES, ...new Set(named)], c => chosen.has(c)) };
}

/** 结果里交代读了哪些来源：整个来源只写名字，学院栏目多也只写名字 */
const describe = ({ picks, who }: Selection) => picks.map(p => {
  const name = p.source.name + (p.source === who?.college ? "（本人学院）" : "");
  return p.columns.length === p.source.columns.length || (p.source.id.startsWith("college-") && p.columns.length > 3) ? name : `${name}：${p.columns.map(c => c.name).join("、")}`;
});
/** 结果里交代按谁取的默认来源 */
const profileOf = (who: Identity | undefined) => who ? { profile: { level: who.level === "grad" ? "研究生" : "本科生", college: who.college?.name ?? null, ...(who.hint ? { hint: who.hint } : {}) } } : {};

// ---------- 读取与合并 ----------

interface Task { key: string; label: string; run: (q: ListQuery) => Promise<ListResult> }

/** 教务网的两类通知一次请求取完；网站群每个栏目各读各的，互不影响 */
function tasks(session: Session, picks: Pick[]): Task[] {
  return picks.flatMap(({ source, columns }): Task[] => source.adapter === "zdbk"
    ? [{ key: source.id, label: source.name, run: async (q) => listZdbk(await session.zdbk(), columns.map(c => c.id), q, session.campus) }]
    // 学院的栏目可能分布在主站和办公网，栏目号会重复，键里带上站点
    : columns.map(column => ({ key: [source.id, ...(column.base ? [new URL(column.base).host + new URL(column.base).pathname.replace(/\/$/, "")] : []), column.id].join("/"), label: label(source, column), run: (q) => listColumn(session.get, source, column, q) })));
}

const titleKey = (s: string) => s.replace(/(\.{3}|…)$/, "").replace(/^【[^】]*】/, "").replace(/[\s“”"'‘’（）()《》〈〉【】[\]—\-－_:：,，、。.·|｜​]/g, "").replace(/^(本科生院|浙江大学)+/, "");
/**
 * 不同来源转发的同一条通知：去掉【…】、「本科生院」「浙江大学」前缀和标点后，短的标题整段出现在长的里（教务网列表标题被截断到约 20 字），
 * 且发布日期相差不超过两周。同一来源内不比标题，只按编号去重。
 */
function sameNotice(a: Notice, b: Notice, keys: Map<Notice, string>): boolean {
  if (a.sourceId === b.sourceId) return false;
  const x = keys.get(a)!, y = keys.get(b)!, [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 8 && long.includes(short) && Math.abs(Date.parse(a.date.slice(0, 10)) - Date.parse(b.date.slice(0, 10))) <= 14 * 86_400_000;
}

/** 按来源表顺序合并，重复的留先出现的；dropped 记下被并掉的条目归到了哪一条 */
function merge(lists: Notice[][]): { notices: Notice[]; dropped: Map<Notice, Notice[]> } {
  const kept: Notice[] = [], ids = new Set<string>(), keys = new Map<Notice, string>(), dropped = new Map<Notice, Notice[]>();
  for (const n of lists.flat()) {
    keys.set(n, titleKey(n.title));
    const twin = ids.has(n.id) ? kept.find(k => k.id === n.id) : kept.find(k => sameNotice(k, n, keys));
    if (twin) { dropped.set(twin, [...(dropped.get(twin) ?? []), n]); continue; }
    ids.add(n.id);
    kept.push(n);
  }
  return { notices: kept.sort((a, b) => b.date.slice(0, 10).localeCompare(a.date.slice(0, 10))), dropped };
}

async function gather(session: Session, list: Task[], query: (task: Task) => ListQuery) {
  const results = await Promise.all(list.map(async (task) => {
    try { return { task, ...(await task.run(query(task))) }; } catch (err) { return { task, error: message(err) }; }
  }));
  const ok = results.filter((r): r is typeof r & ListResult => "notices" in r);
  return { ok, failed: results.filter((r): r is { task: Task; error: string } => "error" in r).map(r => ({ source: r.task.label, error: r.error })) };
}

async function detailOf(session: Session, n: Notice): Promise<NoticeDetail> {
  const target = n.externalUrl ?? n.url;
  const kyjs = await kyjsNotice(session.get, target);
  if (kyjs) return { ...kyjs, publisher: kyjs.publisher || n.publisher, publishedAt: kyjs.publishedAt || n.date };
  if (n.sourceId === "zdbk" || new URL(target).hostname === ZDBK_HOST) return zdbkDetail(await session.zdbk(), n, session.campus);
  if (isAttachment(target)) return attachmentDetail(n.id, target, n.title || undefined);
  // 综合服务网个别条目指向 10.x 的内网系统，WebVPN 只代理声明的域名，直接说明读不到，不去等超时
  if (/^(?:10|127|192.168|172.(?:1[6-9]|2d|3[01]))./.test(new URL(target).hostname)) throw new BadResponse("链接指向校内内网地址，读不到正文", { url: target });
  const res = await session.get(target), d = parseArticle(n.id, res.body, unwrapUrl(res.url));
  return { ...d, publisher: d.origin || n.publisher || d.publisher, publishedAt: d.publishedAt || n.date };
}

type CollectedNotice = Notice & { detail?: NoticeDetail; error?: string };

async function withDetails(session: Session, notices: Notice[]): Promise<CollectedNotice[]> {
  const out = new Array<CollectedNotice>(notices.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, notices.length) }, async () => {
    for (;;) {
      const index = next++, n = notices[index]; if (!n) return;
      try {
        const detail = await detailOf(session, n);
        const title = detail.contentStatus === "unavailable" ? n.title || detail.title : detail.title;
        out[index] = { ...n, title, detail, ...(detail.contentStatus === "unavailable" ? { error: `详情页面未提供可读取正文：${detail.title}` } : {}) };
      } catch (err) { out[index] = { ...n, error: message(err) }; }
    }
  }));
  return out;
}

/** 每条一个扁平记录：详情与列表的重复字段只保留一份，附件不再在 links 里重复（Flash 实测嵌套结果过长时会截断再写脚本重查） */
function noticeView(n: CollectedNotice) {
  const d = n.detail, links = d?.links.filter(l => !l.attachment).map(({ url, text }) => ({ url, text })) ?? [];
  // 按链接取的条目没有列表日期：用正文页的发布时间，再不行用网站群文章地址里的日期
  const fromUrl = n.url.match(/\/(\d{4})\/(\d{2})(\d{2})\/c\w+a\d+\//);
  return { title: n.title, date: n.date || d?.publishedAt.slice(0, 10) || (fromUrl ? `${fromUrl[1]}-${fromUrl[2]}-${fromUrl[3]}` : ""), ...(n.source ? { source: n.source } : {}), publisher: d?.publisher || n.publisher, url: n.externalUrl ?? d?.externalUrl ?? n.url,
    ...(n.pinned ? { pinned: true } : {}), ...(d ? { contentStatus: d.contentStatus, text: d.text, attachments: d.attachments } : {}),
    ...(links.length ? { links } : {}), ...(n.error ? { error: n.error } : {}) };
}
const unread = (n: CollectedNotice) => Boolean(n.error) || n.detail?.contentStatus === "unavailable" || n.detail?.contentStatus === "summary-only";

// ---------- notice list ----------

export interface NoticeQuery { keyword?: string; source?: string; since?: string; until?: string; limit?: number }

/** 标题里通常写全称的校内简称；关键词含简称时同时按全称检索（Flash 实测按「推免」搜不到「推荐免试研究生」） */
const KEYWORD_ALIASES: [string, string][] = [["推免", "免试"], ["大创", "创新训练"]];
/** keyword 可以一次给几个说法（顿号、逗号、竖线分隔），命中任一个即可；最多 8 个。 */
function keywordTerms(keyword?: string): string[] {
  if (!keyword) return [];
  const phrases = splitPhrases(keyword);
  if (!phrases.length) throw new ConfigError("需要通知关键词");
  if (phrases.length > 8) throw new ConfigError("关键词一次最多 8 个说法");
  return [...new Set(phrases.flatMap(p => [p, ...KEYWORD_ALIASES.filter(([short]) => p.includes(short)).map(([short, full]) => p.replace(short, full))]))];
}

function listQuery(opts: NoticeQuery): ListQuery {
  for (const date of [opts.since, opts.until]) if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new ConfigError("通知日期应为有效的 YYYY-MM-DD");
  if (opts.since && opts.until && opts.since > opts.until) throw new ConfigError("起始日期不能晚于结束日期");
  const limit = opts.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ConfigError("通知数量应在 1–200 之间");
  return { terms: keywordTerms(opts.keyword), ...(opts.since ? { since: opts.since } : {}), ...(opts.until ? { until: opts.until } : {}), limit };
}

async function collect(session: Session, opts: NoticeQuery, chosen: Selection) {
  const q = listQuery(opts);
  const { ok, failed } = await gather(session, tasks(session, chosen.picks), () => q);
  const merged = merge(ok.map(r => r.notices)).notices;
  const notices = await withDetails(session, merged.slice(0, q.limit));
  const shallow = ok.filter(r => r.scannedTo).map(r => ({ source: r.task.label, scannedTo: r.scannedTo! }));
  const incomplete = notices.filter(unread).length + failed.length;
  return { notices, count: notices.length, hasMore: merged.length > q.limit || ok.some(r => r.hasMore), status: incomplete ? "partial" as const : "complete" as const, incomplete,
    filters: { sources: describe(chosen), ...(opts.keyword ? { keyword: opts.keyword } : {}), ...(q.terms.length > 1 ? { searchedKeywords: q.terms } : {}),
      ...(q.since ? { since: q.since } : {}), ...(q.until ? { until: q.until } : {}), limit: q.limit },
    ...profileOf(chosen.who), ...(failed.length ? { sourceErrors: failed } : {}), ...(shallow.length ? { searchedBackTo: shallow } : {}) };
}

const LIST_NOTE = "按发布时间由新到旧，同一条通知在几个来源都有时只留一条；keyword 检索标题，推免、大创同时按免试、创新训练检索；正文不截断。"
  + "attachment-only 的正文在附件中，summary-only 仅有摘要，不能当作全文。sourceErrors 里的来源本次没有读到；searchedBackTo 里的来源只往回找到所列日期。";

/** Complete task result: full titles, complete bodies, links, and explicit content failures. */
export async function queryNotices(opts: NoticeQuery = {}) {
  const session = new Session();
  try {
    const result = await collect(session, opts, await select(session, opts.source, "default"));
    return { ...result, notices: result.notices.map(noticeView), note: LIST_NOTE };
  } finally { await session.close(); }
}

// ---------- notice view ----------

/** 链接属于哪个已接来源；栏目号对得上时带栏目名 */
function sourceOf(url: URL): { label: string; source?: Source } {
  if (url.hostname === ZDBK_HOST) return { label: "教务网", source: SOURCES.find(s => s.id === "zdbk")! };
  const source = [...SOURCES, ...colleges()].find(s => [s.base, ...s.columns.map(c => c.base ?? s.base)].some(base => new URL(base).hostname === url.hostname));
  const column = source?.columns.find(c => url.pathname.includes(`/c${c.id}a`));
  return source ? { label: column ? label(source, column) : source.name, source } : { label: "" };
}

async function byUrl(session: Session, raw: string) {
  const links = raw.split(/[|｜\n]+/).map(s => s.trim()).filter(Boolean);
  if (!links.length) throw new ConfigError("需要通知链接");
  const stubs = links.map((link): Notice => {
    let url: URL; try { url = new URL(link); } catch { throw new ConfigError(`通知链接不是有效 URL：${link}`); }
    if (!/^https?:$/.test(url.protocol)) throw new ConfigError("通知链接必须是 HTTP(S)");
    const from = sourceOf(url);
    return { id: url.hostname === ZDBK_HOST ? url.searchParams.get("xwbh") ?? "" : articleId(url.href), title: "", titleTruncated: false, publisher: from.source && from.source.id !== "zdbk" ? from.source.name : "",
      date: "", source: from.label, sourceId: url.hostname === ZDBK_HOST ? "zdbk" : from.source?.id ?? "", pinned: false, url: url.href };
  });
  return withDetails(session, stubs);
}

async function byTitle(session: Session, title: string): Promise<CollectedNotice[]> {
  // 服务端按标题子串检索，带书名号、括号的完整长标题常搜不到：先试原标题，再试其中最长的两段连续文字，本地再按标题比对。
  const wanted = titleKey(title);
  const pieces = title.split(/[\s“”"'‘’（）()《》〈〉【】[\]—\-－_:：,，、。.·|｜]+/).filter(p => p.length >= 4).sort((a, b) => b.length - a.length);
  const chosen = await select(session, undefined, "known");
  let found: CollectedNotice[] = [], seenAny: CollectedNotice[] = [], more = false;
  for (const keyword of [...new Set([title, ...pieces.slice(0, 2)])]) {
    const result = await collect(session, { keyword, limit: 20 }, chosen);
    const same = result.notices.filter(n => titleKey(n.title) === wanted);
    found = same.length ? same : result.notices.filter(n => titleKey(n.title).includes(wanted) || (wanted.length >= 8 && wanted.includes(titleKey(n.title))));
    seenAny = result.notices; more = result.hasMore && !same.length;
    if (found.length) break;
  }
  if (found.length !== 1 || more) {
    const candidates = found.length ? found : seenAny;
    const error = new NeedsUser(candidates.length ? "有多条匹配通知，请明确标题或链接" : "未找到匹配通知");
    error.detail.candidates = candidates.map(n => ({ title: n.title, date: n.date, source: n.source, url: n.externalUrl ?? n.url })); throw error;
  }
  if (!found[0]!.detail) throw new BadResponse(found[0]!.error ?? "通知正文获取失败");
  return found;
}

/** 按链接（可多个）或标题取通知全文，记录结构与 queryNotices 的每一条相同。 */
export async function findNotices(target: { title?: string; url?: string }) {
  if ([target.title, target.url].filter(Boolean).length !== 1) throw new ConfigError("请提供通知标题或链接其中一种");
  const session = new Session();
  try {
    const notices = target.url ? await byUrl(session, target.url) : await byTitle(session, target.title!);
    const incomplete = notices.filter(unread).length;
    return { notices: notices.map(noticeView), count: notices.length, status: incomplete ? "partial" as const : "complete" as const, ...(incomplete ? { incomplete } : {}) };
  } finally { await session.close(); }
}

// ---------- notice new ----------

/** 每个增量来源上次检查的时间，和这段时间里见过的条目（编号 → 发布日期） */
interface SeenState { sources: Record<string, { checkedAt: string; seen: Record<string, string> }> }
const stateFile = () => path.join(paths.data(), "notice", "seen.json");
const readState = (): SeenState => readJson<SeenState>(stateFile()) ?? { sources: {} };
/** 第一次给最近几天；之后每次从上次检查再往前几天看起（补发、改期的通知）；最多回看这么多天；一次最多列这么多条 */
const FIRST_DAYS = 7, OVERLAP_DAYS = 7, MAX_DAYS = 45, KEEP_DAYS = 60, PAGE = 100;
const beijingMinute = (iso: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

/** 增量来源里上次查看之后新出现的通知，只有标题、日期、来源和链接 */
export async function newNotices() {
  const state = readState(), session = new Session();
  try {
    const chosen = await select(session, undefined, "feed"), list = tasks(session, chosen.picks);
    const since = (task: Task) => {
      const prev = state.sources[task.key];
      const from = prev ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(Date.parse(prev.checkedAt) - OVERLAP_DAYS * 86_400_000) : today(-FIRST_DAYS);
      return from > today(-MAX_DAYS) ? from : today(-MAX_DAYS);
    };
    const { ok, failed } = await gather(session, list, (task) => ({ terms: [], since: since(task), limit: 1000 }));
    const fresh = ok.map(r => r.notices.filter(n => !state.sources[r.task.key]?.seen[n.id]));
    const merged = merge(fresh), shown = merged.notices.slice(0, PAGE);
    // 没列出来的留到下次：它们和并到它们名下的重复条目都不记为已读
    const held = new Set(merged.notices.slice(PAGE).flatMap(n => [n, ...(merged.dropped.get(n) ?? [])]));
    const zdbk = shown.some(n => n.sourceId === "zdbk" && n.titleTruncated) ? await withFullTitles(await session.zdbk(), shown.filter(n => n.sourceId === "zdbk"), session.campus) : [];
    const titles = new Map(zdbk.map(n => [n.id, n.title]));
    const now = new Date().toISOString(), horizon = today(-KEEP_DAYS);
    const checked = ok.map(r => state.sources[r.task.key]?.checkedAt).filter((t): t is string => Boolean(t)).sort();
    for (const r of ok) {
      const seen = Object.fromEntries(Object.entries(state.sources[r.task.key]?.seen ?? {}).filter(([, date]) => date >= horizon));
      for (const n of r.notices) if (!held.has(n)) seen[n.id] = n.date.slice(0, 10);
      state.sources[r.task.key] = { checkedAt: now, seen };
    }
    const result = { notices: shown.map(n => ({ title: titles.get(n.id) ?? n.title, date: n.date.slice(0, 10), source: n.source, url: n.externalUrl ?? n.url })), count: shown.length,
      ...(held.size ? { remaining: merged.notices.length - shown.length } : {}),
      ...(checked.length ? { lastChecked: beijingMinute(checked[0]!) } : {}), status: failed.length ? "partial" as const : "complete" as const,
      sources: describe(chosen), ...profileOf(chosen.who), ...(failed.length ? { sourceErrors: failed } : {}),
      note: (checked.length ? "上次查看之后新发布的通知" : `第一次查看，给出最近 ${FIRST_DAYS} 天的通知`) + "，只有标题；要看全文，把相关条目的 url 用竖线连起来交给 notice view --url。"
        + (held.size ? `还有 ${merged.notices.length - shown.length} 条更早的没有列出，再调用一次继续。` : "") + (failed.length ? "sourceErrors 里的来源本次没有读到，下次会补上。" : "") };
    writeJson(stateFile(), state);
    return result;
  } finally { await session.close(); }
}

// ---------- notice sources ----------

/** 不联网：学院只看个人档案和本地记录 */
export async function listSources() {
  const state = readState(), who = await identity(), fit = fits(who.level), info = catalogInfo();
  const names = (source: Source, flag: (c: Column) => boolean | undefined) => source.columns.filter(flag).map(c => c.name);
  const only = (source: Source) => source.columns.every(c => c.audience === "undergrad") ? { only: "本科生" } : source.columns.every(c => c.audience === "grad") ? { only: "研究生" } : {};
  const checked = Object.values(state.sources).map(s => s.checkedAt).sort();
  return { ...profileOf(who),
    sources: SOURCES.map(source => ({ name: source.name, site: source.base, network: networkOf(source.base), ...only(source), columns: names(source, () => true), default: names(source, c => c.default && fit(c)), new: names(source, c => c.feed && fit(c)) })),
    ...(who.college ? { myCollege: { name: who.college.name, site: who.college.base, network: networkOf(who.college.base), columns: names(who.college, fit) } } : {}),
    colleges: info.colleges, collegesNotReadable: info.unsupported,
    ...(checked.length ? { lastChecked: beijingMinute(checked[0]!) } : {}),
    note: "default 的栏目是 notice list 不指名来源时读的，new 的栏目是 notice new 扫描的，都已按 profile 里的本科生或研究生取；本人学院（myCollege）的栏目两者都读。"
      + "其余栏目用 --source 写来源名或栏目名才读；colleges 里的其他学院用 --source 写学院名。lastChecked 是上次 notice new 的时间。"
      + "network 是这个网站从校外能不能直接访问：public 的直连，campus 的经 WebVPN，命令自己处理。" };
}
