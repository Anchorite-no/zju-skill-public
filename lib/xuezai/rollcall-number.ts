/** Explicit digital sign-in: prepare captions, read bounded windows, submit evidenced codes and verify. */
import crypto from "node:crypto";
import { BadResponse, ConfigError, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { liveInput, type LiveInputRequest } from "../zhiyun/live-input.ts";
import { remoteTarget, runRemoteLiveInput } from "../zhiyun/remote.ts";
import { liveWait } from "../zhiyun/live-task.ts";
import { answered, cancelledBeforeDeadline, listRollcalls, type Rollcall, type RollcallClient, type SigninOptions, type SigninResult } from "./rollcall.ts";
import { BASE } from "./client.ts";

export interface CaptionSegment { start: string; end: string; text: string }
export interface CaptionWindow { status: string; message: string; course?: string; segments?: CaptionSegment[]; gaps?: unknown[] }
export interface CaptionInput {
  prepare(until: number, signal?: AbortSignal): Promise<void>;
  read(course: string, from: number, to: number, signal?: AbortSignal): Promise<CaptionWindow>;
  close(): Promise<void>;
}
const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

export function createCaptionInput(): CaptionInput {
  const requestId = crypto.randomUUID(); let started = false;
  const call = async (r: LiveInputRequest, signal?: AbortSignal) => {
    if (signal?.aborted) throw new ConfigError("字幕输入已取消");
    if ((process.env.ZJU_DISABLED_MODULES ?? "").split(",").some(x => x.trim().toLowerCase() === "zhiyun")) throw new ConfigError("智云模块已禁用，数字签到无法读取课堂字幕");
    return remoteTarget() ? runRemoteLiveInput(r, signal) : liveInput(r);
  };
  return {
    async prepare(until, signal) {
      started = true;
      const result = await call({ action: "start", requestId, until }, signal);
      if (!["running", "starting"].includes(String(result.status))) throw new BadResponse(String(result.message ?? "课堂字幕暂不可用"));
    },
    async read(course, from, to, signal) { return await call({ action: "text", course, from, to }, signal) as CaptionWindow; },
    async close() { if (started) await call({ action: "stop", requestId }, AbortSignal.timeout(8000)); },
  };
}

export interface NumberCandidate { code: string; score: number; mentions: number; evidence: string }
const CHINESE: Record<string, string> = { 零: "0", 〇: "0", 一: "1", 幺: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };

export function numberCandidates(segments: CaptionSegment[]): NumberCandidate[] {
  const rows = [...new Map(segments.map(s => [`${s.start}|${s.end}|${s.text}`, s])).values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  // A pause over 15 s breaks proximity between an anchor word and a number.
  const text = rows.map((s, i) => (i && Date.parse(s.start) - Date.parse(rows[i - 1]!.end) > 15000 ? "\u0000" : "") + s.text.normalize("NFKC") + " ").join("");
  const anchors = [...text.matchAll(/签到(?:密码|的密码|码|马)?|签[到道]码|切断码|点名(?:密码|码)?|点个毛|密码/g)].map(m => m.index!);
  const digitsOf = (token: string) => [...token].map(c => CHINESE[c] ?? c).join("");
  const tokens = [...text.matchAll(/[0-9零〇一二两三四五六七八九幺]+/g)];
  const occurrences: { at: number; end: number; digits: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const at = tokens[i]!.index!, digits = digitsOf(tokens[i]![0]);
    let combined = digits, end = at + tokens[i]![0].length;
    occurrences.push({ at, end, digits });
    // Split readings such as "12 34" join into one four-digit occurrence.
    for (let next = i + 1; combined.length < 4 && next < tokens.length; next++) {
      const following = tokens[next]!;
      if (!/^[\s,，、]+$/.test(text.slice(end, following.index!))) break;
      combined += digitsOf(following[0]); end = following.index! + following[0].length;
      if (combined.length === 4) occurrences.push({ at, end, digits: combined });
    }
  }
  const found = new Map<string, NumberCandidate>();
  for (const { at, end, digits } of occurrences) {
    const repeated = digits.length > 4 && digits.length % 4 === 0 && digits === digits.slice(0, 4).repeat(digits.length / 4);
    const code = repeated ? digits.slice(0, 4) : digits;
    if (!/^\d{4}$/.test(code) || /(?:不是|不要|别用|作废)\s*$/.test(text.slice(Math.max(0, at - 8), at))) continue;
    const distance = Math.min(...anchors.filter(p => !text.slice(Math.min(p, at), Math.max(p, end)).includes("\u0000")).map(p => p < at ? at - p : p - end));
    if (distance > 32) continue;
    const entry = found.get(code) ?? { code, score: 0, mentions: 0, evidence: text.slice(Math.max(0, at - 32), Math.min(text.length, end + 20)).replaceAll("\u0000", " ").trim() };
    const times = Math.max(1, digits.length / 4);
    entry.mentions += times; entry.score += 40 - distance + 10 * times;
    found.set(code, entry);
  }
  return [...found.values()].sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
}

interface NumberState {
  at: number; course: string; wrong: Set<string>; attempts: number; nextTextAt: number;
  candidates: NumberCandidate[]; text: string; reason: string;
}
export type NumberSigninResult = SigninResult & { windowText?: string; cleanupWarning?: string };

/**
 * Only codes the transcript supports are submitted, one per rollcall per round. An explicit wrong-code answer moves on
 * to the next candidate; any other outcome is checked against the rollcall list and the same code is retried next round.
 */
export async function signinNumber(client: RollcallClient, opts: SigninOptions, input: CaptionInput = createCaptionInput()): Promise<NumberSigninResult> {
  if (!opts.confirm || !writeAllowed()) throw new WriteGateClosed("学在数字签到");
  const now = opts.now ?? Date.now, wait = opts.wait ?? liveWait, deadline = now() + opts.durationMs;
  const states = new Map<number, NumberState>(); let prepared = false, nextPrepare = 0, polls = 0, answers = 0;
  let captionError = "", lastError = "", lastCourse = "", windowText = "", result: NumberSigninResult | undefined;
  const finish = (status: SigninResult["status"], message: string): NumberSigninResult => {
    const success = status === "signed" || status === "already-signed";
    const result = { status, message, polls, answers, ...(lastCourse ? { course: lastCourse } : {}), ...(!success && lastError ? { lastError } : {}), ...(!success && windowText ? { windowText } : {}) };
    if (success) opts.onSuccess?.(result);
    return result;
  };
  const log = async (stage: string, detail: Record<string, unknown>) => {
    try { await opts.journal({ at: new Date(now()).toISOString(), action: "xuezai.rollcall-number", stage, detail }); }
    catch (e) { throw new ConfigError("签到日志写入失败，停止提交：" + messageOf(e)); }
  };
  const courseName = async (row: Rollcall): Promise<string> => {
    if (typeof row.course_title === "string" && row.course_title.trim()) return row.course_title.trim();
    if (/^\d+$/.test(String(row.course_id ?? ""))) {
      const course = await client.json<{ name?: string }>(`/api/courses/${row.course_id}`, opts.signal ? { signal: opts.signal } : {});
      if (course.name?.trim()) return course.name.trim();
    }
    throw new BadResponse("数字点名缺少可确认的课程名称，未使用其他课堂的数字");
  };
  try {
    while (!opts.signal?.aborted && now() < deadline && !result) {
      polls++;
      try {
        if (!prepared && now() >= nextPrepare) {
          try { await input.prepare(deadline, opts.signal); prepared = true; }
          catch (e) { captionError = `课堂字幕暂不可用：${messageOf(e)}`; nextPrepare = now() + 30000; }
        }
        if (opts.signal?.aborted || now() >= deadline) break;
        const rows = (await listRollcalls(client, opts.signal)).filter(r => r.is_number);
        const verified = rows.find(r => answered(r) && states.get(r.rollcall_id)?.attempts);
        if (verified) { lastCourse = states.get(verified.rollcall_id)!.course; result = finish("signed", `数字签到成功：${lastCourse}。`); break; }
        const pending = rows.filter(r => !answered(r));
        if (rows.length && !pending.length) { result = finish("already-signed", "当前数字点名已签到，本次未提交。"); break; }
        let watching = !pending.length;
        for (const row of pending) {
          if (opts.signal?.aborted || now() >= deadline) break;
          let s = states.get(row.rollcall_id);
          if (!s) { s = { at: now(), course: await courseName(row), wrong: new Set(), attempts: 0, nextTextAt: 0, candidates: [], text: "", reason: "尚未发现有签到语境的四位码" }; states.set(row.rollcall_id, s); }
          lastCourse = s.course;
          // Evidence window is [T-300 s, T+300 s] around discovery; 10 s more lets the last sentences arrive.
          if (now() > s.at + 310000) { lastError = prepared ? s.reason : captionError; continue; }
          watching = true;
          if (prepared && now() >= s.nextTextAt) {
            s.nextTextAt = now() + 20000;
            const from = s.at - 300000, to = Math.min(now(), s.at + 300000);
            const window = await input.read(s.course, from, to, opts.signal);
            const segments = (window.segments ?? []).filter(p => typeof p.text === "string" && Date.parse(p.start) <= to && Date.parse(p.end) >= from);
            s.text = segments.map(p => p.text).join("\n");
            s.candidates = numberCandidates(segments);
            if (!s.candidates.length) s.reason = window.message || "窗口内没有可靠的四位签到码";
          }
          windowText = s.text;
          const candidate = s.attempts < 200 ? s.candidates.find(c => !s!.wrong.has(c.code)) : undefined;
          if (!candidate) { lastError = prepared ? s.reason : captionError; continue; }
          await log("answer", { rollcallId: row.rollcall_id, course: s.course, code: candidate.code, evidence: candidate.evidence });
          s.attempts++; answers++;
          // A transport error reaches the round handler below; the same code is retried next round.
          const response = await client.request(`/api/rollcall/${row.rollcall_id}/answer_number_rollcall`, {
            method: "PUT", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ deviceId: crypto.randomUUID(), numberCode: candidate.code }), ...(opts.signal ? { signal: opts.signal } : {}),
          });
          const body = response.json<Record<string, unknown>>();
          await log("response", { rollcallId: row.rollcall_id, httpStatus: response.status, body });
          if (typeof body?.error_code === "string" && /wrong/i.test(body.error_code)) {
            s.wrong.add(candidate.code); lastError = s.reason = `${[...s.wrong].join("、")} 明确错误，等待其他有文字依据的候选`; continue;
          }
          if ((await listRollcalls(client, opts.signal)).some(r => r.rollcall_id === row.rollcall_id && answered(r))) { result = finish("signed", `数字签到成功：${s.course}。`); break; }
          lastError = s.reason = `提交 ${candidate.code} 后回查仍未签到（HTTP ${response.status}），下一轮重试`;
        }
        if (!watching && !result) result = finish("needs-code", `数字点名观察窗口已结束，未签到：${lastError || "未取得可靠四位码"}。`);
      } catch (e) {
        if (e instanceof ConfigError || e instanceof WriteGateClosed) throw e;
        lastError = messageOf(e); opts.onEvent?.(`数字签到第 ${polls} 轮：${lastError}`);
      }
      if (!result && !opts.signal?.aborted && now() < deadline) await wait(Math.min(opts.pollMs, deadline - now()), opts.signal);
    }
    result ??= cancelledBeforeDeadline(opts.signal, now() >= deadline) ? finish("cancelled", "数字签到监测已停止。")
      : finish(states.size ? "needs-code" : "not-signed", `数字签到未完成：${lastError || captionError || (states.size ? "没有可靠四位码" : "等待期间没有发现数字点名")}。`);
    return result;
  } finally {
    try { await input.close(); }
    catch (e) { if (result) { result.cleanupWarning = `本次字幕采集停止尚未确认：${messageOf(e)}`; result.message += ` ${result.cleanupWarning}`; } }
  }
}
