/**
 * 使用前的网络探测：对即将访问的主机各发一次真实 HTTPS 请求，收到任何 HTTP 响应即通；不通就抛带说明的 TransportError。
 * 不做任何回退/跳板。结果按主机缓存 10 分钟（data/cache/reach.json），避免每条命令都探。
 *
 * 必须是真实请求，不能用 TCP connect：本机有 TUN/梯子时 connect 对任何地址都"成功"。
 */
import path from "node:path";
import { HttpClient } from "./http.ts";
import { TransportError } from "./errors.ts";
import { readJson, writeJson } from "./fsjson.ts";
import { paths } from "./paths.ts";
import { debug } from "./output.ts";

const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 4000;

/** 各主机不通时给用户的解释 */
const HINTS: Record<string, string> = {
  "webvpn.zju.edu.cn": "WebVPN 入口不通。它在国内公网可达；海外/被封网段不行。先跑 zju webvpn check",
  "zjuam.zju.edu.cn": "统一身份认证不通。它在国内公网可达；海外/被封网段不行",
  "chalaoshi.de": "查老师在国内被墙，需要本机能出海（WebVPN 帮不上忙）",
  "api.chalaoshi.de": "查老师 API 子域不通，需要本机能出海",
};

interface CacheFile {
  version: 1;
  hosts: Record<string, { ok: boolean; at: number; ms: number }>;
}

function cacheFile(): string {
  return path.join(paths.cache(), "reach.json");
}

export interface ReachResult {
  host: string;
  ok: boolean;
  ms: number;
  cached: boolean;
  error?: string;
}

async function probe(host: string): Promise<ReachResult> {
  const http = new HttpClient({ timeout: TIMEOUT_MS, maxSockets: 1 });
  const t = performance.now();
  try {
    await http.request(`https://${host}/`, { headers: { Range: "bytes=0-0" } });
    return { host, ok: true, ms: Math.round(performance.now() - t), cached: false };
  } catch (err) {
    return { host, ok: false, ms: Math.round(performance.now() - t), cached: false, error: (err as Error).message };
  } finally {
    http.destroy();
  }
}

/** 探测一组主机；opts.fresh 跳过缓存 */
export async function checkReachable(hosts: string[], opts: { fresh?: boolean } = {}): Promise<ReachResult[]> {
  const cache = readJson<CacheFile>(cacheFile()) ?? { version: 1, hosts: {} };
  const out: ReachResult[] = [];
  const todo: string[] = [];
  for (const h of hosts) {
    const c = cache.hosts[h];
    if (!opts.fresh && c && c.ok && Date.now() - c.at < TTL_MS) out.push({ host: h, ok: true, ms: c.ms, cached: true });
    else todo.push(h);
  }
  const fresh = await Promise.all(todo.map(probe));
  for (const r of fresh) {
    if (r.ok) cache.hosts[r.host] = { ok: true, at: Date.now(), ms: r.ms };
    else delete cache.hosts[r.host];
    out.push(r);
  }
  if (fresh.length) writeJson(cacheFile(), cache);
  debug(`reach: ${out.map((r) => `${r.host}=${r.ok ? "ok" : "down"}${r.cached ? "(cache)" : ""}`).join(" ")}`);
  return out;
}

/** 不通就抛 TransportError（code TRANSPORT，退出码 4），message 带说明 */
export async function requireReachable(hosts: string[], opts: { fresh?: boolean } = {}): Promise<ReachResult[]> {
  const rs = await checkReachable(hosts, opts);
  const down = rs.filter((r) => !r.ok);
  if (!down.length) return rs;
  const lines = down.map((r) => `${r.host}：${HINTS[r.host] ?? "不可达"}（${r.error ?? "超时"}）`);
  throw new TransportError(`网络不可达：${lines.join("；")}`, { hosts: down.map((r) => r.host) });
}

export function clearReachCache(): boolean {
  const had = !!readJson(cacheFile());
  writeJson(cacheFile(), { version: 1, hosts: {} } satisfies CacheFile);
  return had;
}
