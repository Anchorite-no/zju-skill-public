/**
 * .env 解析 + 环境变量合并。
 * 支持：BOM、# 整行注释、`export KEY=V`、单/双引号、未加引号时的 ` # 行内注释`。
 * 真实环境变量优先于 .env 文件。
 */
import fs from "node:fs";
import { paths } from "./paths.ts";

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2) {
      // 引号包裹：取到配对引号为止，其后的 ` # 注释` 丢弃
      const close = value.indexOf(quote, 1);
      value = close > 0 ? value.slice(1, close) : value.slice(1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

let cached: { file: string; values: Record<string, string> } | undefined;

export function loadEnv(file = paths.envFile()): Record<string, string> {
  if (!cached || cached.file !== file) {
    let fileVars: Record<string, string> = {};
    try {
      fileVars = parseEnv(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    cached = { file, values: fileVars };
  }
  // 只缓存文件；库调用方在进程内调整环境变量时，写闸也必须立即生效。
  const merged = { ...cached.values };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && v !== "") merged[k] = v;
  return merged;
}

export function env(key: string, fallback = ""): string {
  return loadEnv()[key] ?? fallback;
}

export function envBool(key: string, fallback = false): boolean {
  const v = env(key, "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function envInt(key: string, fallback: number): number {
  const n = Number(env(key, ""));
  return Number.isFinite(n) && env(key, "") !== "" ? n : fallback;
}

/** 写操作总闸 */
export function writeAllowed(): boolean {
  return envBool("ZJU_ALLOW_WRITE", false);
}

export function debugEnabled(): boolean {
  return envBool("ZJU_DEBUG", false);
}
