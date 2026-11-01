import fs from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { bool, command, group, retired, sessionCommands, str, type Command, type Flags, type Option } from "../core/command.ts";
import { ConfigError } from "../core/errors.ts";
import { beijingMinute, beijingTimes } from "../core/output.ts";
import { openPta, sessionStore, type Pta } from "./client.ts";
import { parseAnswers } from "./answers.ts";
import { getExam, getProblem, getSubmission, lastSubmission, listHomework, listSubmissions, problemStatus } from "./query.ts";
import { CLUSTERED, type Submission } from "./types.ts";
import { finishHomework, gate, reconcile, startHomework, writeAnswers } from "./write.ts";
import { findProblem, findSet, homeworkView, labels, problemView, progressView, startedProblems, submissionRow, submissionView, writeView } from "./view.ts";

const SET: Option = { required: true, description: "作业（题目集）名称，写其中一段即可，如 HW02" };
const PROBLEM: Option = { description: "题号，如 7-1" };
const CONFIRM: Option = { type: "boolean", description: "确认写入；同时需要环境变量 ZJU_ALLOW_WRITE=1" };

async function withClient<T>(fn: (client: Pta) => Promise<T>, fresh = false) {
  const c = await openPta();
  // PTA 时间全是 UTC（…Z）；输出前统一换成北京时间，免得把 15:59 当成截止时刻。
  try { await c.login(fresh); return beijingTimes(await fn(c)); } finally { c.close(); }
}
const read = (description: string, options: Record<string, Option>, run: (c: Pta, f: Flags) => Promise<unknown>) => command(description, options, (f) => withClient((c) => run(c, f)));
/** 写命令：写闸在联网之前检查。 */
const write = (description: string, options: Record<string, Option>, run: (c: Pta, f: Flags) => Promise<unknown>) => command(description, { ...options, confirm: CONFIRM }, (f) => {
  gate({ confirm: bool(f, "confirm") });
  return withClient((c) => run(c, f));
});

/** 单题参数或整份答案文件 → 平台小题编号的答案列表；题号在这里换成编号。 */
export function readAnswers(f: Flags, problemId: (label: string) => string) {
  if (f["answers-file"] !== undefined) {
    if (["problem", "answer", "answer-file", "code-file", "compiler"].some(k => f[k] !== undefined)) throw new ConfigError("--answers-file 与单题参数互斥");
    let parsed: { answers?: unknown };
    try { parsed = JSON.parse(fs.readFileSync(str(f, "answers-file"), "utf8").replace(/^﻿/, "")); }
    catch { throw new ConfigError("无法读取答案 JSON 文件"); }
    if (!Array.isArray(parsed?.answers)) throw new ConfigError("答案文件须为 {\"answers\":[{\"problem\":\"题号\",...}]}");
    return parseAnswers({ answers: parsed.answers.map((raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("每题答案须为对象");
      const { problem, ...rest } = raw as Record<string, unknown>;
      if (problem === undefined) return rest;
      if (typeof problem !== "string" || rest.problemId !== undefined) throw new ConfigError("每题用 problem 写题号（如 7-1）");
      return { ...rest, problemId: problemId(problem) };
    }) });
  }
  if (typeof f.problem !== "string") throw new ConfigError("需要 --problem 题号，或 --answers-file 整份答案");
  if (["answer", "answer-file", "code-file"].filter(k => f[k] !== undefined).length !== 1) throw new ConfigError("单题需要 --answer、--answer-file 或 --code-file，三者互斥");
  let answer: unknown;
  if (f.answer !== undefined || f["answer-file"] !== undefined) {
    const raw = f["answer-file"] !== undefined ? fs.readFileSync(str(f, "answer-file"), "utf8") : str(f, "answer");
    if (raw.trim().startsWith("[")) {
      try { answer = JSON.parse(raw); } catch { throw new ConfigError("数组答案必须是有效的 JSON 字符串数组"); }
    } else answer = raw;
  }
  return parseAnswers({ answers: [{ problemId: problemId(f.problem), ...(answer === undefined ? {} : { answer }), ...(f["code-file"] === undefined ? {} : { code: fs.readFileSync(str(f, "code-file"), "utf8") }), ...(f.compiler === undefined ? {} : { compiler: str(f, "compiler") }) }] });
}

/** 代码题提交后判题要几秒：等到出结果，最多约 20 秒，等不到就如实返回当时的状态。 */
export async function settle(c: Pick<Pta, "get">, setId: string, result: Record<string, unknown>, pauseMs = 2000) {
  const waiting = (s: Submission | undefined) => !!s && /WAIT|JUDGING|PENDING|QUEU|REJUDG/i.test(String(s.status));
  for (const receipt of (Array.isArray(result.receipts) ? result.receipts : []) as { submission?: Submission }[]) {
    for (let i = 0; i < 10 && waiting(receipt.submission); i++) {
      await wait(pauseMs);
      try { receipt.submission = (await getSubmission(c as Pta, setId, receipt.submission!.id)).submission; } catch { break; }
    }
  }
  return result;
}

function answering(mode: "save" | "submit", description: string) {
  return write(description, {
    set: SET, problem: PROBLEM,
    answer: { description: "这一题的答案：判断题 TRUE/FALSE，单选题 A，多选或填空写 JSON 数组" },
    "answer-file": { description: "这一题的答案文本文件" },
    "code-file": { description: "这一题的源代码文件（UTF-8）" },
    compiler: { description: "编程题的编译器，取小题详情里 compilers 中的一个，如 GCC" },
    "answers-file": { description: "整份答案 JSON 文件，格式见 PTA 参考" },
  }, async (c, f) => {
    const set = await findSet(c, str(f, "set")), problems = await startedProblems(c, await getExam(c, set.id));
    const answers = readAnswers(f, (label) => findProblem(problems, label).id);
    const result = await writeAnswers(c, set.id, answers, mode, { confirm: true }) as Record<string, unknown>;
    return { set: set.name, ...writeView(mode === "submit" ? await settle(c, set.id, result) : result, labels(problems)) };
  });
}

const homework = group("作业（题目集）：列表、规则与小题、开始答题、结束答题", {
  list: read("本人作业及完成情况；默认只列还没截止的", {
    scope: { choices: ["active", "all"], default: "active", description: "all 包含已截止的历史作业" },
    keyword: { description: "只看名称含这段文字的作业" },
    state: { choices: ["all", "todo", "done"], default: "all", description: "todo 还没答完；done 全部已作答（不代表全对或已交卷）" },
  }, async (c, f) => {
    const r = await listHomework(c, { scope: f.scope as "active" | "all", state: f.state as "all" | "todo" | "done", ...(typeof f.keyword === "string" ? { keyword: f.keyword } : {}) });
    return { currentTime: beijingMinute(Date.now()), scope: r.scope, count: r.homeworks.length,
      homeworks: r.homeworks.map((h) => ({ name: h.name, ...progressView(h.progress!), url: h.url })),
      ...(r.unknown.length ? { unknown: r.unknown.map((h) => ({ name: h.name, reason: h.error ?? "平台没有给出作答状态" })) } : {}) };
  }),
  view: read("一份作业的截止时间、进度、得分和每道小题的题号、题型、分值与对错", { set: SET }, async (c, f) => {
    const info = await getExam(c, (await findSet(c, str(f, "set"))).id);
    return homeworkView(info, await problemStatus(c, info));
  }),
  start: write("开始答题，可能启动限时计时；查询不会自动开始", { set: SET }, async (c, f) => {
    const set = await findSet(c, str(f, "set"));
    return { set: set.name, ...writeView(await startHomework(c, set.id, { confirm: true }) as Record<string, unknown>) };
  }),
  finish: write("结束整份作业（交卷），须教师允许提前结束；只交已经保存在平台上的答案", {
    set: SET, "allow-incomplete": { type: "boolean", description: "还有题没答也结束" },
  }, async (c, f) => {
    const set = await findSet(c, str(f, "set"));
    return { set: set.name, ...writeView(await finishHomework(c, set.id, { confirm: true, allowIncomplete: bool(f, "allow-incomplete") }) as Record<string, unknown>) };
  }),
});

const problem = group("小题：题面与本人作答、保存、提交", {
  view: read("一道小题的完整题面、选项或样例、限制，本人最后一次作答与判题结果、代码草稿", { set: SET, problem: { ...PROBLEM, required: true } }, async (c, f) => {
    const set = await findSet(c, str(f, "set")), info = await getExam(c, set.id), problems = await startedProblems(c, info);
    const target = findProblem(problems, str(f, "problem")), names = labels(problems);
    const { problemSetProblem: data } = await getProblem(c, set.id, target.id);
    const last = await lastSubmission(c, info, data.type, CLUSTERED.has(data.type) ? undefined : target.id);
    const draft = ["PROGRAMMING", "CODE_COMPLETION", "SQL_PROGRAMMING"].includes(data.type) ? await c.get(`/api/problem-sets/problems/${target.id}/exam-draft`) : null;
    return problemView(set.name, data, target.label, info.problemSet.problemSetConfig?.compilers ?? [], last, draft, names);
  }),
  save: answering("save", "保存答案但不判题：判断、选择、填空保存为答题记录，代码题保存为草稿"),
  submit: answering("submit", "提交答案：代码题会判题并等出结果，判断、选择、填空保存为答题记录；不会结束整份作业"),
});

const submission = group("提交记录：历史列表与单次详情", {
  list: read("本人在一份作业里的提交历史，最近的在前", {
    set: SET, problem: { ...PROBLEM, description: "只看这道题的，如 7-1" },
    limit: { type: "integer", min: 1, max: 100, default: 30, description: "条数" },
  }, async (c, f) => {
    const set = await findSet(c, str(f, "set")), info = await getExam(c, set.id);
    if (!info.exam) return { set: set.name, count: 0, submissions: [], note: "还没有开始答题，没有提交记录" };
    const problems = await startedProblems(c, info), names = labels(problems);
    const r = await listSubmissions(c, set.id, { limit: Number(f.limit), ...(typeof f.problem === "string" ? { problemId: findProblem(problems, f.problem).id } : {}) }) as { submissions?: Submission[]; hasBefore?: boolean };
    const rows = (r.submissions ?? []).map((s) => submissionRow(s, names));
    return { set: set.name, count: rows.length, ...(r.hasBefore ? { hasMore: true } : {}), submissions: rows };
  }),
  view: read("一次提交的作答内容和判题详情（代码、编译信息、各测试点）", { set: SET, id: { required: true, description: "提交编号，取自 submission list 的 id" } }, async (c, f) => {
    const set = await findSet(c, str(f, "set")), info = await getExam(c, set.id);
    const names = labels(await startedProblems(c, info));
    if (!/^[1-9]\d*$/.test(str(f, "id"))) throw new ConfigError("--id 是 submission list 里的提交编号");
    return { set: set.name, ...submissionView((await getSubmission(c, set.id, str(f, "id"))).submission, names) };
  }),
});

export const ptaCommands: Record<string, Command> = sessionCommands({
  homework, problem, submission,
  reconcile: read("回查上一次没有确认结果的保存或提交；只读，确认成功才清除本地的未决记录", { set: SET }, async (c, f) => {
    const set = await findSet(c, str(f, "set")), r = await reconcile(c, set.id) as Record<string, unknown>;
    return { set: set.name, pending: r.pending, verified: r.verified, ...(r.action ? { action: r.action } : {}), ...(r.error ? { error: r.error } : {}), ...(r.journalFile ? { journalFile: r.journalFile } : {}) };
  }),
  login: command("建立或复用 PTA 独立会话，返回当前账号", { fresh: { type: "boolean", description: "强制重新登录" } }, (f) => withClient((c) => c.me(), bool(f, "fresh"))),
  status: command("查看本地 PTA 会话，不联网", {}, async () => { const s = sessionStore(); return { file: s.file, ...s.status() }; }, "local"),
  logout: command("清除当前 PTA 账号的本地会话", {}, async () => ({ cleared: sessionStore().clear() }), "local"),
  "import-cookie": command("验证并导入正常浏览器登录后的 Cookie", { file: { required: true, description: "单行 Cookie 请求头文本文件；仅导入 PTA 会话 Cookie" } }, async (f) => {
    const raw = fs.readFileSync(str(f, "file"), "utf8"); const c = await openPta();
    try { return await c.importCookie(raw); } finally { c.close(); }
  }),
}, "pta");

// 旧入口只提示新路径。
for (const [old, now] of Object.entries({
  me: "session login", submissions: "submission list --set 作业名", start: "homework start --set 作业名", finish: "homework finish --set 作业名",
  save: "problem save --set 作业名 --problem 题号", submit: "problem submit --set 作业名 --problem 题号",
})) ptaCommands[old] = retired(`pta ${now}`);
