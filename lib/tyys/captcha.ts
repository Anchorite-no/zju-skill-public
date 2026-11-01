import path from "node:path";
import fs from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { paths } from "../core/paths.ts";
import { ConfigError, NeedsUser, ZjuError } from "../core/errors.ts";
import { row, text, type Row } from "./venue.ts";

const root = () => path.join(paths.data(), "tools", "tyys", ".venv");
export const captchaPython = () => path.join(root(), process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const helper = () => path.join(paths.root, "scripts", "tyys", "captcha.py");
const missing = (message: string) => new ZjuError("DEPENDENCY_MISSING", message, { hint: "运行 tyys venue setup 安装并验证本地识别环境；Ubuntu 还需 python3-venv、libgl1" });
async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONUTF8: "1", PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True" } });
    child.stdout.pipe(process.stderr); child.stderr.pipe(process.stderr);
    child.once("error", () => reject(missing(`无法启动 ${path.basename(executable)}`)));
    child.once("close", code => code === 0 ? resolve() : reject(missing(`识别环境准备失败（退出码 ${code}）`)));
  });
}
export async function setupCaptcha() {
  const uv = spawnSync("uv", ["--version"], { windowsHide: true, stdio: "ignore" }).status === 0;
  if (!fs.existsSync(captchaPython())) await run(uv ? "uv" : process.platform === "win32" ? "python" : "python3", uv ? ["venv", "--python", "3.10", root()] : ["-m", "venv", root()]);
  const packages = ["ddddocr==1.6.1", "paddleocr==3.4.0", "paddlepaddle==3.3.1"];
  await run(uv ? "uv" : captchaPython(), uv ? ["pip", "install", "--python", captchaPython(), ...packages, "--link-mode", "copy"] : ["-m", "pip", "install", ...packages]);
  await run(captchaPython(), ["-X", "utf8", helper(), "--setup"]);
  return checkCaptcha();
}

/** One local process per booking. All venue HTTP stays in VenueClient. */
export class CaptchaSolver {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: { resolve: (v: Row) => void; reject: (e: Error) => void } | undefined;
  private ready: Promise<void> | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly abort = () => this.close();
  constructor(signal?: AbortSignal) { this.signal = signal; }
  async start(): Promise<void> {
    this.signal?.throwIfAborted();
    if (this.ready) return this.ready;
    if (!fs.existsSync(captchaPython())) throw missing("未安装场馆本地验证码识别环境");
    this.ready = new Promise<void>((resolve, reject) => {
      this.pending = { resolve: v => v.ready === true ? resolve() : reject(missing(text(v.error) || "识别器未就绪")), reject };
      const child = this.child = spawn(captchaPython(), ["-X", "utf8", helper()], { windowsHide: true, stdio: "pipe", env: { ...process.env, PYTHONUTF8: "1", PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True" } });
      const timer = setTimeout(() => this.close(), 120_000);
      const lines = createInterface({ input: child.stdout });
      child.stderr.on("data", () => { /* Model logs are not business results. */ });
      lines.on("line", line => {
        let result: Row;
        try { result = row(JSON.parse(line)); } catch { return; }
        const pending = this.pending; this.pending = undefined;
        if (result.ready === true) clearTimeout(timer);
        pending?.resolve(result);
      });
      const failed = () => { clearTimeout(timer); lines.close(); this.pending?.reject(missing("本地验证码识别进程退出或超时")); this.pending = undefined; this.child = undefined; };
      child.once("error", failed); child.once("close", failed);
      this.signal?.addEventListener("abort", this.abort, { once: true });
      if (this.signal?.aborted) this.close();
    });
    return this.ready;
  }
  async solve(image: string, words: string[]): Promise<{ x: number; y: number }[]> {
    await this.start(); this.signal?.throwIfAborted();
    if (!this.child || this.pending) throw new ConfigError("验证码识别器当前不可用");
    const result = await new Promise<Row>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child!.stdin.write(JSON.stringify({ image, words }) + "\n", error => { if (error) { this.pending = undefined; reject(missing("无法发送验证码至本地识别器")); } });
    });
    if (result.error) throw new NeedsUser("本地验证码识别未完成，请稍后重试");
    const points = result.points;
    if (!Array.isArray(points) || points.length !== words.length || points.some(p => !Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.x >= 310 || p.y < 0 || p.y >= 155)) throw new NeedsUser("验证码识别未返回有效坐标");
    return points as { x: number; y: number }[];
  }
  close(): void {
    this.signal?.removeEventListener("abort", this.abort);
    this.pending?.reject(missing("本地验证码识别已停止")); this.pending = undefined;
    this.child?.kill(); this.child = undefined;
  }
}
export async function checkCaptcha() {
  const solver = new CaptchaSolver();
  try { await solver.start(); return { ready: true, python: captchaPython(), message: "本地检测、识别及 Paddle 兜底模型可用" }; }
  finally { solver.close(); }
}
