/**
 * 学生档案：profile.env 保存系统凭据库保护的密文；旧明文首次读取时原子迁移。
 * 环境变量同名键优先于文件。
 *
 * 由 zju profile init 配置；zju profile show 展示（不含密码）。
 */
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "../core/env.ts";
import { readProfileFile, writeProfileFile } from "../core/profile-file.mjs";
import { paths } from "../core/paths.ts";
import { ConfigError, NeedsUser } from "../core/errors.ts";

export type Transport = "webvpn" | "direct";

/** 档案字段（文件里的键名） */
export const PROFILE_KEYS = [
  "zju_username",
  "zju_password",
  "webvpn_username",
  "webvpn_password",
  "cc98_username",
  "cc98_password",
  "pta_username",
  "pta_password",
  "chaoxing_username",
  "chaoxing_password",
  "mail_username",
  "mail_password",
  "transport",
  "grade",
  "major_code",
  "major_name",
  "college",
  "student_level",
  "lab_username",
  "lab_password",
  "tyys_card_password",
  "tyys_buddy_username",
  "tyys_buddy_password",
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];
export type ProfileRaw = Partial<Record<ProfileKey, string>>;

const SECRET_KEYS: ReadonlySet<string> = new Set(["zju_password", "webvpn_password", "cc98_password", "pta_password", "chaoxing_password", "mail_password", "lab_password", "tyys_card_password", "tyys_buddy_password"]);

export function profilePath(): string {
  return process.env["ZJU_PROFILE"] ? path.resolve(process.env["ZJU_PROFILE"]) : path.join(paths.root, "profile.env");
}

export function profileExists(): boolean {
  return fs.existsSync(profilePath());
}

/** 保留旧路径和 ZJU_PROFILE，升级后文件内容是密文，不能用编辑器填写密码。 */
const parseLegacy = (raw: string) => Object.fromEntries(Object.entries(parseEnv(raw)).map(([key, value]) => [key.toLowerCase(), value]));

export function isProfileKey(key: string): boolean {
  if ((PROFILE_KEYS as readonly string[]).includes(key)) return true;
  const match = /^(?:cc98|tyys_buddy)_(?:username|password)_(\d+)$/.exec(key);
  return !!match && Number(match[1]) >= 2 && Number(match[1]) <= 99;
}

export function validateProfileValues(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigError("账号配置需要键值对象");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isProfileKey(key) || typeof value !== "string" || value.length > 1000 || /[\x00-\x1f\x7f]/.test(value)) throw new ConfigError("账号字段格式不正确；请查看 profile init --help");
    out[key] = /password(?:_\d+)?$/.test(key) ? value : value.trim();
  }
  if (out.zju_username && !/^\d{8,12}$/.test(out.zju_username)) throw new ConfigError("学号格式不对（应为 8–12 位数字）");
  if (out.transport && !["webvpn", "direct"].includes(out.transport)) throw new ConfigError("transport 只能是 webvpn 或 direct");
  return out;
}

/** .env 只用于普通运行设置，避免另一份明文密码悄悄覆盖加密账号。 */
function checkLegacyEnv(): void {
  let raw: string;
  try { raw = fs.readFileSync(paths.envFile(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (Object.entries(parseEnv(raw)).some(([key, value]) => value && isProfileKey(key.toLowerCase()) && /password/i.test(key))) {
    throw new ConfigError(".env 中仍有明文校园密码", "请先用 profile init --system 配置对应账号，再从 .env 删除密码项；不使用明文配置继续登录。");
  }
}

/** 持久配置只经凭据库读取；进程环境变量仅作本次运行覆盖，不写入文件。 */
export function readProfileAll(): Record<string, string> {
  checkLegacyEnv();
  const file = readProfileFile(profilePath(), { parseLegacy });
  const out = Object.fromEntries(Object.entries(file.values).filter(([, value]) => value));
  const keys = new Set([...Object.keys(out), ...Object.keys(process.env).map(key => key.toLowerCase()).filter(isProfileKey)]);
  for (const key of keys) {
    const override = process.env[key.toUpperCase()] || process.env[key];
    if (override) out[key] = override.replace(/[\r\n]+$/g, "");
  }
  return out;
}

export function readProfile(): ProfileRaw {
  const all = readProfileAll();
  return Object.fromEntries(PROFILE_KEYS.filter(key => all[key]).map(key => [key, all[key]!])) as ProfileRaw;
}

/** 只更新给出的字段；空值清除，保留多账号和未知旧字段，拒绝并发覆盖。 */
export function writeProfile(input: Record<string, string>): void {
  const update = validateProfileValues(input);
  const file = profilePath(), before = readProfileFile(file, { parseLegacy });
  const next = { ...before.values };
  for (const [key, value] of Object.entries(update)) {
    if (value) next[key] = value;
    else delete next[key];
  }
  writeProfileFile(file, next, { parseLegacy, expectedRaw: before.raw });
}

export function initProfile(values: Record<string, string>): { path: string; created: boolean } {
  const created = !profileExists();
  writeProfile(values);
  return { path: profilePath(), created };
}

/** 展示用：密码替换为是否已填 */
export function publicProfile(): Record<string, string | boolean> & { path: string } {
  const p = readProfile();
  const out: Record<string, string | boolean> = {};
  for (const k of PROFILE_KEYS) out[SECRET_KEYS.has(k) ? k.replace("password", "password_set") : k] = SECRET_KEYS.has(k) ? !!p[k] : (p[k] ?? "");
  return { ...out, cc98_accounts: cc98Accounts().map((a) => `${a.index}:${a.username}`).join(", "), path: profilePath() };
}

export function credentials(): { username: string; password: string } {
  const p = readProfile();
  if (!p.zju_username || !p.zju_password) {
    throw new NeedsUser("缺少统一身份认证凭据", "请在终端运行 zju profile init --system zju，密码输入不回显");
  }
  return { username: p.zju_username, password: p.zju_password };
}

/** WebVPN 凭据独立，不回退到统一认证 */
export function webvpnCredentials(): { username: string; password: string } {
  const p = readProfile();
  if (!p.webvpn_username || !p.webvpn_password) {
    throw new NeedsUser("缺少 WebVPN 凭据（与统一认证不是同一套账号）", "请在终端运行 zju profile init --system webvpn");
  }
  return { username: p.webvpn_username, password: p.webvpn_password };
}

export interface Cc98Account {
  /** 1 起 */
  index: number;
  username: string;
  password: string;
}

/**
 * CC98 多账号：cc98_username / cc98_password 为第 1 个，cc98_username_2 / cc98_password_2 … 依次递增。
 * 环境变量 CC98_USERNAME(_N) 同样生效。缺密码的条目跳过。
 */
export function cc98Accounts(): Cc98Account[] {
  const all = readProfileAll();
  const out: Cc98Account[] = [];
  const indices = new Set<number>();
  for (const k of Object.keys(all)) {
    const m = k.match(/^cc98_username(?:_(\d+))?$/);
    if (m) indices.add(m[1] ? Number(m[1]) : 1);
  }
  for (const i of [...indices].sort((a, b) => a - b)) {
    const suffix = i === 1 ? "" : `_${i}`;
    const username = all[`cc98_username${suffix}`];
    const password = all[`cc98_password${suffix}`];
    if (username && password) out.push({ index: i, username, password });
  }
  return out;
}

/** 按 --account 选账号：可给用户名或 1 起的序号；不给则第 1 个 */
export function cc98Account(selector?: string): Cc98Account {
  const list = cc98Accounts();
  if (!list.length) throw new NeedsUser("缺少 CC98 账号", "请在终端运行 zju profile init --system cc98；多账号加 --index 2");
  if (!selector) return list[0]!;
  const byName = list.find((a) => a.username.toLowerCase() === selector.toLowerCase());
  if (byName) return byName;
  if (/^\d+$/.test(selector)) {
    const byIndex = list.find((a) => a.index === Number(selector));
    if (byIndex) return byIndex;
  }
  throw new ConfigError(`找不到 CC98 账号 "${selector}"`, `已配置：${list.map((a) => `${a.index}:${a.username}`).join(", ")}`);
}

export function currentTransport(): Transport {
  const t = readProfile().transport;
  return t === "direct" ? "direct" : "webvpn";
}

/** PTA / 百腾独立账号，不回退到校园凭据。 */
export function ptaCredentials(): { username: string; password: string } {
  const p = readProfile();
  if (!p.pta_username || !p.pta_password) throw new NeedsUser("缺少 PTA 账号", "请在终端运行 zju profile init --system pta");
  return { username: p.pta_username, password: p.pta_password };
}

/** 超星学习通独立账号（手机号），不回退到校园凭据。 */
export function chaoxingCredentials(): { username: string; password: string } {
  const p = readProfile();
  if (!p.chaoxing_username || !p.chaoxing_password) throw new NeedsUser("缺少超星学习通账号", "请在终端运行 zju profile init --system chaoxing");
  return { username: p.chaoxing_username, password: p.chaoxing_password };
}

/** 浙大邮箱：完整 @zju.edu.cn 地址和网页版生成的客户端专用密码，收信和发信共用 */
export function mailCredentials(): { address: string; password: string } {
  const p = readProfile();
  if (!p.mail_username || !p.mail_password) throw new NeedsUser("缺少浙大邮箱账号", "请在终端运行 zju profile init --system mail，填写完整邮箱地址与客户端专用密码");
  return { address: p.mail_username.trim(), password: p.mail_password };
}

export function setTransport(t: Transport): void {
  writeProfile({ transport: t });
}
