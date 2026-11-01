/**
 * 浙江大学统一身份认证（CAS）客户端。
 *
 * 登录：GET /cas/login 取 execution → GET /cas/v2/getPubKey → 裸 RSA → POST 表单 → 30x 成功。
 * 委托：GET /cas/login?service=<url> → 若 TGT 有效直接 302 到 service?ticket=ST-…；否则走登录。
 * 持久化：data/sessions/zjuam.json 存 iPlanetDirectoryPro 等 cookie。
 *
 * zjuam 公网可达，自身永远直连。resolve 只用于 service 回跳 URL：目标站在校网时由 transport 把回跳重写到 WebVPN。
 */
import { HttpClient, CookieJar, inputValue, type Cookie, type HttpResponse } from "../core/http.ts";
import { NeedsUser, BadResponse, TransportError, AuthExpired } from "../core/errors.ts";
import { log, debug } from "../core/output.ts";
import { SessionStore } from "./session.ts";
import { encryptPassword } from "./rsa.ts";
import type { ModuleRequirements } from "../core/module.ts";

export const ZJUAM_BASE = "https://zjuam.zju.edu.cn";
export const requirements: ModuleRequirements = {
  name: "zjuam",
  title: "统一身份认证",
  hosts: ["zjuam.zju.edu.cn"],
  auth: "none",
  network: "public",
  writes: false,
  sessionProbe: `${ZJUAM_BASE}/cas/login`,
};

/**
 * CAS 自己的 cookie：zjuam 主机上的，和 zju.edu.cn 域上的 TGT 等。会话文件只存取这些。
 * http 的 jar 是整个上下文共用的，里面还有 WebVPN ticket 和各站点的 cookie；连它们一起存下来，
 * 下次加载就会用旧 ticket 盖掉 WebVPN 刚载入的新 ticket，每次运行都要重登 WebVPN（2026-10-06 查实）。
 */
const own = (c: Cookie) => c.domain === "zju.edu.cn" || c.domain === new URL(ZJUAM_BASE).hostname;

export interface ZjuamOptions {
  username: string;
  password: string;
  http: HttpClient;
  /** 把 service 回跳 URL 转成实际请求 URL（目标站在校网时经 WebVPN）；默认恒等。zjuam 自身不经过它。 */
  resolve?: (url: string) => string;
  ttlMs?: number;
}

export interface LoginResult {
  reused: boolean;
  username: string;
}

export class Zjuam {
  readonly username: string;
  private readonly password: string;
  readonly http: HttpClient;
  private readonly resolve: (url: string) => string;
  readonly store: SessionStore;
  private loginPromise: Promise<LoginResult> | undefined;

  constructor(opts: ZjuamOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.http = opts.http;
    this.resolve = opts.resolve ?? ((u) => u);
    this.store = new SessionStore({ system: "zjuam", username: opts.username, ttlMs: opts.ttlMs ?? 12 * 3600 * 1000 });
    const cached = this.store.load();
    if (cached) for (const c of cached.jar.cookies.filter(own)) this.http.jar.put(c.name, c.value, c.domain, c.path, c.secure);
  }

  private save(): void {
    this.store.save(new CookieJar(this.http.jar.cookies.filter(own)));
  }

  /** TGT cookie 是否在 jar 里（不代表服务端仍有效） */
  get hasTgt(): boolean {
    return !!this.http.jar.get("iPlanetDirectoryPro", ZJUAM_BASE + "/cas/login");
  }

  /** 登录（复用缓存则不发表单）。并发调用合并。 */
  login(force = false): Promise<LoginResult> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.doLogin(force).finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private async doLogin(force: boolean): Promise<LoginResult> {
    if (!force && this.hasTgt) {
      // 探测 TGT 是否仍被服务端认可：带 service 请求，有效时直接 302 到 service?ticket=；失效时返回登录表单。
      const probeUrl = `${ZJUAM_BASE}/cas/login?service=${encodeURIComponent(ZJUAM_BASE + "/cas/")}`;
      const probe = await this.http.request(probeUrl);
      if (probe.isRedirect && /[?&]ticket=/.test(probe.location ?? "")) {
        debug("zjuam: TGT 仍有效，复用");
        return { reused: true, username: this.username };
      }
      debug("zjuam: TGT 已失效，重新登录");
    }
    // 无论是 force 还是探测失败，都先清掉旧 TGT，否则 GET /cas/login 会被 302 到默认门户而拿不到登录表单。
    // 只清 zjuam 自己的 host cookie 和 zju.edu.cn 上的 domain cookie（TGT），不能碰 webvpn.zju.edu.cn 等子域。
    this.clearOwnCookies();
    await this.submitLogin(`${ZJUAM_BASE}/cas/login`);
    this.save();
    log("统一身份认证登录成功");
    return { reused: false, username: this.username };
  }

  /**
   * 在指定的 CAS 登录页（可带 ?service=）提交表单。返回 30x 响应（Location 是回跳地址）。
   */
  private async submitLogin(loginUrl: string): Promise<HttpResponse> {
    let page = await this.http.request(loginUrl);
    // 已登录态下 CAS 会直接 302（带 ticket 或去默认门户）；这里只接受停留在 zjuam 的重定向
    while (page.isRedirect) {
      const next = new URL(page.location!, page.url);
      if (next.hostname !== new URL(ZJUAM_BASE).hostname) throw new BadResponse("CAS 未返回登录表单（可能已有登录态被 302 到门户）", { url: loginUrl, location: next.origin + next.pathname });
      page = await this.http.request(next.href);
    }
    if (page.status !== 200) throw new TransportError(`认证入口 HTTP ${page.status}`, { url: loginUrl });
    const execution = inputValue(page.body, "execution");
    if (!execution) throw new BadResponse("认证页面缺少 execution 字段", { url: loginUrl });
    const pub = await this.http.request(`${ZJUAM_BASE}/cas/v2/getPubKey`);
    const key = pub.json<{ modulus?: string; exponent?: string }>();
    if (!key?.modulus || !key.exponent) throw new BadResponse("认证公钥缺失");
    const posted = await this.http.postForm(
      page.url,
      { username: this.username, password: encryptPassword(this.password, key.modulus, key.exponent), execution, _eventId: "submit", authcode: "" },
      { headers: { Origin: new URL(page.url).origin, Referer: page.url } },
    );
    if (posted.isRedirect) return posted;
    const message = posted.body.match(/id=["']msg["'][^>]*>([^<]*)/i)?.[1]?.trim();
    if (message && /密码|账号|用户名|验证码|锁定/.test(message)) throw new NeedsUser(`统一身份认证拒绝：${message}`, "检查学号密码；若提示验证码，请先在浏览器登录一次再重试");
    throw new BadResponse(`认证未成功：${message || `HTTP ${posted.status}`}`, { status: posted.status });
  }

  /**
   * 把登录态委托给某个服务：返回 service 回跳 URL（带 ticket）。
   * 调用方随后 requestFollow(callback) 即拿到该服务的会话 cookie。
   */
  async service(serviceUrl: string): Promise<string> {
    const loginUrl = `${ZJUAM_BASE}/cas/login?service=${encodeURIComponent(serviceUrl)}`;
    let res = await this.http.request(loginUrl);
    if (res.isRedirect && /[?&]ticket=/.test(res.location ?? "")) return new URL(res.location!, loginUrl).href;
    // 没有直接拿到 ticket：TGT 失效或从未登录，走表单
    if (res.isRedirect) res = await this.http.requestFollow(new URL(res.location!, loginUrl).href);
    if (res.status !== 200) throw new TransportError(`CAS service 入口 HTTP ${res.status}`, { url: loginUrl });
    if (!/name=["']execution["']/i.test(res.body)) throw new BadResponse("CAS 返回了既非 ticket 也非登录表单的页面", { url: loginUrl });
    const posted = await this.submitLogin(loginUrl);
    this.save();
    const cb = posted.location;
    if (!cb || !/[?&]ticket=/.test(cb)) throw new AuthExpired("zjuam", "登录后未获得 service ticket");
    return new URL(cb, loginUrl).href;
  }

  /** 委托并跟随回跳，直到目标域给出非重定向响应；返回最终响应 */
  async loginService(serviceUrl: string): Promise<HttpResponse> {
    const cb = await this.service(serviceUrl);
    return this.http.requestFollow(this.resolve(cb));
  }

  private clearOwnCookies(): void {
    this.http.jar.removeWhere(own);
  }

  logout(): void {
    this.clearOwnCookies();
    this.store.clear();
  }
}

/** 便捷构造：只用 profile 里的凭据和一个新的 HttpClient（不经 transport） */
export function createZjuam(creds: { username: string; password: string }, http = new HttpClient({ jar: new CookieJar() }), resolve?: (u: string) => string): Zjuam {
  return new Zjuam(resolve ? { ...creds, http, resolve } : { ...creds, http });
}
