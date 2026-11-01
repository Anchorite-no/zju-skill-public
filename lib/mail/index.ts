/**
 * 浙大邮箱：IMAP 查信、读信和取附件，SMTP 发信与回复。
 * 账号是完整 @zju.edu.cn 地址和网页版生成的 16 位客户端专用密码，收信和发信共用。
 * 目录一律只读打开（EXAMINE），查信、读信都不改未读状态。服务器与协议细节见 README.md。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import { ConfigError, NeedsUser, RemoteRejected, TransportError, WriteGateClosed, ZjuError } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { fileJournal } from "../core/journal.ts";
import { splitPhrases, uniqueMatch } from "../core/match.ts";
import { beijingMinute, fileSize, log } from "../core/output.ts";
import { paths } from "../core/paths.ts";
import { mailCredentials } from "../profile/profile.ts";

export const SERVERS = { imap: { host: "imap.zju.edu.cn", port: 993 }, smtp: { host: "smtp.zju.edu.cn", port: 994 } } as const;
const TLS = { minVersion: "TLSv1.2", rejectUnauthorized: true } as const;
const MAX_MESSAGE = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10 * 1024 * 1024;
const MAX_TEXT = 60_000;
const MAX_RECIPIENTS = 20;
/** 同样的收件人、主题、正文和附件在这段时间里发过一次，就不再发，除非 --force */
const DUPLICATE_WINDOW_MS = 10 * 60_000;

function account(): { address: string; password: string } {
  const { address, password } = mailCredentials();
  if (!/^[^\s@]+@zju\.edu\.cn$/i.test(address)) throw new ConfigError("mail_username 要写完整的 @zju.edu.cn 邮箱地址");
  return { address: address.toLowerCase(), password };
}

/** 认证失败不重试：专用密码不对，反复登录也登不上。 */
function connectionError(err: unknown): ZjuError {
  const e = (err ?? {}) as { authenticationFailed?: boolean; code?: string; responseCode?: number; message?: string };
  if (e.authenticationFailed || e.code === "EAUTH" || e.responseCode === 535) {
    return new NeedsUser("浙大邮箱认证失败", "mail_username 写完整邮箱地址，mail_password 写网页版「设置 → 安全设置 → 客户端专用密码」生成的 16 位密码；收信和发信都用它");
  }
  return new TransportError(`连不上浙大邮箱：${e.message ?? String(err)}`, { code: e.code });
}

async function withImap<T>(work: (client: ImapFlow, address: string) => Promise<T>): Promise<T> {
  const { address, password } = account();
  const client = new ImapFlow({
    host: SERVERS.imap.host, port: SERVERS.imap.port, secure: true, auth: { user: address, pass: password },
    logger: false, emitLogs: false, connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000,
    maxLiteralSize: MAX_MESSAGE, tls: TLS, disableAutoIdle: true,
  });
  client.on("error", () => {});
  try { await client.connect(); } catch (err) { throw connectionError(err); }
  try { return await work(client, address); } finally { await client.logout().catch(() => client.close()); }
}

function smtp(address: string, password: string) {
  return nodemailer.createTransport({
    host: SERVERS.smtp.host, port: SERVERS.smtp.port, secure: true, auth: { user: address, pass: password },
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 60_000, tls: TLS,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  });
}

export function safeName(value: string): string {
  let s = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[ .]+$/g, "").slice(0, 140);
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)) s = "_" + s;
  return s && s !== "." && s !== ".." ? s : "unnamed";
}

// ---- 目录 ----

const KINDS: Record<string, string[]> = {
  "\\Sent": ["已发送", "发件箱", "sent"],
  "\\Drafts": ["草稿", "草稿箱", "drafts"],
  "\\Junk": ["垃圾邮件", "垃圾箱", "junk", "spam"],
  "\\Trash": ["已删除", "回收站", "trash"],
  "\\Archive": ["归档", "archive"],
};
interface Folder { path: string; name: string; use: string | undefined }

async function folderList(client: ImapFlow): Promise<Folder[]> {
  return (await client.list()).filter((f) => !f.flags.has("\\Noselect")).map((f) => ({ path: f.path, name: f.name, use: f.specialUse }));
}

/** 目录按名字找：收件箱、已发送这类常用说法按特殊用途对上，其余按目录名，不唯一时给候选 */
async function resolveFolder(client: ImapFlow, query: string | undefined): Promise<string> {
  const wanted = query?.trim().toLowerCase();
  if (!wanted || wanted === "inbox" || wanted === "收件箱") return "INBOX";
  const list = await folderList(client);
  const byUse = list.filter((f) => f.use && KINDS[f.use]?.includes(wanted));
  if (byUse.length === 1) return byUse[0]!.path;
  return uniqueMatch(list, query!, (f) => [f.path, f.name], (f) => ({ name: f.name, path: f.path }), "邮件目录").path;
}

export async function listFolders() {
  return withImap(async (client) => ({
    folders: (await folderList(client)).map((f) => ({ name: f.name, path: f.path, ...(f.use && KINDS[f.use] ? { kind: KINDS[f.use]![0] } : {}) })),
  }));
}

export async function checkAccount() {
  const { address, password } = account();
  await withImap((client) => client.mailboxOpen("INBOX", { readOnly: true }));
  const transport = smtp(address, password);
  try { await transport.verify(); } catch (err) { throw connectionError(err); } finally { transport.close(); }
  return { address, imap: `${SERVERS.imap.host}:${SERVERS.imap.port}`, smtp: `${SERVERS.smtp.host}:${SERVERS.smtp.port}`, status: "ok", message: "收信和发信服务器都能登录" };
}

// ---- 查信与读信 ----

/** 邮件 id 是「目录 UIDVALIDITY-UID」：目录重建后 UID 会换人，带上 UIDVALIDITY 才不会读错信 */
function parseId(id: string): { validity: string; uid: number } {
  const m = id.trim().match(/^(\d+)-(\d+)$/);
  if (!m) throw new ConfigError("--id 写 message list 结果里的 id，形如 1700000000-123");
  return { validity: m[1]!, uid: Number(m[2]) };
}

type Person = { name?: string | undefined; address?: string | undefined };
const person = (p: Person | undefined) => !p ? "" : p.name ? `${p.name} <${p.address ?? ""}>` : p.address ?? "";
const people = (list: Person[] | undefined) => (list ?? []).map(person).filter(Boolean);
const parsedPeople = (a: AddressObject | AddressObject[] | undefined): Person[] =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value).map((v) => ({ ...(v.name ? { name: v.name } : {}), ...(v.address ? { address: v.address } : {}) }));
const addressesOf = (a: AddressObject | AddressObject[] | undefined) => parsedPeople(a).map((p) => p.address?.toLowerCase()).filter((v): v is string => !!v);

function attachmentCount(node: MessageStructureObject | undefined): number {
  if (!node) return 0;
  const named = !!(node.dispositionParameters?.["filename"] || node.parameters?.["name"]);
  const own = node.disposition === "attachment" || (named && node.disposition !== "inline" && !/^(text|multipart)\//i.test(node.type)) ? 1 : 0;
  return own + (node.childNodes ?? []).reduce((n, child) => n + attachmentCount(child), 0);
}

/** IMAP 的 SINCE/BEFORE 只比日期；用 UTC 零点构造，日期才不会被时区挪一天 */
function day(value: string, flag: string): Date {
  const at = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value) throw new ConfigError(`--${flag} 写日期 YYYY-MM-DD`);
  return at;
}

export interface ListQuery { folder?: string; keyword?: string; from?: string; since?: string; until?: string; unread?: boolean; limit: number }

export async function listMessages(q: ListQuery) {
  return withImap(async (client) => {
    const folder = await resolveFolder(client, q.folder);
    const box = await client.mailboxOpen(folder, { readOnly: true });
    const base: SearchObject = {};
    if (q.since) base.since = day(q.since, "since");
    if (q.until) base.before = new Date(day(q.until, "until").getTime() + 86_400_000);
    if (base.since && base.before && base.since >= base.before) throw new ConfigError("--since 不能晚于 --until");
    if (q.unread) base.seen = false;
    if (q.from) base.from = q.from;
    const words = q.keyword ? splitPhrases(q.keyword) : [];
    const query: SearchObject = words.length > 1 ? { ...base, or: words.map((subject) => ({ subject })) }
      : words.length ? { ...base, subject: words[0]! } : Object.keys(base).length ? base : { all: true };
    const uids = [...((await client.search(query, { uid: true })) || [])].sort((a, b) => b - a);
    const page = uids.slice(0, q.limit);
    const found: FetchMessageObject[] = [];
    if (page.length) for await (const m of client.fetch(page.join(","), { uid: true, envelope: true, flags: true, size: true, bodyStructure: true }, { uid: true })) found.push(m);
    const messages = found.sort((a, b) => b.uid - a.uid).map((m) => ({
      id: `${box.uidValidity}-${m.uid}`,
      subject: m.envelope?.subject || "（无主题）",
      from: person(m.envelope?.from?.[0]),
      to: people(m.envelope?.to).join("、"),
      date: beijingMinute(m.envelope?.date ? new Date(m.envelope.date).toISOString() : undefined),
      unread: !m.flags?.has("\\Seen"),
      attachments: attachmentCount(m.bodyStructure),
      size: fileSize(m.size),
    }));
    return {
      folder, total: uids.length, count: messages.length, messages,
      ...(uids.length > page.length ? { more: `还有 ${uids.length - page.length} 封更早的没列出，用 --since、--until 缩小日期范围` } : {}),
    };
  });
}

async function fetchMessage(client: ImapFlow, folderQuery: string | undefined, id: string): Promise<{ folder: string; parsed: ParsedMail }> {
  const folder = await resolveFolder(client, folderQuery);
  const { validity, uid } = parseId(id);
  const box = await client.mailboxOpen(folder, { readOnly: true });
  if (String(box.uidValidity) !== validity) throw new ConfigError(`这个 id 不是「${folder}」里的，或者目录已经重建；重新 message list 取 id`);
  const meta = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
  if (!meta) throw new NeedsUser("这封邮件已被移动或删除，重新 message list 看看");
  if ((meta.size ?? 0) > MAX_MESSAGE) throw new NeedsUser("这封邮件超过 25 MB，请到网页版 mail.zju.edu.cn 查看");
  const item = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  if (!item || !item.source) throw new NeedsUser("这封邮件已被移动或删除，重新 message list 看看");
  return { folder, parsed: await simpleParser(item.source, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: MAX_MESSAGE }) };
}

/** 正文里引用的内嵌图片不算附件 */
const attachmentsOf = (parsed: ParsedMail) => parsed.attachments.filter((a) => !a.related);
const attachmentName = (a: Attachment) => safeName(a.filename || "附件");

export async function viewMessage(o: { folder?: string; id: string }) {
  return withImap(async (client) => {
    const { folder, parsed } = await fetchMessage(client, o.folder, o.id);
    const text = parsed.text?.trim() || "这封邮件没有文字正文，请到网页版查看";
    return {
      id: o.id, folder, subject: parsed.subject || "（无主题）",
      from: people(parsedPeople(parsed.from)).join("、"), to: people(parsedPeople(parsed.to)).join("、"),
      ...(parsed.cc ? { cc: people(parsedPeople(parsed.cc)).join("、") } : {}),
      ...(parsed.replyTo ? { replyTo: people(parsedPeople(parsed.replyTo)).join("、") } : {}),
      date: beijingMinute(parsed.date?.toISOString()),
      text: text.slice(0, MAX_TEXT), ...(text.length > MAX_TEXT ? { truncated: true } : {}),
      attachments: attachmentsOf(parsed).map((a) => ({ name: attachmentName(a), size: fileSize(a.size), type: a.contentType })),
    };
  });
}

export async function downloadAttachments(o: { folder?: string; id: string; names: string[]; outDir?: string }) {
  return withImap(async (client) => {
    const { folder, parsed } = await fetchMessage(client, o.folder, o.id);
    const all = attachmentsOf(parsed);
    if (!all.length) throw new NeedsUser("这封邮件没有附件");
    const chosen = o.names.length ? [...new Set(o.names.map((n) => uniqueMatch(all, n, (a) => [attachmentName(a)], attachmentName, "附件")))] : all;
    const subject = parsed.subject || "无主题", date = beijingMinute(parsed.date?.toISOString())?.slice(0, 10) ?? "";
    const dir = path.resolve(o.outDir ?? path.join(paths.output(), "mail", safeName(`${date} ${subject}`.trim())));
    fs.mkdirSync(dir, { recursive: true });
    const taken = new Set<string>();
    const files = chosen.map((a) => {
      let name = attachmentName(a);
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = attachmentName(a).replace(/(\.[^.]*)?$/, ` (${i})$1`);
      taken.add(name.toLowerCase());
      const file = path.join(dir, name);
      const reused = fs.existsSync(file) && fs.statSync(file).size === a.content.length;
      if (!reused) {
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, a.content);
        fs.renameSync(temp, file);
      }
      return { name, path: file, size: fileSize(a.content.length), ...(reused ? { reused: true } : {}) };
    });
    return { subject, folder, count: files.length, files };
  });
}

// ---- 发信与回复 ----

export interface Draft { to: string[]; cc: string[]; subject: string; content: string; files: string[]; inReplyTo?: string; references?: string[] }

export function recipients(raw: string | undefined, flag: string, required: boolean): string[] {
  const items = [...new Set(splitPhrases(raw ?? "").map((a) => a.toLowerCase()))];
  if (required && !items.length) throw new ConfigError(`需要 --${flag} 收件人地址`);
  if (items.length > MAX_RECIPIENTS) throw new ConfigError(`--${flag} 最多 ${MAX_RECIPIENTS} 个地址`);
  for (const a of items) if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(a)) throw new ConfigError(`--${flag} 里的「${a}」不是完整的邮箱地址`);
  return items;
}

function snapshot(files: string[]): { filename: string; content: Buffer }[] {
  if (files.length > 10) throw new ConfigError("一封邮件最多带 10 个附件");
  let total = 0;
  return files.map((source) => {
    const file = path.resolve(source);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ConfigError(`附件不存在或不是文件：${file}`);
    const content = fs.readFileSync(file);
    total += content.length;
    if (total > MAX_ATTACHMENTS) throw new ConfigError("附件合计不能超过 10 MB，大文件请到网页版用超大附件发送");
    return { filename: safeName(path.basename(file)), content };
  });
}

/** 发过的同一封信：写前日志里有它的 begin，而且没有被服务器明确拒收 */
function recentDuplicate(digest: string): string | undefined {
  const dir = paths.journal();
  if (!fs.existsSync(dir)) return undefined;
  for (const name of fs.readdirSync(dir)) {
    if (!/^mail-.*\.jsonl$/.test(name)) continue;
    const file = path.join(dir, name);
    if (Date.now() - fs.statSync(file).mtimeMs > DUPLICATE_WINDOW_MS) continue;
    const events = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) as { phase?: string; digest?: string }; } catch { return {}; } });
    if (events.some((e) => e.phase === "begin" && e.digest === digest) && !events.some((e) => e.phase === "rejected")) return file;
  }
  return undefined;
}

/** 在交出正文之前失败的，确定没有发出去；DATA 之后的失败结果不明 */
function definitelyNotSent(err: unknown): boolean {
  const e = (err ?? {}) as { code?: string; command?: string };
  if (e.code === "EAUTH" || e.code === "EENVELOPE" || e.code === "EDNS") return true;
  return !!e.command && /^(CONN|EHLO|HELO|STARTTLS|AUTH|MAIL FROM|RCPT TO)/i.test(e.command);
}

export async function send(d: Draft, o: { action: string; confirm: boolean; dryRun: boolean; force: boolean }) {
  if (!o.dryRun && (!o.confirm || !writeAllowed())) throw new WriteGateClosed(o.action);
  if (!d.subject.trim() || /[\r\n]/.test(d.subject) || d.subject.length > 998) throw new ConfigError("--subject 要有内容、不能换行");
  if (!d.to.length) throw new ConfigError("没有收件人");
  const { address, password } = account();
  const attachments = snapshot(d.files);
  const view = {
    from: address, to: d.to, cc: d.cc, subject: d.subject,
    attachments: attachments.map((a) => ({ name: a.filename, size: fileSize(a.content.length) })),
  };
  if (o.dryRun) return { status: "preview", message: "只是预览，没有发送。把这些给用户看，用户同意后去掉 --dry-run、加 --confirm 再发", ...view, content: d.content };
  const digest = crypto.createHash("sha256").update(JSON.stringify([d.to, d.cc, d.subject, d.content, attachments.map((a) => [a.filename, a.content.length])])).digest("hex");
  const duplicate = o.force ? undefined : recentDuplicate(digest);
  if (duplicate) {
    const err = new ConfigError("10 分钟内已经发过收件人、主题、正文都相同的一封邮件，这次没有发", "确实要再发一次，先问过用户，再加 --force");
    err.detail.journalFile = duplicate;
    throw err;
  }
  // 写前日志落不了盘就不发：结果不明时要靠它查，也靠它拦重复发送。
  const sink = fileJournal("mail");
  sink.append({ at: new Date().toISOString(), phase: "begin", action: o.action, digest, ...view });
  const record = (event: Record<string, unknown>) => { try { sink.append({ at: new Date().toISOString(), ...event }); } catch (err) { log(`邮箱：写后日志没写上（${(err as Error).message}），不影响发送结果`); } };
  const transport = smtp(address, password);
  try {
    const info = await transport.sendMail({
      from: address, to: d.to, cc: d.cc, subject: d.subject, text: d.content,
      attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })),
      ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}), ...(d.references?.length ? { references: d.references } : {}),
    });
    const accepted = (info.accepted ?? []).map(String), rejected = (info.rejected ?? []).map(String);
    const status = rejected.length ? "partial" : "sent";
    record({ phase: "done", status, messageId: info.messageId, accepted, rejected });
    return {
      status, ...view, messageId: info.messageId, accepted, rejected, journalFile: sink.file,
      message: status === "sent" ? "邮件已交给浙大邮件服务器；这不代表对方已经读到" : "部分收件人被服务器拒收；别整封重发，只给被拒的地址另发",
    };
  } catch (err) {
    if (definitelyNotSent(err)) {
      record({ phase: "rejected", error: (err as Error).message });
      if ((err as { code?: string }).code === "EAUTH") throw connectionError(err);
      if ((err as { code?: string }).code === "EENVELOPE") throw new RemoteRejected(`服务器拒收：${(err as Error).message}`);
      throw connectionError(err);
    }
    record({ phase: "unknown", error: (err as Error).message });
    throw new ZjuError("TRANSPORT", "发送结果不明：邮件可能已经发出，不要自动重发", {
      hint: "请用户到网页版「已发送」里或向收件人核实；确认没发出再重新发送，那时要加 --force",
      detail: { outcome: "unknown", journalFile: sink.file },
    });
  } finally { transport.close(); }
}

function quote(parsed: ParsedMail): string {
  const lines = (parsed.text ?? "").trim().split(/\r?\n/);
  const shown = lines.slice(0, 200).map((l) => `> ${l}`);
  if (lines.length > 200) shown.push("> ……");
  return [`在 ${beijingMinute(parsed.date?.toISOString()) ?? ""}，${people(parsedPeople(parsed.from)).join("、")} 写道：`, ...shown].join("\n");
}

/** 回复的收件人取原信的回复地址，没有就取发件人；--all 把原信的收件人和抄送放进抄送，去掉自己 */
export async function replyDraft(o: { folder?: string; id: string; content: string; all: boolean; files: string[] }): Promise<Draft> {
  return withImap(async (client, self) => {
    const { parsed } = await fetchMessage(client, o.folder, o.id);
    const primary = addressesOf(parsed.replyTo).length ? addressesOf(parsed.replyTo) : addressesOf(parsed.from);
    let to = [...new Set(primary)].filter((a) => a !== self);
    // 回复自己发出的信（在已发送里），收件人是原信的收件人。
    if (!to.length) to = [...new Set(addressesOf(parsed.to))].filter((a) => a !== self);
    if (!to.length) throw new NeedsUser("原邮件里找不到可以回复的地址");
    const cc = o.all ? [...new Set([...addressesOf(parsed.to), ...addressesOf(parsed.cc)])].filter((a) => a !== self && !to.includes(a)) : [];
    const subject = parsed.subject ?? "";
    const references = [...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []), ...(parsed.messageId ? [parsed.messageId] : [])];
    return {
      to, cc: cc.slice(0, MAX_RECIPIENTS), files: o.files,
      subject: /^\s*(re|回复|答复)\s*[:：]/i.test(subject) ? subject : `Re: ${subject}`,
      content: `${o.content.trimEnd()}\n\n${quote(parsed)}`,
      ...(parsed.messageId ? { inReplyTo: parsed.messageId } : {}),
      ...(references.length ? { references } : {}),
    };
  });
}
