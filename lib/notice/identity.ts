/**
 * 使用者是谁：本科生还是研究生、哪个学院。通知的默认来源按它选：本人学院的官网，以及只面向本科生或研究生的来源。
 *
 * 类别：加密配置的 student_level；没填时按学号首位（3 本科，2 硕士，1 博士）。
 * 学院：加密配置的 college；没填时本科生从教务网的课表响应里读一次，记在 data/notice/identity.json（30 天）。
 *       研究生不在本科教务网里，要运行 profile init --college 配置学院。大一未确认主修时教务网给的是求是学院、竺可桢学院，名录里没有。
 * 学院官网名录：colleges.json，由 scripts/notice/colleges.ts 从学校主页的学院（系）名录生成。
 */
import fs from "node:fs";
import path from "node:path";
import { readProfile } from "../profile/profile.ts";
import { paths } from "../core/paths.ts";
import { readJson, writeJson } from "../core/fsjson.ts";
import { abbreviates } from "../core/match.ts";
import type { Zdbk } from "../zdbk/client.ts";
import { studentInfo } from "../zdbk/kbcx.ts";
import type { Source } from "./types.ts";

export type Level = "undergrad" | "grad";
export interface Identity {
  level: Level;
  /** 名录里对上的学院 */
  college?: Source;
  /** 没有学院官网可读时，给使用者的一句说明 */
  hint?: string;
}

interface Catalog {
  generatedAt: string;
  colleges: { id: string; name: string; faculty: string; home: string; columns: { base: string; id: string; name: string; audience: "all" | Level; latest: string }[] }[];
  skipped: { name: string; home: string; reason: string }[];
}

let catalog: Catalog | undefined, sources: Source[] | undefined;
const load = () => (catalog ??= JSON.parse(fs.readFileSync(new URL("./colleges.json", import.meta.url), "utf8")) as Catalog);
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** 名录里的全部学院，每个学院是一个网站群来源；栏目可能分布在主站和办公网，各带自己的站点地址 */
export function colleges(): Source[] {
  return (sources ??= load().colleges.map((c): Source => ({ id: `college-${c.id}`, name: c.name, adapter: "webplus", base: new URL(c.home).origin,
    columns: c.columns.map((col) => ({ id: col.id, base: col.base, name: col.name, ...(col.audience === "all" ? {} : { audience: col.audience }) })) })));
}

/** 按名字找学院：全称、全称的一部分、简称（计算机学院、信电、公管）都行；可能不止一个 */
export function findCollege(name: string): Source[] {
  const wanted = norm(name), all = colleges();
  if (wanted.length < 2) return [];
  const exact = all.filter((c) => norm(c.name) === wanted);
  if (exact.length) return exact;
  const part = all.filter((c) => norm(c.name).includes(wanted) || wanted.includes(norm(c.name)));
  return part.length ? part : all.filter((c) => abbreviates(wanted, c.name));
}

export function levelOf(): Level {
  const p = readProfile(), stated = p.student_level ?? "";
  return /研|硕|博/.test(stated) ? "grad" : /本/.test(stated) ? "undergrad" : /^[12]/.test(p.zju_username ?? "") ? "grad" : "undergrad";
}

const file = () => path.join(paths.data(), "notice", "identity.json");
const KEEP_MS = 30 * 86_400_000;

/** 不给 zdbk 时不联网，只看加密配置和本地记录 */
export async function identity(zdbk?: () => Promise<Zdbk>): Promise<Identity> {
  const p = readProfile(), username = p.zju_username ?? "", level = levelOf();
  let name = p.college?.trim(), from = "加密配置的 college";
  if (!name) {
    const saved = readJson<{ username?: string; college?: string; savedAt?: number }>(file());
    if (saved?.username === username && saved.college && Date.now() - (saved.savedAt ?? 0) < KEEP_MS) { name = saved.college; from = "教务网"; }
  }
  if (!name && level === "undergrad") {
    if (!zdbk) return { level, hint: "还没有识别学院：第一次 notice list 或 notice new 时会从教务网读取，也可以运行 profile init --college 配置学院" };
    try {
      name = (await studentInfo(await zdbk())).college.trim(); from = "教务网";
      if (name) writeJson(file(), { username, college: name, savedAt: Date.now() });
    } catch (err) {
      return { level, hint: `没能从教务网读到你的学院（${err instanceof Error ? err.message : String(err)}），这次不含学院官网的通知；也可以运行 profile init --college 配置学院` };
    }
  }
  if (!name) return { level, hint: "不知道你的学院，这次不含学院官网的通知；运行 profile init --college 配置学院（学院全称，如 计算机科学与技术学院）" };
  const found = findCollege(name);
  if (found.length === 1) return { level, college: found[0]! };
  const skipped = load().skipped.find((s) => norm(s.name) === norm(name));
  return { level, hint: found.length > 1 ? `「${name}」对得上 ${found.map((c) => c.name).join("、")}，请用 profile init --college 填写全称`
    : skipped ? `${skipped.name}的官网还读不了，这次不含学院官网的通知`
    : `学院名录里没有「${name}」（来自${from}），这次不含学院官网的通知；已确认主修的同学可用 profile init --college 填写专业所在学院的全称` };
}

/** 名录概况，给 notice sources 用 */
export const catalogInfo = () => ({ generatedAt: load().generatedAt, colleges: load().colleges.map((c) => c.name), unsupported: load().skipped.map((s) => s.name) });
