/** lab module CLI; business calls stay inside this module. */
import { command, retired, sessionCommands, bool, type Command, type Flags, type Option } from "../core/command.ts";
import { ConfigError, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { uniqueMatch } from "../core/match.ts";
import { beijingMinute } from "../core/output.ts";
import { readProfile, credentials } from "../profile/profile.ts";
import { openLab, resolveLabCourseInfo, resolveLabTarget, termOf, labSession, labSessionStatus, type LabCourse, type LabSection, type Selection, type Course } from "./index.ts";

const TERM: Option = { description: "学期，如 2025-2026春夏；不给时为当前学期" };
const COURSE: Option = { description: "实验课名称，如 大学物理实验", required: true };
const LAB: Option = { description: "实验名称", required: true };
const CONFIRM: Option = { description: "确认执行；同时需要环境变量 ZJU_ALLOW_WRITE=1", type: "boolean" };

const WEEKDAYS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const room = (v: unknown) => String(v ?? "").replace(/[,，\s]+$/, "");
const account = () => readProfile().lab_username || credentials().username;
const read = (description: string, options: Record<string, Option>, run: (lab: LabCourse, f: Flags) => Promise<unknown>) =>
  command(description, options, async (f) => { const lab = await openLab(); try { return await run(lab, f); } finally { lab.close(); } });

/** 课程块：星期、上午或下午、可选实验个数上限和选课窗口。 */
function courseRow(c: Course, selections: Selection[]) {
  return {
    course: String(c.courseName ?? c.name ?? ""), weekday: WEEKDAYS[Number(c.week)] ?? null, time: Number(c.time) === 1 ? "上午" : Number(c.time) === 2 ? "下午" : null,
    limit: Number(c.count) || null, selected: selections.filter((s) => Number(s.courseId) === c.id).length,
    selectionOpens: beijingMinute(c.startDate), selectionCloses: beijingMinute(c.endDate),
  };
}

/** 已选的一项实验：week 是平台的实验序号（绪论后的第几次），dates 是实际上课日期。 */
function selectionRow(s: Selection, course: string, section: LabSection | undefined) {
  return {
    course, lab: section?.labName ?? s.labName ?? "", teacher: section?.teacherName ?? "", room: room(section?.address), time: section?.times ?? "",
    week: String(s.selectWeek ?? ""), dates: String(s.dates ?? "").split(/[\s,，]+/).filter(Boolean), selectedAt: beijingMinute(s.gmtCreate),
  };
}

/** 一门课的全部实验班次，连同本人已选、周次冲突和余量，直接给出还能选哪些。 */
async function labsOverview(lab: LabCourse, course: Course, term: number) {
  const [sections, status, selections, windows] = await Promise.all([lab.labs(course.id), lab.weekStatus(term), lab.mySelections(term), lab.openStatus(term)]);
  const relevant = windows.filter((w) => Number(w.id) === course.id && Number(w.termId) === term);
  const window = relevant.length === 1 ? relevant[0] : undefined;
  const now = Date.now();
  const own = selections.filter((s) => sections.some((l) => l.id === s.courseLabId));
  const selectionOpen = window ? now >= window.startDate && now <= window.endDate : null;
  const occupied = new Set(own.flatMap((s) => String(s.selectWeek ?? "").split(",")));
  const atLimit = window ? own.length >= window.count : false;
  const clash = (w: string) => w.split(",").some((n) => occupied.has(n));
  const taken = (l: LabSection, w: string) => Number(status[`${l.id}_${w}`] ?? 0);
  const labs = sections.map((l) => {
    const mine = own.some((s) => s.courseLabId === l.id);
    const reason = selectionOpen === false ? "选课窗口未开放" : selectionOpen === null ? "窗口信息不足"
      : atLimit ? "已达选课数量上限" : mine ? "本人已选此实验"
      : l.weeks.every(clash) ? "全部周次与本人已选实验冲突"
      : l.weeks.filter((w) => !clash(w)).every((w) => !!l.contain && taken(l, w) >= l.contain) ? "不冲突的周次均已满员" : null;
    return {
      lab: l.labName, teacher: l.teacherName ?? "", room: room(l.address), time: l.times ?? "", capacity: l.contain, enrolled: l.counts,
      ...(Number(l.isMust) === 1 ? { required: true } : {}), ...(mine ? { alreadySelected: true } : {}), ...(reason ? { unavailableReason: reason } : {}),
      availableWeeks: l.weeks.filter((w) => selectionOpen === true && !atLimit && !mine && !clash(w) && (!l.contain || taken(l, w) < l.contain))
        .map((w) => ({ week: w, free: l.contain ? Math.max(0, l.contain - taken(l, w)) : null })),
    };
  });
  const availableCount = labs.filter((l) => l.availableWeeks.length > 0).length;
  return {
    status: selectionOpen === null ? "unknown" : availableCount ? "available" : "no-options",
    message: selectionOpen === false ? "当前选课窗口未开放，不能提交新选课。" : selectionOpen === null ? "没有唯一对应的课程窗口，不能可靠判断当前可选性。"
      : atLimit ? "本人已选数量达到课程上限，没有可新增的实验。"
      : !availableCount ? `本人已选 ${own.length} 项实验，当前没有能直接新增的班次；未选班次的周次均冲突或满员，逐项原因见 unavailableReason。`
      : `当前有 ${availableCount} 个实验可作为新增候选，availableWeeks 已排除已选、周次冲突和满员；最终提交由平台校验。`,
    course: String(course.courseName ?? course.name ?? ""), selectionOpen,
    window: window ? { opensAt: beijingMinute(window.startDate), closesAt: beijingMinute(window.endDate), limit: window.count } : null,
    alreadySelected: own.map((s) => ({ lab: sections.find((l) => l.id === s.courseLabId)?.labName ?? "", week: String(s.selectWeek ?? "") })),
    occupiedWeeks: [...occupied].map(Number).filter(Boolean).sort((a, b) => a - b), availableCount, count: labs.length, labs,
  };
}

export const labCommands: Record<string, Command> = sessionCommands({
  timetable: read("我的实验课表：每次实验的日期、开始时间、实验名、实验室和教师，附当前北京时间", { term: TERM }, async (lab, f) => {
    const sessions = await lab.myTimetable(await termOf(lab, f.term));
    return { currentTime: beijingMinute(Date.now()), count: sessions.length, sessions };
  }),
  grades: read("每次实验的报告成绩：实验名、序号、教师、分数与是否出分，默认当前学期", { term: TERM }, async (lab, f) => {
    const reports = await lab.myGrades(await termOf(lab, f.term));
    const gradedCount = reports.filter(r => r.score !== null).length, pendingCount = reports.length - gradedCount;
    return { currentTime: beijingMinute(Date.now()), count: reports.length, gradedCount, pendingCount,
      message: reports.length ? `查到 ${reports.length} 项实验，${gradedCount} 项已评分、${pendingCount} 项未出分。未出分不代表未交报告。` : "该学期没有实验报告成绩记录。",
      reports };
  }),
  courses: read("我的实验课：星期、上午或下午、可选实验个数上限、已选个数和选课开放时间", { term: TERM }, async (lab, f) => {
    const term = await termOf(lab, f.term);
    const [courses, selections] = await Promise.all([lab.myCourses(term), lab.mySelections(term)]);
    return { currentTime: beijingMinute(Date.now()), count: courses.length, courses: courses.map((c) => courseRow(c, selections)) };
  }),
  labs: read("一门课的全部实验：教师、实验室、容量、已选人数，以及排除本人已选、周次冲突和满员后还能选的周次", { course: COURSE, term: TERM }, async (lab, f) => {
    const term = await termOf(lab, f.term);
    return labsOverview(lab, await resolveLabCourseInfo(lab, f.course as string, term), term);
  }),
  selected: read("我已选的实验：实验名、教师、实验室、实验序号和上课日期", { term: TERM }, async (lab, f) => {
    const term = await termOf(lab, f.term);
    const [courses, selections] = await Promise.all([lab.myCourses(term), lab.mySelections(term)]);
    const sections = new Map((await Promise.all(courses.map((c) => lab.labs(c.id)))).flat().map((l) => [l.id, l]));
    const name = (id: unknown) => { const c = courses.find((x) => x.id === Number(id)); return String(c?.courseName ?? c?.name ?? ""); };
    const rows = selections.map((s) => selectionRow(s, name(s.courseId), sections.get(s.courseLabId)))
      .sort((a, b) => (a.dates[0] ?? "9999").localeCompare(b.dates[0] ?? "9999"));
    return { count: rows.length, selections: rows };
  }),
  select: command("选一个实验并回查，选之前先查容量，满员不提交；加 --cancel 是退掉一个已选的实验并回查", {
    course: COURSE, lab: LAB, week: { description: "实验序号，取 labs 结果里 availableWeeks 的 week，如 3 或 5,6；选的时候必须给，退的时候不用" },
    teacher: { description: "教师姓名，同名实验有多个班时用" }, cancel: { description: "退掉这个已选的实验", type: "boolean" }, term: TERM, confirm: CONFIRM,
  }, async (f) => {
    const cancel = bool(f, "cancel");
    if (!cancel && typeof f.week !== "string") throw new ConfigError("选实验需要 --week 实验序号");
    if (!bool(f, "confirm") || !writeAllowed()) throw new WriteGateClosed(cancel ? "实验课退选" : "实验课选课");
    const lab = await openLab();
    try {
      if (cancel) {
        const term = await termOf(lab, f.term), course = await resolveLabCourseInfo(lab, f.course as string, term);
        const [sections, selections] = await Promise.all([lab.labs(course.id), lab.mySelections(term)]);
        const mine = selections.flatMap((s) => { const section = sections.find((l) => l.id === s.courseLabId); return section ? [{ s, section }] : []; });
        const picked = uniqueMatch(mine, f.lab as string, (r) => [r.section.labName], (r) => ({ lab: r.section.labName, week: r.s.selectWeek }), "已选实验");
        const r = await lab.cancel({ recordId: picked.s.id, term, confirm: true });
        return { done: true, verified: true, cancelled: { lab: picked.section.labName, week: String(picked.s.selectWeek ?? "") }, selectedCount: r.selections.length, ...(r.journalFile ? { journalFile: r.journalFile } : {}) };
      }
      const t = await resolveLabTarget(lab, { course: f.course as string, lab: f.lab as string, week: f.week as string,
        ...(f.teacher ? { teacher: f.teacher as string } : {}), term: await termOf(lab, f.term) });
      const r = await lab.select({ courseId: t.courseId, labId: t.labId, week: t.week, term: t.termId, confirm: true });
      return { done: true, verified: true, lab: r.labName, teacher: r.teacherName, week: r.week, selectedCount: r.selections.length, ...(r.journalFile ? { journalFile: r.journalFile } : {}) };
    } finally { lab.close(); }
  }),
  notices: read("实验选课平台的公告全文", {}, async (lab) => {
    const rows = await lab.notices();
    return { count: rows.length, notices: rows.map((n) => ({ title: n.title, publishedAt: beijingMinute(n.publishedAt), text: n.text })) };
  }),
  login: command("实验课选课平台登录（平台自己的账号，默认同学号），返回账号与姓名", { fresh: { description: "强制重新登录", type: "boolean" } }, async (f) => {
    const lab = await openLab({ fresh: bool(f, "fresh") });
    try {
      const a = await lab.login(bool(f, "fresh"));
      return { username: a.username, name: a.name, expiresAt: beijingMinute(a.expiresAt) };
    } finally { lab.close(); }
  }),
  status: command("本地实验课会话状态，不联网", {}, async () => labSessionStatus(account()), "local"),
  logout: command("清除本地实验课会话", {}, async () => ({ cleared: labSession(account()).clear() }), "local"),
}, "lab");

// 旧入口只提示新路径。
for (const [old, now] of Object.entries({ terms: "courses --term 学期名", open: "courses", me: "session login" })) labCommands[old] = retired(`lab ${now}`);
