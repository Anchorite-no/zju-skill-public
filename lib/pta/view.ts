/**
 * 按名称定位题目集与小题，以及 CLI 的输出视图。
 * 平台的四种编号（题目集、小题、答题实例、提交）只在本模块内部流转；调用方写作业名和题号（7-1）。
 */
import { ConfigError, NeedsUser } from "../core/errors.ts";
import { getExam, listSets, problemStatus, progress } from "./query.ts";
import { PROBLEM_TYPES, type ExamInfo, type Problem, type ProblemStatus, type PtaApi, type Submission, type SubmissionDetail } from "./types.ts";

const TYPE_NAMES: Record<string, string> = {
  TRUE_OR_FALSE: "判断题", MULTIPLE_CHOICE: "单选题", MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER: "多选题", FILL_IN_THE_BLANK: "填空题",
  FILL_IN_THE_BLANK_FOR_PROGRAMMING: "程序填空题", CODE_COMPLETION: "函数题", PROGRAMMING: "编程题", SUBJECTIVE: "主观题",
  MULTIPLE_FILE: "多文件编程题", SQL_PROGRAMMING: "SQL 编程题", CHOICE_BLANK: "选择填空题",
};
const PROBLEM_STATUS: Record<string, string> = { PROBLEM_NO_ANSWER: "未作答", PROBLEM_ACCEPTED: "正确", PROBLEM_WRONG_ANSWER: "错误", PROBLEM_SUBMITTED: "已提交待判" };
const STATES: Record<string, string> = { not_started: "未开始", unanswered: "未作答", partial: "部分作答", answered: "已全部作答", unknown: "未知" };
export const typeName = (type: string) => TYPE_NAMES[type] ?? type;
const normalize = (v: string) => v.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

// ---------- 定位 ----------

/** 作业名称（或其中一段）→ 题目集。先在未截止的作业里找，找不到再查历史作业；不唯一时给候选。 */
export async function findSet(client: PtaApi, query: string): Promise<{ id: string; name: string }> {
  const wanted = normalize(query);
  if (!wanted) throw new ConfigError("需要 PTA 作业名称");
  if (/^[1-9]\d{11,}$/.test(wanted)) return { id: wanted, name: (await getExam(client, wanted)).problemSet.name };
  for (const scope of ["active", "all"] as const) {
    const sets = await listSets(client, scope);
    const exact = sets.filter((s) => normalize(s.name) === wanted), contains = exact.length ? exact : sets.filter((s) => normalize(s.name).includes(wanted));
    // 「HW1」不该同时命中 HW10–HW15：有整段匹配（前后不接字母数字）的就只取它们。
    const whole = contains.filter((s) => { const name = normalize(s.name), at = name.indexOf(wanted); return !/[a-z0-9]/.test(name[at - 1] ?? "") && !/[a-z0-9]/.test(name[at + wanted.length] ?? ""); });
    const hits = whole.length ? whole : contains;
    if (hits.length === 1) return { id: hits[0]!.id, name: hits[0]!.name };
    if (hits.length > 1) {
      const error = new NeedsUser("有多份作业的名称匹配，请写得更完整");
      error.detail.candidates = hits.slice(0, 20).map((s) => s.name); throw error;
    }
  }
  const error = new NeedsUser(`没有找到 PTA 作业“${query}”`);
  error.detail.candidates = (await listSets(client, "active")).map((s) => s.name); throw error;
}

/** 题号：平台给了就用平台的（7-1、H-1）；判断题等没有题号时按网页的编法补上「题型序号-组内序号」。 */
export function labels(problems: ProblemStatus[]): Map<string, string> {
  const counts = new Map<string, number>(), out = new Map<string, string>();
  for (const p of problems) {
    const n = (counts.get(p.problemType) ?? 0) + 1; counts.set(p.problemType, n);
    out.set(p.id, p.label || `${PROBLEM_TYPES.indexOf(p.problemType as typeof PROBLEM_TYPES[number]) + 1}-${n}`);
  }
  return out;
}

export async function startedProblems(client: PtaApi, info: ExamInfo): Promise<ProblemStatus[]> {
  const problems = await problemStatus(client, info);
  if (!problems) throw new NeedsUser("这份作业还没有开始答题，开始之后才有小题；需要作答时先用 pta homework start");
  return problems;
}

/** 题号（7-1）→ 小题。 */
export function findProblem(problems: ProblemStatus[], query: string): ProblemStatus & { label: string } {
  const names = labels(problems), wanted = normalize(query).replace(/^第|题$/g, "");
  const hit = problems.filter((p) => normalize(names.get(p.id)!) === wanted || p.id === wanted);
  if (hit.length === 1) return { ...hit[0]!, label: names.get(hit[0]!.id)! };
  const error = new NeedsUser(hit.length ? `题号“${query}”不唯一` : `这份作业里没有题号“${query}”`);
  error.detail.candidates = problems.map((p) => `${names.get(p.id)}（${typeName(p.problemType)}）`); throw error;
}

// ---------- 视图 ----------

export function progressView(p: ReturnType<typeof progress>) {
  return {
    state: STATES[p.state] ?? p.state, deadline: p.deadline,
    ...(p.total !== null ? { total: p.total, answered: p.answered, accepted: p.accepted, wrong: p.wrong, ...(p.pending ? { pending: p.pending } : {}) } : {}),
    ...(p.score !== null ? { score: p.score } : {}), ...(p.closed ? { closed: true } : {}),
    ...(p.examEndedByUser ? { endedByUser: true } : {}), ...(p.allowFinish ? { canFinishEarly: true } : {}),
  };
}

export function homeworkView(info: ExamInfo, problems: ProblemStatus[] | null) {
  const set = info.problemSet, names = labels(problems ?? []);
  return {
    name: set.name, ...(set.description ? { description: set.description } : {}), opensAt: set.startAt,
    ...(info.exam ? { startedAt: info.exam.startAt } : {}), ...progressView(progress(info, problems)),
    url: `https://pintia.cn/problem-sets/${set.id}/exam`,
    ...(problems ? { problems: problems.map((p) => ({ label: names.get(p.id)!, type: typeName(p.problemType), score: p.score, status: PROBLEM_STATUS[p.problemSubmissionStatus] ?? p.problemSubmissionStatus })) }
      : { note: "还没有开始答题，开始之后才有小题列表；查询不会自动开始。" }),
  };
}

type Config = Record<string, unknown>;
const typed = (holder: Config | undefined, suffix: string) => Object.entries(holder ?? {}).find(([k, v]) => k.endsWith(suffix) && v && typeof v === "object")?.[1] as Config | undefined;

/** 一题的作答：判断与选择给 answer，填空给 answers，代码题给 code（与编译器）。 */
export function answerOf(detail: SubmissionDetail | undefined) {
  const d = typed(detail, "SubmissionDetail");
  if (!d) return {};
  return {
    ...(typeof d.answer === "string" ? { answer: d.answer } : {}), ...(Array.isArray(d.answers) ? { answers: d.answers } : {}),
    ...(typeof d.program === "string" ? { code: d.program } : {}), ...(typeof d.compiler === "string" ? { compiler: d.compiler } : {}),
    ...(d.fileContents && typeof d.fileContents === "object" ? { files: d.fileContents } : {}),
  };
}

function judgeOf(response: Config | undefined) {
  const j = typed(response, "JudgeResponseContent");
  if (!j) return {};
  const compile = j.compilationResult as { success?: boolean; log?: string; error?: string } | undefined;
  const cases = Object.entries((j.testcaseJudgeResults ?? {}) as Record<string, Config>).map(([name, c]) => ({
    case: name, result: c.result, score: c.testcaseScore, time: c.time, memory: c.memory,
    ...(c.stdout ? { stdout: c.stdout } : {}), ...(c.stderr ? { stderr: c.stderr } : {}), ...(c.checkerOutput ? { checkerOutput: c.checkerOutput } : {}),
  }));
  return {
    ...(compile && (compile.log || compile.error || compile.success === false) ? { compile: { success: compile.success === true, ...(compile.log ? { log: compile.log } : {}), ...(compile.error ? { error: compile.error } : {}) } } : {}),
    ...(cases.length ? { cases } : {}),
  };
}

/**
 * 一次提交。判断、选择、填空是整组一起提交的：给了 problemId 时只取这一题的答案与对错，
 * 没给时列出组内每题；代码题给代码、编译信息和各测试点结果。
 */
export function submissionView(s: Submission, names: Map<string, string>, problemId?: string) {
  const details = s.submissionDetails ?? [], responses = (s.judgeResponseContents ?? []) as Config[];
  const base = {
    id: s.id, type: typeName(s.problemType), submittedAt: s.submitAt, status: s.status, score: s.score,
    ...(typeof s.compiler === "string" && s.compiler !== "NO_COMPILER" ? { compiler: s.compiler } : {}),
    ...(Number(s.time) > 0 ? { time: s.time } : {}), ...(Number(s.memory) > 0 ? { memory: s.memory } : {}),
  };
  const one = (d: SubmissionDetail, i: number) => {
    const r = responses.find((x) => x.problemSetProblemId === d.problemSetProblemId) ?? (details.length === 1 ? responses[i] : undefined);
    return { ...answerOf(d), ...(r ? { result: r.status, ...(r.score !== undefined ? { score: r.score } : {}), ...judgeOf(r) } : {}) };
  };
  if (problemId) {
    const i = details.findIndex((d) => d.problemSetProblemId === problemId);
    if (i < 0) return { ...base, note: "这次提交里没有这一题的作答" };
    // 整组提交里的一题：对错和得分取这一题自己的，不用整组的。
    const { result, ...rest } = one(details[i]!, i) as { result?: unknown } & Record<string, unknown>;
    return { ...base, ...rest, ...(result !== undefined ? { status: result } : {}) };
  }
  if (details.length === 1) return { ...base, ...(names.get(details[0]!.problemSetProblemId) ? { problem: names.get(details[0]!.problemSetProblemId) } : {}), ...one(details[0]!, 0) };
  return { ...base, ...(details.length ? { answers: details.map((d, i) => ({ problem: names.get(d.problemSetProblemId) ?? "", ...one(d, i) })) } : {}) };
}

export function problemView(setName: string, p: Problem, label: string, compilers: string[], last: Submission | undefined, draft: unknown, names: Map<string, string>) {
  const config = typed(p.problemConfig, "ProblemConfig") ?? {};
  const choices = Array.isArray(config.choices) ? (config.choices as string[]).map((c, i) => `${String.fromCharCode(65 + i)}. ${c}`) : undefined;
  const blanks = Array.isArray(config.blanks) ? config.blanks as { choices?: string[] }[] : undefined;
  const seen = new Set<string>();
  const examples = Array.isArray(config.exampleTestDatas) ? (config.exampleTestDatas as { input?: string; output?: string }[]).map((e) => ({ input: e.input ?? "", output: e.output ?? "" }))
    .filter((e) => !seen.has(JSON.stringify(e)) && seen.add(JSON.stringify(e))) : undefined;
  const saved = (draft as { answer?: { detail?: SubmissionDetail; saveAt?: string } } | null)?.answer;
  return {
    set: setName, label, title: p.title, type: typeName(p.type), score: p.score, ...(p.deadline && !p.deadline.startsWith("1970") ? { deadline: p.deadline } : {}),
    content: p.description || p.content,
    ...(choices ? { choices } : {}),
    ...(blanks ? { blanks: blanks.length, ...(blanks.some((b) => Array.isArray(b.choices)) ? { blankChoices: blanks.map((b) => (b.choices ?? []).map((c, i) => `${String.fromCharCode(65 + i)}. ${c}`)) } : {}) } : {}),
    ...(typeof config.timeLimit === "number" ? { limits: { timeMs: config.timeLimit, memoryKB: config.memoryLimit, codeSizeKB: config.codeSizeLimit } } : {}),
    ...(examples?.length ? { examples } : {}),
    ...(p.type === "PROGRAMMING" ? { compilers } : {}),
    ...(last ? { lastSubmission: submissionView(last, names, p.id) } : {}),
    ...(saved?.detail ? { draft: { ...answerOf(saved.detail), ...(saved.saveAt ? { savedAt: saved.saveAt } : {}) } } : {}),
  };
}

/** 提交历史的一行；整组提交的判断、选择题没有单独的题号。 */
export function submissionRow(s: Submission, names: Map<string, string>) {
  const problem = names.get(String(s.problemSetProblemId ?? ""));
  return {
    id: s.id, problem: problem ?? `${typeName(s.problemType)}（整组）`, submittedAt: s.submitAt, status: s.status, score: s.score,
    ...(typeof s.compiler === "string" && s.compiler !== "NO_COMPILER" ? { compiler: s.compiler } : {}),
  };
}

/** 写操作的结果：平台返回的答题实例、提交记录原样只进 journal，这里给结论。 */
export function writeView(result: Record<string, unknown>, names: Map<string, string> = new Map()) {
  if (result.recovered) return { status: result.status, verified: result.verified, performedNewWrite: false, message: result.message, action: result.action };
  const exam = result.exam as { startAt?: string; endAt?: string; ended?: boolean; score?: number } | undefined;
  const receipts = Array.isArray(result.receipts) ? result.receipts as Config[] : undefined;
  return {
    verified: result.verified !== false, ...(result.mode ? { mode: result.mode } : {}),
    ...(result.alreadyStarted ? { alreadyStarted: true } : {}), ...(result.alreadyFinished ? { alreadyFinished: true } : {}),
    ...(exam ? { ...(exam.startAt ? { startedAt: exam.startAt } : {}), ...(exam.endAt ? { deadline: exam.endAt } : {}), ...(exam.ended ? { ended: true, score: exam.score } : {}) } : {}),
    ...(receipts ? { results: receipts.map((r) => r.savedAs === "draft"
      ? { problem: names.get(String(r.problemId)) ?? "", savedAs: "代码草稿（未判题）" }
      : { ...(r.type ? { type: typeName(String(r.type)) } : {}), ...(r.unchanged ? { unchanged: true } : {}),
          ...(r.submission ? submissionView(r.submission as Submission, names) : { ...(r.submissionId ? { id: r.submissionId } : {}), ...(r.status ? { status: r.status } : {}) }) }) } : {}),
    ...(result.journalFile ? { journalFile: result.journalFile } : {}),
  };
}
