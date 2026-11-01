/**
 * 学在浙大点名的只读查询：当前有没有点名、本人是否已签，以及各课程的历史点名记录。
 * 本版本不提交签到。
 */
import { BadResponse } from "../core/errors.ts";
import { beijingMinute } from "../core/output.ts";
import type { Xuezai } from "./client.ts";
import { listCourses } from "./courses.ts";

export type RollcallClient = Pick<Xuezai, "json" | "request">;
export interface Rollcall {
  rollcall_id: number; course_title?: string; title?: string;
  is_radar?: boolean; is_number?: boolean; status?: string; status_name?: string;
  [key: string]: unknown;
}

export function answered(payload: unknown): boolean {
  const p = payload as { status?: unknown; status_name?: unknown } | null | undefined;
  return [p?.status, p?.status_name].some((s) => s === "on_call" || s === "on_call_fine");
}

export async function listRollcalls(client: RollcallClient, signal?: AbortSignal): Promise<Rollcall[]> {
  const data = await client.json<{ rollcalls?: Rollcall[] }>("/api/radar/rollcalls", signal ? { signal } : {});
  if (!Array.isArray(data?.rollcalls)) throw new BadResponse("点名响应缺少 rollcalls 数组");
  return data.rollcalls;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface PastRollcall { rollcall_time?: string; source?: string; status?: string; student_status?: string; rollcall_status?: string }
const SOURCES: Record<string, string> = { radar: "雷达", number: "数字", qr: "二维码" };
function pastStatus(row: PastRollcall): string {
  if (answered(row) || row.student_status === "on_call") return "已签到";
  if (row.rollcall_status && row.rollcall_status !== "finished") return "未签（点名未结束）";
  const status = row.student_status || row.status || "";
  return status === "absent" ? "缺勤" : status || "未知";
}

/** Past rollcalls per course, newest first: when, how (radar/number/QR) and whether this student signed. */
export async function rollcallHistory(client: Xuezai, course?: string) {
  const { id: user } = await client.me();
  const courses = await listCourses(client, course ? { keyword: course } : {});
  const found: { course: string; semester: string; total: number; signed: number; notSigned: number; latest: string; records: { time: string; type: string; status: string }[] }[] = [];
  const errors: { course: string; message: string }[] = [];
  for (let i = 0; i < courses.length; i += 6) {
    await Promise.all(courses.slice(i, i + 6).map(async (c) => {
      try {
        const data = await client.json<{ rollcalls?: PastRollcall[] }>(`/api/course/${c.id}/student/${user}/rollcalls`);
        if (!Array.isArray(data?.rollcalls)) throw new BadResponse("点名记录响应缺少 rollcalls 数组");
        if (!data.rollcalls.length) return;
        const records = data.rollcalls.map((r) => ({ time: beijingMinute(r.rollcall_time) ?? "", type: SOURCES[r.source ?? ""] ?? r.source ?? "", status: pastStatus(r) }))
          .sort((a, b) => b.time.localeCompare(a.time));
        const signed = records.filter((r) => r.status === "已签到").length;
        found.push({ course: c.name, semester: c.semester?.name ?? "", total: records.length, signed, notSigned: records.length - signed, latest: records[0]!.time, records });
      } catch (error) { errors.push({ course: c.name, message: describe(error) }); }
    }));
  }
  found.sort((a, b) => b.latest.localeCompare(a.latest));
  const missed = found.flatMap((c) => c.records.filter((r) => r.status !== "已签到").map((r) => `${c.course} ${r.time} ${r.status}`));
  const total = found.reduce((n, c) => n + c.total, 0);
  const message = !courses.length ? `没有找到课程“${course}”。`
    : !found.length ? `${course ? [...new Set(courses.map((c) => c.name))].join("、") : "所有课程"}没有点名记录${errors.length ? "（部分课程读取失败）" : ""}。`
    : `${found.length} 门课共 ${total} 次点名，已签到 ${total - missed.length} 次` + (missed.length
      ? `，未签到 ${missed.length} 次：${missed.slice(0, 10).join("；")}${missed.length > 10 ? " 等" : ""}。` : "，没有未签到。");
  const result = { status: found.length ? "found" : "none", message, courses: found.map(({ latest, ...c }) => c) };
  if (errors.length) throw new BadResponse("部分课程点名记录读取失败，结果不完整", { result: { ...result, errors } });
  return result;
}
