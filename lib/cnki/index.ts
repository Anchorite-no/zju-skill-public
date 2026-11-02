/**
 * 中国知网（kns.cnki.net）：检索与全文下载。
 *
 * 没有账号：知网按出口 IP 认机构（浙江大学图书馆）。所以声明 network=campus，默认经 WebVPN 出去；
 * profile 里 transport=direct 时直连，本机要在校园网内。
 *
 * 先 IP 登录再检索：没有登录过的会话打检索站会被带去滑块验证。登录约 20 分钟有效，存在 data/sessions/cnki.json，
 * 有效期内的命令直接复用、不再登录；每篇文献的下载地址只请求一次。
 * 刚登录过仍被带去滑块验证时自动完成拼图并恢复原请求。协议细节见同目录 README。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModuleRequirements } from "../core/module.ts";
import { CookieJar, DEFAULT_UA, HttpResponse } from "../core/http.ts";
import { BadResponse, ConfigError, NeedsUser, RateLimited, RemoteRejected, TransportError, ZjuError } from "../core/errors.ts";
import { decodeEntities, htmlToText } from "../core/html.ts";
import { debug } from "../core/output.ts";
import { openContext, type Context } from "../webvpn/transport.ts";
import { TICKET_COOKIE, unwrapUrl, WEBVPN_BASE, WEBVPN_HOST } from "../webvpn/client.ts";
import { SessionStore } from "../zjuam/session.ts";
import { safeName } from "../zhiyun/download.ts";
import { Slider, sliderLimited, sliderUrl } from "./slider.ts";

const KNS = "https://kns.cnki.net/kns8s";
const IP_LOGIN = "https://login.cnki.net/TopLogin/api/loginapi/IpLoginFlush";
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export const requirements: ModuleRequirements = {
  name: "cnki",
  title: "中国知网",
  hosts: ["cnki.net"],
  auth: "none",
  network: "campus",
  writes: false,
  sessionProbe: IP_LOGIN,
};

/** 文献类型 → 知网的资源名与库代码；不指定类型时查总库。 */
export const TYPES = {
  期刊: { resource: "JOURNAL", classid: "YSTT4HG0" },
  学位论文: { resource: "DISSERTATION", classid: "LSTPFY1C" },
  博士: { resource: "DISSERTATION", classid: "RMJLXHZ3" },
  硕士: { resource: "DISSERTATION", classid: "JQIRZIYA" },
  会议: { resource: "CONFERENCE", classid: "JUP3MUPD" },
  报纸: { resource: "NEWSPAPER", classid: "MPMFIG1A" },
} as const;
export type DocType = keyof typeof TYPES;
const ALL = { resource: "CROSSDB", classid: "WD0FTY92" };
/** 总库默认勾选的子库，与网页上一致 */
const CROSS = "YSTT4HG0,LSTPFY1C,JUP3MUPD,MPMFIG1A,WQ0UVIAA,BLZOG7CK,PWFIRAGL,EMRPGLPA,NLBO1Z6R,NN3FJMUV";

/** 期刊来源类别 → 检索字段 */
export const CORE = { SCI: "SI", EI: "EI", 北大核心: "HX", CSSCI: "CSI", CSCD: "CSD" } as const;
export type CoreKind = keyof typeof CORE;

export const SORTS = { relevance: "FFD", date: "PT", cited: "CF", downloads: "DFR" } as const;
export type Sort = keyof typeof SORTS;

export interface Query {
  /** 主题词，空格隔开的几个词都要出现 */
  keyword?: string;
  /** 篇名里的词，写法同 keyword */
  title?: string;
  author?: string;
  /** 期刊名、学位授予单位或会议名 */
  source?: string;
  type?: DocType;
  /** 发表年份的起止（含） */
  years?: [number, number];
  /** 只对期刊有效，满足其一即可 */
  core?: CoreKind[];
  sort?: Sort;
  /** 条数，最多 50（知网一页的上限） */
  limit?: number;
}

export interface Paper {
  title: string;
  authors: string[];
  source: string;
  /** 期刊、会议是日期，学位论文是授予年度 */
  date: string;
  type: string;
  cited: number;
  downloads: number;
  /** 详情页地址，只在模块内部用 */
  link: string;
}

export interface SavedFile {
  path: string;
  bytes: number;
  format: "pdf" | "caj";
  /** 本地已有同一文件，未重新下载 */
  reused?: true;
  note?: string;
}

// ---------- 检索式 ----------

/** 知网检索式里空格和 * + - ( ) / % = 是运算符，带这些字符的词要用引号括起来。 */
const quote = (term: string) => {
  const t = term.replace(/['"]/g, "").trim();
  return /[\s*+\-()/%=]/.test(t) ? `'${t}'` : t;
};

/** 空格、顿号、逗号隔开的几个词都要出现；检索框上限 120 字，超出的词不再加。 */
export function allOf(raw: string): string {
  const terms: string[] = [];
  for (const word of raw.split(/[\s、，,；;]+/)) {
    const term = quote(word);
    if (!term || /^[*+]+$/.test(term)) continue;
    if ([...terms, term].join(" * ").length > 110) break;
    terms.push(term);
  }
  return terms.join(" * ");
}

/** 完整篇名按标点拆成几段、每段都要出现：标点的全半角与知网不一致时也能找到，最后再比对整个篇名。 */
const titleWords = (title: string) => title.split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
const sameTitle = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function queryJson(q: Query): string {
  const db = q.type ? TYPES[q.type] : ALL;
  const fields: [title: string, field: string, operator: string, value: string | undefined][] = [
    ["主题", "SU", "TOPRANK", q.keyword && allOf(q.keyword)],
    ["篇名", "TI", "DEFAULT", q.title && allOf(q.title)],
    ["作者", "AU", "DEFAULT", q.author && quote(q.author)],
    ["文献来源", "LY", "DEFAULT", q.source && quote(q.source)],
  ];
  const item = (key: string | number, title: string, field: string, operator: string, value: string, value2 = "", logic = 0) =>
    ({ Key: key, Title: title, Logic: logic, Field: field, Operator: operator, Value: value, Value2: value2 });
  const group = (key: string, title: string, items: unknown[]) => ({ Key: key, Title: title, Logic: 0, Items: items, ChildItems: [] });
  // 与网页的高级检索相同：每个条件是一行输入框，时间和来源类别在控制组里。
  const subject = fields.filter((f): f is [string, string, string, string] => !!f[3]).map(([title, field, operator, value], i) => {
    const key = `input[data-tipid=gradetxt-${i + 1}]`;
    return group(key, title, [item(key, title, field, operator, value)]);
  });
  if (!subject.length) throw new ConfigError("需要 --keyword、--title、--author 或 --source 中的至少一个");
  const control: unknown[] = [];
  if (q.years) control.push(group(".tit-date-box", "", [item(".tit-date-box", "发表时间", "PT", "BETWEEN", `${q.years[0]}-01-01`, `${q.years[1]}-12-31`)]));
  if (q.core?.length) control.push(group(".extend-tit-checklist", "", q.core.map((kind, i) => item(i, kind, CORE[kind], "DEFAULT", "Y", "", 1))));
  return JSON.stringify({
    Platform: "", Resource: db.resource, Classid: db.classid, Products: "",
    QNode: { QGroup: [
      { Key: "Subject", Title: "", Logic: 0, Items: [], ChildItems: subject },
      { Key: "ControlGroup", Title: "", Logic: 0, Items: [], ChildItems: control },
    ] },
    ExScope: "1", SearchType: 1, Rlang: "CHINESE", KuaKuCode: q.type ? "" : CROSS, Expands: {}, SearchFrom: 1,
  });
}

// ---------- 结果解析 ----------

const plain = (html: string) => decodeEntities(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const cell = (row: string, name: string) => row.match(new RegExp(`<td\\s+class=['"]${name}['"][^>]*>([\\s\\S]*?)</td>`))?.[1] ?? "";

/** 检索结果表格 → 文献列表。各库的列不同：来源列在期刊是 source，学位论文是 unit，会议是 hy-name；总库和学位论文另有「数据库」列。 */
export function parseGrid(html: string, type?: DocType): { total: number; papers: Paper[] } {
  const body = html.match(/<tbody[\s\S]*?<\/tbody>/)?.[0];
  if (!body) {
    if (/暂无数据|抱歉|没有找到/.test(html)) return { total: 0, papers: [] };
    throw new BadResponse("知网检索结果不是预期的表格", { snippet: htmlToText(html).replace(/\s+/g, " ").slice(0, 200) });
  }
  const papers: Paper[] = [];
  for (const row of body.split(/<tr[\s>]/).slice(1)) {
    const name = cell(row, "name");
    const anchor = name.match(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/);
    if (!anchor) continue;
    const author = cell(row, "author");
    const linked = [...author.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) => plain(m[1]!)).filter(Boolean);
    papers.push({
      title: plain(anchor[2]!),
      authors: linked.length ? linked : plain(author).split(/\s*[;；]\s*/).filter(Boolean),
      source: plain(cell(row, "source") || cell(row, "unit") || cell(row, "hy-name")),
      date: plain(cell(row, "date")).replace(/^(\d{4}-\d{2}-\d{2}).*$/, "$1"),
      type: plain(cell(row, "data")) || type || "",
      cited: Number(plain(cell(row, "quote"))) || 0,
      downloads: Number(plain(cell(row, "download"))) || 0,
      link: unwrapUrl(decodeEntities(anchor[1]!)),
    });
  }
  const total = Number((html.match(/共找到<\/span>\s*<em>([\d,]+)<\/em>/)?.[1] ?? "").replace(/,/g, ""));
  return { total: Number.isFinite(total) && total > 0 ? total : papers.length, papers };
}

// ---------- 客户端 ----------

/** 下载被带去登录页：登录是复用的时候可能只是知网那边的会话没了。 */
class LoginRequired extends RemoteRejected {}
/** 单篇的篇名或候选需要用户处理，不阻止同批其他篇名。 */
export class PaperSelectionRequired extends NeedsUser {}

export interface Login {
  institution: string;
  /** 知网给出的登录有效期（毫秒时间戳） */
  expiresAt: number;
  /** 用的是保存的登录，没有重新登录 */
  reused: boolean;
}

/** 登录状态存在 data/sessions/cnki.json，按出口（webvpn / direct）区分；实际有效期用知网返回的 Expire，这里的 TTL 只是上限。 */
export function sessionStore(transport: string): SessionStore {
  return new SessionStore({ system: "cnki", username: transport, ttlMs: 30 * 60_000 });
}
/** 离到期不足一分钟就当作已过期，免得请求发到一半失效。 */
const usable = (expiresAt: number) => Date.now() < expiresAt - 60_000;

export class Cnki {
  readonly ctx: Context;
  readonly store: SessionStore;
  private session: { institution: string; expiresAt: number } | undefined;
  /** 本进程里最近一次真正登录时的出口。与当前出口相同表示登录是新的，这时再被要求验证就不是会话失效。 */
  private loggedInVia: string | undefined;
  private readonly slider = new Slider();

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.store = sessionStore(ctx.transport);
    const saved = this.store.load(), extra = saved?.extra as { institution?: unknown; expiresAt?: unknown; via?: unknown } | undefined;
    if (saved && typeof extra?.institution === "string" && typeof extra.expiresAt === "number" && extra.via === this.via() && usable(extra.expiresAt)) {
      for (const c of saved.jar.cookies) ctx.http.jar.put(c.name, c.value, c.domain, c.path, c.secure);
      this.session = { institution: extra.institution, expiresAt: extra.expiresAt };
    }
  }

  /** 知网的登录跟着出口走：经 WebVPN 时它的 Cookie 存在 WebVPN 那边，ticket 一换就没了，所以用 ticket 的摘要标记这次登录属于哪个出口。 */
  private via(): string {
    const ticket = this.ctx.http.jar.get(TICKET_COOKIE, `${WEBVPN_BASE}/`);
    return ticket ? crypto.createHash("sha256").update(ticket).digest("hex").slice(0, 16) : "direct";
  }

  /** 直连时知网的 Cookie 在本地，一并存下；经 WebVPN 时本地没有知网的 Cookie，只存登录标记。 */
  private persist(): void {
    if (!this.session) return;
    const cookies = this.ctx.http.jar.cookies.filter((c) => c.domain === "cnki.net" || c.domain.endsWith(".cnki.net"));
    this.store.save(new CookieJar(cookies), { ...this.session, via: this.via() });
  }

  /** 按出口 IP 登录机构账号。保存的登录还在有效期内、出口没变就直接用；fresh 时强制重新登录。 */
  async login(fresh = false): Promise<Login> {
    if (this.session && !fresh && usable(this.session.expiresAt)) return { ...this.session, reused: this.loggedInVia === undefined };
    const res = await this.ctx.fetch(`${IP_LOGIN}?callback=cb&_=${Date.now()}`, { headers: { Referer: "https://www.cnki.net/" } });
    let info: { IsSuccess?: boolean; Msg?: string; ErrorMsg?: string; ShowName?: string; UserName?: string; Expire?: string } | undefined;
    try { info = JSON.parse(res.body.match(/\((\{[\s\S]*\})\)/)?.[1] ?? "") as typeof info; } catch { /* 下面统一报错 */ }
    if (!info?.IsSuccess) {
      this.session = undefined;
      this.store.clear();
      if (!info) throw new BadResponse("知网 IP 登录接口返回异常", { status: res.status });
      throw new NeedsUser(`知网没有把当前出口认作学校的 IP：${info.ErrorMsg || info.Msg || "IP 登录失败"}`,
        this.ctx.transport === "direct" ? "当前是直连（transport=direct），本机要在校园网内；不在校园网时运行 profile init --transport webvpn" : "经 WebVPN 仍失败时多半是学校的并发数已满，过一会儿再试");
    }
    // Expire 是北京时间「2026-10-05 17:45:40」，登录后约 20 分钟。
    const expires = Date.parse(`${(info.Expire ?? "").replace(" ", "T")}+08:00`);
    this.session = { institution: info.ShowName || info.UserName || "机构用户", expiresAt: expires > Date.now() ? expires : Date.now() + 15 * 60_000 };
    this.loggedInVia = this.via();
    this.persist();
    debug(`cnki: IP 登录为 ${this.session.institution}`);
    return { ...this.session, reused: false };
  }

  /** 直连时把这次运行里知网新发的 Cookie 也存下，下次接着用。 */
  close(): void {
    if (this.ctx.transport === "direct") this.persist();
  }

  /**
   * 发一个检索站的请求并检查结果。没有登录过的会话打检索站会被带去滑块验证，所以先保证有登录；
   * 登录是复用的而仍被带去验证，先重新 IP 登录再发一次；还需验证时完成拼图并恢复原请求。
   */
  private async request(send: () => Promise<HttpResponse>, what: string): Promise<HttpResponse> {
    await this.login();
    let res = await send();
    if (sliderUrl(res) && this.loggedInVia !== this.via()) {
      await this.login(true);
      res = await send();
    }
    const verify = sliderUrl(res);
    if (verify) {
      await this.slider.verify(this.ctx, verify);
      res = await send();
      if (sliderUrl(res)) throw sliderLimited("通过后仍未恢复访问");
      this.persist();
    }
    if (res.status === 429) throw new RateLimited("知网限制了请求频率，本次已停止；请过几分钟再试", 300_000);
    if (res.isRedirect) throw new BadResponse(`知网${what}被带到了别的页面`, { to: unwrapUrl(new URL(res.location!, res.url).href).split("?")[0] });
    if (res.status !== 200) throw new TransportError(`知网${what} HTTP ${res.status}`, { status: res.status });
    return res;
  }

  async search(q: Query): Promise<{ total: number; papers: Paper[] }> {
    const db = q.type ? TYPES[q.type] : ALL, limit = q.limit ?? 20;
    const form = new URLSearchParams({
      boolSearch: "true", QueryJson: queryJson(q), pageNum: "1", pageSize: limit > 20 ? "50" : "20",
      sortField: SORTS[q.sort ?? "relevance"], sortType: "desc", dstyle: "listmode", productStr: "", aside: "",
      searchFrom: `资源范围：${q.type ?? "总库"};`, CurPage: "1",
    });
    const res = await this.request(() => this.ctx.fetch(`${KNS}/brief/grid`, {
      method: "POST", body: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Referer: `${KNS}/AdvSearch?classid=${db.classid}`, Origin: "https://kns.cnki.net" },
    }), "检索");
    const found = parseGrid(res.body, q.type);
    return { total: found.total, papers: found.papers.slice(0, limit) };
  }

  /** 按完整篇名找到唯一的一篇；同名的用作者、来源区分，仍不唯一时带着候选报 NEEDS_USER。 */
  async find(title: string, by: { author?: string; source?: string } = {}): Promise<Paper> {
    const words = titleWords(title);
    if (!words) throw new ConfigError("需要篇名");
    const { papers } = await this.search({ title: words, ...by, limit: 50 });
    const exact = papers.filter((p) => sameTitle(p.title) === sameTitle(title));
    const pool = exact.length ? exact : papers;
    if (pool.length === 1) return pool[0]!;
    const error = new PaperSelectionRequired(
      exact.length ? `知网上有 ${exact.length} 篇同名文献，请加 --author 或 --source 区分` : pool.length ? `知网上没有篇名完全是“${title}”的文献，相近的有这些` : `知网上没有找到“${title}”`,
      pool.length ? undefined : "核对篇名；记不清时先用 cnki search 找",
    );
    if (pool.length) error.detail.candidates = pool.slice(0, 10).map(paperRow);
    throw error;
  }

  /** 详情页里的全文地址：有 PDF 用 PDF，只有 CAJ 时用 CAJ。 */
  private async fileLink(paper: Paper): Promise<{ url: string; format: "pdf" | "caj" }> {
    const res = await this.request(() => this.ctx.fetch(paper.link, { headers: { Referer: `${KNS}/AdvSearch` } }), "文献页");
    for (const format of ["pdf", "caj"] as const) {
      const href = res.body.match(new RegExp(`<li class="btn-dl${format}">([\\s\\S]*?)</li>`))?.[1]?.match(/\bhref="([^"]+)"/)?.[1];
      if (href) return { url: unwrapUrl(new URL(decodeEntities(href), res.url).href), format };
    }
    throw new RemoteRejected("知网没有提供这篇文献的全文下载");
  }

  /** 取文件流。下载地址是一次性的下载订单，每一跳只请求一次，自己跟随跳转。 */
  private async stream(url: string, referer: string, signal: AbortSignal): Promise<Response> {
    let current = url;
    let verified = false;
    for (let hop = 0; hop < 8; hop++) {
      const target = this.ctx.resolve(current), cookie = this.ctx.http.jar.getCookieHeader(target);
      const res = await fetch(target, { redirect: "manual", signal, headers: { "User-Agent": DEFAULT_UA, "Accept-Encoding": "identity", Referer: this.ctx.resolve(referer), ...(cookie ? { Cookie: cookie } : {}) } }).catch((err: unknown) => {
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        throw new TransportError(`连不上知网文件服务器：${cause?.message ?? (err instanceof Error ? err.message : String(err))}`, { transport: this.ctx.transport, code: cause?.code }, err);
      });
      this.ctx.http.jar.setFromResponse(res.headers.getSetCookie(), target);
      if (res.status === 429) {
        await res.body?.cancel();
        throw new RateLimited("知网限制了下载频率，本次已停止；请过几分钟再试", 300_000);
      }
      const location = res.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(res.status) && location) {
        await res.body?.cancel();
        const next = new URL(location, target);
        if (next.hostname === WEBVPN_HOST && next.pathname === "/login") throw new TransportError("WebVPN 会话中途失效，重新执行一次即可");
        const real = new URL(unwrapUrl(next.href));
        if (/\/verify\//.test(real.pathname)) {
          if (verified) throw sliderLimited("通过后仍未恢复下载");
          current = (await this.slider.solve(this.ctx, real.href, signal)).href;
          verified = true;
          continue;
        }
        if (real.hostname === "login.cnki.net") throw new LoginRequired("知网要求登录个人账号才能下载这篇文献，学校的订购范围可能不含它");
        current = real.href;
        continue;
      }
      if (res.ok && res.body && !/text\/html|application\/json|text\/plain/i.test(res.headers.get("content-type") ?? "")) return res;
      const body = (await res.text()).slice(0, 20_000);
      // 下载端也可能像检索端一样用 403 JSON 给验证地址。
      const verify = sliderUrl(new HttpResponse({ status: res.status, headers: {}, body, url: target, elapsedMs: 0 }));
      if (verify) {
        if (verified) throw sliderLimited("通过后仍未恢复下载");
        current = (await this.slider.solve(this.ctx, verify, signal)).href;
        verified = true;
        continue;
      }
      const said = htmlToText(body).replace(/\s+/g, " ").slice(0, 160);
      throw new RemoteRejected(`知网没有给出文件${said ? `：${said}` : `（HTTP ${res.status}）`}`);
    }
    throw new BadResponse("知网下载跳转过多");
  }

  /** 把一篇文献的全文存到 dir，文件名与知网网页下载的一致（篇名_第一作者）。本地已有时直接复用。 */
  async save(paper: Paper, dir: string): Promise<SavedFile> {
    const base = safeName(paper.authors[0] ? `${paper.title}_${paper.authors[0]}` : paper.title);
    for (const format of ["pdf", "caj"] as const) {
      const have = await fs.promises.stat(path.join(dir, `${base}.${format}`)).catch(() => undefined);
      if (have?.isFile() && have.size > 0) return { path: path.join(dir, `${base}.${format}`), bytes: have.size, format, reused: true };
    }
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const open = async () => { const link = await this.fileLink(paper); return { link, res: await this.stream(link.url, paper.link, signal) }; };
    const { link, res } = await open().catch(async (error: unknown) => {
      // 登录是复用的而下载被带去登录页：重新 IP 登录，再取一次下载地址。刚登录过仍如此就是这篇确实要个人账号。
      if (!(error instanceof LoginRequired) || this.loggedInVia === this.via()) throw error;
      await this.login(true);
      return open();
    });
    const out = path.join(dir, `${base}.${link.format}`), temporary = `${out}.${crypto.randomUUID()}.part`;
    await fs.promises.mkdir(dir, { recursive: true });
    let bytes = 0;
    const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(null, chunk); } });
    try {
      await pipeline(Readable.fromWeb(res.body as never), counter, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      const advertised = res.headers.get("content-length");
      if (advertised && bytes !== Number(advertised)) throw new TransportError("知网文件下载不完整", { bytes, expected: Number(advertised) });
      if (!bytes) throw new BadResponse("知网返回了空文件");
      if (link.format === "pdf") {
        const file = await fs.promises.open(temporary, "r");
        const head = Buffer.alloc(5);
        try { await file.read(head, 0, 5, 0); } finally { await file.close(); }
        if (head.toString("latin1") !== "%PDF-") throw new BadResponse("知网返回的不是 PDF 文件");
      }
      await fs.promises.rename(temporary, out);
    } catch (err) {
      if (err instanceof ZjuError) throw err;
      throw new TransportError(`知网文件下载中断：${err instanceof Error ? err.message : String(err)}`, {}, err);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
    return { path: out, bytes, format: link.format, ...(link.format === "caj" ? { note: "知网没有提供这篇的 PDF，保存的是 CAJ 格式，要用 CAJViewer 打开" } : {}) };
  }
}

/** 给用户看的一行：不含内部链接 */
export function paperRow(p: Paper) {
  return { title: p.title, authors: p.authors.join("、"), source: p.source, date: p.date, type: p.type, cited: p.cited, downloads: p.downloads };
}

export async function openCnki(): Promise<{ client: Cnki; close(): void }> {
  const ctx = await openContext(requirements, { timeout: 30_000 });
  const client = new Cnki(ctx);
  return { client, close: () => { client.close(); ctx.close(); } };
}
