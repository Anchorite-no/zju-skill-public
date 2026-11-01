/** Official glue 1.9.1 read-only subscription. A new session is required after an uncertain poll. */
import { BadResponse, RemoteRejected } from "../core/errors.ts";
import { openContext, type Context } from "../webvpn/transport.ts";

export function subtitleEndpoint(value: string): string {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.hostname !== "qlite2.cmc.zju.edu.cn" || u.port || u.username || u.password || !/^\/[a-zA-Z0-9_-]+\/?$/.test(u.pathname)) {
    throw new BadResponse("未知的官方实时字幕地址");
  }
  u.pathname = u.pathname.replace(/\/$/, "") + "/glue/ajax";
  u.search = ""; u.hash = "";
  return u.href;
}

export function decodeGlue(message: string): { command: string; data?: unknown } {
  const command = message.slice(0, 2), rest = message.slice(2);
  if (command === "cd") {
    const match = rest.match(/^(\d+)&/);
    if (!match) throw new BadResponse("字幕频道帧无效");
    const size = Number(match[1]), payload = rest.slice(match[0].length);
    if (size < 1 || size > payload.length) throw new BadResponse("字幕频道长度无效");
    const channel = payload.slice(0, size);
    if (channel !== "m") return { command: "other-channel" };
    try { return { command, data: JSON.parse(payload.slice(size)) }; }
    catch { throw new BadResponse("字幕消息不是有效 JSON"); }
  }
  if (command === "in") {
    let data: { socketID?: unknown };
    try { data = JSON.parse(rest); } catch { throw new BadResponse("字幕握手响应无效"); }
    if (typeof data?.socketID !== "string" || !data.socketID) throw new BadResponse("字幕握手缺少 socketID");
    return { command };
  }
  if (["pi", "po", "cl", "dr", "iv"].includes(command)) return { command };
  throw new BadResponse("未知字幕协议帧");
}

export interface SubtitleConnectionOptions {
  signal: AbortSignal;
  onConnected(): void;
  onActivity(): void;
  onCaption(data: unknown, receivedAt: number): void;
  /** Injection is for isolated transport verification, never a public CLI flag. */
  open?: () => Promise<Context>;
}

export async function receiveSubtitles(address: string, opts: SubtitleConnectionOptions): Promise<void> {
  const endpoint = subtitleEndpoint(address);
  const ctx = await (opts.open?.() ?? openContext({ name: "zhiyun-live", title: "智云官方实时字幕", hosts: ["qlite2.cmc.zju.edu.cn"], auth: "none", network: "campus", writes: false }, { signal: opts.signal, timeout: 45000, maxSockets: 3 }));
  const local = new AbortController();
  const signal = AbortSignal.any([opts.signal, local.signal]);
  let uid = "", token = "", connected = false, lastActivity = Date.now(), pingAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined, heartbeat: Promise<void> | undefined, failure: unknown;
  // Direct connections get HTTP 400 without Origin; through WebVPN the same request passed without it (2026-10-12).
  const post = async (body: string, timeout = 45000, requestSignal = signal) => {
    const r = await ctx.fetch(endpoint, { method: "POST", body, headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: "https://classroom.zju.edu.cn" }, timeout, signal: requestSignal });
    if (r.status !== 200) throw new RemoteRejected(`实时字幕 HTTP ${r.status}`);
    return r.body;
  };
  const push = async (message: string) => { await post(`u${uid}&${message}`, 8000); };
  try {
    const init = await post("i", 10000), match = init.match(/^([a-zA-Z0-9_-]+)&([a-zA-Z0-9_-]+)$/);
    if (!match) throw new BadResponse("字幕连接初始化无效");
    [uid, token] = [match[1]!, match[2]!];
    await push('in{"version":"1.9.1"}');
    timer = setInterval(() => {
      if (heartbeat || signal.aborted || !connected) return;
      if (pingAt && Date.now() - pingAt > 8000) {
        failure = new BadResponse("字幕心跳无响应"); local.abort(); return;
      }
      if (Date.now() - lastActivity < 35000 || pingAt) return;
      pingAt = Date.now();
      heartbeat = push("pi").catch(e => { failure = e; local.abort(); }).finally(() => { heartbeat = undefined; });
    }, 1000);
    while (!signal.aborted) {
      const response = await post(`o${uid}&${token}`);
      if (response === "t") continue; // a transport timeout response does not advance the poll token
      if (response === "c") throw new BadResponse("字幕连接已由服务端关闭");
      const split = response.indexOf("&");
      if (split <= 0 || !/^[a-zA-Z0-9_-]+$/.test(response.slice(0, split))) throw new BadResponse("字幕轮询令牌无效");
      token = response.slice(0, split);
      const frame = decodeGlue(response.slice(split + 1));
      lastActivity = Date.now(); pingAt = 0;
      opts.onActivity();
      if (frame.command === "in") { connected = true; opts.onConnected(); }
      else if (frame.command === "pi") await push("po");
      else if (frame.command === "cd") {
        if (!connected) throw new BadResponse("握手前收到字幕消息");
        opts.onCaption(frame.data, lastActivity);
      } else if (["cl", "dr", "iv"].includes(frame.command)) throw new BadResponse(`字幕连接被拒绝或关闭（${frame.command}）`);
    }
    if (failure) throw failure;
  } catch (error) {
    if (!opts.signal.aborted) throw failure ?? error;
  } finally {
    clearInterval(timer); local.abort();
    await heartbeat;
    // Close only our subscription; never leave a polling session alive after stop.
    if (uid) await post(`u${uid}&cl`, 2000, AbortSignal.timeout(2000)).catch(() => {});
    ctx.close();
  }
}
