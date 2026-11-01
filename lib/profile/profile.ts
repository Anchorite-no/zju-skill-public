/**
 * 学生档案：仓库根目录 profile.env，普通的 KEY=VALUE 文件。
 * 环境变量同名键优先于文件。
 *
 * 由 zju profile init 生成模板；zju profile show 展示（不含密码）。
 */
import fs from "node:fs";
import path from "node:path";
import { parseEnv, loadEnv } from "../core/env.ts";
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

const SECRET_KEYS: ReadonlySet<string> = new Set(["zju_password", "webvpn_password", "cc98_password", "pta_password", "chaoxing_password", "lab_password", "tyys_card_password", "tyys_buddy_password"]);

export function profilePath(): string {
  return process.env["ZJU_PROFILE"] ? path.resolve(process.env["ZJU_PROFILE"]) : path.join(paths.root, "profile.env");
}

export function profileExists(): boolean {
  return fs.existsSync(profilePath());
}

/** profile init 与仓库示例共用一份模板，避免字段和默认值分叉。 */
export const PROFILE_TEMPLATE = fs.readFileSync(path.join(paths.root, "profile.env.example"), "utf8");

/** 读文件 + 环境变量覆盖，返回全部键（小写）。多账号等动态键用这个。 */
export function readProfileAll(): Record<string, string> {
  let fileVars: Record<string, string> = {};
  try {
    fileVars = parseEnv(fs.readFileSync(profilePath(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const out: Record<string, string> = {};
  const clean = (v: string) => v.replace(/[\r\n]+$/g, "");
  for (const [k, v] of Object.entries(fileVars)) if (v) out[k.toLowerCase()] = clean(v);
  for (const [k, v] of Object.entries(loadEnv())) if (v && /^(zju|webvpn|cc98|pta|chaoxing|tyys)_/i.test(k)) out[k.toLowerCase()] = clean(v);
  return out;
}

/** 读文件 + 环境变量覆盖，只返回档案键 */
export function readProfile(): ProfileRaw {
  let fileVars: Record<string, string> = {};
  try {
    fileVars = parseEnv(fs.readFileSync(profilePath(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const env = loadEnv();
  const out: ProfileRaw = {};
  for (const k of PROFILE_KEYS) {
    const v = env[k.toUpperCase()] || env[k] || fileVars[k] || fileVars[k.toUpperCase()] || "";
    if (v) out[k] = v.replace(/[\r\n]+$/g, "");
  }
  return out;
}

/** 生成/更新档案文件：保留用户已填的值和注释，只替换给定键 */
export function writeProfile(values: ProfileRaw): void {
  const file = profilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : PROFILE_TEMPLATE;
  const lines = current.split(/\r?\n/);
  const seen = new Set<string>();
  const quote = (v: string) => (/[\s#"']/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v);
  const out = lines.map((line) => {
    const m = line.match(/^([a-zA-Z_]+)=/);
    if (!m) return line;
    const k = m[1]!.toLowerCase() as ProfileKey;
    if (!(k in values)) return line;
    seen.add(k);
    return `${k}=${quote(values[k] ?? "")}`;
  });
  for (const [k, v] of Object.entries(values)) if (!seen.has(k) && v !== undefined) out.push(`${k}=${quote(v)}`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out.join("\n").replace(/\n*$/, "\n"), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function initProfile(values: ProfileRaw): { path: string; created: boolean } {
  const created = !profileExists();
  if (values.zju_username && !/^\d{8,12}$/.test(values.zju_username)) throw new ConfigError("学号格式不对（应为 8–12 位数字）");
  if (values.transport && !["webvpn", "direct"].includes(values.transport)) throw new ConfigError("transport 只能是 webvpn 或 direct");
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
    throw new NeedsUser("缺少统一身份认证凭据", `填写 ${profilePath()} 里的 zju_username / zju_password（zju profile init 生成模板）`);
  }
  return { username: p.zju_username, password: p.zju_password };
}

/** WebVPN 凭据独立，不回退到统一认证 */
export function webvpnCredentials(): { username: string; password: string } {
  const p = readProfile();
  if (!p.webvpn_username || !p.webvpn_password) {
    throw new NeedsUser("缺少 WebVPN 凭据（与统一认证不是同一套账号）", `填写 ${profilePath()} 里的 webvpn_username / webvpn_password`);
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
  if (!list.length) throw new NeedsUser("缺少 CC98 账号", `填写 ${profilePath()} 里的 cc98_username / cc98_password（多账号加 _2、_3 后缀）`);
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
  if (!p.pta_username || !p.pta_password) throw new NeedsUser("缺少 PTA 账号", `填写 ${profilePath()} 里的 pta_username / pta_password`);
  return { username: p.pta_username, password: p.pta_password };
}

/** 超星学习通独立账号（手机号），不回退到校园凭据。 */
export function chaoxingCredentials(): { username: string; password: string } {
  const p = readProfile();
  if (!p.chaoxing_username || !p.chaoxing_password) throw new NeedsUser("缺少超星学习通账号", `填写 ${profilePath()} 里的 chaoxing_username / chaoxing_password`);
  return { username: p.chaoxing_username, password: p.chaoxing_password };
}

export function setTransport(t: Transport): void {
  writeProfile({ transport: t });
}
