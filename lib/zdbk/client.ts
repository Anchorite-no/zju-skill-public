/**
 * 本科教学管理信息服务平台（zdbk.zju.edu.cn，正方 jwglxt）。
 *
 * 声明：auth=cas network=public（公网可达，直连；2026-09-17 外部主机实测）。
 * 登录：zjuam.loginService("…/xtgl/login_ssologin.html") 回跳后拿到三个 path 下的 JSESSIONID（/jwglxt、/、/jwglxt/xtgl），
 *       CookieJar 按 path 区分。会话存 data/sessions/zdbk.json（TTL 2h；服务端 session 大约 30 分钟不动就失效，失效自动重登一次）。
 * 失效表现（2026-09-17 实测）：接口 HTTP 901 空体；页面 302 到 login_slogin / cas/login 且无 ticket；页面 body 含 id="loginForm"。
 * 规矩：功能模块 URL 必须带 ?gnmkdm=<模块码>&su=<学号>（通知页 gnmkdm=index 不需要 su）；jqGrid 列表都是 POST ?doType=query，
 *       表单 queryModel.showCount / queryModel.currentPage / queryModel.sortName / queryModel.sortOrder，响应 {items, totalResult, totalPage}。
 */
import type { ModuleRequirements } from "../core/module.ts";
import { openContext, type Context, type OpenOptions } from "../webvpn/transport.ts";
import { SessionStore } from "../zjuam/session.ts";
import { credentials } from "../profile/profile.ts";
import { AuthExpired, BadResponse, TransportError } from "../core/errors.ts";
import { log, debug } from "../core/output.ts";
import type { HttpResponse, RequestOptions } from "../core/http.ts";

export const ZDBK_HOST = "zdbk.zju.edu.cn";
export const BASE = `https://${ZDBK_HOST}/jwglxt`;
export const CAS_SERVICE = `${BASE}/xtgl/login_ssologin.html`;
export const SESSION_PROBE = `${BASE}/xtgl/index_initMenu.html?jsdm=06`;
const SESSION_TTL_MS = 2 * 3600 * 1000;

export const requirements: ModuleRequirements = {
  name: "zdbk",
  title: "本科教学管理信息服务平台（教务网）",
  hosts: [ZDBK_HOST],
  auth: "cas",
  network: "public",
  writes: true,
  casService: CAS_SERVICE,
  sessionProbe: SESSION_PROBE,
};

/** 功能模块码（URL 里的 gnmkdm） */
export const MODULE = {
  index: "index",
  /** 培养方案查询 */
  pyfa: "N153020",
  /** 学生课表查询 */
  kbcx: "N253508",
  /** 个人考试查询 */
  exams: "N509070",
  /** 自主选课 */
  xsxk: "N253530",
} as const;

export const XRW = { "X-Requested-With": "XMLHttpRequest" } as const;

/** jqGrid 分页响应外壳 */
export interface GridPage<T> {
  items: T[];
  totalResult: string | number;
  totalPage?: number;
  currentPage?: number;
  showCount?: number;
}

/** 正方 grid 每行都带的噪音字段，输出前去掉 */
const NOISE = ["queryModel", "userModel", "listnav", "localeKey", "pageable", "rangeable", "completeAnswer", "jgpxzd", "row_id", "totalResult"];
export function stripRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!NOISE.includes(k)) out[k] = v;
  return out;
}

export interface ZdbkOptions extends OpenOptions {
  /** 强制重新做 CAS 委托（丢弃 zdbk 会话缓存） */
  fresh?: boolean;
}

export class Zdbk {
  readonly ctx: Context;
  /** 学号（URL 的 su 参数） */
  readonly su: string;
  readonly store: SessionStore;
  private loginPromise: Promise<void> | undefined;
  private loggedIn = false;

  constructor(ctx: Context, su: string) {
    this.ctx = ctx;
    this.su = su;
    this.store = new SessionStore({ system: "zdbk", username: su, ttlMs: SESSION_TTL_MS });
    const cached = this.store.load();
    if (cached) {
      for (const c of cached.jar.cookies) if (c.domain === ZDBK_HOST) ctx.http.jar.put(c.name, c.value, c.domain, c.path, c.secure);
      this.loggedIn = cached.jar.cookies.some((c) => c.domain === ZDBK_HOST && c.name === "JSESSIONID");
      if (this.loggedIn) debug("zdbk: 复用缓存会话");
    }
  }

  /** 构造功能模块 URL：自动带 gnmkdm 与 su */
  url(path: string, module: string = MODULE.index, query: Record<string, string> = {}): string {
    const u = new URL(path.startsWith("http") ? path : `${BASE}/${path.replace(/^\//, "")}`);
    u.searchParams.set("gnmkdm", module);
    if (module !== MODULE.index) u.searchParams.set("su", this.su);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.href;
  }

  /** CAS 委托登录，拿 zdbk 自己的会话。并发合并。 */
  login(force = false): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.doLogin(force).finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private async doLogin(force: boolean): Promise<void> {
    if (this.loggedIn && !force) return;
    if (!this.ctx.zjuam) throw new AuthExpired("zjuam", "zdbk 需要统一身份认证上下文");
    // 两台机器短时间内交替登录时，回跳偶尔仍落在登录页（2026-10-03 实测，连续多次登录后更常见）；隔一会儿再走一次。
    let res: HttpResponse;
    for (let attempt = 1; ; attempt++) {
      this.ctx.http.jar.removeDomain(ZDBK_HOST);
      res = await this.ctx.zjuam.loginService(CAS_SERVICE);
      if (!isExpired(res) || attempt === 2) break;
      debug("zdbk: CAS 回跳后仍是登录页，稍后重试一次");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!this.ctx.http.jar.get("JSESSIONID", `${BASE}/xtgl/`)) throw new BadResponse("CAS 回跳后未获得教务网会话", { status: res.status, url: res.url });
    if (isExpired(res)) throw new AuthExpired("zdbk", "CAS 回跳后教务网仍要求登录");
    this.loggedIn = true;
    this.store.save(this.ctx.http.jar);
    log("教务网登录成功");
  }

  /** 发请求；会话失效自动重登一次再重放 */
  async request(url: string, opts: RequestOptions = {}, follow = false, retryAuth = true): Promise<HttpResponse> {
    await this.login();
    const once = () => (follow ? this.ctx.fetchFollow(url, opts) : this.ctx.fetch(url, opts));
    // 连接或 TLS 握手阶段断开时请求尚未发出，写请求也可以安全重发一次
    const send = () => once().catch((err: unknown) => {
      if (err instanceof TransportError && (err.detail["phase"] === "connect" || err.detail["phase"] === "tls")) return once();
      throw err;
    });
    let res = await send();
    // 922：同一账号在另一台机器登录后，这边被顶掉的会话收到的第一个响应。此时直接重新登录；
    // 再用旧会话发一次请求会让随后的登录回跳落回登录页（2026-10-03 本机与服务器交替实测）。
    if (isExpired(res) || res.status === 922) {
      debug(`zdbk: 会话失效（HTTP ${res.status}），重新登录`);
      this.loggedIn = false;
      if (!retryAuth) throw new AuthExpired("zdbk", "写请求会话失效，未自动重发；请回查选课记录");
      await this.login(true);
      res = await send();
      if (isExpired(res) || res.status === 922) throw new AuthExpired("zdbk");
    }
    return res;
  }

  get(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request(url, opts, true);
  }

  postForm(url: string, data: Record<string, string>, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request(url, { ...opts, method: "POST", body: new URLSearchParams(data).toString(), headers: { ...XRW, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", ...(opts.headers ?? {}) } });
  }

  /** 单次写请求：不跟随重定向、不在失效后重放，由业务层回查结果。 */
  postOnce(url: string, data: Record<string, string>, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request(url, { ...opts, method: "POST", body: new URLSearchParams(data).toString(), headers: { ...XRW, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", ...(opts.headers ?? {}) } }, false, false);
  }

  /** POST 表单并解析 JSON */
  async postJson<T>(url: string, data: Record<string, string>, opts: RequestOptions = {}): Promise<T> {
    const res = await this.postForm(url, data, opts);
    if (res.status !== 200) throw new TransportError(`教务网 HTTP ${res.status}`, { url: res.url.split("?")[0] });
    const j = res.json<T>();
    if (j === null) throw new BadResponse("教务网未返回 JSON", { url: res.url.split("?")[0], body: res.body.slice(0, 200) });
    return j;
  }

  /** jqGrid 分页查询；opts 原样交给请求（调用方要自己的超时时用） */
  async grid<T extends Record<string, unknown>>(url: string, form: Record<string, string>, page: { page?: number; size?: number; sort?: string; order?: "asc" | "desc" } = {}, opts: RequestOptions = {}): Promise<{ items: T[]; total: number; page: number; size: number; totalPages: number }> {
    const size = page.size ?? 15;
    const current = page.page ?? 1;
    const data: Record<string, string> = { ...form, "queryModel.showCount": String(size), "queryModel.currentPage": String(current), "queryModel.sortName": page.sort ?? "", "queryModel.sortOrder": page.order ?? "desc", time: "1" };
    const j = await this.postJson<GridPage<T>>(url.includes("doType=") ? url : url + (url.includes("?") ? "&" : "?") + "doType=query", data, opts);
    if (!Array.isArray(j.items)) throw new BadResponse("教务网列表响应缺少 items", { keys: Object.keys(j) });
    const total = Number(j.totalResult ?? j.items[0]?.["totalResult"] ?? j.items.length) || 0;
    return { items: j.items, total, page: current, size, totalPages: Math.max(1, Math.ceil(total / size)) };
  }

  /** 会话状态（不联网） */
  status(): { username: string; file: string; cached: boolean; ageMs?: number; expired?: boolean } {
    const s = this.store.status();
    const out: ReturnType<Zdbk["status"]> = { username: this.su, file: this.store.file, cached: s.exists && !s.expired };
    if (s.ageMs !== undefined) out.ageMs = s.ageMs;
    if (s.expired !== undefined) out.expired = s.expired;
    return out;
  }

  /** 真实探测：GET 菜单页 */
  async probe(): Promise<{ ok: boolean; status: number }> {
    const res = await this.ctx.fetch(SESSION_PROBE);
    return { ok: res.status === 200 && !/id=["']loginForm["']/i.test(res.body), status: res.status };
  }

  logout(): boolean {
    this.ctx.http.jar.removeDomain(ZDBK_HOST);
    this.loggedIn = false;
    return this.store.clear();
  }

  close(): void {
    this.ctx.close();
  }
}

/** 三条失效判据 */
export function isExpired(res: HttpResponse): boolean {
  if (res.status === 901) return true;
  if (res.isRedirect && /login_slogin|login_ssologin|\/cas\/login/.test(res.location ?? "") && !/[?&]ticket=/.test(res.location ?? "")) return true;
  if (res.status === 200 && /id=["']loginForm["']/i.test(res.body)) return true;
  return false;
}

/** 组装：CAS 上下文 + zdbk 会话（复用缓存，不主动探测；请求失效时自动重登） */
export async function openZdbk(opts: ZdbkOptions = {}): Promise<Zdbk> {
  const su = credentials().username;
  const ctx = await openContext(requirements, opts);
  const z = new Zdbk(ctx, su);
  if (opts.fresh) z.logout();
  return z;
}
