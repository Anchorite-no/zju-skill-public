import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { ConfigError } from "../core/errors.ts";

export const SYSTEMS: Record<string, { title: string; username?: string; password: string }> = {
  zju: { title: "统一身份认证", username: "zju_username", password: "zju_password" },
  webvpn: { title: "WebVPN", username: "webvpn_username", password: "webvpn_password" },
  cc98: { title: "CC98", username: "cc98_username", password: "cc98_password" },
  pta: { title: "PTA", username: "pta_username", password: "pta_password" },
  chaoxing: { title: "超星学习通", username: "chaoxing_username", password: "chaoxing_password" },
  mail: { title: "浙大邮箱（客户端专用密码）", username: "mail_username", password: "mail_password" },
  lab: { title: "实验课平台（账号留空使用学号）", username: "lab_username", password: "lab_password" },
  tyys: { title: "校园卡查询密码", password: "tyys_card_password" },
  buddy: { title: "场馆同伴", username: "tyys_buddy_username", password: "tyys_buddy_password" },
};

export async function promptAccount(system: string, index: number): Promise<Record<string, string>> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new ConfigError("请在交互终端里配置账号；自动化程序可用 profile init --stdin 传入 JSON，请勿把密码放在命令参数或聊天中。");
  const spec = SYSTEMS[system];
  if (!spec) throw new ConfigError("未知账号系统");
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!hidden) process.stderr.write(chunk); done(); } });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  const ask = (prompt: string, secret = false) => new Promise<string>((resolve, reject) => {
    hidden = secret;
    if (secret) process.stderr.write(prompt);
    const cancel = () => { reader.close(); reject(new ConfigError("账号配置已取消")); };
    reader.once("SIGINT", cancel);
    const closed = () => reject(new ConfigError("账号输入已结束，配置未保存"));
    reader.once("close", closed);
    reader.question(secret ? "" : prompt, value => {
      reader.off("SIGINT", cancel); reader.off("close", closed);
      if (secret) process.stderr.write("\n");
      hidden = false;
      resolve(value);
    });
  });
  try {
    process.stderr.write(`${spec.title}\n空密码会清除当前密码；Ctrl+C 取消。\n`);
    const suffix = index > 1 ? `_${index}` : "";
    const values: Record<string, string> = {};
    if (spec.username) values[spec.username + suffix] = await ask("账号：");
    values[spec.password + suffix] = await ask("密码（不回显）：", true);
    return values;
  } finally { reader.close(); }
}

export async function readInput(): Promise<unknown> {
  if (process.stdin.isTTY) throw new ConfigError("--stdin 需要通过标准输入传入 JSON；交互配置请使用 --system");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > 1024 * 1024) throw new ConfigError("账号配置输入过大");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ConfigError("账号配置需要有效 JSON；输入内容不会回显"); }
}
