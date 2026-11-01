import { TransportError } from "../core/errors.ts";
import type { RequestOptions } from "../core/http.ts";

/**
 * 前两次只等这么久。从校外进校内的新连接有几个百分点会一直不回应（2026-10-06 本机实测，学校的 WebVPN 网关和 VPN 节点都有），
 * 等满默认的 10 秒才重发，一次 notice list 就要 12 秒；正常请求从发出到收完不到 1 秒。
 */
export const QUICK_MS = 3500;

/**
 * 只读请求最多发三次：前两次用短超时，卡住就换一条连接重发；最后一次用连接默认的超时，照顾对面真的慢的时候。
 * 超时后立刻重发；连接被断开等其他传输错误隔一会儿再发（官网偶发断开连接）。只能用在重发没有副作用的请求上。
 */
export async function patiently<T>(send: (opts: RequestOptions) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await send(attempt < 2 ? { timeout: QUICK_MS } : {}); } catch (err) {
      if (!(err instanceof TransportError) || attempt >= 2) throw err;
      if (err.detail["code"] !== "ETIMEDOUT") await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}
