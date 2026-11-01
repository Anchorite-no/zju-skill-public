import { CookieJar, type HttpResponse } from "../core/http.ts";
import { AuthExpired, BadResponse, ConfigError, RemoteRejected } from "../core/errors.ts";
import { openContext, type Context, type OpenOptions } from "../webvpn/transport.ts";
import { SessionStore } from "../zjuam/session.ts";
import { credentials } from "../profile/profile.ts";
import type { ModuleRequirements } from "../core/module.ts";
import type { JsonObject } from "./types.ts";

export const BASE = "https://classroom.zju.edu.cn";
export const API = "https://yjapi.cmc.zju.edu.cn";
export const MY_COURSES = "https://education.cmc.zju.edu.cn/personal/courseapi/vlabpassportapi/v1/account-profile/course";
const LOGIN = "https://tgmedia.cmc.zju.edu.cn/index.php?r=auth%2Flogin&forward=https%3A%2F%2Fclassroom.zju.edu.cn%2F";
const HOSTS = new Set(["classroom.zju.edu.cn", "yjapi.cmc.zju.edu.cn", "education.cmc.zju.edu.cn", "tgmedia.cmc.zju.edu.cn"]);
const AUTH_HOSTS = new Set([...HOSTS, "zjuam.zju.edu.cn"]);
// The portal sets these at .zju.edu.cn; do not persist the unrelated CAS cookies.
const OWN_COOKIES = new Set(["JWTUser", "_token", "login_cmc_id", "login_cmc_tid", "group_code", "login_cmc_url", "login_cmc_type", "cmc_version", "tenant_code"]);
export const requirements: ModuleRequirements = { name: "zhiyun", title: "智云课堂", hosts: [...HOSTS], auth: "cas", network: "public", writes: false };

export function object(value: unknown, label = "响应"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadResponse(`${label}不是对象`);
  return value as JsonObject;
}
export function id(value: unknown, label = "ID"): string {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new ConfigError(`${label}必须是正整数`);
  return String(value);
}
export function jsonContent(value: unknown): JsonObject {
  if (value === null || value === undefined || value === "") return {};
  if (typeof value !== "string") return object(value, "content");
  try { return object(JSON.parse(value), "content"); } catch { throw new BadResponse("课次 content JSON 无效"); }
}
export function session(username: string) { return new SessionStore({ system: "zhiyun", username, ttlMs: 12 * 3600_000 }); }
export function tokenFromCookie(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return undefined; }
  return decoded.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0];
}
function expired(r: HttpResponse): boolean {
  const j = r.json<JsonObject>();
  return r.status === 401 || j?.code === 401 || (r.isRedirect && /\/cas\/|auth%2[fF]login|auth\/login/.test(r.location!)) || /^\s*<(?:!doctype|html)/i.test(r.body);
}
export class Zhiyun {
  readonly ctx: Context;
  readonly username: string;
  readonly store: SessionStore;
  private loggedIn = false;
  private pending: Promise<void> | undefined;
  private generation = 0;
  constructor(ctx: Context, username: string) {
    this.ctx = ctx; this.username = username; this.store = session(username);
    const saved = this.store.load();
    if (saved) {
      for (const c of saved.jar.cookies.filter(c => OWN_COOKIES.has(c.name) && (c.domain === "zju.edu.cn" || HOSTS.has(c.domain)))) {
        ctx.http.jar.removeWhere(x => x.name === c.name && x.domain === c.domain && x.path === c.path);
        ctx.http.jar.cookies.push({ ...c });
      }
      this.loggedIn = !!ctx.http.jar.get("JWTUser", BASE);
    }
  }
  login(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (this.loggedIn && !force) return Promise.resolve();
    // Keep a failed promise: invalid credentials must not trigger parallel retries.
    this.pending = this.doLogin().then(() => { this.pending = undefined; this.generation++; });
    return this.pending;
  }
  private async doLogin(): Promise<void> {
    this.loggedIn = false;
    this.ctx.http.jar.removeWhere(c => OWN_COOKIES.has(c.name));
    let url = LOGIN;
    for (let hop = 0; hop < 20; hop++) {
      const u = new URL(url);
      if (u.protocol !== "https:" || !AUTH_HOSTS.has(u.hostname)) throw new BadResponse("智云认证跳转到未知站点", { host: u.hostname });
      if (u.hostname === "zjuam.zju.edu.cn" && u.pathname === "/cas/login") {
        const service = u.searchParams.get("service");
        if (!service || !this.ctx.zjuam) throw new AuthExpired("zhiyun");
        const target = new URL(service);
        // CAS advertises its own callbackAuthorize service over HTTP. The service
        // identifier must remain exact; the returned callback is requested over TLS.
        const legacyCallback = target.protocol === "http:" && target.hostname === "zjuam.zju.edu.cn" && target.pathname === "/cas/oauth2.0/callbackAuthorize";
        if ((!legacyCallback && target.protocol !== "https:") || !AUTH_HOSTS.has(target.hostname)) throw new BadResponse("智云 CAS service 无效");
        const callback = new URL(await this.ctx.zjuam.service(service));
        if (legacyCallback && callback.hostname === "zjuam.zju.edu.cn") callback.protocol = "https:";
        url = callback.href; continue;
      }
      const res = await this.ctx.fetch(url);
      if (res.isRedirect) { url = new URL(res.location!, url).href; continue; }
      const meta = res.body.match(/<meta\b[^>]*http-equiv=["']refresh["'][^>]*content=["']\d+;\s*URL=([^"']+)/i);
      if (meta) { url = new URL(meta[1]!.replaceAll("&amp;", "&"), url).href; continue; }
      if (res.status !== 200 || u.hostname !== "classroom.zju.edu.cn" || !this.ctx.http.jar.get("JWTUser", BASE)) throw new AuthExpired("zhiyun", "智云登录未取得用户会话");
      this.loggedIn = true;
      this.store.save(new CookieJar(this.ctx.http.jar.cookies.filter(c => OWN_COOKIES.has(c.name) && (c.domain === "zju.edu.cn" || HOSTS.has(c.domain)))));
      return;
    }
    throw new BadResponse("智云登录跳转超过 20 次");
  }
  async user(): Promise<{ id: string; account: string; tenantId: string }> {
    await this.login();
    try {
      const u = object(JSON.parse(decodeURIComponent(this.ctx.http.jar.get("JWTUser", BASE)!)));
      if (!u.account) throw new Error();
      return { id: id(u.id), account: String(u.account), tenantId: id(u.tenant_id) };
    } catch { throw new AuthExpired("zhiyun", "智云用户 Cookie 无效"); }
  }
  async json(url: string, query: Record<string, string | number> = {}, referer = BASE + "/"): Promise<JsonObject> {
    const u = new URL(url, BASE);
    if (u.protocol !== "https:" || !HOSTS.has(u.hostname)) throw new ConfigError("智云 API 目标无效");
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    await this.login();
    const sent = this.generation;
    const send = () => {
      const token = tokenFromCookie(this.ctx.http.jar.get("_token", BASE));
      return this.ctx.fetch(u.href, { headers: { Accept: "application/json", Referer: referer, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    };
    let res = await send();
    if (expired(res)) { if (sent === this.generation) await this.login(true); res = await send(); if (expired(res)) throw new AuthExpired("zhiyun"); }
    const data = res.json(); // Some subtitle responses claim text/html.
    if (res.status < 200 || res.status >= 300) throw new RemoteRejected(`智云 HTTP ${res.status}`, { path: u.pathname });
    const j = object(data);
    if (j.success === false || (j.code !== undefined && ![0, 200, 1000].includes(Number(j.code)))) throw new RemoteRejected(`智云拒绝：${String(j.msg ?? j.message ?? j.code)}`);
    return j;
  }
  close() { this.ctx.close(); }
}
export async function openZhiyun(opts: OpenOptions = {}): Promise<Zhiyun> {
  const ctx = await openContext(requirements, opts);
  const client = new Zhiyun(ctx, credentials().username);
  try { await client.login(opts.fresh ?? false); return client; } catch (e) { client.close(); throw e; }
}
