import { command, group, retired, sessionCommands, bool, type Command, type Flags, type Option } from "../core/command.ts";
import { ConfigError, NeedsUser, ZjuError } from "../core/errors.ts";
import { beijingMinute, fileSize } from "../core/output.ts";
import { uniqueMatch } from "../core/match.ts";
import type { Xuezai } from "./client.ts";
import { findCourse, getActivity, getCourse, listActivities, listCourses, listModules, pickSemesters, courseRow, courseView } from "./courses.ts";
import { courseMaterials, downloadMaterials, materialRow, placeOf, type Material } from "./materials.ts";
import type { CourseModule } from "./types.ts";
import { listHomework, getHomework, submitHomework, retractHomework, downloadAttachments, downloadSubmission, homeworkList, homeworkView, submissionView } from "./homework.ts";
import { getTodos } from "./todos.ts";
import { withClient, localSession, writeSetup } from "./cli-common.ts";
import { rollcallCommands } from "./rollcall-cli.ts";

const COURSE: Option = { description: "课程名称，可用常见简称（计组、概统）；也可以写 course list 给的课程链接", required: true };
const CHAPTER: Option = { description: "只要这一章（或节）里的文件，写章节名称" };
const HOMEWORK: Option = { description: "作业名称", required: true };
const CONFIRM: Option = { description: "确认执行；同时需要环境变量 ZJU_ALLOW_WRITE=1", type: "boolean" };

const text = (f: Flags, key: string) => typeof f[key] === "string" ? f[key] as string : undefined;
/** 多个值用竖线分隔，与 doc pdf --file、cc98 --image 相同。 */
const list = (value: string | undefined) => (value ?? "").split(/[|｜]/).map((v) => v.trim()).filter(Boolean);
const read = (description: string, options: Record<string, Option>, run: (c: Xuezai, f: Flags) => Promise<unknown>) =>
  command(description, options, (f) => withClient((c) => run(c, f)));

async function homeworkTarget(c: Xuezai, f: Flags) {
  const course = await findCourse(c, f.course as string);
  const rows = await listHomework(c, course.id);
  if (!rows.length) throw new NeedsUser(`${course.name} 在学在浙大没有布置作业`);
  return { ...uniqueMatch(rows, f.name as string, (r) => [r.title], (r) => ({ name: r.title, deadline: beijingMinute(r.end_time) }), "作业"), courseName: course.name };
}

/** 给了 --chapter 就只留那一章（或节）里的文件。几章同名时一起算；名字对到几个不同的章节时给候选。 */
function inChapter(rows: Material[], modules: CourseModule[], chapter: string | undefined): Material[] {
  if (chapter === undefined) return rows;
  const names = [...new Set(rows.flatMap((row) => Object.values(placeOf(row, modules))))];
  if (!names.length) throw new NeedsUser("这门课的文件没有分章节");
  const picked = uniqueMatch(names, chapter, (name) => [name], (name) => name, "章节");
  return rows.filter((row) => Object.values(placeOf(row, modules)).includes(picked));
}

const course = group("我的课程；一门课的简介、章节和每章里的资料、作业", {
  list: read("本人课程：名称、学期、教师；默认当前学期", {
    semester: { description: "学期（2025-2026春夏）或学年（2025-2026）；不给时为当前学期" },
    all: { description: "全部学期", type: "boolean" },
  }, async (c, f) => {
    if (bool(f, "all") && f.semester !== undefined) throw new ConfigError("--all 与 --semester 只给一个");
    const semesters = bool(f, "all") ? undefined : await pickSemesters(c, text(f, "semester"));
    const courses = await listCourses(c, semesters ? { semester: semesters.map((s) => s.id) } : {});
    return { ...(semesters ? { semesters: semesters.map((s) => s.name) } : {}), count: courses.length, courses: courses.map(courseRow) };
  }),
  view: read("一门课的简介和章节，每章列出其中的资料、作业、链接等活动及其说明、截止时间和文件名", { course: COURSE }, async (c, f) => {
    const { id } = await findCourse(c, f.course as string);
    const [detail, modules, activities] = await Promise.all([getCourse(c, id), listModules(c, id), listActivities(c, id)]);
    return courseView(detail, modules, activities);
  }),
});

const material = group("课件等课程文件：清单与下载", {
  list: read("一门课的全部文件，照课程里的先后：文件名、大小、在哪一章和所在活动", { course: COURSE, chapter: CHAPTER }, async (c, f) => {
    const found = await findCourse(c, f.course as string), { materials, modules } = await courseMaterials(c, found.id);
    const rows = inChapter(materials, modules, text(f, "chapter"));
    return { course: found.name, count: rows.length, materials: rows.map((row) => materialRow(row, modules)) };
  }),
  download: read("下载课程文件，返回本地路径；下载过的直接复用。默认存到 data/output/xuezai/课程名/", {
    course: COURSE,
    name: { description: "文件名或所在活动名，多个用竖线分隔；与 --all 二选一" },
    chapter: { description: `${CHAPTER.description}；只给它、不给 --name 时下载这一章的全部文件，不含视频` },
    all: { description: "这门课的全部文件，不含视频", type: "boolean" },
    video: { description: "和 --all 或单独的 --chapter 一起用：视频也下载", type: "boolean" },
    "out-dir": { description: "保存目录" },
  }, async (c, f) => {
    const names = list(text(f, "name")), chapter = text(f, "chapter");
    if (bool(f, "all") && names.length) throw new ConfigError("--name 与 --all 只给一个");
    // 只说了哪一章，就是要这一章的全部。
    const whole = !names.length;
    if (whole && !bool(f, "all") && chapter === undefined) throw new ConfigError("需要 --name 文件名、--chapter 章节名，或 --all 下载这门课的全部文件");
    if (bool(f, "video") && !whole) throw new ConfigError("--video 只在下载整门课或整章时用；下载某个视频直接把它写进 --name");
    const found = await findCourse(c, f.course as string), { materials, modules } = await courseMaterials(c, found.id);
    if (!materials.length) throw new NeedsUser(`${found.name} 没有文件`);
    const rows = inChapter(materials, modules, chapter);
    // 整门课、整章下载默认不带视频：一门课的视频常有几个 GB。
    const skipped = whole && !bool(f, "video") ? rows.filter((r) => r.type === "video") : [];
    const wanted = whole ? rows.filter((r) => !skipped.includes(r))
      : names.map((name) => uniqueMatch(rows, name, (r) => [r.name, ...r.activities.map((a) => a.title)], (r) => materialRow(r, modules), "文件"));
    return {
      course: found.name, ...await downloadMaterials(c, found.name, materials, [...new Set(wanted)], { ...(text(f, "out-dir") ? { outDir: text(f, "out-dir")! } : {}) }),
      ...(skipped.length ? { note: `没有下载${chapter === undefined ? "这门课" : "这一章"}的 ${skipped.length} 个视频（共 ${fileSize(skipped.reduce((sum, r) => sum + r.size, 0))}）；要下载加 --video` } : {}),
    };
  }),
});

const homework = group("作业：列表、要求与本人提交记录、下载老师给的附件和本人交过的文件、提交、撤回", {
  list: read("一门课的全部作业（含已交），按截止先后：状态、要求、分数", { course: COURSE }, async (c, f) => {
    const found = await findCourse(c, f.course as string);
    return { course: found.name, ...homeworkList(await listHomework(c, found.id)) };
  }),
  view: read("一个作业的完整要求、老师附件、提交规则和本人提交记录（文件、分数、评语）", { course: COURSE, name: HOMEWORK }, async (c, f) => {
    const { activity, submissions } = await getHomework(c, (await homeworkTarget(c, f)).id);
    return homeworkView(activity, submissions);
  }),
  download: read("下载本人交过的作业文件（最近一次提交）和老师批改后传回的文件，返回本地路径", {
    course: COURSE, name: HOMEWORK, "out-dir": { description: "保存目录" },
  }, async (c, f) => {
    const target = await homeworkTarget(c, f);
    const { activity, submissions } = await getHomework(c, target.id);
    return { course: target.courseName, ...await downloadSubmission(c, target.courseName, activity, submissions, { ...(text(f, "out-dir") ? { outDir: text(f, "out-dir")! } : {}) }) };
  }),
  attachments: read("下载老师随作业给的附件，返回本地路径；下载过的直接复用。默认存到 data/output/xuezai/课程名/作业附件/作业名/", {
    course: COURSE, name: HOMEWORK,
    file: { description: "只下这个附件，多个用竖线分隔；不给时全部下载" },
    "out-dir": { description: "保存目录" },
  }, async (c, f) => {
    const target = await homeworkTarget(c, f);
    const activity = await getActivity(c, target.id), uploads = activity.uploads ?? [];
    if (!uploads.length) throw new NeedsUser(`「${activity.title}」没有附件`);
    const names = list(text(f, "file"));
    const wanted = names.length ? names.map((name) => uniqueMatch(uploads, name, (u) => [u.name], (u) => ({ name: u.name, size: fileSize(u.size) }), "附件")) : uploads;
    return { course: target.courseName, ...await downloadAttachments(c, target.courseName, activity, [...new Set(wanted)], { ...(text(f, "out-dir") ? { outDir: text(f, "out-dir")! } : {}) }) };
  }),
  submit: command("提交个人作业并回查；文件和文字至少给一样", {
    course: COURSE, name: HOMEWORK,
    file: { description: "要交的文件，多个用竖线分隔" },
    comment: { description: "作业正文或留言" },
    confirm: CONFIRM,
  }, async (f) => {
    const setup = writeSetup(f, "提交学在浙大作业");
    const files = list(text(f, "file")), comment = text(f, "comment") ?? "";
    if (!files.length && !comment.trim()) throw new ConfigError("需要 --file 或 --comment");
    try {
      return await withClient(async (c) => {
        const target = await homeworkTarget(c, f);
        const r = await submitHomework(c, { ...setup, activityId: target.id, files, comment });
        return { homework: target.title, done: r.done, verified: r.verified, submission: submissionView(r.submission) };
      });
    } catch (e) {
      if (e instanceof ZjuError) e.detail.journalFile = setup.journalFile;
      throw e;
    }
  }),
  retract: command("撤回最近一次提交到草稿（老师允许时）并回查", { course: COURSE, name: HOMEWORK, confirm: CONFIRM }, async (f) => {
    const setup = writeSetup(f, "撤回学在浙大作业");
    return withClient(async (c) => {
      const target = await homeworkTarget(c, f);
      const r = await retractHomework(c, { ...setup, activityId: target.id });
      return { homework: target.title, done: r.done, ...("verified" in r ? { verified: r.verified } : { alreadyDraft: true }), submission: submissionView(r.submission) };
    });
  }),
});

export const xuezaiCommands: Record<string, Command> = sessionCommands({
  todos: read("待办：当前学期各课未交的作业和测验，按截止先后，含作业要求", {
    course: { description: "只看这门课" },
    done: { description: "已交的作业也列出来，标 done: true", type: "boolean" },
  }, async (c, f) => getTodos(c, f.course === undefined ? undefined : await findCourse(c, f.course as string), { done: bool(f, "done") })),
  course, material, homework,
  ...rollcallCommands,
  login: command("检查或更新学在站点会话，返回当前账号；认证复用 zjuam", { fresh: { description: "强制重新登录", type: "boolean" } },
    (f) => withClient((c) => c.me(), bool(f, "fresh"))),
  status: command("本地会话状态（不联网）", {}, async () => { const s = localSession(); return { file: s.file, ...s.status() }; }, "local"),
  logout: command("清除本地学在浙大会话", {}, async () => ({ cleared: localSession().clear() }), "local"),
}, "xuezai");

// 平铺的旧入口只提示新路径。
for (const [old, now] of Object.entries({
  me: "session login", semesters: "course list --semester 学期", courses: "course list",
  chapters: "course view --course 课程名", activities: "course view --course 课程名", activity: "course view --course 课程名",
  materials: "material list --course 课程名", download: "material download --course 课程名 --name 文件名",
  read: "material download --course 课程名 --name 文件名；然后直接读取返回的本地文件",
  submit: "homework submit", retract: "homework retract", submission: "homework view --course 课程名 --name 作业名",
  attendance: "rollcall status", "rollcall-history": "rollcall history", rollcalls: "rollcall status",
})) xuezaiCommands[old] = retired(`xuezai ${now}`);
