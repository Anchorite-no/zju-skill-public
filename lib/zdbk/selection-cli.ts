import { command, bool, type Command, type Flags, type Option } from "../core/command.ts";
import { uniqueMatch } from "../core/match.ts";
import { BadResponse, RemoteRejected, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { fileJournal } from "../core/journal.ts";
import { credentials } from "../profile/profile.ts";
import { openZdbk } from "./client.ts";
import { Xsxk, type SelectionWriteOptions, type SelectionWriteResult } from "./xsxk.ts";
import { taskSections, ownedTarget, oneSection, searchAll, sectionView, courseView, ownedView, categoryNames, writeView, type CourseTarget } from "./selection-task.ts";
import { invalidateScheduleCache } from "./kbcx.ts";

const COURSE: Option = { description: "课程名称或课程代码", required: true };
const TEACHER: Option = { description: "教师姓名，用来限定教学班" };
const TIME: Option = { description: "上课时间里的文字，如 周四，用来限定教学班" };
const SECTION: Option = { description: "教学班号（结果里的 section），仍不唯一时用它指定" };
const DRY_RUN: Option = { description: "只读预览，不提交", type: "boolean" };
const CONFIRM: Option = { description: "确认执行；同时需要环境变量 ZJU_ALLOW_WRITE=1", type: "boolean" };

const target = (f: Flags): CourseTarget => ({ course: (f.course as string).trim(),
  ...(f.teacher ? { teacher: (f.teacher as string).trim() } : {}), ...(f.time ? { time: (f.time as string).trim() } : {}), ...(f.section ? { section: (f.section as string).trim() } : {}) });

async function withSelection<T>(fn: (xk: Xsxk) => Promise<T>): Promise<T> {
  const z = await openZdbk();
  try { return await fn(new Xsxk(z)); } finally { z.close(); }
}
const read = (description: string, options: Record<string, Option>, run: (xk: Xsxk, f: Flags) => Promise<unknown>) =>
  command(description, options, (f) => withSelection((xk) => run(xk, f)));

/** 写命令：写闸在建立会话之前检查；结果只给结论与整理过的教学班，平台响应进 journal。 */
function write(description: string, options: Record<string, Option>, fn: (xk: Xsxk, f: Flags, opts: SelectionWriteOptions) => Promise<SelectionWriteResult>) {
  return command(description, { ...options, "dry-run": DRY_RUN, confirm: CONFIRM }, async (f) => {
    let opts: SelectionWriteOptions, journalFile: string | undefined;
    if (bool(f, "dry-run")) opts = { dryRun: true };
    else {
      if (!bool(f, "confirm") || !writeAllowed()) throw new WriteGateClosed("教务网选课／志愿操作");
      const sink = fileJournal<Parameters<NonNullable<SelectionWriteOptions["journal"]>>[0]>("zdbk");
      opts = { confirm: true, journal: sink.append }; journalFile = sink.file;
      invalidateScheduleCache(credentials().username);
    }
    const result = await withSelection((xk) => fn(xk, f, opts));
    const data = { ...writeView(result), ...(journalFile ? { journalFile } : {}) };
    if (result.status === "rejected") throw new RemoteRejected(result.message, data);
    if (result.status === "unknown") throw new BadResponse(result.message, data);
    return data;
  });
}

export const selectionCommands: Record<string, Command> = {
  context: read("当前选课学年学期、每门课可填的志愿数和课程类别；页面可读不代表现在允许选课", {}, async (xk) => {
    const c = await xk.context();
    return { year: c.xn, semester: c.xq === "1" ? "秋冬" : c.xq === "2" ? "春夏" : c.xq, maxChoices: c.xkzys, categories: categoryNames(c).map((x) => x.name) };
  }),
  courses: read("某个课程类别下的全部课程；不给类别时列出类别", { category: { description: "课程类别名称，如 通识核心课程" } }, async (xk, f) => {
    const names = categoryNames(await xk.context());
    if (f.category === undefined) return { categories: names.map((x) => x.name) };
    const picked = uniqueMatch(names, f.category as string, (x) => [x.name], (x) => x.name, "课程类别");
    const courses = [], seen = new Set<string>();
    for (let page = 1; page <= 1000; page++) {
      const r = await xk.courses({ category: picked.category.dl, name: picked.category.name, page, size: 50 });
      for (const row of r.items) {
        const key = row.query.course + row.query.pool;
        if (seen.has(key)) throw new BadResponse("课程分页重复，无法确认完整结果");
        seen.add(key); courses.push(courseView(row));
      }
      if (!r.hasMore) return { category: picked.name, count: courses.length, courses };
    }
    throw new BadResponse("课程分页超过上限");
  }),
  search: read("按课程名搜索本学期开设的课程，自动查完全部分页", {
    keyword: { description: "课程名里的关键词", required: true },
    "only-available": { description: "只要还有余量的", type: "boolean" },
  }, async (xk, f) => {
    const courses = (await searchAll(xk, { keyword: (f.keyword as string).trim(), onlyAvailable: bool(f, "only-available") })).map(courseView);
    return { count: courses.length, courses };
  }),
  sections: read("一门课的教学班：教师、时间、地点、余量与容量", { course: COURSE, teacher: TEACHER, time: TIME, section: SECTION }, async (xk, f) => {
    const sections = (await taskSections(xk, target(f))).map(sectionView);
    return { count: sections.length, sections };
  }),
  selected: read("本人已选上的课和待筛选的志愿：教学班、志愿次序与状态，附选课系统汇总的学分", {}, async (xk) => {
    const choices = (await xk.owned()).map(ownedView);
    const credits = await xk.credits().catch(() => undefined);
    return { count: choices.length, ...(credits ? { credits } : {}), choices };
  }),
  credits: read("选课系统汇总的本学期学分（total 总计、regular 长学期、short 短学期）；不据此推断低定资格", {}, (xk) => xk.credits()),
  select: write("保存一个教学班志愿并回查；教学班不唯一时返回候选", { course: COURSE, teacher: TEACHER, time: TIME, section: SECTION },
    async (xk, f, o) => {
      const picked = oneSection(await taskSections(xk, target(f))), result = await xk.select(picked.choice, o);
      // 提交前重新读取的教学班没有课程名，补上定位时的。
      const candidate = (result.target as { candidate?: Record<string, unknown> } | undefined)?.candidate;
      if (candidate) candidate.kcmc ??= picked.kcmc;
      return result;
    }),
  reorder: write("调整一门课（或一个志愿组）的志愿顺序并回查，须给出完整顺序", {
    course: COURSE, order: { description: "新的志愿顺序，教师姓名或教学班号，用竖线分隔，如 张三|李四", required: true },
  }, async (xk, f, o) => {
    const rows = await ownedTarget(xk, target(f));
    const order = (f.order as string).split(/[|｜]/).map((v) => uniqueMatch(rows, v, (r) => [String(r.jsxm ?? ""), r.xkkh], ownedView, "志愿教学班"));
    return xk.reorder(order.map((r) => r.xkkh), o);
  }),
  drop: write("退掉一个已选或待筛选的教学班并回查", { course: COURSE, teacher: TEACHER, section: SECTION },
    async (xk, f, o) => xk.drop(oneSection(await ownedTarget(xk, target(f))).xkkh, o)),

};
