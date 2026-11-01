import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { AuthExpired, BadResponse, ConfigError, NeedsUser, RateLimited, RemoteRejected, WriteGateClosed, ZjuError } from "../core/errors.ts";
import { readJson, removeFile, writeJson } from "../core/fsjson.ts";
import { fileJournal } from "../core/journal.ts";
import { paths } from "../core/paths.ts";
import { envBool } from "../core/env.ts";
import { accountKey } from "./client.ts";
import { buildDetail, parseAnswers } from "./answers.ts";
import { getExam, getProblem, id, lastSubmission, problemStatus, progress } from "./query.ts";
import { CLUSTERED, type AnswerInput, type ExamInfo, type PtaApi, type SubmissionDetail } from "./types.ts";

export interface WriteOptions { confirm: boolean; journalFile?: string }
export function gate(options: WriteOptions) {
  if (!options.confirm || !envBool("ZJU_ALLOW_WRITE")) throw new WriteGateClosed("PTA 作答/保存/交卷");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
type Pending = {
  version: 1; action: "answer" | "draft" | "start" | "finish"; setId: string; examId?: string;
  type?: string; problemId?: string; problemIds?: string[]; hash?: string; previousId?: string;
  createdAt: string; journalFile: string;
};
const stateFile = (client: PtaApi, setId: string) => path.join(paths.data(), "pta", "pending", `${accountKey(client.username)}-${id(setId)}.json`);
function pendingAt(file: string): Pending | undefined {
  if (!fs.existsSync(file)) return undefined;
  const p = readJson<Pending>(file);
  if (p?.version !== 1 || !p.setId || !p.journalFile) throw new BadResponse("PTA 未决记录损坏，停止写入", { pendingFile: file });
  return p;
}
async function lock<T>(client: PtaApi, setId: string, fn: () => Promise<T>): Promise<T> {
  const file = `${stateFile(client, setId)}.lock`; fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ConfigError("此 PTA 作业已有写操作占用锁", `确认没有运行中的 PTA 命令后才可删除 ${file}；保留旁边的未决 JSON 并运行 pta reconcile`);
    throw error;
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await fn(); }
  finally { fs.closeSync(fd); removeFile(file); }
}
function ensureWritable(info: ExamInfo) {
  if (!info.exam) throw new ConfigError("尚未开始此作业，请先使用 pta start --set ID --confirm");
  if (info.exam.status !== "PROCESSING" || info.exam.ended || (info.permission?.permission & 4) !== 4) throw new RemoteRejected("PTA 当前作业不可作答", { status: info.status, examStatus: info.exam.status });
  if (info.problemSet.type === "PEER_REVIEW") throw new ConfigError("互评作业的评阅与最终交稿流程尚未接入；可读取详情");
  if (info.problemSet.problemSetConfig?.omsProtected) throw new RemoteRejected("该题目集要求官方监考客户端，请使用 PTA 官方入口");
  const now = Date.parse(info.serverTime);
  const end = Date.parse(info.exam.endAt);
  if (!Number.isFinite(now) || !Number.isFinite(end)) throw new BadResponse("PTA 未提供有效的服务端时间/截止时间");
  if (end > 0 && now >= end) throw new RemoteRejected("作业已超过服务端截止时间");
}
async function verify(client: PtaApi, pending: Pending) {
  const info = await getExam(client, pending.setId);
  if (pending.action === "start") return { verified: !!info.exam?.id, exam: info.exam };
  if (pending.examId !== info.exam?.id) return { verified: false, reason: "exam_changed" };
  if (pending.action === "finish") return { verified: info.exam?.ended === true, exam: info.exam };
  if (pending.action === "draft") {
    const draft = await client.get<{ answer?: { detail?: SubmissionDetail } }>(`/api/problem-sets/problems/${id(pending.problemId!)}/exam-draft`);
    return { verified: !!draft.answer?.detail && digest(draft.answer.detail) === pending.hash, problemId: pending.problemId, savedAs: "draft" };
  }
  const submission = await lastSubmission(client, info, pending.type!, pending.problemId);
  const details = submission?.submissionDetails;
  const matched = details?.filter(d => pending.problemIds!.includes(d.problemSetProblemId)).sort((a, b) => a.problemSetProblemId.localeCompare(b.problemSetProblemId));
  const verified = !!submission && submission.id !== pending.previousId && matched?.length === pending.problemIds!.length && digest(matched) === pending.hash;
  return { verified, submissionId: submission?.id, status: submission?.status, submission };
}
async function reconcileLocked(client: PtaApi, setId: string) {
  const file = stateFile(client, setId); const pending = pendingAt(file);
  if (!pending) return { pending: false, verified: true };
  let result: Awaited<ReturnType<typeof verify>>;
  try { result = await verifyEventually(client, pending); }
  catch (error) { return { pending: true, verified: false, pendingFile: file, journalFile: pending.journalFile, error: error instanceof Error ? error.message : String(error) }; }
  if (result.verified) {
    fileJournal("pta", pending.journalFile).append({ at: new Date().toISOString(), action: pending.action, phase: "reconciled", setId });
    removeFile(file);
  }
  return { ...result, action: pending.action, pending: !result.verified, pendingFile: file, journalFile: pending.journalFile };
}
export async function reconcile(client: PtaApi, setId: string) {
  return lock(client, id(setId), () => reconcileLocked(client, setId));
}
async function checkPending(client: PtaApi, setId: string) {
  if (!pendingAt(stateFile(client, setId))) return;
  const recovered = await reconcileLocked(client, setId);
  // 本次只回查，不顺带再次执行传入的新写请求。
  if (recovered.verified) return { ...recovered, status: "recovered-previous-operation", recovered: true, performedNewWrite: false,
    message: "上次操作已自动回查确认，本次未发起新的提交。" };
  throw new RemoteRejected("上次操作仍未确认，已自动回查，未重复提交", recovered);
}
async function verifyEventually(client: PtaApi, pending: Pending) {
  let result: Awaited<ReturnType<typeof verify>> | undefined, failure: unknown;
  for (const delay of [0, 1000, 2000, 3000]) {
    if (delay) await wait(delay);
    try { result = await verify(client, pending); failure = undefined; if (result.verified) return result; }
    catch (error) { if (error instanceof AuthExpired || error instanceof ConfigError || error instanceof RateLimited || error instanceof NeedsUser) throw error; failure = error; }
  }
  if (failure) throw failure;
  return result!;
}
async function execute(client: PtaApi, pending: Pending, endpoint: string, body: unknown, method: "POST" | "PUT" = "POST") {
  const file = stateFile(client, pending.setId); const journal = fileJournal("pta", pending.journalFile);
  journal.append({ ...pending, phase: "prepared" });
  writeJson(file, pending);
  let response: unknown; let requestError: unknown;
  try { response = await client.mutate(endpoint, body, method); }
  catch (error) {
    requestError = error;
    const raw = error instanceof RemoteRejected ? error.detail.raw as { status?: number } | undefined : undefined;
    const definitelyRejected = error instanceof AuthExpired || (raw?.status !== undefined && raw.status >= 400 && raw.status < 500 && raw.status !== 408);
    if (definitelyRejected) {
      journal.append({ at: new Date().toISOString(), phase: "rejected", action: pending.action, setId: pending.setId, code: error instanceof ZjuError ? error.code : "ERROR" });
      removeFile(file); throw error;
    }
  }
  let verified: Awaited<ReturnType<typeof verify>> | undefined; let verifyError: unknown;
  try { verified = await verifyEventually(client, pending); } catch (error) { verifyError = error; }
  if (!verified?.verified) {
    journal.append({ at: new Date().toISOString(), phase: "uncertain", action: pending.action, setId: pending.setId });
    throw new RemoteRejected("PTA 操作结果未确认；保留未决记录，只回查、不自动重发", { pendingFile: file, journalFile: journal.file, response, requestError: requestError instanceof Error ? requestError.message : undefined, verificationError: verifyError instanceof Error ? verifyError.message : undefined });
  }
  journal.append({ at: new Date().toISOString(), phase: "verified", action: pending.action, setId: pending.setId, ...(verified.submissionId ? { submissionId: verified.submissionId } : {}) });
  removeFile(file);
  return { ...verified, journalFile: journal.file };
}
function pendingBase(setId: string, action: Pending["action"], options: WriteOptions): Pending {
  return { version: 1, action, setId, createdAt: new Date().toISOString(), journalFile: fileJournal("pta", options.journalFile).file };
}
export async function startHomework(client: PtaApi, setId: string, options: WriteOptions) {
  gate(options); id(setId);
  return lock(client, setId, async () => {
    const recovered = await checkPending(client, setId); if (recovered) return recovered;
    const info = await getExam(client, setId);
    if (info.exam) return { alreadyStarted: true, exam: info.exam };
    if (info.status !== "READY") throw new RemoteRejected("当前作业尚未开放或已结束，不能开始", { status: info.status });
    if (info.problemSet.type === "PEER_REVIEW" || info.problemSet.problemSetConfig?.omsProtected) throw new ConfigError("互评或监考题目集请在官方页面开始");
    return execute(client, pendingBase(setId, "start", options), `/api/problem-sets/${setId}/exams`, {});
  });
}
/** save：客观题正式保存；代码题保存草稿。submit：全部题型提交答题记录。 */
export async function writeAnswers(client: PtaApi, setId: string, answers: AnswerInput[], mode: "save" | "submit", options: WriteOptions) {
  gate(options); id(setId); parseAnswers({ answers });
  return lock(client, setId, async () => {
    const recovered = await checkPending(client, setId); if (recovered) return recovered;
    const info = await getExam(client, setId); ensureWritable(info);
    // 先验证整份输入和远端小题归属，任何一题错误都在首个业务 POST 前报出。
    const prepared: Array<{ type: string; detail: SubmissionDetail }> = [];
    for (const input of answers) {
      const { problemSetProblem: problem } = await getProblem(client, setId, input.problemId);
      const deadline = Date.parse(problem.deadline ?? "");
      if (deadline > 0 && deadline <= Date.parse(info.serverTime)) throw new RemoteRejected(`小题 ${problem.label} 已超过截止时间`);
      if (mode === "save" && !CLUSTERED.has(problem.type) && !["PROGRAMMING", "CODE_COMPLETION", "SQL_PROGRAMMING"].includes(problem.type)) throw new ConfigError(`${problem.type} 暂不支持草稿保存，请使用 submit`);
      prepared.push({ type: problem.type, detail: buildDetail(input, problem, info) });
    }
    const batches: Array<{ type: string; details: SubmissionDetail[]; problemId?: string; draft: boolean }> = [];
    for (const p of prepared) {
      const clustered = CLUSTERED.has(p.type); const previous = clustered ? batches.find(b => b.type === p.type) : undefined;
      if (previous) previous.details.push(p.detail);
      else batches.push({ type: p.type, details: [p.detail], ...(clustered ? {} : { problemId: p.detail.problemSetProblemId }), draft: mode === "save" && !clustered });
    }
    const receipts: unknown[] = [];
    const journalFile = fileJournal("pta", options.journalFile).file;
    for (const batch of batches) {
      const current = await getExam(client, setId); ensureWritable(current);
      if (current.exam!.id !== info.exam!.id) throw new RemoteRejected("答题实例已改变，停止剩余操作", { receipts });
      const pending = { ...pendingBase(setId, batch.draft ? "draft" : "answer", { ...options, journalFile }), examId: info.exam!.id, type: batch.type, ...(batch.problemId ? { problemId: batch.problemId } : {}) };
      try {
        if (batch.draft) {
          pending.hash = digest(batch.details[0]);
          receipts.push(await execute(client, pending, `/api/problem-sets/problems/${batch.problemId}/exam-draft`, { answer: { detail: batch.details[0], saveAt: new Date().toISOString() } }));
        } else {
          const previous = await lastSubmission(client, current, batch.type, batch.problemId);
          if (batch.type === "SUBJECTIVE") {
            const old = previous?.submissionDetails?.find(d => d.problemSetProblemId === batch.problemId)?.subjectiveSubmissionDetail as { file?: string } | undefined;
            const updated = batch.details[0]!.subjectiveSubmissionDetail as { file: string };
            if (old?.file) updated.file = old.file;
          }
          const merged = new Map<string, SubmissionDetail>();
          // 整题型保存会替换上次记录，必须合并未修改答案。
          if (CLUSTERED.has(batch.type)) for (const d of previous?.submissionDetails ?? []) merged.set(d.problemSetProblemId, d);
          for (const d of batch.details) merged.set(d.problemSetProblemId, d);
          const details = [...merged.values()].sort((a, b) => a.problemSetProblemId.localeCompare(b.problemSetProblemId));
          if (previous?.submissionDetails && digest([...previous.submissionDetails].sort((a, b) => a.problemSetProblemId.localeCompare(b.problemSetProblemId))) === digest(details)) {
            receipts.push({ verified: true, unchanged: true, submissionId: previous.id, type: batch.type }); continue;
          }
          pending.hash = digest(details); pending.problemIds = details.map(d => d.problemSetProblemId);
          if (previous?.id) pending.previousId = previous.id;
          receipts.push(await execute(client, pending, `/api/exams/${info.exam!.id}/exam-submissions`, { problemType: batch.type, details }));
        }
      } catch (error) {
        if (error instanceof ZjuError) { error.detail.receipts = receipts; error.detail.journalFile = journalFile; error.detail.stoppedAt = { type: batch.type, problemId: batch.problemId }; }
        throw error;
      }
    }
    return { verified: true, mode, setId, receipts, journalFile };
  });
}
export async function finishHomework(client: PtaApi, setId: string, options: WriteOptions & { allowIncomplete?: boolean }) {
  gate(options); id(setId);
  return lock(client, setId, async () => {
    const recovered = await checkPending(client, setId); if (recovered) return recovered;
    const info = await getExam(client, setId);
    if (info.exam?.ended) return { verified: true, alreadyFinished: true, exam: info.exam };
    ensureWritable(info);
    if (!info.problemSet.problemSetConfig?.allowSubmitExam || info.exam!.delayedEndAt) throw new RemoteRejected("教师不允许提前结束此作业；保存答案后由平台在截止时结束");
    const summary = progress(info, await problemStatus(client, info));
    if (!summary.allAnswered && !options.allowIncomplete) throw new ConfigError("仍有未答题或状态未知，请先核对 homework；确需交不完整作业时加 --allow-incomplete");
    const pending = { ...pendingBase(setId, "finish", options), examId: info.exam!.id };
    return execute(client, pending, `/api/exams/${info.exam!.id}/end`, {}, "PUT");
  });
}
