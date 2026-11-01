/**
 * 超星学习通（泛雅）客户端：手机号密码登录、Cookie 会话缓存、被带去登录页时重登一次。
 * 请求、端点和协议上的坑见 README.md。
 */
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CookieJar, type HttpResponse } from "../core/http.ts";
import { AuthExpired, BadResponse, NeedsUser, RateLimited, RemoteRejected } from "../core/errors.ts";
import { log } from "../core/output.ts";
import type { ModuleRequirements } from "../core/module.ts";
import { chaoxingCredentials, profilePath, readProfile } from "../profile/profile.ts";
import { SessionStore } from "../zjuam/session.ts";
import { openContext, type Context } from "../webvpn/transport.ts";

export const PASSPORT = "https://passport2.chaoxing.com";
export const MOOC1 = "https://mooc1.chaoxing.com";
export const MOOC2 = "https://mooc2-ans.chaoxing.com";
export const API = "https://mooc1-api.chaoxing.com";
export const requirements: ModuleRequirements = { name: "chaoxing", title: "超星学习通", hosts: ["chaoxing.com"], auth: "own", network: "public", writes: false, sessionProbe: `${API}/mycourse/backclazzdata?view=json&rss=1` };

/** 登录页 login.js 里的 transferKey，既是密钥也是 IV（AES-128-CBC，PKCS7，Base64）。 */
const LOGIN_KEY = "u2oh6Vu^HWe4_AES";
/** 请求排队，间隔不小于这个值：超星对密集请求会要验证码。 */
const GAP_MS = 150;

export function sessionStore(username = readProfile().chaoxing_username ?? "") {
  return new SessionStore({ system: "chaoxing", username, ttlMs: 30 * 24 * 3600 * 1000 });
}

function encrypt(text: string): string {
  const cipher = crypto.createCipheriv("aes-128-cbc", LOGIN_KEY, LOGIN_KEY);
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

const isLogin = (u: URL) => u.hostname === "passport2.chaoxing.com" && /^\/(?:[mw]?login|fanyalogin)/.test(u.pathname);
const isVerify = (u: URL) => /antispider|processVerify/i.test(u.pathname);

export interface Page { url: string; status: number; body: string }
interface Init { method?: string; body?: string; referer?: string; headers?: Record<string, string> }

export class Chaoxing {
  readonly username: string;
  readonly store: SessionStore;
  private readonly password: string;
  private readonly ctx: Context;
  private ready: Promise<void> | undefined;
  private refresh: Promise<void> | undefined;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(ctx: Context, credentials: { username: string; password: string }) {
    this.ctx = ctx; this.username = credentials.username; this.password = credentials.password;
    this.store = sessionStore(this.username);
    const saved = this.store.load();
    if (saved) ctx.http.jar = saved.jar;
  }

  private cookie(name: string) { return this.ctx.http.jar.get(name, `${MOOC1}/`); }
  get uid(): string { return this.cookie("_uid") ?? this.cookie("UID") ?? ""; }
  /** 账号所在单位编号，文件状态接口要用。 */
  get fid(): string { return this.cookie("fid") ?? ""; }
  /** 下载器访问超星自己的主机时带上会话 Cookie；文件 CDN 不需要。 */
  cookieHeader(url: string): string { return this.ctx.http.jar.getCookieHeader(url); }

  private send(url: string, init: Init): Promise<HttpResponse> {
    const request = this.queue.then(async () => {
      const wait = GAP_MS - (Date.now() - this.lastRequestAt);
      if (wait > 0) await delay(wait);
      this.lastRequestAt = Date.now();
      const headers = { ...(init.referer ? { Referer: init.referer } : {}), ...(init.headers ?? {}) };
      return this.ctx.fetch(url, { ...(init.method ? { method: init.method } : {}), ...(init.body === undefined ? {} : { body: init.body }), headers });
    });
    this.queue = request.catch(() => undefined);
    return request;
  }

  login(fresh = false): Promise<void> {
    // 失败的 promise 保留，同一客户端不会反复提交错误密码。
    return this.ready ??= this.resolveLogin(fresh);
  }

  private async resolveLogin(fresh: boolean): Promise<void> {
    if (!fresh && this.uid) return;
    this.ctx.http.jar = new CookieJar();
    const form = new URLSearchParams({
      fid: "-1", uname: encrypt(this.username), password: encrypt(this.password), refer: "https%3A%2F%2Fi.chaoxing.com", t: "true",
      forbidotherlogin: "0", validate: "", doubleFactorLogin: "0", independentId: "0", independentNameId: "0",
    });
    const res = await this.send(`${PASSPORT}/fanyalogin`, {
      method: "POST", body: form.toString(), referer: `${PASSPORT}/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com`,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Origin: PASSPORT },
    });
    const data = res.json<{ status?: boolean; msg2?: string; mes?: string; containTwoFactorLogin?: boolean }>();
    if (!data || typeof data !== "object") throw new BadResponse(`超星登录返回非 JSON（HTTP ${res.status}）`, { status: res.status });
    const hint = `检查 ${profilePath()} 里的 chaoxing_username / chaoxing_password；要求验证码或二次验证时先在浏览器里正常登录一次，不要反复尝试`;
    if (data.containTwoFactorLogin) throw new NeedsUser("超星登录需要二次验证", hint);
    if (!data.status) throw new NeedsUser(`超星登录失败：${data.msg2 || data.mes || "平台没有给出原因"}`, hint);
    if (!this.uid) throw new BadResponse("超星登录成功但没有拿到会话 Cookie");
    this.generation++; this.save(); log("超星：登录成功");
  }

  private save() { this.store.save(this.ctx.http.jar); }

  /** 跟随跳转（平台常给 http 地址，统一换成 https）；被带到登录页或验证码页时抛出。 */
  private async follow(url: string, init: Init): Promise<Page> {
    let current = url, next = init;
    for (let hop = 0; hop < 10; hop++) {
      const res = await this.send(current, next);
      const target = res.isRedirect ? new URL(res.location!, current) : undefined;
      if (target?.hostname.endsWith("chaoxing.com")) target.protocol = "https:";
      const at = target ?? new URL(current);
      if (isLogin(at)) throw new AuthExpired("chaoxing");
      if (isVerify(at) || /antispiderShowVerify/.test(res.body.slice(0, 4000))) throw new RateLimited("超星要求输入验证码（请求过于频繁），过几分钟再试", 300_000);
      if (!target) return { url: current, status: res.status, body: res.body };
      current = target.href;
      next = { ...(init.referer ? { referer: init.referer } : {}) };
    }
    throw new BadResponse("超星跳转次数过多", { url });
  }

  /** 先保证已登录；会话在服务端失效时重登一次再做。 */
  private async authed<T>(run: () => Promise<T>): Promise<T> {
    await this.login();
    const generation = this.generation;
    try { return await run(); }
    catch (error) {
      if (!(error instanceof AuthExpired)) throw error;
      if (generation === this.generation) await (this.refresh ??= this.resolveLogin(true));
      return run();
    }
  }

  /** 页面或片段的 HTML。 */
  page(url: string, init: Init = {}): Promise<Page> {
    return this.authed(async () => {
      const page = await this.follow(url, init);
      if (page.status >= 400) throw new RemoteRejected(`超星请求被拒绝（HTTP ${page.status}）`, { path: new URL(page.url).pathname });
      this.save();
      return page;
    });
  }

  /** JSON 接口；未登录时接口用 200 + 提示文字表示。 */
  json<T extends object>(url: string, init: Init = {}): Promise<T> {
    return this.authed(async () => {
      const page = await this.follow(url, init);
      let data: unknown;
      try { data = JSON.parse(page.body); } catch { /* 下面统一报错 */ }
      if (!data || typeof data !== "object") {
        if (/passport2\.chaoxing\.com|用户登录/.test(page.body.slice(0, 4000))) throw new AuthExpired("chaoxing");
        if (page.status === 404) throw new RemoteRejected("超星上没有这个资源，可能已被删除");
        throw new BadResponse(`超星返回非 JSON（HTTP ${page.status}）`, { path: new URL(page.url).pathname, snippet: page.body.slice(0, 160) });
      }
      const message = String((data as { msg?: unknown; errorMsg?: unknown }).errorMsg ?? (data as { msg?: unknown }).msg ?? "");
      if (/重新登录|请先登录|未登录/.test(message)) throw new AuthExpired("chaoxing");
      this.save();
      return data as T;
    });
  }

  /** 不跟随跳转，只取跳转目标：资料下载接口 302 到带签名的文件地址。 */
  redirect(url: string, referer: string): Promise<string> {
    return this.authed(async () => {
      const res = await this.send(url, { referer });
      const target = res.isRedirect ? new URL(res.location!, url) : undefined;
      if (target && isLogin(target)) throw new AuthExpired("chaoxing");
      if (!target) throw new RemoteRejected("超星没有给出文件地址，老师可能没有开放下载", { status: res.status, snippet: res.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) });
      return target.href;
    });
  }

  async me() {
    await this.login();
    return { username: this.username, uid: this.uid, sessionFile: this.store.file };
  }

  close() { this.ctx.close(); }
}

export async function openChaoxing(): Promise<Chaoxing> {
  return new Chaoxing(await openContext(requirements, { timeout: 20000 }), chaoxingCredentials());
}
