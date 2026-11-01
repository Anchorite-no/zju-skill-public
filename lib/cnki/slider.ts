/** 知网拼图验证：同一 HTTP 会话取题、本地匹配、校验，回到站点后再由调用方确认业务结果。 */
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PNG } from "pngjs";
import { BadResponse, NeedsUser, RateLimited, TransportError } from "../core/errors.ts";
import type { HttpResponse } from "../core/http.ts";
import { debug } from "../core/output.ts";
import { unwrapUrl } from "../webvpn/client.ts";
import type { Context } from "../webvpn/transport.ts";

const API = "https://kns.cnki.net/verify-api";
const MAX_ATTEMPTS = 3;

export const sliderLimited = (reason: string) => new RateLimited(`知网滑块验证${reason}，本次已停止；请过几分钟再试`, 300_000);

/** HTTP Location 和接口 403 JSON 共用一个识别入口；非 JSON 的 403 不能误当作滑块。 */
export function sliderUrl(res: HttpResponse): string | undefined {
  const target = res.isRedirect ? res.location : res.status === 403 ? res.json<{ message?: unknown }>()?.message : undefined;
  if (typeof target !== "string") return undefined;
  let url: URL;
  try { url = new URL(unwrapUrl(new URL(target, res.url).href)); } catch { return undefined; }
  if (!url.pathname.startsWith("/verify/")) return undefined;
  return cnkiUrl(url.href).href;
}

/** 验证跳转只允许知网；WebVPN 地址先还原，再交给同一 Context 重写。 */
function cnkiUrl(raw: string, base?: string): URL {
  let url: URL;
  try { url = new URL(unwrapUrl(new URL(raw, base).href)); }
  catch { throw new BadResponse("知网验证返回了无效地址"); }
  if (!["https:", "http:"].includes(url.protocol) || !(url.hostname === "cnki.net" || url.hostname.endsWith(".cnki.net")) || url.username || url.password || url.port) {
    throw new BadResponse("知网验证返回了非知网地址");
  }
  // 现网 check 返回 http://kns.cnki.net/...；保持 HTTPS 传输和原有 Secure Cookie。
  url.protocol = "https:";
  return url;
}

function png(base64: string): PNG {
  const bytes = Buffer.from(base64, "base64");
  // 先约束 PNG 头里的尺寸，防止解码时按异常尺寸分配内存。
  if (bytes.length < 24 || bytes.length > 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    || bytes.readUInt32BE(16) > 1024 || bytes.readUInt32BE(20) > 512) throw new BadResponse("知网滑块图片格式或尺寸异常");
  try { return PNG.sync.read(bytes); } catch { throw new BadResponse("知网滑块图片无法解码"); }
}

const grey = (data: Buffer, i: number) => 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;

/**
 * 拼块保留原图的高度，透明区携带纵向位置。只沿 x 搜索；去掉白色描边后做归一化相关，
 * 允许缺口处变暗。不能把透明区的左边距裁掉，否则提交位移会偏移。
 * 返回 undefined 表示纹理不足或有相近候选，交给执行器换新题，不猜坐标。
 */
export function matchSlider(background: string, jigsaw: string): { x: number; score: number } | undefined {
  const bg = png(background), piece = png(jigsaw);
  if (bg.width !== 310 || bg.height !== 155 || piece.height !== bg.height || piece.width < 10 || piece.width > bg.width / 2) {
    throw new BadResponse("知网滑块图片尺寸与当前验证协议不一致");
  }
  const points: { x: number; y: number; value: number }[] = [];
  for (let y = 2; y < piece.height - 2; y++) for (let x = 2; x < piece.width - 2; x++) {
    let inside = true;
    for (let d = -2; d <= 2; d++) {
      if (piece.data[((y + d) * piece.width + x) * 4 + 3] !== 255 || piece.data[(y * piece.width + x + d) * 4 + 3] !== 255) { inside = false; break; }
    }
    if (inside) points.push({ x, y, value: grey(piece.data, (y * piece.width + x) * 4) });
  }
  if (points.length < 100) return undefined;
  const mean = points.reduce((sum, p) => sum + p.value, 0) / points.length;
  const variance = points.reduce((sum, p) => sum + (p.value - mean) ** 2, 0);
  if (variance / points.length < 4) return undefined;
  const matches: { x: number; score: number }[] = [];
  for (let x = 0; x <= bg.width - piece.width; x++) {
    let sum = 0, squares = 0, covariance = 0;
    for (const p of points) {
      const value = grey(bg.data, (p.y * bg.width + p.x + x) * 4);
      sum += value; squares += value * value; covariance += (p.value - mean) * value;
    }
    const denom = Math.sqrt(variance * Math.max(0, squares - sum * sum / points.length));
    matches.push({ x, score: denom ? covariance / denom : 0 });
  }
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0]!, other = matches.find((m) => Math.abs(m.x - best.x) > 4);
  return best.score >= 0.55 && best.score - (other?.score ?? 0) >= 0.03 ? best : undefined;
}

function encryptPoint(x: number, secret: unknown): string {
  const point = JSON.stringify({ x, y: 5 });
  if (secret === undefined || secret === null || secret === "") return point;
  if (typeof secret !== "string" || ![16, 24, 32].includes(Buffer.byteLength(secret))) throw new BadResponse("知网滑块密钥格式异常");
  const key = Buffer.from(secret), cipher = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  return Buffer.concat([cipher.update(point), cipher.final()]).toString("base64");
}

interface Reply { code: string | number; message?: unknown; data?: Record<string, unknown> | null }

/** 每次验证最多三题；后续论文独立计数，同一业务请求验证后仍被拦截由调用方立即停止。 */
export class Slider {
  private readonly clientUid = crypto.randomUUID();

  /** 检索接口验证后回到高级检索页，先取得放行 Cookie，再由调用方重发原 POST。 */
  async verify(ctx: Context, rawUrl: string): Promise<void> {
    const signal = AbortSignal.timeout(60_000);
    let back = await this.solve(ctx, rawUrl, signal);
    for (let hop = 0; hop < 5; hop++) {
      const res = await ctx.fetch(back.href, { headers: { Referer: rawUrl }, signal });
      if (sliderUrl(res)) throw sliderLimited("通过后仍被要求验证");
      if (res.isRedirect) { back = cnkiUrl(res.location!, res.url); continue; }
      if (res.status !== 200) throw new TransportError(`知网验证返回页 HTTP ${res.status}`, { status: res.status });
      return;
    }
    throw new BadResponse("知网验证返回页跳转过多");
  }

  async solve(ctx: Context, rawUrl: string, signal?: AbortSignal): Promise<URL> {
    const url = cnkiUrl(rawUrl);
    if (url.searchParams.get("captchaType") !== "blockPuzzle") throw new NeedsUser("知网要求的不是拼图滑块，暂时无法自动完成该验证");
    // 现网前端直接拆 query，没有 decodeURIComponent；尤其 returnUrl 必须保留 %3D 等编码。
    const params = new Map(url.search.slice(1).split("&").map((part) => {
      const at = part.indexOf("="); return [part.slice(0, at), part.slice(at + 1)] as const;
    }));
    const ident = params.get("ident"), captchaId = params.get("captchaId"), returnUrl = params.get("returnUrl");
    if (!ident || !captchaId || !returnUrl) throw new BadResponse("知网滑块地址缺少验证参数");
    const post = async (endpoint: string, body: Record<string, unknown>): Promise<Reply> => {
      const res = await ctx.fetch(`${API}/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json;charset=utf-8", uniplatform: "NZKPT", Referer: url.href },
        body: JSON.stringify(body), ...(signal ? { signal } : {}),
      });
      if (res.status === 429) throw sliderLimited("请求过于频繁");
      if (res.status !== 200) throw new TransportError(`知网滑块接口 HTTP ${res.status}`, { status: res.status });
      const reply = res.json<Reply>();
      if (!reply || !["string", "number"].includes(typeof reply.code)) throw new BadResponse("知网滑块接口返回异常");
      if (String(reply.code) === "6201") throw sliderLimited("请求过于频繁");
      return reply;
    };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await delay(1000, undefined, signal ? { signal } : {});
      debug(`cnki: 滑块取题 ${attempt}/${MAX_ATTEMPTS}`);
      const reply = await post("get", { captchaType: "blockPuzzle", clientUid: this.clientUid, ident, captchaId, ts: Date.now() });
      if (String(reply.code) !== "0") throw sliderLimited("取题失败");
      const data = reply.data;
      if (!data || typeof data.originalImageBase64 !== "string" || typeof data.jigsawImageBase64 !== "string" || typeof data.token !== "string" || !data.token) {
        throw new BadResponse("知网滑块题目缺少图片或 token");
      }
      const match = matchSlider(data.originalImageBase64, data.jigsawImageBase64);
      if (!match) { debug("cnki: 滑块匹配不确定，换新题"); continue; }
      const checked = await post("web/check", { captchaType: "blockPuzzle", pointJson: encryptPoint(match.x, data.secretKey), token: data.token, ident, returnUrl });
      if (String(checked.code) === "0") {
        if (typeof checked.data?.returnUrl !== "string" || !checked.data.returnUrl) throw new BadResponse("知网滑块校验通过但缺少返回地址");
        const back = cnkiUrl(checked.data.returnUrl, url.href);
        back.searchParams.set("captchaId", captchaId);
        debug("cnki: 滑块校验通过");
        return back;
      }
      // 只对坐标错误或题目过期换题；其他业务拒绝立即停止。
      if (!["6110", "6111"].includes(String(checked.code))) throw sliderLimited("未通过");
    }
    throw sliderLimited("未能在三次取题内完成");
  }
}
