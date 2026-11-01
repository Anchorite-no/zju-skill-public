/** Generate public command documentation from the same registry used at runtime. */
import fs from "node:fs/promises";
import path from "node:path";
import { modules } from "../lib/cli.ts";
import { publicCommands } from "../lib/core/cli.ts";
import { paths } from "../lib/core/paths.ts";

const visible = Object.entries(modules).filter(([, module]) => !module.hidden);
const rows = visible.flatMap(([name, module]) => publicCommands(module.commands, name));
const lines = ["# 当前命令总表", "", `生成日期：${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date())}。共 ${rows.length} 条公开命令路径、${visible.length} 个模块。`, "",
  "入口为 `node scripts/zju.ts <module> <command> [参数]`。默认帮助逐级展示；`--help --all` 展开当前范围全部公开命令。参数类型与帮助来自实际注册定义，本生成器不执行登录或业务。", "",
  "系统归属见 [架构](../dev/architecture.md)。未知参数、多余位置参数和错误类型会报错；业务对象的进一步校验由模块负责。", "",
  "| 模块 | 公开路径数 | 范围 |", "|---|---:|---|",
  ...visible.map(([name, module]) => `| [${name}](#${name}) | ${publicCommands(module.commands, name).length} | ${module.description} |`), ""];
for (const [name, module] of visible) {
  lines.push(`## ${name}`, "", module.description, "");
  for (const row of publicCommands(module.commands, name)) {
    lines.push(`### ${row.path}`, "", "```text", `zju ${row.path} ${row.command.help}`, "```", "");
    const entries = Object.entries(row.command.options ?? {});
    if (!entries.length) { lines.push("无参数。", ""); continue; }
    const types = entries.map(([key, option]) => `\`--${key}\`：${option.choices?.join(" / ") ?? (option.type === "boolean" ? "开关" : option.type === "integer" ? "整数" : option.type === "number" ? "数值" : "文本/路径")}${option.required ? "，必填" : ""}${option.default === undefined ? "" : `，默认 ${option.default}`}${option.min === undefined ? "" : `，最小 ${option.min}`}${option.max === undefined ? "" : `，最大 ${option.max}`}${option.allowEmpty ? "，允许空值清除配置" : ""}`);
    lines.push(types.join("；") + "。", "");
  }
}
lines.push("## 边界与数据衔接", "",
  "- 业务自动认证；session 仅作维护。网络和 URL 工具均在 webvpn。",
  "- zdbk selection 通过课程、教师和上课时间自动定位，课程池与搜索条件由内部保留。普通志愿按用户指定的单次操作提交并回查。培养方案按专业名、学院名查。",
  "- notice 的来源和栏目都写名称；list 与 view 的每条通知是同一种记录，new 只有标题、日期、来源和链接。",
  "- 学在 rollcall 自动发现、执行和回查，确认成功立即结束；duration 为等待上限，默认 600 秒。体艺 rollcall 仅有 status、history 两个只读子命令。",
  "- 学在的课程、作业、文件都按名称定位；下载结果总在 files 列表里。",
  "- zhiyun 支持课程名称；--lesson/--lesson-id/--date/--week-of/--all 互斥。kind 支持 video,audio,ppt,slides,subtitles。视频优先 1080p；仅取音频优先独立音轨或 360p；无独立音轨的混合下载复用视频。",
  "- zhiyun trans 只处理本地文件；音频默认 SenseVoice，ppt 提取已有文字与原图，未启用 OCR。输出交给 AI 按模板直接成稿。", "",
  "## 智云本地依赖", "", "```text", "zju zhiyun setup [--component all|media|asr|ppt] [--engine sensevoice|firered] [--cpu]", "```", "",
  "安装、检查和转写均属于 zhiyun。setup 只在缺依赖时使用并复用现有环境；默认 SenseVoice，单独 ppt 只安装文档处理依赖。", "");
const file = path.join(paths.root, "references/commands.md");
await fs.writeFile(file, lines.join("\n"));
console.log(JSON.stringify({ file, publicRoutes: rows.length }));
