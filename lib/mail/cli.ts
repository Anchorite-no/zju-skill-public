/** 浙大邮箱命令注册：参数在这里声明并组装结果，收发信在 index.ts。 */
import fs from "node:fs";
import { command, group, bool, type Command, type Flags, type Option } from "../core/command.ts";
import { exclusive } from "../core/cli.ts";
import { ConfigError, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { checkAccount, downloadAttachments, listFolders, listMessages, recipients, replyDraft, send, viewMessage } from "./index.ts";

const text = (f: Flags, key: string) => typeof f[key] === "string" ? (f[key] as string).trim() || undefined : undefined;
/** 多个值用竖线分隔，与其他模块相同。 */
const list = (value: string | undefined) => (value ?? "").split(/[|｜]/).map((v) => v.trim()).filter(Boolean);
const optional = (f: Flags, ...keys: string[]) => Object.fromEntries(keys.flatMap((k) => text(f, k) ? [[k, text(f, k)!]] : []));

const FOLDER: Option = { description: "邮件目录，默认收件箱；写目录名，或 已发送、草稿、垃圾邮件、已删除" };
const ID: Option = { description: "邮件 id，来自 message list", required: true };
const WRITE: Record<string, Option> = {
  content: { description: "正文，纯文本；要用户自己的意思，发之前给用户看过" },
  "content-file": { description: "正文较长时写进 UTF-8 文本文件，给文件路径；和 --content 二选一" },
  file: { description: "附件的本地路径，多个用 | 分隔；最多 10 个、合计 10 MB" },
  "dry-run": { description: "只预览将要发出的收件人、主题、正文和附件，不发送", type: "boolean" },
  force: { description: "10 分钟内发过同样一封时仍然再发", type: "boolean" },
  confirm: { description: "确认发送；同时需要环境变量 ZJU_ALLOW_WRITE=1", type: "boolean" },
};

function body(f: Flags): string {
  exclusive(f, ["content", "content-file"]);
  const file = text(f, "content-file");
  const value = file ? fs.readFileSync(file, "utf8") : text(f, "content");
  if (!value?.trim()) throw new ConfigError("需要 --content 或 --content-file 正文");
  return value.replace(/\r\n/g, "\n");
}
/** 写闸在读账号、连服务器之前；--dry-run 不发信，不需要写闸 */
const gate = (f: Flags, action: string) => { if (!bool(f, "dry-run") && (!bool(f, "confirm") || !writeAllowed())) throw new WriteGateClosed(action); };
const sendOptions = (f: Flags, action: string) => ({ action, confirm: bool(f, "confirm"), dryRun: bool(f, "dry-run"), force: bool(f, "force") });

const message = group("邮件：列表、正文、下载附件、发信和回复", {
  list: command("邮件列表，最新的在前：主题、发件人、时间、是否未读、几个附件；只读，不改未读状态", {
    folder: FOLDER,
    keyword: { description: "主题里的词；几种说法用顿号或 | 隔开，满足其一即可" },
    from: { description: "发件人的地址或名字" },
    since: { description: "从这一天起 YYYY-MM-DD，含当天" },
    until: { description: "到这一天为止 YYYY-MM-DD，含当天" },
    unread: { description: "只看未读", type: "boolean" },
    limit: { description: "条数", type: "integer", min: 1, max: 100, default: 20 },
  }, async (f) => listMessages({ ...optional(f, "folder", "keyword", "from", "since", "until"), unread: bool(f, "unread"), limit: Number(f.limit) })),
  view: command("一封邮件的完整正文、发件人、收件人、抄送和附件清单；只读，不会标成已读", { id: ID, folder: FOLDER },
    async (f) => viewMessage({ id: f.id as string, ...optional(f, "folder") })),
  download: command("下载一封邮件的附件，默认全部，返回本地路径；默认存到 data/output/mail/，下载过的直接复用", {
    id: ID, folder: FOLDER,
    name: { description: "附件名，可以只写能唯一确定它的一部分；多个用 | 分隔；不写是全部" },
    "out-dir": { description: "保存目录" },
  }, async (f) => downloadAttachments({ id: f.id as string, names: list(text(f, "name")), ...optional(f, "folder"), ...(text(f, "out-dir") ? { outDir: text(f, "out-dir")! } : {}) })),
  send: command("发一封新邮件：先 --dry-run 预览给用户看，用户同意后加 --confirm 发；发出后不能撤回", {
    to: { description: "收件人完整地址，多个用 | 分隔", required: true },
    cc: { description: "抄送地址，多个用 | 分隔" },
    subject: { description: "主题", required: true },
    ...WRITE,
  }, async (f) => {
    gate(f, "mail message send");
    return send({ to: recipients(text(f, "to"), "to", true), cc: recipients(text(f, "cc"), "cc", false), subject: f.subject as string, content: body(f), files: list(text(f, "file")) }, sendOptions(f, "mail message send"));
  }),
  reply: command("回复一封邮件：收件人取原信的回复地址或发件人，主题加 Re:，原文引用附在正文后面；加 --all 是回复全部。同样先 --dry-run", {
    id: ID, folder: FOLDER,
    all: { description: "回复全部：原信的收件人和抄送放进抄送", type: "boolean" },
    ...WRITE,
  }, async (f) => {
    gate(f, "mail message reply");
    const draft = await replyDraft({ id: f.id as string, content: body(f), all: bool(f, "all"), files: list(text(f, "file")), ...optional(f, "folder") });
    return send(draft, sendOptions(f, "mail message reply"));
  }),
});

export const mailCommands: Record<string, Command> = {
  check: command("检查邮箱账号：收信（IMAP）和发信（SMTP）服务器能不能登录；不读邮件、不发信", {}, () => checkAccount()),
  folders: command("邮件目录：收件箱、已发送、草稿、垃圾邮件和自己建的文件夹", {}, () => listFolders()),
  message,
};
