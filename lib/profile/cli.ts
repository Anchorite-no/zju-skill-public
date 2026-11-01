/** profile module CLI; business calls stay inside this module. */
import { command, retired, type Command, type Option } from "../core/command.ts";
import { initProfile, publicProfile, type ProfileRaw } from "./profile.ts";

// 账号项可以给空值，用来清除已有配置。
const field = (description: string): Option => ({ description, allowEmpty: true });
const FIELDS = {
  "zju-username": field("统一身份认证学号"), "zju-password": field("统一身份认证密码"),
  "webvpn-username": field("WebVPN（校园网）账号"), "webvpn-password": field("WebVPN（校园网）密码"),
  "pta-username": field("PTA 账号邮箱"), "pta-password": field("PTA 密码"),
} satisfies Record<string, Option>;

export const profileCommands: Record<string, Command> = {
  init: command("生成 profile.env 模板；已存在时只更新给出的项", {
    ...FIELDS, transport: { description: "校内站点的访问方式", choices: ["webvpn", "direct"] },
  }, async (f) => {
    const values: ProfileRaw = {};
    for (const key of [...Object.keys(FIELDS), "transport"]) if (typeof f[key] === "string") (values as Record<string, string>)[key.replace("-", "_")] = f[key] as string;
    const r = initProfile(values);
    return { ...r, next: r.created ? "用编辑器打开该文件填写账号密码" : "已更新", ...publicProfile() };
  }, "local"),
  show: command("显示配置；密码只显示是否已填", {}, async () => publicProfile(), "local"),
  transport: retired("profile init --transport"),
};
