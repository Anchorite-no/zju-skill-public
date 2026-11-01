import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { paths } from "../core/paths.ts";
import { env } from "../core/env.ts";
import { BadResponse, ConfigError, ZjuError } from "../core/errors.ts";
import { log } from "../core/output.ts";

export type AsrEngine = "sensevoice" | "firered";
export type AsrDevice = "auto" | "cuda:0" | "cpu";
export interface AsrOptions { engine?: AsrEngine; device?: AsrDevice; batchSeconds?: number; signal?: AbortSignal }
export interface AsrInfo { engine: AsrEngine; device: string; signature: string; versions: Record<string, string> }
export interface Segment { start: number | null; end: number | null; text: string }
export interface MaterialText {
  status: "text" | "no_text" | "unsupported" | "error";
  pages?: { page: number; text: string }[];
  images?: { page: number; path: string; duplicateOf?: number; similarTo?: { page: number; path: string; distance: number; thumbnailRmse?: number } }[];
  dedup?: { visualAvailable: boolean; exact: string; near: string; nearDistance: number };
  reason?: string | null;
}

export function engineOf(value = "sensevoice"): AsrEngine {
  if (value !== "sensevoice" && value !== "firered") throw new ConfigError("engine 必须为 sensevoice 或 firered");
  return value;
}
export function pythonPath(engine: AsrEngine = "sensevoice"): string {
  const override = env(engine === "firered" ? "ZJU_FIRERED_PYTHON" : "ZJU_ASR_PYTHON");
  return override || path.join(paths.data(), "tools", engine === "firered" ? "zhiyun-firered" : "zhiyun-asr", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}
async function pythonJson(script: string, args: string[], opts: AsrOptions = {}): Promise<unknown> {
  const executable = pythonPath(opts.engine);
  const setup = script === "extract.py" ? "zju zhiyun setup --component ppt" : `zju zhiyun setup --component asr --engine ${opts.engine ?? "sensevoice"}`;
  try { await fs.access(executable); } catch {
    throw new ZjuError("DEPENDENCY_MISSING", "本地处理环境尚未安装", { hint: setup });
  }
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const child = spawn(executable, ["-X", "utf8", path.join(paths.root, "scripts", "zhiyun", script), ...args], {
      cwd: paths.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ZJU_DATA_DIR: paths.data(), PYTHONUTF8: "1" }, ...(opts.signal ? { signal: opts.signal } : {}),
    });
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
      if (Buffer.byteLength(stdout) > 20 * 1024 * 1024) { child.kill(); reject(new BadResponse("Python 输出超过 20 MiB")); }
    });
    child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-2500); });
    child.once("error", reject);
    child.once("close", code => {
      let result: any;
      try { result = JSON.parse(stdout); } catch { reject(new BadResponse("本地脚本未返回有效 JSON", { script, exitCode: code, stderr })); return; }
      if (code !== 0 || result?.ok === false) {
        const message = result?.error?.message ?? `本地脚本退出 ${code}`;
        // Accept the legacy worker code without changing its fingerprint or invalidating ASR caches.
        const missing = ["DEPENDENCY_MISSING", "PLUGIN_NOT_INSTALLED"].includes(result?.error?.code);
        reject(new ZjuError(missing ? "DEPENDENCY_MISSING" : "BAD_RESPONSE", message,
          missing ? { hint: setup } : {}));
      } else resolve(result?.ok === true ? result.data : result);
    });
  });
}
function workerArgs(opts: AsrOptions): string[] {
  return ["--engine", opts.engine ?? "sensevoice", "--device", opts.device ?? "auto", "--batch-seconds", String(opts.batchSeconds ?? 60)];
}
export async function checkAsr(opts: AsrOptions = {}): Promise<AsrInfo> {
  const info = await pythonJson("worker.py", ["check", ...workerArgs(opts)], opts) as AsrInfo;
  if (!info.signature || !info.device) throw new BadResponse("ASR 环境检查结果无效");
  return info;
}
export async function transcribeAudio(audio: string, out: string, opts: AsrOptions = {}): Promise<AsrInfo & { durationSeconds: number; segmentCount: number }> {
  log(`本地转写 ${opts.engine ?? "sensevoice"}：${path.basename(audio)}`);
  return await pythonJson("worker.py", ["transcribe", "--audio", path.resolve(audio), "--out", path.resolve(out), ...workerArgs(opts)], opts) as AsrInfo & { durationSeconds: number; segmentCount: number };
}
export async function extractMaterialText(file: string, opts: AsrOptions & { imagesDir?: string } = {}): Promise<MaterialText> {
  return await pythonJson("extract.py", [path.resolve(file), ...(opts.imagesDir ? ["--images-dir", path.resolve(opts.imagesDir)] : [])], opts) as MaterialText;
}
export async function checkCourseware(): Promise<unknown> { return pythonJson("extract.py", ["--check"]); }
export function parseSegments(value: unknown): Segment[] {
  if (!Array.isArray(value) || !value.length) throw new BadResponse("转写结果缺少句段");
  return value.map(row => {
    if (!row || typeof row !== "object" || typeof row.text !== "string") throw new BadResponse("转写句段格式无效");
    const { start, end, text } = row;
    if ((start === null) !== (end === null) || (start !== null && (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start))) throw new BadResponse("转写时间戳无效");
    return { start, end, text };
  });
}
