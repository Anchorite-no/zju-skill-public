/**
 * 传输层：根据模块声明（ModuleRequirements）组装"怎么到达 + 怎么登录"。
 *
 *   const ctx = await openContext(requirements);
 *   const res = await ctx.fetch("https://zdbk.zju.edu.cn/...");   // 真实 URL，自动重写
 *
 * 两个正交维度，由网站自身决定：
 *   auth=cas      → 注入 zjuam；站点会话缺失或失效时按需委托，不预检 CAS。
 *                   zjuam 公网直连，密码认证和票据交换始终由该组件负责。
 *   auth=own/none → 不碰 zjuam
 *   network=campus → 该站只在校网：复用 WebVPN ticket，缺失时登录，失效响应后恢复；
 *                    profile 里 transport=direct 时直连（仅限能直连校园网的机器）；
 *                    模块在 publicHosts 里点名的主机是实测公网可达的，直连；直连不通、或者网站把校外的访问
 *                    挡到「无权访问」页（网站群对只给校内看的页面这样做）时，这一次运行里改走 WebVPN
 *   network=public → 直连
 * 两者组合时顺序是：WebVPN 会话 → CAS 登录（直连）→ CAS 回跳到校内站（经 WebVPN 重写）。
 */
import type { ModuleRequirements } from "../core/module.ts";
import { HttpClient, CookieJar, type HttpResponse, type RequestOptions } from "../core/http.ts";
import { credentials, webvpnCredentials, currentTransport, type Transport } from "../profile/profile.ts";
import { Zjuam } from "../zjuam/login.ts";
import { Webvpn, rewriteUrl, WEBVPN_HOST } from "./client.ts";
import { debug } from "../core/output.ts";
import { currentUrl } from "../core/moved.ts";
import { TransportError } from "../core/errors.ts";

/** 网站群把校外读者挡下来时跳去的页面；原来要看的地址在它的 parentUrl 参数里 */
export const NO_PERMIT_PATH = "/nopermit_zjusub.jsp";

/**
 * 经 WebVPN 时，一个真实地址实际该请求哪个地址：模块声明的校内主机改写成 WebVPN 形式，
 * 其中 open 里的（实测公网可达）不改，直连；别的主机（公网网站）原样。open 可以在运行中删掉直连不通的主机。
 */
export function rewriteFor(hosts: string[], open: ReadonlySet<string>): (url: string) => string {
  const declared = hosts.map((h) => h.toLowerCase());
  return (u) => {
    const url = new URL(u), h = url.hostname.toLowerCase();
    if (h === WEBVPN_HOST || open.has(url.host.toLowerCase())) return u;
    return declared.some((x) => h === x || h.endsWith("." + x)) ? rewriteUrl(u) : u;
  };
}

export interface Context {
  requirements: ModuleRequirements;
  transport: Transport;
  http: HttpClient;
  /** auth=cas 时存在；由 service/loginService 按需认证 */
  zjuam?: Zjuam;
  /** transport=webvpn 时存在，缓存 ticket 已装载或已完成登录 */
  webvpn?: Webvpn;
  /** 真实 URL → 实际请求 URL */
  resolve(url: string): string;
  fetch(url: string, opts?: RequestOptions): Promise<HttpResponse>;
  fetchFollow(url: string, opts?: RequestOptions): Promise<HttpResponse>;
  close(): void;
}

export interface OpenOptions {
  signal?: AbortSignal;
  scheduling?: "lifo" | "fifo";
  transport?: Transport;
  timeout?: number;
  /** 强制重新登录（跳过 session 缓存） */
  fresh?: boolean;
  /** 不做 CAS（即使模块声明 auth=cas） */
  skipAuth?: boolean;
  /** 连接池大小（keep-alive 热连接数），默认 4 */
  maxSockets?: number;
  /** 空闲连接保活时长（毫秒），默认 30s */
  idleTimeoutMs?: number;
}

export async function openContext(req: ModuleRequirements, opts: OpenOptions = {}): Promise<Context> {
  const transport: Transport = req.network === "public" ? "direct" : (opts.transport ?? currentTransport());
  const http = new HttpClient({
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.scheduling ? { scheduling: opts.scheduling } : {}),
    jar: new CookieJar(),
    timeout: opts.timeout ?? 10000,
    ...(opts.maxSockets !== undefined ? { maxSockets: opts.maxSockets } : {}),
    ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
  });
  let resolve: (u: string) => string = (u) => u;
  /** 模块点名的公网可达主机，直连；某个主机这次直连不通就从这里拿掉，之后走 WebVPN */
  const open = new Set((req.publicHosts ?? []).map((h) => h.toLowerCase()));

  let webvpn: Webvpn | undefined;
  if (transport === "webvpn") {
    const creds = webvpnCredentials();
    webvpn = new Webvpn({ ...creds, http });
    if (opts.fresh || !webvpn.hasTicket) await webvpn.login(true);
    // 只重写模块声明的校内主机；zjuam 等公网主机一律直连
    resolve = rewriteFor(req.hosts, open);
  }

  let zjuam: Zjuam | undefined;
  if (req.auth === "cas" && !opts.skipAuth) {
    zjuam = new Zjuam({ ...credentials(), http, resolve });
    if (opts.fresh) await zjuam.login(true);
  }

  debug(`context ${req.name}: transport=${transport} auth=${req.auth}${zjuam ? " (cas component attached)" : ""}`);

  const withReferer = (o?: RequestOptions): RequestOptions => {
    const headers = { ...(o?.headers ?? {}) };
    if (headers["Referer"]) headers["Referer"] = resolve(headers["Referer"]);
    return { ...(o ?? {}), headers };
  };
  // 同账号在别处登录会踢掉 ticket；只在明确收到网关登录页时恢复一次。
  // 多路保活共用一次重登，避免互相踢会话；密码/验证码错误原样抛给调用方。
  // 网关对不带有效 ticket 的请求回 302 /login，同时下发一个新的匿名 ticket（2026-10-06 实测）。所以重登期间不发新请求，
  // 登录前先等同一批在途请求回来：它们迟到的响应会把刚登录的 ticket 换成匿名的，表现为一次运行登录两回、个别请求拿到登录页。
  let refresh: Promise<unknown> | undefined;
  let generation = 0, inflight = 0;
  const settled: (() => void)[] = [];
  /** 在途请求都回来。被网关拒掉的请求回得很快；已被放行、卡在慢后端上的不会带回新 ticket，不必等，所以最多等 1 秒 */
  const drained = () => new Promise<void>((done) => {
    if (!inflight) return done();
    const timer = setTimeout(done, 1000);
    settled.push(() => { clearTimeout(timer); done(); });
  });
  const perform = async (url: string, o?: RequestOptions, follow = false): Promise<HttpResponse> => {
    // 学校已经停用的旧地址（core/moved.ts）改去请求现在的地址。
    const target = resolve(currentUrl(url));
    const send = () => follow ? http.requestFollow(target, withReferer(o)) : http.request(target, withReferer(o));
    const host = new URL(target).host.toLowerCase();
    if (webvpn && open.has(host)) {
      // 标注为公网可达的主机直连。两种情况改走 WebVPN，这次运行里这个主机之后也走 WebVPN：
      // 连不上（标注过时了，或者这台机器的网络到不了）；这一页只给校内看，网站把校外的访问挡到了「无权访问」页。
      try {
        const res = await send();
        const landed = new URL(res.isRedirect && res.location ? new URL(res.location, target).href : res.url);
        if (landed.pathname !== NO_PERMIT_PATH) return res;
        debug(`context ${req.name}: ${host} 这一页只给校内看，改走 WebVPN`);
      } catch (err) {
        if (!(err instanceof TransportError) || err.detail["code"] === "ABORT_ERR") throw err;
        debug(`context ${req.name}: ${host} 直连不通（${err.message}），改走 WebVPN`);
      }
      open.delete(host);
      return perform(url, o, follow);
    }
    if (!webvpn || new URL(target).hostname !== WEBVPN_HOST || !/^\/https?(?:-\d+)?\//.test(new URL(target).pathname)) return send();
    const vpn = webvpn;
    for (let attempt = 0; ; attempt++) {
      if (refresh) await refresh;
      const sentGeneration = generation;
      inflight++;
      let res: HttpResponse;
      try { res = await send(); } finally { if (--inflight === 0) for (const done of settled.splice(0)) done(); }
      const vpnLogin = (res.isRedirect && new URL(res.location!, target).hostname === WEBVPN_HOST && new URL(res.location!, target).pathname === "/login")
        || (new URL(res.url).hostname === WEBVPN_HOST && new URL(res.url).pathname === "/login")
        || (res.contentType.includes("text/html") && /do-login/.test(res.body) && /password/.test(res.body));
      if (!vpnLogin || attempt > 0) return res;
      // 失败的 promise 保留：同一上下文不能不断尝试错误密码。
      if (sentGeneration === generation) refresh ??= drained().then(() => vpn.login(true)).then((value) => { generation++; refresh = undefined; return value; });
    }
  };
  const ctx: Context = {
    requirements: req,
    transport,
    http,
    resolve,
    fetch: (url, o) => perform(url, o),
    fetchFollow: (url, o) => perform(url, o, true),
    close: () => http.destroy(),
  };
  if (zjuam) ctx.zjuam = zjuam;
  if (webvpn) ctx.webvpn = webvpn;
  return ctx;
}
