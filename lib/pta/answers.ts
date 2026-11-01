import { ConfigError } from "../core/errors.ts";
import { id } from "./query.ts";
import type { AnswerInput, ExamInfo, Problem, SubmissionDetail } from "./types.ts";

export function parseAnswers(value: unknown): AnswerInput[] {
  const list = value && typeof value === "object" && !Array.isArray(value) ? (value as { answers?: unknown }).answers : undefined;
  if (!Array.isArray(list) || !list.length || list.length > 1000) throw new ConfigError("答案文件须为 {\"answers\":[{\"problemId\":\"小题ID\",...}]}，包含 1–1000 题");
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("每题答案须为对象");
    for (const key of Object.keys(raw)) if (!["problemId", "answer", "code", "compiler", "fileContents"].includes(key)) throw new ConfigError(`不支持的答案字段 ${key}`);
    id(raw.problemId);
    if (seen.has(raw.problemId)) throw new ConfigError("答案文件有重复小题 ID");
    seen.add(raw.problemId);
    if (raw.answer !== undefined && typeof raw.answer !== "string" && !(Array.isArray(raw.answer) && raw.answer.every((x: unknown) => typeof x === "string"))) throw new ConfigError("answer 须为字符串或字符串数组");
    if (raw.code !== undefined && (typeof raw.code !== "string" || !raw.code.trim())) throw new ConfigError("code 须为非空代码文本");
    if (raw.compiler !== undefined && (typeof raw.compiler !== "string" || !raw.compiler.trim())) throw new ConfigError("compiler 须为编译器名称");
    if (raw.fileContents !== undefined && (!raw.fileContents || typeof raw.fileContents !== "object" || Array.isArray(raw.fileContents) || !Object.keys(raw.fileContents).length || Object.values(raw.fileContents).some(x => typeof x !== "string"))) throw new ConfigError("fileContents 须为文件名到代码文本的对象");
    if ([raw.answer, raw.code, raw.fileContents].filter(x => x !== undefined).length !== 1) throw new ConfigError("每题只提供 answer、code 或 fileContents 中的一种");
  }
  return list as AnswerInput[];
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ConfigError("该题需要非空字符串 answer");
  return value;
}
function array(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some(x => typeof x !== "string") || value.every(x => !x.trim())) throw new ConfigError("该题需要非空字符串数组 answer");
  return value;
}
function choice(value: string, choices: unknown): string {
  const answer = value.trim().toUpperCase();
  const count = choices && typeof choices === "object" ? Object.values(choices).length : 0;
  if (!/^[A-Z]$/.test(answer) || answer.charCodeAt(0) - 65 >= count) throw new ConfigError("选项须为原始 choices 顺序对应的 A/B/C…，不能使用网页随机排序后的序号");
  return answer;
}
export function buildDetail(input: AnswerInput, problem: Problem, info: ExamInfo): SubmissionDetail {
  if (input.problemId !== problem.id) throw new ConfigError("答案与小题不匹配");
  const detail: SubmissionDetail = { problemId: "0", problemSetProblemId: problem.id };
  const config = problem.problemConfig as Record<string, { choices?: unknown[]; blanks?: Array<{ choices: unknown[] }> }>;
  if (input.compiler !== undefined && problem.type !== "PROGRAMMING") throw new ConfigError("只有 PROGRAMMING 题型接受 compiler");
  switch (problem.type) {
    case "TRUE_OR_FALSE": {
      const answer = text(input.answer).trim().toUpperCase();
      if (!["TRUE", "FALSE", "T", "F"].includes(answer)) throw new ConfigError("判断题 answer 须为 TRUE/FALSE 或 T/F");
      detail.trueOrFalseSubmissionDetail = { answer: answer === "T" ? "TRUE" : answer === "F" ? "FALSE" : answer }; break;
    }
    case "MULTIPLE_CHOICE": detail.multipleChoiceSubmissionDetail = { answer: choice(text(input.answer), config.multipleChoiceProblemConfig?.choices) }; break;
    case "MULTIPLE_CHOICE_MORE_THAN_ONE_ANSWER": {
      const answers = array(input.answer).map(x => choice(x, config.multipleChoiceMoreThanOneAnswerProblemConfig?.choices));
      if (new Set(answers).size !== answers.length) throw new ConfigError("多选答案不能重复");
      detail.multipleChoiceMoreThanOneAnswerSubmissionDetail = { answers: answers.sort() }; break;
    }
    case "FILL_IN_THE_BLANK":
    case "FILL_IN_THE_BLANK_FOR_PROGRAMMING":
    case "CHOICE_BLANK": {
      const key = problem.type === "FILL_IN_THE_BLANK" ? "fillInTheBlank" : problem.type === "CHOICE_BLANK" ? "choiceBlank" : "fillInTheBlankForProgramming";
      const answers = array(input.answer); const blanks = config[`${key}ProblemConfig`]?.blanks;
      if (!Array.isArray(blanks) || answers.length !== blanks.length) throw new ConfigError(`填空答案数组须与题目空位数量一致（${blanks?.length ?? "未知"}）`);
      detail[`${key}SubmissionDetail`] = { answers: problem.type === "CHOICE_BLANK" ? answers.map((a, i) => a === "" ? "" : choice(a, blanks[i]?.choices)) : answers }; break;
    }
    case "PROGRAMMING": {
      const compiler = input.compiler;
      if (!compiler || !info.problemSet.problemSetConfig?.compilers?.includes(compiler)) throw new ConfigError(`编程题须指定允许的 compiler：${info.problemSet.problemSetConfig?.compilers?.join(", ") ?? "未提供"}`);
      detail.programmingSubmissionDetail = { program: text(input.code), compiler }; break;
    }
    case "CODE_COMPLETION": detail.codeCompletionSubmissionDetail = { program: text(input.code) }; break;
    case "SQL_PROGRAMMING": detail.sqlProgrammingSubmissionDetail = { program: text(input.code) }; break;
    case "SUBJECTIVE": detail.subjectiveSubmissionDetail = { answer: text(input.answer), file: "", taskSubmission: false }; break;
    case "MULTIPLE_FILE": {
      if (!input.fileContents || !Object.keys(input.fileContents).length) throw new ConfigError("多文件题需要 fileContents");
      const template = (problem.problemConfig.multipleFileProblemConfig as { template?: string } | undefined)?.template;
      if (template !== "GENERAL") throw new ConfigError("当前仅支持 GENERAL 多文件题的文本代码提交；其他模板/ZIP 请使用官方页面");
      for (const name of Object.keys(input.fileContents)) if (!name || /(^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$))/.test(name)) throw new ConfigError("代码文件名必须是相对路径且不得包含 ..");
      detail.multipleFileSubmissionDetail = { answerZip: "", files: [], fileContents: input.fileContents }; break;
    }
    default: throw new ConfigError(`尚不支持提交 ${problem.type} 题型`);
  }
  return detail;
}
