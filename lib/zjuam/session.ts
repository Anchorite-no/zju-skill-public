/**
 * 每系统一个 session 文件：data/sessions/<system>.json（0600）。
 * 存 cookie jar + 少量额外字段（token 等），带 username 与 savedAt，超过 TTL 视为过期。
 */
import { readJson, writeJson, removeFile, exists } from "../core/fsjson.ts";
import { paths } from "../core/paths.ts";
import { CookieJar, type Cookie } from "../core/http.ts";

export interface SessionFile {
  version: 1;
  system: string;
  username: string;
  savedAt: number;
  cookies: Cookie[];
  extra: Record<string, unknown>;
}

export interface SessionStoreOptions {
  system: string;
  username: string;
  ttlMs: number;
}

export class SessionStore {
  readonly system: string;
  readonly username: string;
  readonly ttlMs: number;

  constructor(opts: SessionStoreOptions) {
    this.system = opts.system;
    this.username = opts.username;
    this.ttlMs = opts.ttlMs;
  }

  get file(): string {
    return paths.session(this.system);
  }

  /** 读缓存；用户名不匹配或超 TTL 或损坏则返回 undefined */
  load(): { jar: CookieJar; extra: Record<string, unknown>; savedAt: number } | undefined {
    const s = readJson<SessionFile>(this.file);
    if (!s || s.version !== 1 || s.username !== this.username || !Array.isArray(s.cookies)) return undefined;
    if (Date.now() - s.savedAt > this.ttlMs) return undefined;
    return { jar: new CookieJar(s.cookies), extra: s.extra ?? {}, savedAt: s.savedAt };
  }

  save(jar: CookieJar, extra: Record<string, unknown> = {}): void {
    const payload: SessionFile = { version: 1, system: this.system, username: this.username, savedAt: Date.now(), cookies: jar.toJSON(), extra };
    writeJson(this.file, payload);
  }

  clear(): boolean {
    return removeFile(this.file);
  }

  status(): { exists: boolean; ageMs?: number; expired?: boolean; username?: string } {
    const s = readJson<SessionFile>(this.file);
    if (!s || !exists(this.file)) return { exists: false };
    const ageMs = Date.now() - s.savedAt;
    return { exists: true, ageMs, expired: ageMs > this.ttlMs || s.username !== this.username, username: s.username };
  }
}
