import type { ModuleRequirements } from "../core/module.ts";
import { openContext, type Context, type OpenOptions } from "../webvpn/transport.ts";
import { CookieJar, type HttpResponse, type RequestOptions } from "../core/http.ts";
import { AuthExpired, BadResponse, ConfigError, RemoteRejected } from "../core/errors.ts";
import { SessionStore } from "../zjuam/session.ts";
import { decodeEntities } from "../core/html.ts";
import type { Page } from "./types.ts";

export const BASE = "https://courses.zju.edu.cn";
export const HOST = "courses.zju.edu.cn";
export const requirements: ModuleRequirements = { name: "xuezai", title: "学在浙大", hosts: [HOST], auth: "cas", network: "public", writes: true };
const SESSION_TTL = 12 * 3600_000;
const AUTH_HOSTS = new Set([HOST, "identity.zju.edu.cn", "zjuam.zju.edu.cn"]);

export function id(value: number | string, label = "ID"): string {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new ConfigError(`${label} 必须是正整数`);
  return String(value);
}

export function metaRefresh(html: string): string | undefined {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/http-equiv\s*=\s*["']refresh["']/i.test(m[0])) continue;
    const content = m[0].match(/content\s*=\s*(["'])(.*?)\1/i)?.[2];
    const target = content?.match(/\burl\s*=\s*(.*)/i)?.[1]?.replace(/^["']|["']$/g, "");
    if (target) return decodeEntities(target);
  }
  return undefined;
}

export function currentUserId(html: string): number | undefined {
  // 当前页面模板给附件操作组件注入自己的 userId；不从其他用户的活动记录推断。
  const ids = [...html.matchAll(/\bng-init\s*=\s*["']\s*userId\s*=\s*(\d+)\s*;?\s*["']/g)].map((m) => Number(m[1]));
  const unique = [...new Set(ids)];
  return unique.length === 1 && Number.isSafeInteger(unique[0]) && unique[0]! > 0 ? unique[0] : undefined;
}

export function isExpired(res: HttpResponse): boolean {
  if (res.status === 401) return true;
  if (res.isRedirect) {
    const u = new URL(res.location!, res.url);
    return AUTH_HOSTS.has(u.hostname) && (/\/cas\/login|\/auth\/realms\/|\/user\/index|\/login/.test(u.pathname));
  }
  return res.contentType.includes("text/html") && /name=["']execution["']|\/cas\/login\?service=/.test(res.body);
}

export function xuezaiSession(username: string): SessionStore {
  return new SessionStore({ system: "xuezai", username, ttlMs: SESSION_TTL });
}

export class Xuezai {
  readonly ctx: Context;
  readonly username: string;
  readonly store: SessionStore;
  /** 原生 fetch 用于文件下载与签名上传；可以注入离线测试实现。 */
  readonly transfer: typeof fetch;
  private loggedIn = false;
  private loginPromise: Promise<void> | undefined;
  private userId: number | undefined;

  constructor(ctx: Context, transfer: typeof fetch = globalThis.fetch) {
    if (!ctx.zjuam) throw new ConfigError("学在客户端需要已组装的 CAS 组件");
    this.ctx = ctx; this.username = ctx.zjuam.username; this.transfer = transfer;
    this.store = xuezaiSession(this.username);
    const cached = this.store.load();
    if (cached) {
      const cookies = cached.jar.cookies.filter((c) => c.domain === HOST || c.domain === "identity.zju.edu.cn");
      for (const cookie of cookies) {
        ctx.http.jar.removeWhere((c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path);
        ctx.http.jar.cookies.push({ ...cookie });
      }
      this.loggedIn = cookies.some((c) => c.domain === HOST && (c.expires === null || c.expires > Date.now()));
      if (typeof cached.extra.userId === "number") this.userId = cached.extra.userId;
    }
  }

  /** 内部站点会话适配；认证只委托给 ctx.zjuam，不读取密码或自行提交 CAS 表单。 */
  private ensureSession(force = false): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.establishSession(force).finally(() => { this.loginPromise = undefined; });
    return this.loginPromise;
  }

  private async establishSession(force: boolean): Promise<void> {
    if (this.loggedIn && !force) return;
    this.loggedIn = false;
    if (force) { this.ctx.http.jar.removeDomain(HOST); this.userId = undefined; }
    let url = BASE + "/user/index";
    for (let hop = 0; hop < 20; hop++) {
      const target = new URL(url);
      if (target.protocol !== "https:" || !AUTH_HOSTS.has(target.hostname)) throw new BadResponse("学在浙大登录跳转到了未知站点", { host: target.hostname });
      if (target.hostname === "zjuam.zju.edu.cn" && target.pathname === "/cas/login") {
        const service = target.searchParams.get("service");
        if (!service || !this.ctx.zjuam) throw new AuthExpired("xuezai", "登录链缺少 CAS service 或认证上下文");
        const serviceUrl = new URL(service);
        if (serviceUrl.protocol !== "https:" || !AUTH_HOSTS.has(serviceUrl.hostname)) throw new BadResponse("CAS service 目标无效");
        url = await this.ctx.zjuam.service(service);
        continue;
      }
      const response = await this.ctx.fetch(url);
      if (response.isRedirect) { url = new URL(response.location!, url).href; continue; }
      const refresh = metaRefresh(response.body);
      if (refresh) { url = new URL(refresh, url).href; continue; }
      if (response.status !== 200 || target.hostname !== HOST) throw new AuthExpired("xuezai", `学在浙大登录未完成（HTTP ${response.status}）`);
      this.userId = currentUserId(response.body);
      const probe = await this.ctx.fetch(BASE + "/api/my-semesters?fields=id");
      if (probe.status !== 200 || !Array.isArray(probe.json<{ semesters?: unknown }>()?.semesters)) throw new AuthExpired("xuezai", "登录后课程接口仍不可用");
      this.loggedIn = true;
      this.saveSession();
      return;
    }
    throw new BadResponse("学在浙大登录跳转超过 20 次");
  }

  private saveSession(): void {
    const jar = new CookieJar(this.ctx.http.jar.cookies.filter((c) => c.domain === HOST || c.domain === "identity.zju.edu.cn"));
    this.store.save(jar, this.userId === undefined ? {} : { userId: this.userId });
  }

  async me(): Promise<{ id: number; username: string }> {
    await this.ensureSession();
    if (!this.userId) {
      const page = await this.request("/user/index");
      this.userId = currentUserId(page.body);
      if (!this.userId) throw new BadResponse("页面未提供当前用户 ID，无法定位本人作业提交记录");
      this.saveSession();
    }
    return { id: this.userId, username: this.username };
  }

  url(route: string): string {
    const url = new URL(route, BASE);
    if (url.origin !== BASE) throw new ConfigError("学在浙大 API 路径必须属于 courses.zju.edu.cn");
    return url.href;
  }

  async request(route: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    const url = this.url(route);
    await this.ensureSession();
    const send = () => {
      const csrf = this.ctx.http.jar.get("XSRF-TOKEN", BASE + "/");
      return this.ctx.fetch(url, { ...opts, headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", Referer: BASE + "/user/index", ...(csrf ? { "X-XSRF-TOKEN": decodeURIComponent(csrf) } : {}), ...(opts.headers ?? {}) } });
    };
    let response = await send();
    if (isExpired(response)) {
      this.loggedIn = false;
      if (!["GET", "HEAD"].includes((opts.method ?? "GET").toUpperCase())) throw new AuthExpired("xuezai", "会话失效；写请求未自动重放，请查询提交记录后再操作");
      await this.ensureSession(true);
      response = await send();
      if (isExpired(response)) throw new AuthExpired("xuezai");
    }
    return response;
  }

  async json<T>(route: string, opts: RequestOptions = {}): Promise<T> {
    const response = await this.request(route, opts);
    const data = response.json<T>();
    if (response.status < 200 || response.status >= 300) {
      const message = (data as Record<string, unknown> | null)?.message;
      throw new RemoteRejected(`学在浙大 HTTP ${response.status}${typeof message === "string" ? `：${message}` : ""}`, { path: new URL(response.url).pathname, status: response.status });
    }
    if (data === null) throw new BadResponse("学在浙大接口未返回 JSON", { path: new URL(response.url).pathname, status: response.status });
    return data;
  }

  post<T>(route: string, body: unknown, method = "POST"): Promise<T> {
    return this.json<T>(route, { method, headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body) });
  }

  async page<T>(route: string, key: string, page = 1, pageSize = 50): Promise<Page<T>> {
    if (![page, pageSize].every((n) => Number.isSafeInteger(n) && n > 0)) throw new ConfigError("page / pageSize 必须是正整数");
    const url = new URL(this.url(route)); url.searchParams.set("page", String(page)); url.searchParams.set("page_size", String(pageSize));
    const data = await this.json<Record<string, unknown>>(url.href);
    if (!Array.isArray(data[key])) throw new BadResponse(`列表响应缺少 ${key}`, { keys: Object.keys(data) });
    const items = data[key] as T[];
    const pages = Number(data.pages ?? 1); const total = Number(data.total ?? items.length);
    if (!Number.isSafeInteger(pages) || pages < 0 || !Number.isFinite(total) || total < 0) throw new BadResponse("列表分页字段无效");
    return { items, page, pageSize, pages, total };
  }

  async all<T>(route: string, key: string, pageSize = 50): Promise<T[]> {
    const first = await this.page<T>(route, key, 1, pageSize);
    const items = [...first.items];
    if (first.pages > 10000) throw new BadResponse("分页数量异常", { pages: first.pages });
    for (let p = 2; p <= first.pages; p++) items.push(...(await this.page<T>(route, key, p, pageSize)).items);
    return items;
  }

  /**
   * 文件在 tcmedia 上的签名下载地址：不带 Cookie，可以重复请求，支持 Range。
   * `/blob` 跳转给的地址带 nonce，只能请求一次，分不了块，所以不用。
   */
  async fileUrl(uploadId: number | string): Promise<string> {
    const { url } = await this.json<{ url?: unknown }>(`/api/uploads/${id(uploadId)}/url`);
    if (typeof url !== "string" || !url.startsWith("https://")) throw new BadResponse("学在浙大没有给出文件的下载地址");
    return url;
  }

  logout(): boolean { this.loggedIn = false; this.userId = undefined; this.ctx.http.jar.removeDomain(HOST); return this.store.clear(); }
  close(): void { this.ctx.close(); }
}

export async function openXuezai(opts: OpenOptions = {}): Promise<Xuezai> {
  const ctx = await openContext(requirements, opts);
  try {
    const client = new Xuezai(ctx);
    if (opts.fresh) client.logout();
    return client;
  } catch (error) { ctx.close(); throw error; }
}
