/** Read-only PE attendance status and history. */
import { AuthExpired, ConfigError, RateLimited, RemoteRejected } from "../core/errors.ts";
import type { ApiResponse, AttendanceClient, RequestObserver } from "./client.ts";

export interface Course { courseId: string; name: string; teacherId: string }
type Probe = RequestObserver;
type RecordRow = { week: string; status: string; method?: "gps" | "qr" };
type Session = { week: string | undefined; date: string; deleted: boolean; qrReason: string };
type Gps = { week?: string; reason: string; error?: string };
type LocationReads = Map<string, Promise<ApiResponse>>;

// Only declared diagnostic fields are retained, never location coordinates, uid or QR tokens.
const field = (value: unknown) => typeof value === "string" ? value.slice(0, 200)
  : typeof value === "number" || typeof value === "boolean" ? value : null;
const shape = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const API = "/api/l/v6";
/** App ClassAttendanceModel2.Status: 1 到, 6 迟. */
const SIGNED = new Set(["1", "6"]);
const recordMethod = (type: unknown): "gps" | "qr" | undefined => String(type) === "2" ? "gps" : String(type) === "1" ? "qr" : undefined;
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const gpsFailure = (error: unknown): Gps => ({ reason: error instanceof AuthExpired ? "auth-error" : "request-error", error: describe(error) });
function gpsMessage(gps: Gps): string {
  if (gps.error) return "GPS 查询失败：" + gps.error + "。无法据此判断 GPS 是否开放。";
  if (gps.week) return "已取得第 " + gps.week + " 次课的匹配 GPS 目标。";
  switch (gps.reason) {
    case "course-mismatch": return "已取得教师位置，但返回课程与本人课程不一致，尚未匹配到本课 GPS 目标。";
    case "different-day": return "GPS 返回的课次日期不属于今天，尚未匹配到今天的 GPS 目标。";
    case "deleted-session": return "GPS 返回的课次已被标记删除，尚未匹配到可用 GPS 目标。";
    case "ambiguous-session": return "GPS 返回的课次关联存在冲突，暂时无法确定目标课次。";
    case "incomplete-location": return "已收到教师位置响应，但缺少有效课程或课次，暂时无法确定 GPS 目标。";
    case "invalid-location": return "教师位置响应格式异常，暂时无法确定 GPS 目标。";
    default: return "本次未取得教师位置，无法确认 GPS 是否开放。";
  }
}
function rethrowFatal(error: unknown): void {
  if (error instanceof ConfigError || error instanceof RateLimited) throw error;
}
const campusDay = (at: number) => new Date(at + 8 * 3600_000).toISOString().slice(0, 10);
const sessionId = (value: unknown): string | undefined => {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0 ? String(Number(text)) : undefined;
};
function data(res: ApiResponse, what: string): unknown {
  if (res.code !== 200) throw new RemoteRejected("体艺" + what + "失败：" + (res.message || "code " + res.code), { code: res.code });
  return res.data;
}
export async function myCourses(client: AttendanceClient): Promise<Course[]> {
  const terms = data(await client.get(API + "/termlist"), "学期查询");
  const term = (Array.isArray(terms) ? terms : []).find(t => t?.thisTerm === true);
  if (!term) throw new RemoteRejected("体艺未返回当前学期");
  const rows = data(await client.get(API + "/student/courselist", {
    uid: client.username, termId: String(term.termId), schoolYear: String(term.schoolYear),
  }), "课程查询");
  if (!Array.isArray(rows)) throw new RemoteRejected("体艺课程列表格式异常");
  return [...new Map(rows.map(c => {
    if (!c?.courseId || !c?.teacherId) throw new RemoteRejected("体艺课程缺少课程或教师标识");
    const course = { courseId: String(c.courseId), name: String(c.name), teacherId: String(c.teacherId) };
    return [course.courseId, course] as const;
  })).values()];
}
async function records(client: AttendanceClient, courseId: string, probe?: Probe): Promise<RecordRow[]> {
  const res = await client.get(API + "/student/attendancelist", { uid: client.username, courseId });
  const raw = res.data as { detail?: unknown } | null;
  await probe?.("records-probe", { courseId, code: res.code, httpStatus: res.httpStatus, dataType: shape(res.data),
    rows: (Array.isArray(raw?.detail) ? raw.detail : []).map(r => ({
      teachingWeek: field(r?.teachingWeek), status: field(r?.status), time: field(r?.time), type: field(r?.type),
    })) });
  const body = data(res, "考勤记录查询") as { detail?: unknown } | null;
  if (!Array.isArray(body?.detail)) throw new RemoteRejected("体艺考勤记录格式异常");
  return body.detail.flatMap(r => {
    const week = sessionId(r?.teachingWeek);
    const method = recordMethod(r?.type);
    return week ? [{ week, status: String(r?.status), ...(method ? { method } : {}) }] : [];
  });
}
const isSigned = (rows: RecordRow[], week: string) => rows.some(r => r.week === week && SIGNED.has(r.status));

/** Fetch once per teacher per round, but log the match separately for every own course. */
async function location(client: AttendanceClient, course: Course, reads: LocationReads, probe?: Probe): Promise<Gps> {
  const reused = reads.has(course.teacherId);
  if (!reused) reads.set(course.teacherId, client.get(API + "/attendance/potion", { tid: course.teacherId }));
  const res = await reads.get(course.teacherId)!;
  const context = { courseId: course.courseId, teacherId: course.teacherId, code: res.code,
    httpStatus: res.httpStatus, dataType: shape(res.data), reusedWithinPoll: reused };
  if (res.code !== 200) {
    await probe?.("gps-probe", { ...context, reason: res.code === 422 ? "location-unavailable" : "remote-error", message: res.message });
    if (res.code === 422) return { reason: "location-unavailable" };
  }
  let value = data(res, "考勤位置查询");
  if (typeof value === "string") {
    try { value = value.trim() ? JSON.parse(value) : null; }
    catch {
      await probe?.("gps-probe", { ...context, reason: "invalid-json" });
      throw new RemoteRejected("体艺考勤位置返回了无法解析的数据");
    }
  }
  const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const week = sessionId(item?.teachingWeek);
  const reason = value == null ? "empty-location" : !item ? "invalid-location"
    : !item.courseId || !week ? "incomplete-location"
    : String(item.courseId) !== course.courseId ? "course-mismatch" : "candidate";
  await probe?.("gps-probe", { ...context, reason, returnedCourseId: field(item?.courseId),
    teachingWeek: field(item?.teachingWeek), hasCoordinates: item?.lat != null && item?.lng != null });
  return reason === "candidate" ? { week: week!, reason } : { reason };
}

/** Empty fields impose no clock gate; malformed nonempty fields must not open a window. */
function timeOn(value: unknown, day: string): number | undefined {
  if (value == null || String(value).trim() === "") return undefined;
  const match = /(?:^|[T\s])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:$|[.+Z])/.exec(String(value).trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) return NaN;
  return Date.parse(day + "T" + match[1]!.padStart(2, "0") + ":" + match[2] + ":" + (match[3] ?? "00") + "+08:00");
}
async function sessions(client: AttendanceClient, course: Course, now: number, probe?: Probe): Promise<Session[]> {
  const res = await client.get(API + "/course_times", { courseId: course.courseId });
  const day = campusDay(now), context = { courseId: course.courseId, day, code: res.code, httpStatus: res.httpStatus };
  if (res.code !== 200) await probe?.("qr-probe", { ...context, reason: "remote-error", message: res.message });
  const raw = data(res, "课次查询");
  if (!Array.isArray(raw)) {
    await probe?.("qr-probe", { ...context, reason: "invalid-list", dataType: shape(raw) });
    throw new RemoteRejected("体艺课次列表格式异常");
  }
  const inspected: Record<string, unknown>[] = [];
  const rows = raw.map(r => {
    const week = sessionId(r?.teachingWeek), date = String(r?.date ?? "").slice(0, 10);
    const deleted = [true, 1, "1", "true"].includes(r?.isDelete);
    const hasAttendanceTime = r?.attendanceStartTime || r?.attendanceEndTime;
    const start = timeOn(hasAttendanceTime ? r.attendanceStartTime : r?.startTime, day);
    const end = timeOn(hasAttendanceTime ? r.attendanceEndTime : r?.endTime, day);
    const qrReason = deleted ? "deleted" : date !== day ? "different-day" : !week ? "missing-session"
      : Number.isNaN(start) || Number.isNaN(end) || (start !== undefined && end !== undefined && end < start) ? "invalid-window"
      : start !== undefined && now < start ? "before-window" : end !== undefined && now > end ? "after-window" : "candidate";
    inspected.push({ teachingWeek: field(r?.teachingWeek), date: field(r?.date), isDelete: field(r?.isDelete),
      startTime: field(r?.startTime), endTime: field(r?.endTime),
      attendanceStartTime: field(r?.attendanceStartTime), attendanceEndTime: field(r?.attendanceEndTime), reason: qrReason });
    return { week, date, deleted, qrReason };
  });
  const candidates = rows.filter(r => r.qrReason === "candidate");
  await probe?.("qr-probe", { ...context, reason: candidates.length === 1 ? "candidate" : candidates.length > 1 ? "ambiguous-session"
    : rows.some(r => r.date === day) ? "no-eligible-row" : "no-today-row", rows: inspected });
  return rows;
}
function gpsCheck(gps: Gps, rows: Session[], day: string): Gps {
  if (!gps.week) return gps;
  const matching = rows.filter(r => r.week === gps.week);
  // course_times is dynamic. Its absence must not become a new prerequisite for the App GPS path.
  if (!matching.length) return { week: gps.week, reason: "candidate-date-unconfirmed" };
  if (matching.length === 1 && !matching[0]!.deleted && !/^\d{4}-\d{2}-\d{2}$/.test(matching[0]!.date))
    return { week: gps.week, reason: "candidate-date-unconfirmed" };
  const reason = matching.length > 1 ? "ambiguous-session"
    : matching[0]!.deleted ? "deleted-session" : matching[0]!.date !== day ? "different-day" : "candidate";
  return reason === "candidate" ? gps : { reason };
}
function qrWeek(rows: Session[], preferred?: string): string | undefined {
  const candidates = rows.filter(r => r.qrReason === "candidate" && (preferred === undefined || r.week === preferred));
  return candidates.length === 1 ? candidates[0]!.week : undefined;
}
function signedSession(rows: RecordRow[], times: Session[], gps: Gps, day: string): string | undefined {
  const target = gps.week ?? qrWeek(times);
  // Once discovery identifies a target, a different signed session must not end this task.
  if (target) return isSigned(rows, target) ? target : undefined;
  const today = times.filter(r => !r.deleted && r.date === day && r.week !== undefined);
  // Several sessions on one day need an explicit current target before declaring completion.
  return today.length === 1 && isSigned(rows, today[0]!.week!) ? today[0]!.week : undefined;
}
const STATUS_LABELS: Record<string, string> = { "-1": "停课", "0": "未考勤", "1": "到", "2": "缺勤", "3": "早退", "4": "病假", "5": "事假", "6": "迟到", "7": "未确认" };

/**
 * Attendance history of every term's PE course, newest first. Counts come from the held sessions in `detail`:
 * the list's own `lack` also counts sessions not yet held (2026-09 term: shouldReach 16, lack 13 after 3 classes).
 */
export async function history(client: AttendanceClient, course?: string) {
  const wanted = course?.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const terms = data(await client.get(`${API}/termlist`), "学期查询");
  const perTerm = await Promise.all((Array.isArray(terms) ? terms : []).reverse().map(async (t) => {
    const rows = data(await client.get(`${API}/student/courselist`, { uid: client.username, termId: String(t.termId), schoolYear: String(t.schoolYear) }), "课程查询");
    return (Array.isArray(rows) ? rows : []).map((c) => ({ courseId: String(c.courseId), name: String(c.name), semester: String(t.name ?? "") }));
  }));
  const courses = perTerm.flat().filter((c) => !wanted || c.name.normalize("NFKC").replace(/\s+/g, "").toLowerCase().includes(wanted));
  const found = await Promise.all(courses.map(async (c) => {
    const [list, times] = await Promise.all([
      client.get(`${API}/student/attendancelist`, { uid: client.username, courseId: c.courseId }).then((res) => data(res, "考勤记录查询") as { shouldReach?: unknown; detail?: unknown } | null),
      client.get(`${API}/course_times`, { courseId: c.courseId }).then((res) => data(res, "课次查询")),
    ]);
    const dates = new Map((Array.isArray(times) ? times : []).map((r) => [String(r.teachingWeek), String(r.date ?? "").slice(0, 10)]));
    const records = (Array.isArray(list?.detail) ? list.detail : []).map((r) => ({
      session: Number(r.teachingWeek), date: dates.get(String(r.teachingWeek)) ?? "",
      status: (STATUS_LABELS[String(r.status)] ?? `状态 ${r.status}`) + (Number(r.isEarly) === 1 && String(r.status) !== "3" ? "（早退）" : ""),
    })).sort((a, b) => b.session - a.session);
    const signed = records.filter((r) => r.status.startsWith("到") || r.status.startsWith("迟到")).length;
    return { course: c.name, semester: c.semester, planned: Number(list?.shouldReach) || undefined, held: records.length, signed, records };
  }));
  const missed = found.flatMap((c) => c.records.filter((r) => !/^(到|迟到|停课)/.test(r.status)).map((r) => `${c.course} 第 ${r.session} 次课${r.date ? `（${r.date}）` : ""} ${r.status}`));
  const held = found.reduce((n, c) => n + c.held, 0), signed = found.reduce((n, c) => n + c.signed, 0);
  const message = !courses.length ? (course ? `没有找到体育课“${course}”。` : "没有体艺课程。")
    : !held ? `${found.map((c) => c.course).join("、")}还没有考勤记录。`
    : `${found.length} 门体育课已有 ${held} 次考勤，到勤 ${signed} 次` + (missed.length ? `，未到：${missed.join("；")}。` : "，没有缺勤。");
  return { status: held ? "found" : "none", message, courses: found };
}

/** Read current targets and held records without generating a token or writing attendance. */
export async function attendance(client: AttendanceClient, probe?: Probe) {
  const items: { course: string; status: string; message: string; session?: string; recordedMethod?: "gps" | "qr";
    gps: { status: string; message: string; session?: string } }[] = [];
  const reads: LocationReads = new Map();
  for (const course of await myCourses(client)) {
    const now = Date.now(), day = campusDay(now);
    const errors: string[] = [];
    let gps: Gps, times: Session[] = [], rows: RecordRow[] = [];
    try { gps = await location(client, course, reads, probe); }
    catch (error) { rethrowFatal(error); gps = gpsFailure(error); }
    try { times = await sessions(client, course, now, probe); }
    catch (error) { rethrowFatal(error); errors.push("课次查询失败：" + describe(error)); }
    const checked = gpsCheck(gps, times, day);
    await probe?.("gps-check", { courseId: course.courseId, reason: checked.reason, returnedSession: gps.week ?? null, day });
    try { rows = await records(client, course.courseId, probe); }
    catch (error) { rethrowFatal(error); errors.push("到勤记录查询失败：" + describe(error)); }
    const qr = qrWeek(times, checked.week);
    const signed = signedSession(rows, times, checked, day);
    const week = signed ?? checked.week ?? qr;
    const status = signed ? "already-signed" : checked.week ? "gps-available" : qr ? "session-found" : "unknown";
    const method = signed ? rows.find(r => r.week === signed && SIGNED.has(r.status))?.method : undefined;
    const message = signed ? "第 " + signed + " 次课已到勤" + (method ? "（记录方式：" + (method === "gps" ? "GPS" : "扫码") + "）" : "") + "。" + gpsMessage(checked)
      : gpsMessage(checked) + (qr && !checked.week ? "已找到当天课次。" : "")
        + "尚未确认目标课次到勤。" + (errors.length ? errors.join("；") + "。" : "");
    items.push({ course: course.name, status, message, ...(week ? { session: week } : {}), ...(method ? { recordedMethod: method } : {}),
      gps: { status: checked.week ? "available" : checked.reason, message: gpsMessage(checked), ...(checked.week ? { session: checked.week } : {}) } });
  }
  const status = ["already-signed", "gps-available", "session-found"].find(status => items.some(item => item.status === status)) ?? (items.length ? "unknown" : "no-course");
  return { status, items, message: items.length ? items.map(item => item.course + "：" + item.message).join("\n") : "当前学期没有体艺课程。" };
}
