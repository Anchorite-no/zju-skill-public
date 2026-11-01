import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigError } from "../core/errors.ts";
import { downloadFile, exists, publish, type Transfer } from "./download.ts";
import { resolveHls, downloadHls } from "./hls.ts";
import { checkFfmpeg, runFfmpeg } from "./ffmpeg.ts";
import type { Asset } from "./types.ts";

export type AudioFormat = "m4a" | "wav" | "mp3";
export async function extractLocalAudio(input: string, out: string, format: AudioFormat = "wav", signal?: AbortSignal): Promise<{ path: string; bytes: number }> {
  await checkFfmpeg();
  const target = path.resolve(out); await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.audio-${randomUUID()}.${format}`);
  try {
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", path.resolve(input), "-map", "0:a:0", "-vn",
      ...(format === "wav" ? ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"] : format === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "96k"] : ["-c:a", "aac", "-b:a", "96k"]), temp], signal ? { signal } : {});
    if ((await fs.stat(temp)).size <= 44) throw new ConfigError("提取的音频为空");
    await publish(temp, target); return { path: target, bytes: (await fs.stat(target)).size };
  } finally { await fs.unlink(temp).catch(() => {}); }
}
export async function downloadMedia(transfer: Transfer, asset: Asset, opts: { out: string; audioOnly?: boolean; audioFormat?: AudioFormat; resume?: boolean; ffmpeg?: string }): Promise<{ path: string; bytes: number; independentAudio: boolean; warning?: string }> {
  const out = path.resolve(opts.out), hls = /\.m3u8$/i.test(new URL(asset.url).pathname);
  if (await exists(out)) throw new ConfigError(`文件已存在：${out}`);
  if (!opts.audioOnly && !hls) { const result = await downloadFile(transfer, asset.url, { out, ...(opts.resume !== undefined ? { resume: opts.resume } : {}) }); return { ...result, independentAudio: false }; }
  await checkFfmpeg(opts.ffmpeg);
  const format = opts.audioFormat ?? "m4a";
  if (!["m4a", "wav", "mp3"].includes(format)) throw new ConfigError("audio-format 须为 m4a / wav / mp3");
  await fs.mkdir(path.dirname(out), { recursive: true });
  const work = await fs.mkdtemp(path.join(path.dirname(out), ".zhiyun-media-"));
  const temp = path.join(work, `output-${randomUUID()}.${opts.audioOnly ? format : "mp4"}`);
  const inputArgs: string[] = [];
  let independentAudio = asset.kind === "audio", separateAudio = false;
  const source = out + ".source";
  let completed = false;
  try {
    if (hls) {
      const selected = await resolveHls(transfer, asset.url, !!opts.audioOnly);
      independentAudio ||= selected.independentAudio;
      for (const [name, url] of Object.entries(selected).filter(([name]) => name === "video" || name === "audio")) {
        const local = await downloadHls(transfer, url as string, path.join(work, name));
        inputArgs.push("-protocol_whitelist", "file,crypto,data", "-allowed_extensions", "ALL", "-i", local);
      }
      separateAudio = !!selected.video && !!selected.audio;
    } else {
      // Keep an already completed source after interrupted transcoding; never silently trust it on a later run.
      if (await exists(source)) throw new ConfigError(`存在上次保留的源文件：${source}`, "可手动用 FFmpeg 转换该文件，或移走后重试");
      await downloadFile(transfer, asset.url, { out: source, ...(opts.resume !== undefined ? { resume: opts.resume } : {}) });
      inputArgs.push("-i", source);
    }
    const encoding = opts.audioOnly
      ? ["-map", "0:a:0", "-vn", ...(format === "wav" ? ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"] : format === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "96k"] : ["-c:a", "aac", "-b:a", "96k"])]
      : ["-map", "0:v:0", "-map", separateAudio ? "1:a:0" : "0:a:0?", "-c", "copy"];
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-nostdin", "-n", ...inputArgs, ...encoding, ...(opts.audioOnly && format !== "m4a" ? [] : ["-movflags", "+faststart"]), temp], { ...(transfer.options.signal ? { signal: transfer.options.signal } : {}), ...(opts.ffmpeg ? { executable: opts.ffmpeg } : {}) });
    await publish(temp, out); completed = true;
    if (!hls) await fs.unlink(source);
    const warning = opts.audioOnly && !independentAudio ? "源站未提供独立音轨；仅保留音频，但下载阶段仍传输了含视频的媒体数据。" : undefined;
    return { path: out, bytes: (await fs.stat(out)).size, independentAudio, ...(warning ? { warning } : {}) };
  } finally {
    // Work is a freshly created directory, resolved under the output parent, with our fixed prefix.
    const resolved = path.resolve(work), parent = path.resolve(path.dirname(out));
    if (completed && path.dirname(resolved) === parent && path.basename(resolved).startsWith(".zhiyun-media-")) await fs.rm(resolved, { recursive: true, force: true });
    // On failure retain the work directory and completed source for inspection/recovery.
  }
}
