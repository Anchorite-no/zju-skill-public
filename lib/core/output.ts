/**
 * 统一 JSON 信封与 stderr 日志。stdout 只输出一个 JSON；进度、调试全部走 stderr。
 */
import { ZjuError, exitCodeFor } from "./errors.ts";
import { debugEnabled } from "./env.ts";
import { currentAddresses } from "./moved.ts";
import { redact, redactText } from "./redact.mjs";
export { redact } from "./redact.mjs";

export type Source = "live" | "cache" | "local";

export interface Envelope<T = unknown> {
  ok: true;
  system: string;
  action: string;
  source: Source;
  generated_at: string;
  meta: Record<string, unknown>;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  system: string;
  action: string;
  generated_at: string;
  error: { code: string; message: string; hint?: string; detail?: Record<string, unknown> };
}

/** 结果里出现的、学校已经停用的旧地址（旧文件里的老素拓网地址这类）换成现在的地址，见 moved.ts。 */
export function envelope<T>(system: string, action: string, data: T, opts: { source?: Source; meta?: Record<string, unknown> } = {}): Envelope<T> {
  return { ok: true, system, action, source: opts.source ?? "live", generated_at: new Date().toISOString(), meta: opts.meta ?? {}, data: currentAddresses(data) };
}

export function errorEnvelope(system: string, action: string, err: unknown): ErrorEnvelope {
  const base = { ok: false as const, system, action, generated_at: new Date().toISOString() };
  if (err instanceof ZjuError) {
    const e: ErrorEnvelope["error"] = { code: err.code, message: redactText(err.message) };
    if (err.hint) e.hint = redactText(err.hint);
    if (Object.keys(err.detail).length) e.detail = redact(err.detail) as Record<string, unknown>;
    return { ...base, error: e };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ...base, error: { code: "INTERNAL", message: redactText(message) } };
}

export function printAndExit(payload: Envelope | ErrorEnvelope, err?: unknown): void {
  const code = payload.ok ? 0 : exitCodeFor(err);
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n", () => process.exit(code));
}

/** 平台时间（UTC/带时区 ISO 或毫秒时间戳）→ 北京时间「YYYY-MM-DD HH:mm」；缺失或无效为 null。 */
export function beijingMinute(value: unknown): string | null {
  const at = typeof value === "number" ? value : typeof value === "string" && value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : null;
}

const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

/**
 * 透传平台结构的命令用：结果里所有 UTC ISO 时间（以 Z 结尾）换成北京时间「YYYY-MM-DD HH:mm」，
 * 平台用 1970-01-01 表示未设置的换成 null；其余值原样返回。
 */
export function beijingTimes<T>(value: T, depth = 0): T {
  if (typeof value === "string") {
    if (!UTC_ISO.test(value)) return value;
    const at = Date.parse(value);
    return (at === 0 ? null : beijingMinute(at) ?? value) as T;
  }
  if (depth > 20 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => beijingTimes(v, depth + 1)) as T;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, beijingTimes(v, depth + 1)])) as T;
}

/** 字节数 → 「8.3 MB」这类可读大小。 */
export function fileSize(bytes: unknown): string | null {
  const n = Number(bytes);
  if (typeof bytes !== "number" || !Number.isFinite(n) || n < 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = n, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

export function log(msg: string): void {
  process.stderr.write(`[zju] ${redactText(msg)}\n`);
}

/** 下载进度的一行：已经收到的字节数和总字节数（总量还估不出来时是 0）。前缀固定，启动这条命令的程序按它认。 */
export function progress(state: { bytes: number; total: number }): void {
  process.stderr.write(`[zju:progress] ${JSON.stringify(state)}\n`);
}

export function debug(msg: string): void {
  if (debugEnabled()) process.stderr.write(`[zju:debug] ${redactText(msg)}\n`);
}
