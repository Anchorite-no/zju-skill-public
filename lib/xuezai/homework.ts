import fs from "node:fs";
import path from "node:path";
import { ConfigError, BadResponse, NeedsUser, RemoteRejected, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { htmlToText } from "../core/html.ts";
import { beijingMinute } from "../core/output.ts";
import { paths } from "../core/paths.ts";
import { id, type Xuezai } from "./client.ts";
import { getActivity } from "./courses.ts";
import { safeFileName, saveUploads } from "./materials.ts";
import type { Activity, Submission, Upload, WriteOptions } from "./types.ts";

export function listHomework(client: Xuezai, courseId: number | string): Promise<Activity[]> {
  return client.all<Activity>(`/api/courses/${id(courseId)}/homework-activities`, "homework_activities");
}

export async function mySubmissions(client: Xuezai, activityId: number | string, groupId?: number): Promise<Submission[]> {
  const owner = groupId === undefined ? `students/${(await client.me()).id}` : `groups/${id(groupId)}`;
  const data = await client.json<{ list: Submission[] }>(`/api/activities/${id(activityId)}/${owner}/submission_list`);
  if (!Array.isArray(data.list)) throw new BadResponse("提交记录响应缺少 list");
  return data.list;
}

export async function getHomework(client: Xuezai, activityId: number | string, groupId?: number) {
  const activity = await getActivity(client, activityId);
  if (activity.type !== "homework") throw new ConfigError(`活动 ${activityId} 不是作业`);
  const submissions = await mySubmissions(client, activityId, groupId);
  return { activity, submissions };
}

// ----- 输出视图：只给任务需要的结论，平台原字段留在 API 层 -----

const SUBMIT_WITH: Record<string, string> = { file_upload: "上传文件" };
const text = (html: unknown) => typeof html === "string" ? htmlToText(html) : "";
const hasScore = (v: unknown) => v !== null && v !== undefined && v !== "";

function status(submitted: boolean, activity: Activity, now: number): string {
  if (submitted) return "已交";
  const end = Date.parse(String(activity.end_time ?? ""));
  return activity.is_closed === true || (Number.isFinite(end) && end < now) ? "已截止未交" : "未交";
}

/** 作业要求：正文转纯文本，全文；没有正文为空串。 */
export function requirementText(data: unknown): string {
  return text((data as { description?: unknown } | undefined)?.description);
}

/** 作业列表的一行；按截止时间排序由调用方完成。 */
export function homeworkRow(row: Activity, now = Date.now()) {
  const requirement = requirementText(row.data);
  return {
    name: row.title, deadline: beijingMinute(row.end_time), status: status(row.submitted === true, row, now),
    ...(requirement ? { requirement } : {}),
    ...(hasScore(row.score) ? { score: row.score } : {}),
    ...(row.submit_by_group ? { groupHomework: true } : {}),
  };
}

export function homeworkList(rows: Activity[], now = Date.now()) {
  const at = (r: Activity) => { const t = Date.parse(String(r.end_time ?? "")); return Number.isFinite(t) ? t : Infinity; };
  return { currentTime: beijingMinute(now), count: rows.length, homeworks: [...rows].sort((a, b) => at(a) - at(b)).map((r) => homeworkRow(r, now)) };
}

/**
 * 老师批改留下的文件分两种：老师传回的文件，和平台保存网页批注笔迹用的 markattatchment.txt
 * （URL 编码的 SVG 路径，不是给人看的）。后者只说明「有网页批注」，不当作文件给出。
 */
function corrections(s: Submission) {
  const uploads = ((s.submission_correct ?? {}) as { uploads?: Upload[] }).uploads ?? [];
  const marks = uploads.filter((u) => /^markatt?a(t)?chment\.txt$/i.test(u.name));
  return { files: uploads.filter((u) => !marks.includes(u)), annotated: marks.length > 0 };
}
const ANNOTATED = "老师在网页上直接批注了这份作业，批注只能在学在浙大网页上看";

export function submissionView(s: Submission) {
  const correct = (s.submission_correct ?? {}) as { instructor_score?: unknown };
  const score = hasScore(s.score) ? s.score : hasScore(correct.instructor_score) ? correct.instructor_score : undefined;
  const comment = text(s.comment), teacherComment = text(s.instructor_comment);
  const corrected = corrections(s);
  return {
    submittedAt: beijingMinute(s.submitted_at ?? s.created_at), ...(s.is_draft ? { draft: true } : { canRetract: s.can_retract === true }),
    files: (s.uploads ?? []).map((u) => u.name), ...(comment ? { text: comment } : {}),
    ...(score !== undefined ? { score } : {}), ...(teacherComment ? { teacherComment } : {}),
    ...(corrected.files.length ? { correctionFiles: corrected.files.map((u) => u.name) } : {}),
    ...(corrected.annotated ? { annotation: ANNOTATED } : {}),
  };
}

/** 单个作业：要求、截止、附件、提交规则与本人提交记录。 */
export function homeworkView(activity: Activity, submissions: Submission[], now = Date.now()) {
  const data = activity.data ?? {};
  const kind = String(data.homework_type ?? "");
  const limit = Number(data.submit_times ?? activity.submit_times);
  const final = submissions.filter((s) => !s.is_draft);
  const graded = final.find((s) => hasScore(s.score));
  return {
    name: activity.title, currentTime: beijingMinute(now),
    ...(activity.start_time ? { opensAt: beijingMinute(activity.start_time) } : {}),
    deadline: beijingMinute(activity.end_time), status: status(final.length > 0, activity, now),
    requirement: text(data.description) || "（老师未写文字说明）",
    attachments: (activity.uploads ?? []).map((u) => u.name),
    submitWith: SUBMIT_WITH[kind] ?? kind,
    resubmit: Number.isInteger(limit) && limit > 0 ? `最多 ${limit} 次` : "不限次数",
    retractAllowed: data.allow_retract !== false,
    ...(activity.submit_by_group ? { groupHomework: true } : {}),
    ...(graded ? { score: graded.score } : {}),
    submissions: submissions.map(submissionView),
  };
}

/**
 * 把本人最近一次提交的文件（与撤回同一条记录）和老师批改后传回的文件下载到本地。
 * 默认目录 data/output/xuezai/<课程名>/我的提交/<作业名>/，批改文件在其下的「老师批改」。
 * 重交时同名文件内容会变，所以每次都重新下载，不复用本地文件。
 */
export async function downloadSubmission(client: Xuezai, course: string, activity: Activity, submissions: Submission[], opts: { outDir?: string; signal?: AbortSignal } = {}) {
  const at = (s: Submission) => Date.parse(String(s.submitted_at ?? s.created_at ?? "")) || 0;
  const current = [...submissions].sort((a, b) => at(b) - at(a))[0];
  if (!current) throw new NeedsUser(activity.submit_by_group ? `「${activity.title}」是小组作业，没有以你个人名义提交的记录` : `「${activity.title}」还没有提交记录`);
  const dir = path.resolve(opts.outDir ?? path.join(paths.output(), "xuezai", safeFileName(course), "我的提交", safeFileName(activity.title)));
  const pass = { reuse: false, ...(opts.signal ? { signal: opts.signal } : {}) };
  const mine = await saveUploads(client, dir, current.uploads ?? [], pass);
  const marked = corrections(current);
  const corrected = await saveUploads(client, path.join(dir, "老师批改"), marked.files, pass);
  const failed = [...mine.failed, ...corrected.failed], comment = text(current.comment);
  const empty = !(current.uploads ?? []).length ? current.submit_by_instructor === true ? "这条提交记录是老师代为登记的，没有文件" : "这次提交没有文件" : undefined;
  const result = {
    homework: activity.title, submittedAt: beijingMinute(current.submitted_at ?? current.created_at), ...(current.is_draft ? { draft: true } : {}),
    count: mine.files.length, files: mine.files, ...(corrected.files.length ? { correctionFiles: corrected.files } : {}),
    ...(comment ? { text: comment } : {}), ...(marked.annotated ? { annotation: ANNOTATED } : {}),
    ...(empty ? { note: empty } : {}), ...(failed.length ? { failed } : {}),
  };
  if (!mine.files.length && !corrected.files.length && failed.length) throw new RemoteRejected(failed.length === 1 ? failed[0]!.reason : "文件都没有下载成功", { result });
  return result;
}

/**
 * 把老师随作业给的附件下载到本地，默认目录 data/output/xuezai/<课程名>/作业附件/<作业名>/。
 * 附件发布后不会换内容，下载过且大小一致的直接复用。
 */
export async function downloadAttachments(client: Xuezai, course: string, activity: Activity, wanted: Upload[], opts: { outDir?: string; signal?: AbortSignal } = {}) {
  const dir = path.resolve(opts.outDir ?? path.join(paths.output(), "xuezai", safeFileName(course), "作业附件", safeFileName(activity.title)));
  const { files, failed } = await saveUploads(client, dir, wanted, { all: activity.uploads ?? [], ...(opts.signal ? { signal: opts.signal } : {}) });
  const result = { homework: activity.title, count: files.length, files, ...(failed.length ? { failed } : {}) };
  if (!files.length && failed.length) throw new RemoteRejected(failed.length === 1 ? failed[0]!.reason : "文件都没有下载成功", { result });
  return result;
}

function gate(opts: WriteOptions, action: string): void {
  if (!opts.confirm || !writeAllowed()) throw new WriteGateClosed(action);
  if (typeof opts.journal !== "function") throw new ConfigError("作业写操作必须提供 journal");
}
function record(opts: WriteOptions, action: string, stage: string, detail: Record<string, unknown>) {
  return opts.journal({ at: new Date().toISOString(), action, stage, detail });
}

export interface SubmitHomeworkOptions extends WriteOptions {
  activityId: number | string;
  files?: string[];
  /** 平台 comment 字段，也用于在线文字作业。 */
  comment?: string;
  signal?: AbortSignal;
}

export function submittedMatch(row: Submission, uploadIds: number[], comment: string): boolean {
  if (row.is_draft !== false) return false;
  const ids = row.uploads?.map((u) => Number(u.id)) ?? [];
  if (ids.length !== uploadIds.length || !uploadIds.every((id) => ids.includes(id))) return false;
  // 附件由本次新分配的 ID 标识；文本作业同时核对正文。
  return !comment || htmlToText(String(row.comment ?? "")).trim() === htmlToText(comment).trim();
}

export async function submitHomework(client: Xuezai, opts: SubmitHomeworkOptions) {
  gate(opts, "提交学在浙大作业");
  const activityId = Number(id(opts.activityId));
  const comment = opts.comment ?? "";
  const files = (opts.files ?? []).map((file) => {
    const absolute = path.resolve(file); const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new ConfigError(`不是文件：${absolute}`);
    return { path: absolute, name: path.basename(absolute), size: stat.size };
  });
  if (!files.length && !comment.trim()) throw new ConfigError("需要至少一个文件或作业正文");
  const { activity, submissions: before } = await getHomework(client, activityId);
  if (activity.submit_by_group) throw new ConfigError("当前提交 API 支持个人作业；小组作业需使用平台小组提交入口");
  const uploads: number[] = [];
  const action = "xuezai.submit";
  const signal = opts.signal ?? AbortSignal.timeout(300_000);
  await record(opts, action, "begin", { activityId, files: files.map((f) => ({ name: f.name, size: f.size })), comment });
  try {
    for (const file of files) {
      await record(opts, action, "reserve", { activityId, name: file.name, size: file.size });
      const reserved = await client.post<{ id: number; upload_url: string }>("/api/uploads", { name: file.name, size: file.size, parent_type: "submission_upload", parent_id: 0, is_scorm: false, embed_material_type: "" });
      if (!reserved?.id || typeof reserved.upload_url !== "string") throw new BadResponse("上传占位响应缺少 id / upload_url");
      const target = new URL(reserved.upload_url);
      if (target.protocol !== "https:") throw new BadResponse("上传地址必须为 HTTPS");
      const body = new FormData();
      body.append("file", await fs.openAsBlob(file.path), file.name);
      await record(opts, action, "upload", { activityId, uploadId: reserved.id, name: file.name });
      // 签名 URL 自带授权；不附带 Cookie，不自动重试或跨站重定向上传。
      const response = await client.transfer(target.href, { method: "PUT", body, redirect: "error", signal });
      await response.body?.cancel();
      if (!response.ok) throw new RemoteRejected(`上传文件 HTTP ${response.status}`, { uploadId: reserved.id });
      uploads.push(Number(reserved.id));
    }
    await record(opts, action, "submit", { activityId, uploadIds: uploads });
    let responseError: string | undefined;
    try {
      await client.post(`/api/course/activities/${activityId}/submissions`, { uploads, comment, slides: [], is_draft: false });
    } catch (e) {
      // 超时可能已经提交成功，只读回查；不重复 POST。
      responseError = e instanceof Error ? e.message : String(e);
    }
    let after: Submission[] = [];
    let verificationError: string | undefined;
    try { after = await mySubmissions(client, activityId); }
    catch (e) { verificationError = e instanceof Error ? e.message : String(e); }
    const submission = after.find((s) => {
      if (!submittedMatch(s, uploads, comment)) return false;
      const previous = before.find((old) => old.id === s.id);
      return !previous || previous.is_draft || uploads.length > 0 || previous.submitted_at !== s.submitted_at || previous.comment !== s.comment;
    });
    if (!submission) throw new RemoteRejected("提交结果未能确认，请用 homework view 查看提交记录后再决定是否重试", { activityId, uploadIds: uploads, responseError, verificationError });
    await record(opts, action, "verified", { activityId, submissionId: submission.id, uploadIds: uploads });
    return { done: true as const, verified: true as const, activityId, uploadIds: uploads, submission };
  } catch (e) {
    await record(opts, action, "failed", { activityId, uploadIds: uploads, message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** 撤回最近一次正式提交（与网页上的「撤回」相同）；最近一次已是草稿时直接返回。 */
export async function retractHomework(client: Xuezai, opts: WriteOptions & { activityId: number | string }) {
  gate(opts, "撤回学在浙大作业");
  const activityId = Number(id(opts.activityId));
  const { activity, submissions } = await getHomework(client, activityId);
  const at = (s: Submission) => Date.parse(String(s.submitted_at ?? s.created_at ?? "")) || 0;
  const current = [...submissions].sort((a, b) => at(b) - at(a))[0];
  if (!current) throw new ConfigError("这个作业还没有提交记录，无可撤回");
  if (current.is_draft) return { done: true, alreadyDraft: true, submission: current };
  if (current.can_retract === false || activity.data.allow_retract === false) throw new RemoteRejected("平台不允许撤回该作业");
  const submissionId = current.id;
  await record(opts, "xuezai.retract", "submit", { activityId, submissionId });
  let responseError: string | undefined;
  try { await client.post(`/api/submissions/${submissionId}/retract`, {}, "PUT"); }
  catch (e) { responseError = e instanceof Error ? e.message : String(e); }
  const after = await mySubmissions(client, activityId);
  const submission = after.find((s) => s.id === submissionId && s.is_draft === true);
  if (!submission) throw new RemoteRejected("撤回结果未能确认，请用 homework view 查看提交记录", { activityId, submissionId, responseError });
  await record(opts, "xuezai.retract", "verified", { activityId, submissionId });
  return { done: true, verified: true, submission };
}
