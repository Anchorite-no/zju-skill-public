/**
 * WebVPN（webvpn.zju.edu.cn，深信服 wrdvpn）。
 *
 * 登录：GET /login 取 _csrf / captcha_id / 页内 encrypt(pwd,"key","iv") 的 AES key+iv →
 *       AES-128-CFB 加密密码，提交 hex(iv)+hex(ct) → POST /do-login；返回 NEED_CONFIRM 再 POST /do-confirm-login。
 * 有效性：cookie wengine_vpn_ticketwebvpn_zju_edu_cn 存在。
 * URL 重写：https://<host>/<path> → https://webvpn.zju.edu.cn/https/<enc(host)>/<path>?vpn-12-o2-<host>
 *   enc(host) = hex(IV) + hex(AES-128-CFB(host, key=iv="wrdvpnisthebest!"))
 *
 * 移植自 cc98-autosign-fast/src/webvpn.go；编码器为本项目新增（已用旧常量反解验证）。
 */
import crypto from "node:crypto";
import { HttpClient, CookieJar, type Cookie, type HttpResponse } from "../core/http.ts";
import { NeedsUser, BadResponse, TransportError } from "../core/errors.ts";
import { log, debug } from "../core/output.ts";
import { SessionStore } from "../zjuam/session.ts";
import type { ModuleRequirements } from "../core/module.ts";

export const WEBVPN_BASE = "https://webvpn.zju.edu.cn";
export const WEBVPN_HOST = "webvpn.zju.edu.cn";
export const TICKET_COOKIE = "wengine_vpn_ticketwebvpn_zju_edu_cn";
const WRD_KEY = "wrdvpnisthebest!";

export const requirements: ModuleRequirements = {
  name: "webvpn",
  title: "WebVPN",
  hosts: [WEBVPN_HOST],
  auth: "own",
  network: "public",
  writes: false,
  sessionProbe: `${WEBVPN_BASE}/`,
};

// ---------- 编码器 ----------

function aesCfbEncrypt(plain: Buffer, key: Buffer, iv: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-cfb", key, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function aesCfbDecrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  const d = crypto.createDecipheriv("aes-128-cfb", key, iv);
  return Buffer.concat([d.update(data), d.final()]);
}

/** WebVPN 登录密码加密：hex(iv) + hex(AES-128-CFB(pwd)) */
export function encryptPassword(password: string, key: string, iv: string): string {
  const k = Buffer.from(key, "utf8");
  const i = Buffer.from(iv, "utf8");
  if (k.length !== 16 || i.length !== 16) throw new BadResponse("WebVPN 登录页 AES key/iv 长度异常");
  return i.toString("hex") + aesCfbEncrypt(Buffer.from(password, "utf8"), k, i).toString("hex");
}

/** 主机名编码：hex(IV) + hex(AES-128-CFB(host))，key = iv = "wrdvpnisthebest!" */
export function encodeHost(host: string): string {
  const k = Buffer.from(WRD_KEY, "utf8");
  return k.toString("hex") + aesCfbEncrypt(Buffer.from(host.toLowerCase(), "utf8"), k, k).toString("hex");
}

export function decodeHost(encoded: string): string {
  const k = Buffer.from(WRD_KEY, "utf8");
  const prefix = k.toString("hex");
  if (!encoded.startsWith(prefix)) throw new BadResponse("不是 wrdvpn 编码的主机名");
  return aesCfbDecrypt(Buffer.from(encoded.slice(prefix.length), "hex"), k, k).toString("utf8");
}

/** 把真实 URL 改写为 WebVPN URL。已经是 WebVPN URL 则原样返回。 */
export function rewriteUrl(realUrl: string): string {
  const u = new URL(realUrl);
  if (u.hostname === WEBVPN_HOST) return realUrl;
  const scheme = u.protocol.replace(":", "");
  const port = u.port ? `-${u.port}` : "";
  const path = u.pathname + u.search;
  const sep = u.search ? "&" : "?";
  return `${WEBVPN_BASE}/${scheme}${port}/${encodeHost(u.hostname)}${path}${sep}vpn-12-o2-${u.hostname}`;
}

/** 反向：WebVPN URL → 真实 URL（用于解析响应里的 Location） */
export function unwrapUrl(vpnUrl: string): string {
  const u = new URL(vpnUrl);
  if (u.hostname !== WEBVPN_HOST) return vpnUrl;
  const m = u.pathname.match(/^\/(https?)(?:-(\d+))?\/([0-9a-f]+)(\/.*)?$/i);
  if (!m) return vpnUrl;
  const [, scheme, port, enc, rest] = m;
  const host = decodeHost(enc!);
  const search = u.search.replace(/[?&]vpn-12-o2-[^&]*/g, "").replace(/^&/, "?");
  return `${scheme}://${host}${port ? ":" + port : ""}${rest ?? "/"}${search}`;
}

// ---------- 登录 ----------

interface LoginFields {
  csrf: string;
  captchaId: string;
  key: string;
  iv: string;
}

export function parseLoginPage(html: string): LoginFields {
  const csrf = html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  const captchaId = html.match(/name="captcha_id"\s+value="([^"]+)"/)?.[1];
  const kv = html.match(/encrypt\s*\([^,]+,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/);
  if (!csrf || !captchaId || !kv?.[1] || !kv[2]) throw new BadResponse("WebVPN 登录页缺少 _csrf / captcha_id / AES key");
  return { csrf, captchaId, key: kv[1], iv: kv[2] };
}

/** 会话文件只存取网关自己的 cookie；共用 jar 里其他站点的（统一认证等）归各自的会话文件 */
const own = (c: Cookie) => c.domain === WEBVPN_HOST;

export interface WebvpnOptions {
  username: string;
  password: string;
  http: HttpClient;
  ttlMs?: number;
}

export class Webvpn {
  readonly username: string;
  private readonly password: string;
  readonly http: HttpClient;
  readonly store: SessionStore;
  private loginPromise: Promise<{ reused: boolean }> | undefined;

  constructor(opts: WebvpnOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.http = opts.http;
    this.store = new SessionStore({ system: "webvpn", username: opts.username, ttlMs: opts.ttlMs ?? 6 * 3600 * 1000 });
    const cached = this.store.load();
    if (cached) for (const c of cached.jar.cookies.filter(own)) this.http.jar.put(c.name, c.value, c.domain, c.path, c.secure);
  }

  private save(): void {
    this.store.save(new CookieJar(this.http.jar.cookies.filter(own)));
  }

  get hasTicket(): boolean {
    return !!this.http.jar.get(TICKET_COOKIE, WEBVPN_BASE + "/");
  }

  /** ticket 是否仍被服务端接受：GET / 不跳到 /login 即有效 */
  async probe(): Promise<boolean> {
    if (!this.hasTicket) return false;
    const res = await this.http.request(`${WEBVPN_BASE}/`);
    if (res.status === 200 && !/name="_csrf"/.test(res.body)) return true;
    if (res.isRedirect && !/\/login/.test(res.location ?? "")) return true;
    return false;
  }

  login(force = false): Promise<{ reused: boolean }> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.doLogin(force).finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private async doLogin(force: boolean): Promise<{ reused: boolean }> {
    if (!force && (await this.probe())) {
      debug("webvpn: ticket 仍有效，复用");
      return { reused: true };
    }
    this.http.jar.removeDomain(WEBVPN_HOST);
    const page = await this.http.requestFollow(`${WEBVPN_BASE}/login`);
    if (page.status !== 200) throw new TransportError(`WebVPN 登录页 HTTP ${page.status}`);
    const f = parseLoginPage(page.body);
    const form: Record<string, string> = {
      _csrf: f.csrf,
      auth_type: "local",
      username: this.username,
      sms_code: "",
      password: encryptPassword(this.password, f.key, f.iv),
      captcha: "",
      needCaptcha: "false",
      captcha_id: f.captchaId,
    };
    const headers = { Accept: "application/json, text/plain, */*", Referer: `${WEBVPN_BASE}/login`, Origin: WEBVPN_BASE };
    let res = await this.http.postForm(`${WEBVPN_BASE}/do-login`, form, { headers });
    const payload = res.json<{ error?: string; message?: string }>() ?? {};
    if (payload.error === "NEED_CONFIRM") {
      res = await this.http.postForm(`${WEBVPN_BASE}/do-confirm-login`, form, { headers });
    } else if (payload.error) {
      const msg = payload.message || payload.error;
      if (/captcha|验证码/i.test(msg)) throw new NeedsUser(`WebVPN 需要验证码：${msg}`, "请在浏览器登录 webvpn.zju.edu.cn 一次后再重试，或用 zju webvpn import-cookie 导入 cookie");
      // 密码错误有次数限制（服务端提示"还剩 N 次机会"），绝不自动重试
      throw new NeedsUser(`WebVPN 登录失败：${msg}`, "WebVPN 是校园网账号，与统一认证不同。用 profile init --system webvpn 检查账号；连续错误会锁定账号，请勿反复尝试");
    }
    if (res.status !== 200 && !res.isRedirect) throw new TransportError(`WebVPN do-login HTTP ${res.status}`);
    if (!this.hasTicket) throw new BadResponse("WebVPN 登录后未获得 ticket cookie");
    this.save();
    log("WebVPN 登录成功");
    return { reused: false };
  }

  /** 手动导入浏览器里的 ticket（验证码场景的逃生口） */
  importTicket(ticket: string, route?: string): void {
    this.http.jar.put(TICKET_COOKIE, ticket, WEBVPN_HOST, "/", true);
    if (route) this.http.jar.put("route", route, WEBVPN_HOST, "/", true);
    this.save();
  }

  /** 经 WebVPN 请求一个真实 URL */
  fetch(realUrl: string, opts: Parameters<HttpClient["request"]>[1] = {}): Promise<HttpResponse> {
    const headers = { ...(opts.headers ?? {}) };
    if (headers["Referer"]) headers["Referer"] = rewriteUrl(headers["Referer"]);
    return this.http.request(rewriteUrl(realUrl), { ...opts, headers });
  }

  logout(): void {
    this.http.jar.removeDomain(WEBVPN_HOST);
    this.store.clear();
  }
}
