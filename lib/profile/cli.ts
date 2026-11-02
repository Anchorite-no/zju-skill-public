/** Passwords arrive through a masked terminal prompt or stdin, never command arguments. */
import { command, type Option } from "../core/command.ts";
import { ConfigError } from "../core/errors.ts";
import { initProfile, publicProfile, validateProfileValues } from "./profile.ts";
import { promptAccount, readInput, SYSTEMS } from "./input.ts";

const field = (description: string): Option => ({ description, allowEmpty: true });
const SETTINGS = {
  transport: { description: "校内站点的访问方式", choices: ["webvpn", "direct"] },
  college: field("学院全称"), grade: field("入学年份"),
  "student-level": field("本科生或研究生"),
  "major-name": field("专业名称"), "major-code": field("专业代码"),
} satisfies Record<string, Option>;

export const profileCommands = {
  init: command("加密保存账号；--system 在终端输入账号和密码，--stdin 从标准输入接收 JSON", {
    system: { description: "要配置的账号；密码输入不回显", choices: Object.keys(SYSTEMS) },
    index: { description: "CC98 或场馆同伴的账号序号", type: "integer", min: 1, max: 99 },
    stdin: { description: "从标准输入读配置 JSON，不与 --system 同用", type: "boolean" },
    ...SETTINGS,
  }, async flags => {
    if (flags.stdin && flags.system) throw new ConfigError("--stdin 与 --system 不能一起使用");
    if (flags.index !== undefined && !["cc98", "buddy"].includes(String(flags.system))) throw new ConfigError("--index 只适用于 --system cc98 或 buddy");
    let values: Record<string, string> = {};
    if (flags.stdin) values = validateProfileValues(await readInput());
    else if (typeof flags.system === "string") values = await promptAccount(flags.system, Number(flags.index ?? 1));
    for (const key of Object.keys(SETTINGS)) if (typeof flags[key] === "string") values[key.replaceAll("-", "_")] = flags[key];
    const result = initProfile(values);
    return { ...result, next: "账号已加密保存；配置其他账号请运行 profile init --system 对应系统", ...publicProfile() };
  }, "local"),
  show: command("显示配置；密码只显示是否已填", {}, async () => publicProfile(), "local"),
};
