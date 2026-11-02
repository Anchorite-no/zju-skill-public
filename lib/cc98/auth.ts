/**
 * CC98 鉴权：OpenID Connect password grant（公开客户端凭据，与官方前端一致）。
 *
 * POST https://openid.cc98.org/connect/token
 *   grant_type=password&username&password&scope=cc98-api openid offline_access
 *   → {access_token, expires_in(3600), token_type:"Bearer", refresh_token, scope}
 *   grant_type=refresh_token&refresh_token → 同上（refresh_token 不变，官方前端按 30 天缓存）
 *   密码错：400 {"error":"invalid_grant","error_description":"invalid_username_or_password"}
 *
 * 每个账号一份缓存 data/sessions/cc98-<username>.json（0600）：access_token + 过期时刻 + refresh_token。
 * 过期前 60s 自动刷新；刷新失败再走一次 password grant；密码错误抛 NEEDS_USER，绝不重试。
 * 2026-09-17 经 WebVPN 实测通过。
 */
import type { Context } from "../webvpn/transport.ts";
import { SessionStore } from "../zjuam/session.ts";
import { CookieJar } from "../core/http.ts";
import { NeedsUser, BadResponse, TransportError, AuthExpired } from "../core/errors.ts";
import { log, debug } from "../core/output.ts";

const OPENID_TOKEN_URL = "https://openid.cc98.org/connect/token";
const CC98_WEB_ORIGIN = "https://www.cc98.org";
/** 官方前端公开的客户端凭据（ZJU-CC98/Forum、CC98-PWA 源码内置） */
const CLIENT_ID = "9a1fd200-8687-44b1-4c20-08d50a96e5cd";
const CLIENT_SECRET = "8b53f727-08e2-4509-8857-e34bf92b27f2";
const SCOPE = "cc98-api openid offline_access";
/** refresh_token 有效期按官方前端的 30 天算 */
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const REFRESH_AHEAD_MS = 60 * 1000;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

interface TokenExtra {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  tokenType: string;
}

interface Cc98AuthOptions {
  username: string;
  password: string;
  ctx: Context;
}

export class Cc98Auth {
  readonly username: string;
  private readonly password: string;
  private readonly ctx: Context;
  readonly store: SessionStore;
  private token: TokenExtra | undefined;
  private pending: Promise<string> | undefined;

  constructor(opts: Cc98AuthOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.ctx = opts.ctx;
    this.store = new SessionStore({ system: `cc98-${opts.username}`, username: opts.username, ttlMs: SESSION_TTL_MS });
    const cached = this.store.load();
    const e = cached?.extra as Partial<TokenExtra> | undefined;
    if (e?.accessToken && typeof e.expiresAt === "number" && e.refreshToken) {
      this.token = { accessToken: e.accessToken, expiresAt: e.expiresAt, refreshToken: e.refreshToken, tokenType: e.tokenType ?? "Bearer" };
    }
  }

  /** 缓存里是否有 token（不代表服务端仍接受） */
  get hasToken(): boolean {
    return !!this.token;
  }

  /** 返回可用的 access_token（必要时刷新/重登）。并发调用合并。 */
  accessToken(force = false): Promise<string> {
    if (this.pending) return this.pending;
    this.pending = this.resolveToken(force).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** Authorization 头的值 */
  async authorization(force = false): Promise<string> {
    const t = await this.accessToken(force);
    return `${this.token?.tokenType ?? "Bearer"} ${t}`;
  }

  private async resolveToken(force: boolean): Promise<string> {
    if (!force && this.token && this.token.expiresAt - Date.now() > REFRESH_AHEAD_MS) {
      debug("cc98: access_token 仍有效，复用");
      return this.token.accessToken;
    }
    if (this.token?.refreshToken) {
      try {
        await this.grant({ grant_type: "refresh_token", refresh_token: this.token.refreshToken });
        log(`CC98 ${this.username}：token 已刷新`);
        return this.token.accessToken;
      } catch (err) {
        if (err instanceof NeedsUser) throw err;
        debug(`cc98: refresh 失败（${(err as Error).message}），改用密码登录`);
      }
    }
    await this.grant({ grant_type: "password", username: this.username, password: this.password, scope: SCOPE });
    log(`CC98 ${this.username}：登录成功`);
    return this.token!.accessToken;
  }

  private async grant(fields: Record<string, string>): Promise<void> {
    const body = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...fields }).toString();
    const res = await this.ctx.fetch(OPENID_TOKEN_URL, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json, text/plain, */*",
        Origin: CC98_WEB_ORIGIN,
        Referer: CC98_WEB_ORIGIN + "/",
      },
    });
    const payload = res.json<TokenResponse>();
    if (!payload) {
      if (/name="_csrf"|wengine_vpn_ticket/.test(res.body)) throw new AuthExpired("webvpn", "WebVPN 会话失效，返回了登录页");
      throw new TransportError(`CC98 token 端点返回非 JSON（HTTP ${res.status}）`, { status: res.status, snippet: res.body.slice(0, 200) });
    }
    if (res.status !== 200 || !payload.access_token) {
      const desc = payload.error_description || payload.error || `HTTP ${res.status}`;
      if (fields["grant_type"] === "password" && /invalid_grant|invalid_username_or_password/i.test(desc)) {
        throw new NeedsUser(`CC98 登录失败：${desc}`, "用 profile init --system cc98 检查账号；不要反复尝试");
      }
      throw new BadResponse(`CC98 token 获取失败：${desc}`, { status: res.status, grant: fields["grant_type"] });
    }
    this.token = {
      accessToken: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
      refreshToken: payload.refresh_token ?? this.token?.refreshToken ?? "",
      tokenType: payload.token_type ?? "Bearer",
    };
    this.store.save(new CookieJar(), { ...this.token });
  }

  logout(): boolean {
    this.token = undefined;
    return this.store.clear();
  }

  status(): { username: string; file: string; hasToken: boolean; accessExpiresInMs?: number; sessionAgeMs?: number } {
    const s = this.store.status();
    const out: ReturnType<Cc98Auth["status"]> = { username: this.username, file: this.store.file, hasToken: this.hasToken };
    if (this.token) out.accessExpiresInMs = this.token.expiresAt - Date.now();
    if (s.ageMs !== undefined) out.sessionAgeMs = s.ageMs;
    return out;
  }
}
