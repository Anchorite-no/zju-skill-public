/**
 * 学在浙大点名签到，接入原 ZJU-Course-Autosign（src/core.js）的流程：
 * 每轮 GET /api/radar/rollcalls；未签的雷达点名先用默认点 ZJGD1、再依次用 12 个校区参考点应答，
 * 收集响应里的 distance，凑满 3 个就用 100 位 Decimal 球面 Gauss-Newton 拟合位置再应答一次。
 * 没签上的雷达点名下一轮整套重试；默认入口只处理雷达，数字入口另行注册。
 * 相对原脚本只多两点：每次应答前写日志；单个参考点出错不打断本轮其余参考点。
 */
import crypto from "node:crypto";
import { Decimal as DecimalBase } from "decimal.js";
import { BadResponse, ConfigError, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { beijingMinute } from "../core/output.ts";
import { BASE, type Xuezai } from "./client.ts";
import { listCourses } from "./courses.ts";
import type { Journal } from "./types.ts";

export type RollcallClient = Pick<Xuezai, "json" | "request">;
export interface Rollcall {
  rollcall_id: number; course_title?: string; title?: string;
  is_radar?: boolean; is_number?: boolean; status?: string; status_name?: string;
  [key: string]: unknown;
}
export interface SigninOptions {
  confirm: boolean; journal: Journal; pollMs: number; durationMs: number;
  signal?: AbortSignal; onEvent?: (message: string) => void;
  /** Composition hook: cancel the sibling as soon as success is confirmed, before resource cleanup. */
  onSuccess?: (result: SigninResult) => void;
  /** Test clock and wait. */
  now?: () => number; wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export interface SigninResult {
  status: "signed" | "already-signed" | "needs-code" | "not-signed" | "cancelled";
  message: string; course?: string; polls: number; answers: number; lastError?: string;
}

const RADAR_AT = "ZJGD1";
const RADAR_POINTS: Record<string, [number, number]> = {
  ZJGD1: [120.089136, 30.302331], ZJGX1: [120.085042, 30.30173], ZJGB1: [120.077135, 30.305142],
  YQ4: [120.122176, 30.261555], YQ1: [120.123853, 30.262544], YQ7: [120.120344, 30.263907],
  ZJ1: [120.126008, 30.192908], HJC1: [120.195939, 30.272068], HJC2: [120.198193, 30.270419],
  ZJ2: [120.124267, 30.19139], YQSS: [120.124001, 30.265735], ZJG4: [120.073427, 30.299757],
};

export function answered(payload: unknown): boolean {
  const p = payload as { status?: unknown; status_name?: unknown } | null | undefined;
  return [p?.status, p?.status_name].some((s) => s === "on_call" || s === "on_call_fine");
}

export async function listRollcalls(client: RollcallClient, signal?: AbortSignal): Promise<Rollcall[]> {
  const data = await client.json<{ rollcalls?: Rollcall[] }>("/api/radar/rollcalls", signal ? { signal } : {});
  if (!Array.isArray(data?.rollcalls)) throw new BadResponse("点名响应缺少 rollcalls 数组");
  return data.rollcalls;
}

/** The CLI aborts with a TimeoutError at the deadline; only an earlier abort is a user cancellation. */
export const cancelledBeforeDeadline = (signal: AbortSignal | undefined, expired: boolean) => !!signal?.aborted && !expired && signal.reason?.name !== "TimeoutError";
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const nameOf = (row: Rollcall) => row.course_title || row.title || `点名 ${row.rollcall_id}`;
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

interface Answerer { client: RollcallClient; log: (stage: string, detail: Record<string, unknown>) => Promise<void>; signal?: AbortSignal }

/** autosign requestAnswer; the journal entry is written before the request is sent. */
async function answerAt(ctx: Answerer, rollcallId: number, [longitude, latitude]: [number, number]): Promise<Record<string, unknown> | null> {
  await ctx.log("answer", { rollcallId, longitude, latitude });
  const res = await ctx.client.request(`/api/rollcall/${rollcallId}/answer?api_version=1.1.2`, {
    method: "PUT", headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ deviceId: crypto.randomUUID(), latitude, longitude, speed: null, accuracy: 68, altitude: null, altitudeAccuracy: null, heading: null }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const body = res.json<Record<string, unknown>>();
  await ctx.log("response", { rollcallId, httpStatus: res.status, body });
  return body;
}

/** autosign answerRaderRollcall: default point, every reference point, then the point fitted from ≥3 distances. */
async function answerRadar(ctx: Answerer, rollcallId: number): Promise<{ success: boolean; reason: string }> {
  const outcomes: [[number, number], Record<string, unknown> | null][] = [];
  let lastError: string | undefined;
  for (const point of [RADAR_POINTS[RADAR_AT]!, ...Object.values(RADAR_POINTS)]) {
    if (ctx.signal?.aborted) return { success: false, reason: "已取消" };
    try {
      const outcome = await answerAt(ctx, rollcallId, point);
      if (answered(outcome)) return { success: true, reason: "" };
      outcomes.push([point, outcome]);
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      lastError = describe(error);
    }
  }
  const nested = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>).distance : undefined);
  const points = outcomes.flatMap(([[lon, lat], outcome]) => {
    const d = Number(outcome?.distance ?? nested(outcome?.data) ?? nested(outcome?.result));
    return Number.isFinite(d) && d > 0 ? [{ lon, lat, d }] : [];
  });
  if (points.length < 3) return { success: false, reason: `参考点只取得 ${points.length} 个距离，无法定位${lastError ? `（最近错误：${lastError}）` : ""}` };
  const estimate = solveSphereLeastSquaresDecimal(points);
  const outcome = await answerAt(ctx, rollcallId, [estimate.lon, estimate.lat]);
  return answered(outcome) ? { success: true, reason: "" } : { success: false, reason: `按 ${points.length} 个距离拟合的位置仍未签上` };
}

/** Poll radar rollcalls and answer until signed, already signed, cancellation or the deadline. Every error is retried next round. */
export async function signin(client: RollcallClient, opts: SigninOptions): Promise<SigninResult> {
  if (!opts.confirm || !writeAllowed()) throw new WriteGateClosed("学在浙大签到");
  const now = opts.now ?? Date.now, wait = opts.wait ?? sleep, deadline = now() + opts.durationMs;
  const tried = new Set<number>();
  let polls = 0, answers = 0, lastError: string | undefined, lastCourse: string | undefined;
  const ctx: Answerer = { client, ...(opts.signal ? { signal: opts.signal } : {}), log: async (stage, detail) => {
    if (stage === "answer") answers++;
    try { await opts.journal({ at: new Date(now()).toISOString(), action: "xuezai.rollcall", stage, detail }); }
    catch (error) { throw new ConfigError("签到日志写入失败，停止提交：" + describe(error)); }
  } };
  const finish = (status: SigninResult["status"], message: string, course?: string): SigninResult => {
    const result = { status, message, ...(course ? { course } : {}), polls, answers, ...(lastError && status !== "signed" && status !== "already-signed" ? { lastError } : {}) };
    if (status === "signed" || status === "already-signed") opts.onSuccess?.(result);
    return result;
  };
  while (!opts.signal?.aborted && now() < deadline) {
    polls++;
    try {
      const rows = (await listRollcalls(client, opts.signal)).filter(row => row.is_radar);
      const confirmed = rows.find((row) => answered(row) && tried.has(row.rollcall_id));
      if (confirmed) return finish("signed", `已签到：${nameOf(confirmed)}。`, nameOf(confirmed));
      const pending = rows.filter((row) => !answered(row));
      if (rows.length && !pending.length) return finish("already-signed", `当前点名已是签到状态（${rows.map(nameOf).join("、")}），本次未提交。`);
      for (const row of pending) {
        tried.add(row.rollcall_id); lastCourse = nameOf(row);
        opts.onEvent?.(`第 ${polls} 轮：${nameOf(row)} 雷达点名，开始应答`);
        const result = await answerRadar(ctx, row.rollcall_id);
        if (result.success) return finish("signed", `已签到：${nameOf(row)}。`, nameOf(row));
        lastError = result.reason;
      }
    } catch (error) {
      if (error instanceof ConfigError || error instanceof WriteGateClosed) throw error;
      lastError = describe(error);
      opts.onEvent?.(`第 ${polls} 轮出错，继续重试：${lastError}`);
    }
    if (now() >= deadline) break;
    await wait(Math.min(opts.pollMs, Math.max(0, deadline - now())), opts.signal);
  }
  if (cancelledBeforeDeadline(opts.signal, now() >= deadline)) return finish("cancelled", "签到已取消。");
  const seconds = Math.round(opts.durationMs / 1000);
  return finish("not-signed", lastCourse ? `${lastCourse} 的点名在 ${seconds} 秒内没有签上${lastError ? `：${lastError}` : ""}。`
    : `${seconds} 秒内没有发现点名，未签到${lastError ? `（最近错误：${lastError}）` : ""}。`);
}

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

// Ported directly from the user's ZJU-Course-Autosign/src/core.js (GPL-3.0-only).
// Keep its 100-digit spherical Gauss-Newton solver, radius, epsilon and convergence threshold.
const Decimal = DecimalBase.clone({ precision: 100 });
interface RadarPoint { lon: number; lat: number; d: number }
function decimalHaversineDist(lon: DecimalBase.Value, lat: DecimalBase.Value, lonI: DecimalBase.Value, latI: DecimalBase.Value, radius: DecimalBase) {
  const degrees = Decimal.acos(-1).div(180);

  const longitude = new Decimal(lon).mul(degrees);
  const latitude = new Decimal(lat).mul(degrees);
  const longitudeI = new Decimal(lonI).mul(degrees);
  const latitudeI = new Decimal(latI).mul(degrees);

  const dLatitude = latitude.minus(latitudeI);
  const dLongitude = longitude.minus(longitudeI);

  const sinLatitude = dLatitude.div(2).sin().pow(2);
  const sinLongitude = dLongitude.div(2).sin().pow(2);

  const h = sinLatitude.plus(
    latitude.cos().mul(latitudeI.cos()).mul(sinLongitude)
  );

  const deltaSigma = Decimal.asin(h.sqrt()).mul(2);
  return radius.mul(deltaSigma);
}

function residualsDecimal(lon: DecimalBase.Value, lat: DecimalBase.Value, points: RadarPoint[], radius: DecimalBase) {
  return points.map((point) => {
    const distance = decimalHaversineDist(
      lon,
      lat,
      point.lon,
      point.lat,
      radius
    );

    return new Decimal(point.d).minus(distance);
  });
}

function jacobianDecimal(lon: DecimalBase.Value, lat: DecimalBase.Value, points: RadarPoint[], radius: DecimalBase) {
  const epsilon = new Decimal("1e-12");
  const base = residualsDecimal(lon, lat, points, radius);
  const longitudeResiduals = residualsDecimal(
    new Decimal(lon).plus(epsilon),
    lat,
    points,
    radius
  );
  const latitudeResiduals = residualsDecimal(
    lon,
    new Decimal(lat).plus(epsilon),
    points,
    radius
  );

  return points.map((_, index) => [
    longitudeResiduals[index]!.minus(base[index]!).div(epsilon).neg(),
    latitudeResiduals[index]!.minus(base[index]!).div(epsilon).neg(),
  ]);
}

function gaussNewtonDecimal(points: RadarPoint[], lon0: number, lat0: number, radius: DecimalBase, onIteration?: (i: number, lon: DecimalBase, lat: DecimalBase) => void) {
  let lon = new Decimal(lon0);
  let lat = new Decimal(lat0);

  for (let iteration = 0; iteration < 30; iteration += 1) {
    const residuals = residualsDecimal(lon, lat, points, radius);
    const jacobian = jacobianDecimal(lon, lat, points, radius);

    let jtj: [[DecimalBase, DecimalBase], [DecimalBase, DecimalBase]] = [
      [new Decimal(0), new Decimal(0)],
      [new Decimal(0), new Decimal(0)],
    ];
    let jtr: [DecimalBase, DecimalBase] = [new Decimal(0), new Decimal(0)];

    for (let index = 0; index < points.length; index += 1) {
      const row = jacobian[index]!;
      const residual = residuals[index]!;

      jtj[0][0] = jtj[0][0].plus(row[0]!.mul(row[0]!));
      jtj[0][1] = jtj[0][1].plus(row[0]!.mul(row[1]!));
      jtj[1][0] = jtj[1][0].plus(row[1]!.mul(row[0]!));
      jtj[1][1] = jtj[1][1].plus(row[1]!.mul(row[1]!));

      jtr[0] = jtr[0].plus(row[0]!.mul(residual));
      jtr[1] = jtr[1].plus(row[1]!.mul(residual));
    }

    const determinant = jtj[0][0].mul(jtj[1][1]).minus(jtj[0][1].mul(jtj[1][0]));
    const inverse: [[DecimalBase, DecimalBase], [DecimalBase, DecimalBase]] = [
      [jtj[1][1].div(determinant), jtj[0][1].neg().div(determinant)],
      [jtj[1][0].neg().div(determinant), jtj[0][0].div(determinant)],
    ];

    const dLon = inverse[0][0].mul(jtr[0]).plus(inverse[0][1].mul(jtr[1]));
    const dLat = inverse[1][0].mul(jtr[0]).plus(inverse[1][1].mul(jtr[1]));

    lon = lon.plus(dLon);
    lat = lat.plus(dLat);

    onIteration?.(iteration, lon, lat);

    if (dLon.abs().lt("1e-14") && dLat.abs().lt("1e-14")) {
      break;
    }
  }

  return { lon, lat };
}

function rmsDecimal(lon: DecimalBase.Value, lat: DecimalBase.Value, points: RadarPoint[], radius: DecimalBase) {
  let sum = new Decimal(0);

  for (const point of points) {
    const distance = decimalHaversineDist(
      lon,
      lat,
      point.lon,
      point.lat,
      radius
    );
    const diff = new Decimal(point.d).minus(distance);
    sum = sum.plus(diff.mul(diff));
  }

  return sum.div(points.length).sqrt();
}

function solveSphereLeastSquaresDecimal(rawPoints: RadarPoint[], onIteration?: (i: number, lon: DecimalBase, lat: DecimalBase) => void) {
  const lon0 =
    rawPoints.reduce((sum, point) => sum + point.lon, 0) / rawPoints.length;
  const lat0 =
    rawPoints.reduce((sum, point) => sum + point.lat, 0) / rawPoints.length;
  const radius = new Decimal("6372999.26");
  const result = gaussNewtonDecimal(rawPoints, lon0, lat0, radius, onIteration);
  const rms = rmsDecimal(result.lon, result.lat, rawPoints, radius);

  return {
    lon: Number(result.lon),
    lat: Number(result.lat),
    rms: Number(rms),
  };
}
