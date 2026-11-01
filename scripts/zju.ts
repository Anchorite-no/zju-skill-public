#!/usr/bin/env node
/** One executable; each module owns its commands and authentication lifecycle. */
import { modules, resolveCommand } from "../lib/cli.ts";
import { parseArgv, describeCommands, leafHelp } from "../lib/core/cli.ts";
import { ConfigError } from "../lib/core/errors.ts";
import { envelope, errorEnvelope, printAndExit, log } from "../lib/core/output.ts";
import { remoteTarget, runRemoteZhiyun } from "../lib/zhiyun/remote.ts";
import { validateOptions } from "../lib/core/command.ts";

function disabledModules(): Set<string> {
  return new Set((process.env.ZJU_DISABLED_MODULES ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean));
}

async function main(): Promise<void> {
  const started = performance.now();
  let system = "cli", action = "";
  try {
    const { values, positionals } = parseArgv(process.argv.slice(2));
    const route = resolveCommand(positionals);
    system = route.system || "cli"; action = route.path.join(" ");
    if (route.system && disabledModules().has(route.system.toLowerCase())) {
      throw new ConfigError(`模块已被当前运行环境禁用：${route.system}`);
    }
    if (system === "lecture") throw new ConfigError("lecture 已移除；请使用 zhiyun check、zhiyun trans audio 或 zhiyun trans ppt。转写结果直接交给 AI 按模板生成 Markdown");
    if (route.system && !modules[route.system]) throw new ConfigError(`未知模块：${route.system}`);
    if (route.path.length && !route.command) throw new ConfigError(`未知命令：${system} ${action}`);
    if (values.help || !positionals.length || !route.path.length) {
      const all = values.all === true || values.all === "true";
      const lines = ["用法: zju <模块> <命令> [参数]", ""];
      if (route.command?.children) {
        if (route.command.options) lines.push(...leafHelp(route.command, `${system} ${action}`), "", "子命令:");
        lines.push(...describeCommands(route.command.children, `${system} ${action}`, all));
      }
      else if (route.command) lines.push(...leafHelp(route.command, `${system} ${action}`));
      else if (route.system) lines.push(...describeCommands(modules[route.system]!.commands, system, all));
      else for (const [name, module] of Object.entries(modules)) if (!module.hidden) {
        lines.push(...(all ? describeCommands(module.commands, name, true) : [`  zju ${name}  ${module.description}`]));
      }
      lines.push("", "逐级使用 --help；--help --all 展开当前范围的全部公开命令。");
      process.stderr.write(lines.join("\n") + "\n");
      process.exit(values.help || positionals.length ? 0 : 1);
    }
    const command = route.command!;
    if (command.children && route.rest.length) {
      throw new ConfigError(`未知子命令：${system} ${action} ${route.rest[0]}；可选 ${Object.entries(command.children).filter(([, c]) => !c.hidden).map(([name]) => name).join(" / ")}`);
    }
    if (route.system === "zhiyun" && remoteTarget()) {
      if (route.rest.length) throw new ConfigError(`不接受位置参数：${route.rest.join(" ")}`);
      if (command.options) validateOptions(command.options, values);
      const { payload, code } = await runRemoteZhiyun(process.argv.slice(2));
      await new Promise<void>(resolve => process.stdout.write(JSON.stringify(payload, null, 2) + "\n", () => resolve()));
      process.exit(code);
    }
    const data = await command.run(values, route.rest);
    printAndExit(envelope(system, action, data, { source: typeof command.source === "function" ? command.source(data) : command.source ?? "live", meta: { durationMs: Math.round(performance.now() - started) } }));
  } catch (err) {
    if (process.env.ZJU_DEBUG === "1" && err instanceof Error && err.stack) log(err.stack);
    printAndExit(errorEnvelope(system, action, err), err);
  }
}
void main();
