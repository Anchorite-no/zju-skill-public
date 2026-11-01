import path from "node:path";
import { paths } from "../core/paths.ts";
import { env } from "../core/env.ts";
import { ConfigError } from "../core/errors.ts";
import { command, group, str, num, bool, type Option, type Flags } from "../core/command.ts";
import { checkAsr, checkCourseware, type AsrOptions } from "./asr.ts";
import { checkFfmpeg } from "./ffmpeg.ts";
import { localTranscribe, transcribeCourseware } from "./local.ts";
import { setupLocal, type SetupComponent } from "./setup.ts";

const asr: Record<string, Option> = {
  engine: { description: "本地转写引擎", choices: ["sensevoice", "firered"], default: "sensevoice" },
  device: { description: "计算设备", choices: ["auto", "cuda:0", "cpu"], default: "auto" },
  "batch-seconds": { description: "SenseVoice 批量时长", type: "integer", default: 60, min: 1, max: 600 },
};
const opts = (f: Flags): AsrOptions => ({ engine: str(f, "engine") as "sensevoice" | "firered", device: str(f, "device") as "auto" | "cuda:0" | "cpu", batchSeconds: num(f, "batch-seconds") });
function configuredAsr(): AsrOptions {
  const engine = env("ZJU_ASR_ENGINE", "sensevoice"), device = env("ZJU_ASR_DEVICE", "auto"), batchSeconds = Number(env("ZJU_ASR_BATCH_SECONDS", "60"));
  if (!["sensevoice", "firered"].includes(engine) || !["auto", "cuda:0", "cpu"].includes(device) || !Number.isSafeInteger(batchSeconds) || batchSeconds < 1 || batchSeconds > 600) throw new ConfigError("ASR 运行配置无效");
  return { engine: engine as AsrOptions["engine"] & string, device: device as AsrOptions["device"] & string, batchSeconds };
}
const input: Record<string, Option> = { file: { description: "本地输入文件", required: true }, "out-dir": { description: "可选输出目录，默认自动生成" } };
async function cancellable<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(), abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try { return await run(controller.signal); } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}
const output = (f: Flags) => typeof f['out-dir'] === 'string' ? f['out-dir'] : path.join(paths.output(), 'zhiyun', path.basename(str(f, 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") + '-trans');
export const localCommands = {
  setup: command("准备智云本地依赖；复用可用环境，按需安装，默认只选 SenseVoice", {
    component: { description: "需要准备的能力；ppt 只装文档依赖", choices: ["all", "media", "asr", "ppt"], default: "all" },
    engine: { description: "ASR 引擎；FireRed 仅在显式选择时安装", choices: ["sensevoice", "firered"], default: "sensevoice" },
    cpu: { description: "新建 ASR 环境时使用 CPU 版 PyTorch", type: "boolean" },
  }, f => setupLocal({ component: str(f, "component") as SetupComponent, engine: str(f, "engine") as AsrOptions["engine"] & string, cpu: bool(f, "cpu") }), "local"),
  check: command("检查本地组件", { component: { description: "组件", choices: ["asr", "media", "ppt"], default: "asr" }, ...asr }, async f => f.component === "media" ? checkFfmpeg() : f.component === "ppt" ? checkCourseware() : checkAsr(opts(f)), "local"),
  trans: group("audio 转写录音；ppt 提取课件，直接供 AI 阅读", {
    audio: command("本地音视频 → 带时间的 Markdown 粗稿、TXT 和原始 JSON", { ...input }, f => cancellable(signal => localTranscribe(str(f, "file"), output(f), { ...configuredAsr(), signal })), "local"),
    ppt: command("课件文字/原图提取与去重，近似图标记供 AI 核对；不做 OCR", input, f => transcribeCourseware(str(f, "file"), output(f)), "local"),
  }),
};
