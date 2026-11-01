import fs from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../core/errors.ts";
import { bool, type Flags, type Option } from "../core/command.ts";
import { id, type Zhiyun } from "./client.ts";
import { catalogue, selectLessons, resolveCourse } from "./courses.ts";
import type { Lesson } from "./types.ts";

export const KINDS = ["video", "audio", "ppt", "slides", "subtitles"] as const;
export type ResourceKind = typeof KINDS[number] | "courseware"; // Legacy manifests only.
export interface Selection { version: 1; courseId: string; lessonIds: string[] }
export const selectionOptions: Record<string, Option> = {
  course: { description: "课程名称" }, teacher: { description: "教师姓名，同名课程有多位教师时用" },
  lesson: { description: "第几次课，如 1,3-5" }, date: { description: "日期 YYYY-MM-DD" },
  "week-of": { description: "指定日期所在自然周" }, all: { description: "全部课次", type: "boolean" },
};
export function kinds(value: string, allowAll = false): ResourceKind[] {
  if (value === "all" && allowAll) return [...KINDS];
  const list = [...new Set(value.split(","))];
  if (!list.length || list.some(k => !KINDS.some(allowed => allowed === k))) throw new ConfigError(`kind 须为 ${KINDS.join(" / ")}，多种用逗号分隔`);
  return list as ResourceKind[];
}
export function lessonSelectors(f: Flags) {
  if (f.sub !== undefined) throw new ConfigError("--sub 已更名为 --lesson-id");
  const result: { lesson?: string; subId?: string; date?: string; weekOf?: string; all?: boolean } = {};
  for (const [key, field] of [["lesson", "lesson"], ["lesson-id", "subId"], ["date", "date"], ["week-of", "weekOf"]] as const) {
    if (f[key] !== undefined) {
      if (typeof f[key] !== "string" || !f[key]) throw new ConfigError(`--${key} 需要取值`);
      result[field] = f[key];
    }
  }
  if (bool(f, "all")) result.all = true;
  if (Object.keys(result).length > 1) throw new ConfigError("--lesson / --date / --week-of / --all 只能选一种");
  if (result.subId) id(result.subId, "lesson-id");
  if (result.lesson && !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(result.lesson)) throw new ConfigError("--lesson 格式为 1 或 1,3-5");
  if (result.lesson) for (const part of result.lesson.split(",")) {
    const [a, b = a] = part.split("-").map(Number);
    if (!a || !b || a > b || b > 10000) throw new ConfigError("lesson 范围须在 1..10000 且递增");
  }
  // Date syntax and calendar validity are checked even when the catalogue is empty.
  if (result.date || result.weekOf) selectLessons([], result);
  return result;
}
export async function resolveSelection(f: Flags, required: boolean, client?: Zhiyun) {
  if (f.selection) {
    if (["course", "lesson", "lesson-id", "date", "week-of", "all"].some(k => f[k] !== undefined && f[k] !== false)) throw new ConfigError("--selection 不能与课程/课次参数同时使用");
    const raw = JSON.parse((await fs.readFile(path.resolve(f.selection as string), "utf8")).replace(/^\uFEFF/, ""));
    const value = raw?.selection ?? raw?.data?.selection ?? raw;
    if (!value || value.version !== 1 || !Array.isArray(value.lessonIds) || !value.lessonIds.length) throw new ConfigError("selection 需要 version=1、courseId 和非空 lessonIds；请使用 search lessons/resources --out 的输出");
    return { courseId: id(value.courseId, "course"), lessonIds: [...new Set(value.lessonIds.map((v: unknown) => id(v, "lesson-id")))] as string[] };
  }
  if (!f.course) throw new ConfigError("需要 --course 课程名称");
  const selectors = lessonSelectors(f);
  if (required && !Object.keys(selectors).length) throw new ConfigError("请用 --lesson / --date / --week-of / --all 明确课次");
  if (!client) return { courseId: id(f.course, "course"), selectors };
  const found = await resolveCourse(client, String(f.course), typeof f.teacher === "string" ? f.teacher : undefined);
  return { courseId: found.id, selectors, ...(found.course ? { course: found.course } : {}), ...(found.otherTerms ? { otherTerms: found.otherTerms, current: found.current === true } : {}) };
}
export async function selectedLessons(client: Zhiyun, resolved: Awaited<ReturnType<typeof resolveSelection>>) {
  const rows = await catalogue(client, resolved.courseId);
  if (resolved.lessonIds) return resolved.lessonIds.map(subId => selectLessons(rows, { subId })[0]!);
  return selectLessons(rows, resolved.selectors!);
}
export function publicLesson(l: Lesson) {
  return { courseId: l.courseId, lessonId: l.subId, lessonNumber: l.lesson, title: l.title, teacher: l.teacher,
    startsAt: l.startsAt, playable: l.playable, url: l.url, availableKinds: [...new Set(l.assets.map(a => a.kind === "courseware" ? "ppt" : a.kind))] };
}
/** CLI 里的一行课次：第几次、日期与时间、能否回放、有哪些资源；平台编号留在 download.json。 */
export function lessonRow(l: Lesson) {
  return { lesson: l.lesson, title: l.title, date: l.startsAt?.slice(0, 10) ?? null, time: l.startsAt?.slice(11, 16) ?? null, teacher: l.teacher,
    playable: l.playable, kinds: [...new Set(l.assets.map(a => a.kind === "courseware" ? "ppt" : a.kind))], url: l.url };
}
export function selectionFor(courseId: string, rows: Lesson[]): Selection { return { version: 1, courseId, lessonIds: rows.map(l => l.subId) }; }
export async function saveQuery<T extends object>(value: T, out?: string): Promise<T & { saved?: string }> {
  if (!out) return value;
  const file = path.resolve(out); await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { ...value, saved: file };
}
