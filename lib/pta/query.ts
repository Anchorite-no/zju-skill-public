import { BadResponse, ConfigError, RemoteRejected } from "../core/errors.ts";
import type { ExamInfo, Problem, ProblemSet, ProblemStatus, PtaApi, Submission } from "./types.ts";

export function id(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw new ConfigError("PTA ID 必须为正整数的字符串，不能用 Number 以免丢失精度");
  return value;
}
export function query(values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  return `?${params}`;
}
export async function getExam(client: PtaApi, setId: string): Promise<ExamInfo> {
  const data = await client.get<ExamInfo>(`/api/problem-sets/${id(setId)}/exams`);
  if (data.problemSet?.id !== setId || typeof data.status !== "string" || (data.exam && (data.exam.problemSetId !== setId || !data.exam.id))) throw new BadResponse("PTA 作业响应与目标不符");
  return data;
}
export async function problemStatus(client: PtaApi, info: ExamInfo): Promise<ProblemStatus[] | null> {
  if (!info.exam) return null;
  const data = await client.get<{ problemStatus: ProblemStatus[] }>(`/api/exams/${id(info.exam.id)}/problem-sets/${id(info.problemSet.id)}/problem-status`);
  if (!Array.isArray(data.problemStatus)) throw new BadResponse("PTA 缺少小题作答状态");
  return data.problemStatus;
}
export function progress(info: ExamInfo, problems: ProblemStatus[] | null) {
  const counts = { total: problems?.length ?? null, answered: 0, unanswered: 0, accepted: 0, wrong: 0, pending: 0, unknown: 0 };
  for (const problem of problems ?? []) {
    switch (problem.problemSubmissionStatus) {
      case "PROBLEM_NO_ANSWER": counts.unanswered++; break;
      case "PROBLEM_ACCEPTED": counts.accepted++; counts.answered++; break;
      case "PROBLEM_WRONG_ANSWER": counts.wrong++; counts.answered++; break;
      case "PROBLEM_SUBMITTED": counts.pending++; counts.answered++; break;
      default: counts.unknown++;
    }
  }
  const state = !info.exam ? "not_started" : !problems || !problems.length || counts.unknown ? "unknown" : counts.answered === 0 ? "unanswered" : counts.unanswered === 0 ? "answered" : "partial";
  return { state, ...counts, allAnswered: state === "answered", allAccepted: !!counts.total && counts.accepted === counts.total,
    examStatus: info.exam?.status ?? null, examEndedByUser: info.exam?.ended ?? false,
    closed: info.status === "END" || info.exam?.status === "END", allowFinish: info.problemSet.problemSetConfig?.allowSubmitExam === true,
    deadline: info.exam?.endAt ?? info.problemSet.endAt, score: info.exam?.score ?? null };
}
/** 本人的题目集（自动翻页）；active 只含尚未截止的。 */
export async function listSets(client: PtaApi, scope: "active" | "all" = "active"): Promise<ProblemSet[]> {
  const sets: ProblemSet[] = []; const seen = new Set<string>();
  for (let page = 0; ; page++) {
    const data = await client.get<{ total: number; problemSets: ProblemSet[] }>(`/api/problem-sets${query({ page, limit: 100, order_by: "END_AT", asc: true, filter: scope === "all" ? {} : { endAtAfter: new Date().toISOString() } })}`);
    if (!Array.isArray(data.problemSets) || !Number.isSafeInteger(data.total)) throw new BadResponse("PTA 题目集分页响应异常");
    for (const set of data.problemSets) {
      if (seen.has(set.id)) throw new BadResponse("PTA 题目集分页重复，停止避免循环");
      seen.add(set.id); sets.push(set);
    }
    if (seen.size >= data.total) break;
    if (!data.problemSets.length || page >= 999) throw new BadResponse("PTA 分页提前结束，结果不完整");
  }
  return sets;
}
/** 每份作业的进度要另查两次；客户端按约 3 次/秒限速，历史作业八十多份时全量扫描约一分钟，用 keyword 缩小范围。 */
export async function listHomework(client: PtaApi, options: { scope?: "active" | "all"; keyword?: string; state?: "all" | "todo" | "done" } = {}) {
  const sets = (await listSets(client, options.scope ?? "active")).filter(x => !options.keyword || x.name.toLowerCase().includes(options.keyword.toLowerCase()));
  const results: { name: string; url: string; progress?: ReturnType<typeof progress>; error?: string }[] = [];
  for (const set of sets) {
    const base = { name: set.name, url: `https://pintia.cn/problem-sets/${set.id}/exam` };
    try {
      const info = await getExam(client, set.id);
      results.push({ ...base, progress: progress(info, await problemStatus(client, info)) });
    } catch (error) {
      // 单份历史作业可能已撤销查看权限；保留为未知，不能误判成未做。
      if (!(error instanceof RemoteRejected) && !(error instanceof BadResponse)) throw error;
      results.push({ ...base, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const wanted = (state: string | undefined) => !options.state || options.state === "all" || (options.state === "done" ? state === "answered" : ["not_started", "unanswered", "partial"].includes(state ?? ""));
  return { scope: options.scope ?? "active", homeworks: results.filter(x => x.progress && x.progress.state !== "unknown" && wanted(x.progress.state)), unknown: results.filter(x => !x.progress || x.progress.state === "unknown") };
}
export async function getProblem(client: PtaApi, setId: string, problemId: string) {
  const data = await client.get<{ problemSetProblem: Problem; [key: string]: unknown }>(`/api/problem-sets/${id(setId)}/exam-problems/${id(problemId)}`);
  if (data.problemSetProblem?.id !== problemId || data.problemSetProblem.problemSetId !== setId) throw new BadResponse("PTA 返回的小题不属于目标题目集");
  return data;
}
export async function lastSubmission(client: PtaApi, info: ExamInfo, type: string, problemId?: string) {
  if (!info.exam) return undefined;
  const data = await client.get<{ submission?: Submission }>(`/api/exams/${id(info.exam.id)}/problem-sets/${id(info.problemSet.id)}/last-submissions${query({ problem_type: type, problem_set_problem_id: problemId })}`);
  if (data.submission && (data.submission.problemSetId !== info.problemSet.id || data.submission.userId !== info.exam.userId)) throw new BadResponse("PTA 最后提交记录不属于本人当前作业");
  return data.submission;
}
export async function listSubmissions(client: PtaApi, setId: string, options: { before?: string; limit?: number; problemId?: string } = {}) {
  const info = await getExam(client, setId);
  if (!info.exam) return { submissions: [], hasBefore: false, hasAfter: false };
  return client.get(`/api/exams/${id(info.exam.id)}/problem-sets/${id(setId)}/submissions${query({ before: options.before ? id(options.before) : undefined, limit: options.limit ?? 30, filter: { userId: info.exam.userId, ...(options.problemId ? { problemSetProblemId: id(options.problemId) } : {}) } })}`);
}
export async function getSubmission(client: PtaApi, setId: string, submissionId: string) {
  const info = await getExam(client, setId);
  if (!info.exam) throw new ConfigError("尚未开始答题，无提交记录");
  const data = await client.get<{ submission: Submission; [key: string]: unknown }>(`/api/exams/${id(info.exam.id)}/submissions/${id(submissionId)}`);
  if (data.submission?.userId !== info.exam.userId || data.submission.problemSetId !== setId) throw new BadResponse("提交记录不属于本人当前作业");
  return data;
}
