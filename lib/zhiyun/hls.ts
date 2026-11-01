import fs from "node:fs/promises";
import path from "node:path";
import { BadResponse, ConfigError, TransportError } from "../core/errors.ts";
import { Transfer, downloadFile, pool } from "./download.ts";
import { selectQuality, videoHeight } from "./quality.ts";

export interface Variant { url: string; bandwidth: number; audio: string; codecs: string; height?: number }
export interface AudioTrack { url: string; group: string; default: boolean }
export interface HlsMaster { variants: Variant[]; audio: AudioTrack[] }
export function attributes(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g)].map(m => [m[1]!, m[2] ?? m[3]!]));
}
function resolve(uri: string, base: string): string {
  const u = new URL(uri, base);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new BadResponse("HLS 清单包含非 HTTP 资源");
  return u.href;
}
export function parseMaster(text: string, base: string): HlsMaster {
  if (!text.trimStart().startsWith("#EXTM3U")) throw new BadResponse("响应不是 HLS 清单");
  const variants: Variant[] = [], audio: AudioTrack[] = [], lines = text.split(/\r?\n/).map(s => s.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = attributes(line);
      if (a.TYPE === "AUDIO" && a.URI) audio.push({ url: resolve(a.URI, base), group: a["GROUP-ID"] ?? "", default: a.DEFAULT === "YES" });
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const a = attributes(line), uri = lines[i + 1];
      if (!uri || uri.startsWith("#")) throw new BadResponse("HLS 码率条目缺少 URI");
      const height = videoHeight(a.RESOLUTION ?? uri);
      variants.push({ url: resolve(uri, base), bandwidth: Number(a.BANDWIDTH) || 0, audio: a.AUDIO ?? "", codecs: a.CODECS ?? "", ...(height === undefined ? {} : { height }) });
    }
  }
  return { variants, audio };
}
export async function resolveHls(transfer: Transfer, url: string, audioOnly: boolean): Promise<{ video?: string; audio?: string; independentAudio: boolean }> {
  for (let depth = 0; depth < 5; depth++) {
    const response = await transfer.text(url), master = parseMaster(response.text, response.url);
    if (!master.variants.length) return audioOnly ? { audio: response.url, independentAudio: false } : { video: response.url, independentAudio: false };
    const variants = [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth);
    const selected = selectQuality(variants, audioOnly ? 360 : 1080)!;
    const audio = master.audio.filter(a => a.group === selected.audio).sort((a, b) => Number(b.default) - Number(a.default))[0];
    if (audio) return audioOnly ? { audio: audio.url, independentAudio: true } : { video: selected.url, audio: audio.url, independentAudio: true };
    const audioVariant = variants.find(v => v.codecs && /mp4a|opus|ac-3/.test(v.codecs) && !/avc|hev|hvc|vp0|av01/.test(v.codecs));
    if (audioOnly && audioVariant) return { audio: audioVariant.url, independentAudio: true };
    url = selected.url;
  }
  throw new BadResponse("HLS 主清单嵌套超过 5 层");
}
export interface HlsResource { url: string; file: string; range?: { start: number; end: number } }
export function localPlaylist(text: string, base: string): { text: string; resources: HlsResource[] } {
  parseMaster(text, base);
  if (!text.includes("#EXT-X-ENDLIST")) throw new ConfigError("当前 HLS 尚未结束，暂只下载完整回放");
  const lines = text.split(/\r?\n/).map(s => s.trim()), output: string[] = [], resources: HlsResource[] = [];
  let pendingRange: string | undefined, priorUrl = "", priorEnd = -1;
  const add = (uri: string, rangeText?: string, isMap = false) => {
    const url = resolve(uri, base); let range: HlsResource["range"];
    if (rangeText) {
      const m = rangeText.match(/^(\d+)(?:@(\d+))?$/);
      if (!m || Number(m[1]) < 1) throw new BadResponse("HLS BYTERANGE 无效");
      if (!m[2] && (isMap || priorUrl !== url || priorEnd < 0)) throw new BadResponse("HLS 隐式 BYTERANGE 缺少同一资源的前驱");
      const start = m[2] ? Number(m[2]) : priorEnd + 1, end = start + Number(m[1]) - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new BadResponse("HLS BYTERANGE 超出范围");
      range = { start, end };
    }
    const file = `resource-${String(resources.length).padStart(6, "0")}.bin`;
    resources.push({ url, file, ...(range ? { range } : {}) });
    if (!isMap) { priorUrl = url; priorEnd = range?.end ?? -1; }
    return file;
  };
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF") || line.startsWith("#EXT-X-MEDIA:")) throw new BadResponse("媒体清单中仍包含主清单");
    if (line.startsWith("#EXT-X-BYTERANGE:")) { pendingRange = line.slice(line.indexOf(":") + 1); continue; }
    if (line.startsWith("#EXT-X-KEY:")) {
      const a = attributes(line);
      if (a.METHOD === "NONE") { output.push(line); continue; }
      if (a.METHOD !== "AES-128" || !a.URI || (a.KEYFORMAT && a.KEYFORMAT !== "identity")) throw new ConfigError("暂不支持该 HLS 加密方式");
      if (a.IV && !/^0x[0-9a-f]{32}$/i.test(a.IV)) throw new BadResponse("HLS IV 无效");
      output.push(`#EXT-X-KEY:METHOD=AES-128,URI="${add(a.URI, undefined, true)}"${a.IV ? `,IV=${a.IV}` : ""}`); continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const a = attributes(line); if (!a.URI) throw new BadResponse("HLS MAP 缺少 URI");
      output.push(`#EXT-X-MAP:URI="${add(a.URI, a.BYTERANGE, true)}"`); continue;
    }
    if (line && !line.startsWith("#")) { output.push(add(line, pendingRange)); pendingRange = undefined; continue; }
    // Do not let ffmpeg discover undeclared network URIs through other extension tags.
    if (line.startsWith("#") && /URI\s*=/.test(line)) throw new ConfigError("暂不支持包含额外 URI 的 HLS 标签");
    output.push(line);
  }
  if (!resources.length || pendingRange) throw new BadResponse("HLS 没有完整的分片列表");
  return { text: output.join("\n"), resources };
}
export async function downloadHls(transfer: Transfer, url: string, dir: string): Promise<string> {
  const response = await transfer.text(url), parsed = localPlaylist(response.text, response.url);
  await fs.mkdir(dir, { recursive: true });
  await pool(parsed.resources, transfer.threads, async resource => {
    const out = path.join(dir, resource.file);
    if (!resource.range) { await downloadFile(transfer, resource.url, { out }); return; }
    const { start, end } = resource.range;
    await transfer.request(resource.url, { headers: { Range: `bytes=${start}-${end}` } }, async res => {
      const match = res.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (res.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) !== end) throw new BadResponse("HLS 字节范围响应不匹配");
      // Range fragments can be large; stream them through a bounded reader.
      if (!res.body) throw new BadResponse("HLS 分片为空");
      const file = await fs.open(out, "w", 0o600), reader = res.body.getReader(); let bytes = 0;
      try {
        while (true) { const r = await reader.read(); if (r.done) break; bytes += r.value.length; if (bytes > end - start + 1) throw new BadResponse("HLS 分片过长"); let offset = 0; while (offset < r.value.length) offset += (await file.write(r.value, offset)).bytesWritten; }
        if (bytes !== end - start + 1) throw new TransportError("HLS 分片长度不完整");
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close(); }
    });
  });
  const playlist = path.join(dir, "local.m3u8"); await fs.writeFile(playlist, parsed.text); return playlist;
}
