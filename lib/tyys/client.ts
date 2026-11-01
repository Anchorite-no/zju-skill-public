import { openContext, type Context, type OpenOptions } from "../webvpn/transport.ts";
import { CookieJar } from "../core/http.ts";
import type { ModuleRequirements } from "../core/module.ts";
import { AuthExpired, BadResponse, ConfigError, RateLimited, RemoteRejected, ZjuError } from "../core/errors.ts";
import { SessionStore } from "../zjuam/session.ts";
import { signingMaterial, signRequest } from "./sign.ts";

export const APP_BASE = "http://tyys.zju.edu.cn/cgapp-server";
export const BASE = "http://www.tyys.zju.edu.cn/ptm";
export const LOGIN_SERVICE = "http://www.tyys.zju.edu.cn/cgapp-server/cas/appLogin";
export const requirements: ModuleRequirements = {
  name: "tyys", title: "浙大体艺", hosts: ["tyys.zju.edu.cn", "www.tyys.zju.edu.cn"],
  auth: "cas", network: "public", writes: false, casService: LOGIN_SERVICE,
};
export interface ApiResponse { code: number; message: string; data: unknown; httpStatus: number }
export type RequestObserver = (stage: string, detail: Record<string, unknown>) => Promise<void>;
export interface AttendanceClient {
  readonly username: string;
  get(path: string, params?: Record<string, string>): Promise<ApiResponse>;
  setObserver?(observer: RequestObserver | undefined): void;
  requestStats?(): Record<string, number>;
}
interface Tokens { full: string; authorization: string; material: Buffer; uid: string; expires: number }
export function tyysSession(username: string): SessionStore { return new SessionStore({ system: "tyys", username, ttlMs: 12 * 3600_000 }); }

export function parseTokens(full: string, username: string): Tokens {
  let parts: string[], payload: Record<string, unknown>, material: Buffer;
  try {
    parts = full.split(".");
    if (parts.length !== 5) throw Error();
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!payload || !["string", "number"].includes(typeof payload.sub) || !String(payload.sub).trim()
      || typeof payload.exp !== "number" || !Number.isFinite(payload.exp * 1000)) throw Error();
    material = signingMaterial(parts[3]!);
  } catch { throw new BadResponse("体艺登录返回的令牌格式异常，无法建立会话", { reason: "token-format" }); }
  // Login identity comes from JWT sub. Attendance row uid is not an account check.
  if (String(payload.sub) !== username) throw new AuthExpired("tyys", "体艺登录返回了另一账号的会话，无法用于当前配置账号");
  return { full, authorization: parts.slice(0, 3).join("."), material, uid: String(payload.sub), expires: Number(payload.exp) * 1000 };
}

export class Tyys implements AttendanceClient {
  readonly ctx: Context;
  readonly username: string;
  readonly store: SessionStore;
  private tokens: Tokens | undefined;
  private pendingLogin: Promise<void> | undefined;
  private observer: RequestObserver | undefined;
  private generation = 0;
  private apiRequests = 0;
  private authRecoveries = 0;
  // A caller may batch reads (e.g. history); do not turn that into a request burst.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: Context, options: { fresh?: boolean } = {}) {
    if (!ctx.zjuam) throw new ConfigError("体艺客户端需要已组装的 CAS 组件");
    this.ctx = ctx; this.username = ctx.zjuam.username; this.store = tyysSession(this.username);
    if (options.fresh) this.store.clear();
    const cached = options.fresh ? undefined : this.store.load();
    if (typeof cached?.extra.token === "string") {
      try { this.tokens = parseTokens(cached.extra.token, this.username); }
      catch { this.store.clear(); /* Discard stale/wrong-account App cache; authenticate the configured account. */ }
    }
  }

  /** 内部 App 会话适配；CAS 凭据、登录和票据交换由注入的 zjuam 负责。 */
  private ensureSession(fresh = false): Promise<void> {
    if (this.pendingLogin) return this.pendingLogin;
    this.pendingLogin = this.establishSession(fresh).finally(() => { this.pendingLogin = undefined; });
    return this.pendingLogin;
  }

  private async establishSession(fresh: boolean): Promise<void> {
    if (!fresh && this.tokens && this.tokens.expires > Date.now() + 5000) return;
    this.tokens = undefined;
    if (!this.ctx.zjuam) throw new ConfigError("体艺客户端缺少 CAS 上下文");
    const response = await this.ctx.zjuam.loginService(LOGIN_SERVICE);
    const full = response.body.match(/jwtToken["']\s*:\s*["']([^"']+)/)?.[1];
    if (response.status !== 200 || !full) throw new AuthExpired("tyys", "体艺 App 登录未返回令牌，请检查账号是否可使用体艺 App");
    const tokens = parseTokens(full, this.username);
    if (tokens.expires <= Date.now()) throw new AuthExpired("tyys", "体艺登录返回已过期令牌");
    this.tokens = tokens;
    this.generation++;
    this.store.save(new CookieJar(), { token: full });
  }

  /** Bound to known hosts; input cannot supply arbitrary URLs or authentication headers. */
  private async request(path: string, params: Record<string, string>, app = false): Promise<ApiResponse> {
    if (!/^\/api\/[A-Za-z0-9_./-]+$/.test(path) || path.includes("..")) throw new ConfigError("无效的体艺 API 路径");
    await this.ensureSession();
    const method = "GET";
    const query = new URLSearchParams(params).toString();
    const send = async () => {
      const tokens = this.tokens!;
      const headers = {
        // The App selects a different application key for cgapp-server and PTM.
        "app-key": app ? "azk3t4jrcfm5772t" : "cgsoft", v1: "d28da4a4ce6503e85af53079144efd3a",
        imei: "00000000-0000-0000-0000-000000000000", cgAuthorization: tokens.authorization,
        ...signRequest(tokens.material, path, query), Accept: "application/json",
      };
      const request = ++this.apiRequests, started = Date.now();
      const res = await this.ctx.fetch((app ? APP_BASE : BASE) + path + (query ? "?" + query : ""), {
        method, headers,
      }).catch(async (error: unknown) => {
        await this.observer?.("http-error", { method, path, request, sessionGeneration: this.generation,
          elapsedMs: Date.now() - started, error: error instanceof ZjuError ? error.code : error instanceof Error ? error.name : "unknown",
          transportCode: error instanceof ZjuError && typeof error.detail.code === "string" ? error.detail.code : null });
        throw error;
      });
      const body = res.json<Record<string, unknown>>();
      await this.observer?.("http-response", { method, path, request, sessionGeneration: this.generation,
        service: app ? "cgapp-server" : "ptm", appKey: headers["app-key"],
        httpStatus: res.status, code: body?.code != null && Number.isFinite(Number(body.code)) ? Number(body.code) : null,
        elapsedMs: res.elapsedMs, connection: res.connection ?? null,
        headers: Object.fromEntries(["date", "age", "cache-control", "retry-after"].filter(key => res.headers[key] !== undefined)
          .map(key => [key, String(res.headers[key]).slice(0, 200)])) });
      if (res.status === 429) {
        const value = String(res.headers["retry-after"] ?? ""), seconds = Number(value);
        const delay = value.trim() && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
        throw new RateLimited("体艺接口限流", Number.isFinite(delay) && delay >= 0 ? delay : 10_000);
      }
      // An HTTP 401 may have an HTML/empty body; it still triggers refresh.
      if (res.status === 401) return undefined;
      // Some PTM endpoints invalidate the App token with business code 2001,
      // even while attendancelist continues to accept that same token.
      if ([401, 2001].includes(Number(body?.code))) return undefined;
      if (!body || Array.isArray(body) || !Number.isFinite(Number(body.code)) || body.code == null) throw new BadResponse("体艺响应缺少业务状态码", { path, httpStatus: res.status });
      if (res.status < 200 || res.status >= 300) throw new RemoteRejected(`体艺 HTTP ${res.status}`, { path, httpStatus: res.status });
      const message = typeof body.message === "string" ? body.message : "";
      return { code: Number(body.code), message: this.redact(message, params.token ? [params.token] : []), data: body.data, httpStatus: res.status };
    };
    let response = await send();
    if (!response) {
      this.tokens = undefined; this.store.clear();
      this.authRecoveries++;
      await this.observer?.("auth-recovery", { method, path, sessionGeneration: this.generation });
      await this.ensureSession(true); response = await send();
    }
    if (!response) {
      this.tokens = undefined; this.store.clear();
      throw new AuthExpired("tyys");
    }
    return response;
  }

  private redact(text: string, values: string[]): string {
    const sensitive = [this.tokens?.full, this.tokens?.authorization, ...values].filter((s): s is string => !!s);
    return sensitive.reduce((out, value) => out.split(value).join("<redacted>"), text).slice(0, 500);
  }
  setObserver(observer: RequestObserver | undefined): void { this.observer = observer; }
  requestStats(): Record<string, number> {
    return { httpRequests: this.ctx.http.stats.requests, apiRequests: this.apiRequests, authRecoveries: this.authRecoveries };
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  get(path: string, params: Record<string, string> = {}): Promise<ApiResponse> { return this.serial(() => this.request(path, params)); }
  async checkSession(): Promise<void> {
    const response = await this.serial(() => this.request("/api/l/v6/u/info", { xh: this.username }, true));
    if (response.code !== 200) throw new RemoteRejected(`体艺用户信息查询失败：${response.message}`, { code: response.code });
  }
  close(): void { this.ctx.close(); }
}

export async function openTyys(options: OpenOptions = {}): Promise<Tyys> {
  const ctx = await openContext(requirements, options);
  try { return new Tyys(ctx, { fresh: options.fresh ?? false }); }
  catch (error) { ctx.close(); throw error; }
}
