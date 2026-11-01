import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../core/paths.ts";
import { env } from "../core/env.ts";
import { ZjuError, BadResponse } from "../core/errors.ts";

export function ffmpegPath(): string {
  const configured = env("FFMPEG_PATH");
  if (configured) return configured;
  const managed = path.join(paths.data(), "tools", "zhiyun-media", "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  return fs.existsSync(managed) ? managed : "ffmpeg";
}
export async function runFfmpeg(args: string[], opts: { signal?: AbortSignal; executable?: string; cwd?: string } = {}): Promise<void> {
  const executable = opts.executable ?? ffmpegPath();
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once("error", (e: NodeJS.ErrnoException) => reject(e.code === "ENOENT" ? new ZjuError("DEPENDENCY_MISSING", "音频提取 / HLS 封装需要 FFmpeg", { hint: "运行 zju zhiyun setup --component media；也可在 .env 设置 FFMPEG_PATH=已有可执行文件绝对路径；zhiyun check --component media 检查" }) : e));
    child.once("close", code => code === 0 ? resolve() : reject(new BadResponse(`FFmpeg 失败（${code}）`, { stderr })));
  });
}
export async function checkFfmpeg(executable?: string): Promise<{ available: true; executable: string }> {
  const binary = executable ?? ffmpegPath(); await runFfmpeg(["-version"], { executable: binary }); return { available: true, executable: binary };
}
