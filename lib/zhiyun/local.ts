import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ConfigError } from "../core/errors.ts";
import { paths } from "../core/paths.ts";
import { writeJson, readJson } from "../core/fsjson.ts";
import { checkAsr, transcribeAudio, extractMaterialText, parseSegments, type AsrOptions } from "./asr.ts";
import { extractLocalAudio } from "./media.ts";
import { sha256, validStage } from "./cache.ts";
function timestamp(seconds: number): string { const n=Math.floor(seconds);return [Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(v=>String(v).padStart(2,'0')).join(':'); }
import { exists } from "./download.ts";

const key = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function audioMarkdown(result: { segments: string }): Promise<string> {
  const output = path.join(path.dirname(result.segments), "transcript.md");
  const segments = parseSegments(JSON.parse(await fs.readFile(result.segments, "utf8")));
  const body = ["# 音频转写粗稿", "", "SenseVoice 等本地模型的识别结果，未做总结；公式、数字和作业要求需结合课件核对。", "",
    ...segments.flatMap(s => [`[${s.start === null ? "时间未知" : `${timestamp(s.start)}–${timestamp(s.end!)}`}] ${s.text}`, ""])].join("\n");
  try { await fs.writeFile(output, body, { flag: "wx", mode: 0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } // Preserve a manually edited rough draft.
  return output;
}
export interface LocalOperations { checkAsr: typeof checkAsr; transcribeAudio: typeof transcribeAudio; extractMaterialText: typeof extractMaterialText; extractLocalAudio: typeof extractLocalAudio }
export async function localTranscribe(audioFile: string, directory: string, opts: AsrOptions = {}, overrides: Partial<LocalOperations> = {}) {
  const ops = { checkAsr, transcribeAudio, extractMaterialText, extractLocalAudio, ...overrides };
  const audio = path.resolve(audioFile), dir = path.resolve(directory), info = await ops.checkAsr(opts);
  const hash = await sha256(audio), cache = path.join(dir, "transcribe.json");
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, "transcribe.lock"), handle = await fs.open(lock, "wx", 0o600).catch(() => { throw new ConfigError(`转写目录已锁定：${lock}`); });
  try {
    const old = readJson<{ key: string; files: { path: string; bytes: number; sha256: string }[]; result: unknown }>(cache);
    if (!old && await exists(cache)) throw new ConfigError("transcribe.json 损坏，请使用新目录");
    const signature = key({ audio: hash, signature: info.signature, batch: opts.batchSeconds ?? 60 });
    if (await validStage(old, signature)) {
      const result = old!.result as { segments: string };
      return { ...result, markdown: await audioMarkdown(result), reused: true };
    }
    const normalized = path.join(dir, `audio-${randomUUID().slice(0, 8)}.wav`);
    await ops.extractLocalAudio(audio, normalized, "wav", opts.signal);
    const output = path.join(dir, `asr-${opts.engine ?? "sensevoice"}-${randomUUID().slice(0, 8)}`);
    const asr = await ops.transcribeAudio(normalized, output, opts);
    if (asr.signature !== info.signature) throw new ConfigError("ASR 环境在执行中变化，请重试");
    const result = { ...asr, audio: normalized, segments: path.join(output, "segments.json"), metadata: path.join(output, "metadata.json"), text: path.join(output, "transcript.txt"), raw: path.join(output, "raw.json"), cache };
    const files = await Promise.all([normalized, result.segments, result.metadata, result.text, result.raw].map(async file => ({ path: file, bytes: (await fs.stat(file)).size, sha256: await sha256(file) })));
    writeJson(cache, { key: signature, files, result }); return { ...result, markdown: await audioMarkdown(result), reused: false };
  } finally { await handle.close(); await fs.unlink(lock).catch(() => {}); }
}

/** Text and original slide images for direct AI reading. No ASR/model loading. */
export async function transcribeCourseware(fileName: string, directory: string, overrides: Partial<LocalOperations> = {}) {
  const source = path.resolve(fileName), dir = path.resolve(directory);
  const signature = key({ source: await sha256(source), extractor: await sha256(path.join(paths.root, "scripts/zhiyun/extract.py")) });
  const cache = path.join(dir, "courseware-cache.json"); await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, "courseware.lock"), handle = await fs.open(lock, "wx", 0o600).catch(() => { throw new ConfigError(`课件目录已锁定：${lock}`); });
  try {
    const old = readJson<{ key: string; files: { path: string; bytes: number; sha256: string }[]; result: { source: string; json: string; markdown: string; status: string; imageCount: number; pageCount: number; visualDedup?: boolean } }>(cache);
    if (!old && await exists(cache)) throw new ConfigError("课件缓存损坏，请使用新目录");
    const cached = old?.result.status !== "unsupported" && old?.result.visualDedup !== false && await validStage(old, signature);
    const stage = cached ? path.dirname(old!.result.json) : path.join(dir, `courseware-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(stage, { recursive: true });
    const json = path.join(stage, "courseware.json"), markdown = path.join(stage, "courseware.md");
    const extracted = cached ? JSON.parse(await fs.readFile(json, "utf8")) as Awaited<ReturnType<typeof extractMaterialText>>
      : await (overrides.extractMaterialText ?? extractMaterialText)(source, { imagesDir: path.join(stage, "images") });
    if (extracted.status === "error") throw new ConfigError(`课件提取失败：${extracted.reason ?? "未知原因"}`);
    const link = (p: string) => {
      const rel = path.relative(stage, p).replace(/\\/g, "/");
      return encodeURI(rel).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16)}`);
    };
    const images = extracted.images ?? [];
    const uniqueImageCount = new Set(images.map(i => i.path)).size;
    const duplicateImageCount = images.length - uniqueImageCount, nearDuplicateCount = images.filter(i => i.similarTo).length;
    const lines = [`# ${path.basename(source).replace(/[\r\n]/g, " ")}`, "", `[原始课件](${link(source)})`, "", `提取状态：${extracted.status}。${extracted.reason ?? "以下为文件已有文字。"}`, "",
      "原图按课件页序列出，供 AI 直接查看；这是嵌入图片提取，不是完整幻灯片渲染或 OCR。", "",
      `图片引用 ${images.length} 次，保存 ${uniqueImageCount} 张，完全重复 ${duplicateImageCount} 次，近似候选 ${nearDuplicateCount} 张（保留，需看图核对）。`, ""];
    if (extracted.dedup?.visualAvailable === false) lines.push("未安装 Pillow，本次只检查字节一致；尚未执行像素比较与近似图检测。", "");
    const pageNumbers = [...new Set([...(extracted.pages ?? []).map(p => p.page), ...(extracted.images ?? []).map(p => p.page)])].sort((a, b) => a - b);
    for (const page of pageNumbers) {
      lines.push(`## 第 ${page} 页`, "");
      for (const row of (extracted.pages ?? []).filter(p => p.page === page)) lines.push(row.text, "");
      for (const [i, row] of images.filter(p => p.page === page).entries()) {
        lines.push(`- [本页原图 ${i + 1}](${link(row.path)})${row.duplicateOf === undefined ? "" : `，与第 ${row.duplicateOf} 页的图片完全相同，复用原图`}`);
        if (row.similarTo) lines.push(`  与[第 ${row.similarTo.page} 页原图](${link(row.similarTo.path)})近似，仍保留。请核对文字、公式和动画增量后决定是否合并展示。`);
      }
      lines.push("");
    }
    const result = { source, json, markdown, status: extracted.status, imageCount: images.length, uniqueImageCount, duplicateImageCount, nearDuplicateCount, visualDedup: extracted.dedup?.visualAvailable ?? true, pageCount: pageNumbers.length };
    if (!cached) {
      writeJson(json, { source, ...extracted });
      const files = await Promise.all([...new Set([json, ...images.map(i => i.path)])].map(async p => ({ path: p, bytes: (await fs.stat(p)).size, sha256: await sha256(p) })));
      writeJson(cache, { key: signature, files, result });
    }
    try { await fs.writeFile(markdown, lines.join("\n"), { flag: "wx", mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    return { ...result, reused: cached };
  } finally { await handle.close(); await fs.unlink(lock).catch(() => {}); }
}
