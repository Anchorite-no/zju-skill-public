import { command, retired, type Command, type Flags, type Option } from "../core/command.ts";
import { NeedsUser } from "../core/errors.ts";
import { openChalaoshi, ensureIndex, searchIndex, loadIndex, parseRate, type TeacherHit, type TeacherSort } from "./index.ts";

const COLLEGE: Option = { description: "学院名称里的文字，用来区分同名教师，如 数学" };
const text = (f: Flags, key: string) => typeof f[key] === "string" ? f[key] as string : undefined;
const teacherRow = (t: TeacherHit) => ({ name: t.name, college: t.college, rating: t.rating, hot: t.hot, url: t.url });

export function createChalaoshiCommands(open: typeof openChalaoshi = openChalaoshi): Record<string, Command> {
  /** 姓名 → 唯一教师；同名时要学院，没有同名的给相近候选。 */
  const findTeacher = (hits: TeacherHit[], name: string): TeacherHit => {
    const candidates = hits.filter((t) => t.score >= 60), exact = candidates.filter((t) => t.exact);
    if (exact.length === 1) return exact[0]!;
    const error = new NeedsUser(exact.length ? `有 ${exact.length} 位同名教师，请加 --college 学院` : candidates.length ? `没有叫“${name}”的教师，相近的有这些` : `查老师里没有“${name}”，可以试试拼音或首字母`);
    error.detail.candidates = (exact.length ? exact : candidates).map(teacherRow);
    throw error;
  };
  const commands: Record<string, Command> = {
    search: command("按姓名、拼音或首字母找教师，或按学院浏览：评分、热度和主页链接", {
      keyword: { description: "姓名、全拼或首字母，可再带学院，如 王伟 数学；只写学院名则列出该学院教师", required: true },
      college: COLLEGE,
      sort: { description: "排序：relevance 匹配度、rate 评分、hot 热度、name 姓名", choices: ["relevance", "rate", "hot", "name"], default: "relevance" },
      limit: { description: "条数", type: "integer", min: 1, max: 200, default: 20 },
    }, async (f) => {
      const s = await open();
      try {
        const { index } = await ensureIndex(s.ctx);
        const sort = f.sort === "relevance" ? "score" : f.sort as TeacherSort;
        const hits = searchIndex(index, f.keyword as string, { limit: Number(f.limit), sort, ...(text(f, "college") ? { college: text(f, "college")! } : {}) });
        return { count: hits.length, teachers: hits.map(teacherRow) };
      } finally { s.close(); }
    }),
    teacher: command("一位教师的评分、评分人数、点名比例、所教课程的平均绩点，以及学生评论", {
      name: { description: "教师姓名", required: true },
      college: COLLEGE,
      limit: { description: "评论条数，0 不取评论", type: "integer", min: 0, max: 200, default: 10 },
      sort: { description: "评论排序：rate 点赞最多，time 最新", choices: ["rate", "time"], default: "rate" },
    }, async (f) => {
      const s = await open();
      try {
        const { index } = await ensureIndex(s.ctx);
        const target = findTeacher(searchIndex(index, f.name as string, { limit: 10, ...(text(f, "college") ? { college: text(f, "college")! } : {}) }), f.name as string);
        const detail = await s.client.teacher(target.id), limit = Number(f.limit);
        const comments = limit > 0 ? (await s.client.comments(target.id, f.sort as "rate" | "time")).slice(0, limit) : [];
        return {
          name: detail.name, college: detail.college, rating: detail.rating, ratingCount: detail.ratingCount,
          ...(detail.attendancePct !== null ? { rollCallPct: detail.attendancePct } : {}),
          courses: detail.courses.map((c) => ({ course: c.course, gpa: c.gpa, students: c.sampleText })),
          url: detail.url, commentCount: detail.commentCount,
          comments: comments.map((c) => ({ date: c.date, likes: c.likes, text: c.text })),
        };
      } finally { s.close(); }
    }),
    course: command("教一门课的所有老师的平均绩点、标准差和样本人数，并附各人的查老师评分", {
      name: { description: "课程名，写法要与查老师页面一致，如 微积分（甲）Ⅰ", required: true },
    }, async (f) => {
      const s = await open();
      try {
        const rows = await s.client.courseGpa(f.name as string);
        if (!rows.length) throw new NeedsUser(`查老师里没有课程“${f.name as string}”的绩点数据；课程名要与页面写法完全一致（全角括号、罗马数字），可先用 chalaoshi teacher 看任课教师的 courses 里怎么写`);
        const index = loadIndex(), colleges = new Map((index?.colleges ?? []).map((c) => [c.id, c.name]));
        const sameName = (teacher: string) => (index?.teachers ?? []).filter((t) => t.name === teacher).map((t) => ({ college: colleges.get(t.xy) ?? "", rating: parseRate(t.rate) }));
        return { course: f.name, count: rows.length, teachers: rows.map((r) => {
          const found = sameName(r.teacher);
          return { teacher: r.teacher, gpa: r.gpa, sd: r.sd, students: r.sampleText,
            ...(found.length === 1 ? found[0] : found.length > 1 ? { sameName: found } : {}) };
        }) };
      } finally { s.close(); }
    }),
  };
  commands.comments = retired("chalaoshi teacher --name 姓名");
  commands.sync = retired("chalaoshi search --keyword 关键词；索引自动维护");
  return commands;
}
export const chalaoshiCommands = createChalaoshiCommands();
