/** Local dependencies belong to zhiyun; setup is invoked only through its CLI/API. */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { paths } from "../core/paths.ts";
import { ConfigError, ZjuError } from "../core/errors.ts";
import { env } from "../core/env.ts";
import { checkAsr, checkCourseware, engineOf, pythonPath, type AsrEngine } from "./asr.ts";
import { checkFfmpeg } from "./ffmpeg.ts";

export type SetupComponent = "all" | "media" | "asr" | "ppt";
export interface SetupOptions { component?: SetupComponent; engine?: AsrEngine; cpu?: boolean }

async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(process.stderr); child.stderr.pipe(process.stderr);
    child.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? new ConfigError(`缺少命令 ${executable}`, "Python 环境需要 uv；可选 FireRed 还需要 Git") : error));
    child.once("close", code => code === 0 ? resolve() : reject(new ConfigError(`${executable} 退出 ${code}`)));
  });
}
function missing(error: unknown): boolean {
  return error instanceof ZjuError && error.code === "DEPENDENCY_MISSING";
}
async function ensurePython(engine: AsrEngine): Promise<string> {
  const python = pythonPath(engine);
  const managed = path.join(paths.data(), "tools", engine === "sensevoice" ? "zhiyun-asr" : "zhiyun-firered", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (path.resolve(python) !== path.resolve(managed)) throw new ConfigError("setup 不修改自备 Python 环境", "修复自备环境，或取消 ZJU_ASR_PYTHON / ZJU_FIRERED_PYTHON 覆盖后再运行 setup");
  try { await fs.access(python); }
  catch { await run("uv", ["venv", "--python", "3.12", path.dirname(path.dirname(python))]); }
  return python;
}
async function installPackages(python: string, packages: string[]): Promise<void> {
  await run("uv", ["pip", "install", "--python", python, ...packages, "--link-mode", "copy"]);
}
async function setupMedia() {
  try { return { component: "media", reused: true, ...await checkFfmpeg() }; }
  catch (error) { if (!missing(error)) throw error; }
  if (env("FFMPEG_PATH")) throw new ConfigError("FFMPEG_PATH 指向的程序不可用", "修复此路径，或取消覆盖后由 zhiyun setup --component media 安装");
  const destination = path.join(paths.data(), "tools", "zhiyun-media");
  await fs.mkdir(destination, { recursive: true });
  const args = ["install", "--prefix", destination, "--no-audit", "--no-fund", "--save-exact", "ffmpeg-static@5.3.0"];
  let executable = "npm";
  if (process.platform === "win32") {
    const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    try { await fs.access(npmCli); } catch { throw new ConfigError("无法定位 npm-cli.js", "请通过 npm run zju -- zhiyun setup --component media 调用，或配置 FFMPEG_PATH"); }
    executable = process.execPath; args.unshift(npmCli);
  }
  await run(executable, args);
  return { component: "media", reused: false, destination, ...await checkFfmpeg() };
}
async function setupAsr(engine: AsrEngine, cpu: boolean) {
  const device = cpu ? "cpu" : "auto";
  try { return { component: "asr", reused: true, ...await checkAsr({ engine, device }) }; }
  catch (error) { if (!missing(error)) throw error; }
  const python = await ensurePython(engine);
  await run("uv", ["pip", "install", "--python", python, "torch==2.10.0", "torchaudio==2.10.0", "--index-url", `https://download.pytorch.org/whl/${cpu ? "cpu" : "cu128"}`, "--link-mode", "copy"]);
  await installPackages(python, engine === "sensevoice"
    ? ["funasr==1.4.15", "soundfile>=0.12.1", "sentencepiece==0.2.2", "einops", "modelscope", "pypdf>=5,<7", "pillow>=11,<13"]
    : ["transformers==4.51.3", "numpy==1.26.4", "cn2an==0.5.23", "kaldiio==2.18.0", "kaldi-native-fbank==1.22.3", "sentencepiece==0.2.2", "soundfile==0.12.1", "textgrid", "peft==0.15.2", "modelscope", "pypdf>=5,<7", "pillow>=11,<13"]);
  if (engine === "firered") {
    const source = path.join(paths.data(), "tools", "zhiyun-firered", "FireRedASR2S");
    try { await fs.access(source); } catch {
      await run("git", ["clone", "https://github.com/FireRedTeam/FireRedASR2S.git", source]);
      await run("git", ["-C", source, "checkout", "--detach", "4e7d9aaf4482a47cec1724807026b9b151926eb5"]);
    }
  }
  await run(python, ["-X", "utf8", path.join(paths.root, "scripts/zhiyun/setup_models.py"), "--engine", engine, "--models", path.join(paths.data(), "models/zhiyun-asr")]);
  await run("uv", ["pip", "check", "--python", python]);
  return { component: "asr", reused: false, ...await checkAsr({ engine, device }) };
}
async function setupPpt() {
  try {
    const info = await checkCourseware() as { pdfTextAvailable?: boolean; visualDedupAvailable?: boolean };
    if (info.pdfTextAvailable && info.visualDedupAvailable) return { component: "ppt", reused: true, ...info };
  } catch (error) { if (!missing(error)) throw error; }
  const python = await ensurePython("sensevoice");
  await installPackages(python, ["pypdf>=5,<7", "pillow>=11,<13"]);
  return { component: "ppt", reused: false, ...await checkCourseware() as Record<string, unknown> };
}
export async function setupLocal(opts: SetupOptions = {}) {
  const component = opts.component ?? "all", engine = engineOf(opts.engine);
  if (!["all", "media", "asr", "ppt"].includes(component)) throw new ConfigError("component 必须为 all/media/asr/ppt");
  const results: Record<string, unknown>[] = [];
  if (component === "all" || component === "media") results.push(await setupMedia());
  if (component === "all" || component === "asr") results.push(await setupAsr(engine, opts.cpu ?? false));
  if (component === "all" || component === "ppt") results.push(await setupPpt());
  return { component, results };
}
