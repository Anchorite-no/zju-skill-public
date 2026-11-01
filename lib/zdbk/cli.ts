import { command, group, retired, sessionCommands, bool, type Command, type Flags, type Option } from "../core/command.ts";
import { credentials } from "../profile/profile.ts";
import { SessionStore } from "../zjuam/session.ts";
import { openZdbk, type Zdbk } from "./client.ts";
import { selectionCommands } from "./selection-cli.ts";
import { cachedSchedule, studentInfo } from "./kbcx.ts";
import { getExams } from "./kscx.ts";
import { getGrades } from "./cjcx.ts";
import { findPlans, viewPlan } from "./pyfagl.ts";

const YEAR: Option = { description: "学年，如 2026-2027；默认跟随教务页面" };
const TERM: Option = { description: "学期：秋、冬、春、夏、短、暑；默认跟随教务页面" };
const text = (f: Flags, ...keys: string[]) => Object.fromEntries(keys.filter((k) => typeof f[k] === "string").map((k) => [k, f[k] as string]));
const localSession = () => new SessionStore({ system: "zdbk", username: credentials().username, ttlMs: 2 * 3600 * 1000 });

export function createZdbkCommands(open: typeof openZdbk = openZdbk): Record<string, Command> {
  const read = (description: string, options: Record<string, Option>, run: (z: Zdbk, f: Flags) => Promise<unknown>) =>
    command(description, options, async (f) => { const z = await open(); try { return await run(z, f); } finally { z.close(); } });

  const timetable = command("完整课表：每门课的教师、星期、节次、起止时间、周次与教室，附当前北京时间；自动缓存", { year: YEAR, term: TERM },
    (f) => cachedSchedule(text(f, "year", "term"), open));
  timetable.source = (data) => (data as Awaited<ReturnType<typeof cachedSchedule>>).cache.hit ? "cache" : "live";

  const commands = sessionCommands({
    timetable,
    exams: read("本人考试安排：期中与期末的日期、时间、考场和座位号，未公布的如实标出", {
      course: { description: "只看课程名含这段文字的课" }, year: YEAR, term: TERM,
    }, (z, f) => getExams(z, text(f, "course", "year", "term"))),
    grades: read("本人全部成绩、学分与五分制平均绩点：总体、各学期和主修课程", {}, (z) => getGrades(z)),
    student: read("本人学籍：学号、姓名、学院、专业和行政班（本科教务网，研究生查不到）", {}, (z) => studentInfo(z)),
    plan: group("培养方案：本人或某专业的方案与 PDF，某年级的方案列表", {
      view: read("本人（或指定专业）的培养方案：学分、学位、核心课，并把完整 PDF 存到本地", {
        major: { description: "专业名称；不给时为本人专业" },
        year: { description: "入学年份，如 2025；不给时为本人年级" },
      }, (z, f) => viewPlan(z, text(f, "major", "year"))),
      list: read("某一年级的培养方案列表，可按学院、专业名筛选", {
        year: { description: "入学年份，如 2025；不给时为本人年级" },
        college: { description: "学院名称里的文字" },
        major: { description: "专业名称里的文字" },
      }, (z, f) => findPlans(z, text(f, "year", "college", "major"))),
    }),
    selection: group("自主选课：查课程与教学班、单次选退与志愿管理", selectionCommands),
    login: command("教务网登录（CAS 委托）并保存会话", { fresh: { description: "强制重新登录", type: "boolean" } }, async (f) => {
      const z = await open({ fresh: bool(f, "fresh") });
      try {
        await z.login(bool(f, "fresh"));
        const s = z.status(), p = await z.probe();
        return { ...s, probed: p.ok, httpStatus: p.status };
      } finally { z.close(); }
    }),
    status: command("教务网会话状态（不联网）", {}, async () => {
      const store = localSession(), s = store.status();
      return { username: credentials().username, file: store.file, cached: s.exists && !s.expired, ageMs: s.ageMs, expired: s.expired };
    }, "local"),
    logout: command("清除教务网会话", {}, async () => ({ cleared: localSession().clear() }), "local"),
  }, "zdbk");

  // 旧入口只提示新路径。
  for (const [old, now] of Object.entries({
    plans: "plan list", "plan-pdf": "plan view", "my-plan": "plan view",
    terms: "timetable --term 秋|冬|春|夏|短|暑", "xk-context": "selection context",
    ...Object.fromEntries(Object.keys(selectionCommands).map((name) => [name, `selection ${name}`])),
  })) commands[old] = retired(`zdbk ${now}`);
  selectionCommands["xk-context"] = retired("zdbk selection context");
  return commands;
}
export const zdbkCommands = createZdbkCommands();
