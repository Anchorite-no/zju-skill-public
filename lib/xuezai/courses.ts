import { BadResponse, NeedsUser } from "../core/errors.ts";
import { htmlToText } from "../core/html.ts";
import { beijingMinute } from "../core/output.ts";
import { BASE, id, type Xuezai } from "./client.ts";
import type { Activity, Course, CourseModule, Semester } from "./types.ts";
import { abbreviates, uniqueMatch } from "../core/match.ts";

/** 课程页面的地址。course list 把它给出来，原样写回 --course 就是这门课：名字会重、会互相包含，链接不会。 */
export const courseLink = (courseId: number | string) => `${BASE}/course/${id(courseId)}/content`;

/** 课程名称、简称、课程页面的链接或平台课程 ID → 本人课程；同名时优先当前学期，仍不唯一则给候选。 */
export async function findCourse(client: Xuezai, query: string): Promise<Course> {
  const linked = query.trim().match(/^https?:\/\/courses\.zju\.edu\.cn\/course\/(\d+)(?:[/?#]|$)/);
  if (linked) return getCourse(client, linked[1]!);
  if (/^\d+$/.test(query)) return getCourse(client, query);
  let rows = await listCourses(client, { keyword: query });
  // 平台关键词只匹配子串；搜不到时按简称匹配本人课程，仍没有就把课程列作候选。
  if (!rows.length) { const all = await listCourses(client); rows = all.filter(row => abbreviates(query, row.name)); if (!rows.length) rows = all; }
  let current = rows.filter(row => row.semester?.is_active);
  if (!current.length && rows.length > 1) {
    const now = new Set(currentSemesters(await listSemesters(client)).map(s => s.id));
    current = rows.filter(row => row.semester && now.has(row.semester.id));
  }
  return uniqueMatch(current.length ? current : rows, query, row => [row.name, row.course_code ?? "", ...(abbreviates(query, row.name) ? [query] : [])],
    row => ({ id: row.id, name: row.name, semester: row.semester?.name, teachers: row.instructors?.map(t => t.name) }), "课程");
}

export async function listSemesters(client: Xuezai): Promise<Semester[]> {
  const data = await client.json<{ semesters: Semester[] }>("/api/my-semesters?fields=id,name,sort,is_active,code");
  if (!Array.isArray(data.semesters)) throw new BadResponse("学期响应缺少 semesters");
  return data.semesters;
}

/** 平台只把长学期标成当前（2026-2027秋冬）；同一学年里与它互相包含的学期（秋、冬）的课也正在上。 */
export function currentSemesters(all: Semester[]): Semester[] {
  const parts = (s: Semester) => s.name.match(/^(\d{4}-\d{4})(.+)$/);
  const within = (a: string, b: string) => [...a].every(ch => b.includes(ch));
  const active = all.filter(s => s.is_active);
  return all.filter(s => s.is_active || active.some(a => {
    const x = parts(a), y = parts(s);
    return !!x && !!y && x[1] === y[1] && (within(y[2]!, x[2]!) || within(x[2]!, y[2]!));
  }));
}

/** 学期名（2025-2026春夏）或学年（2025-2026）→ 学期；不给时为当前学期。 */
export async function pickSemesters(client: Xuezai, name?: string): Promise<Semester[]> {
  const all = await listSemesters(client);
  if (!name) return currentSemesters(all);
  const wanted = name.normalize("NFKC").replace(/\s+/g, "");
  const exact = all.filter(s => s.name === wanted), hit = exact.length ? exact : all.filter(s => s.name.includes(wanted));
  if (hit.length) return hit;
  const error = new NeedsUser(`没有学期“${name}”`);
  error.detail.candidates = all.map(s => s.name);
  throw error;
}

export interface CourseOptions { semester?: number | number[]; keyword?: string; status?: string[]; pageSize?: number }
export async function listCourses(client: Xuezai, opts: CourseOptions = {}): Promise<Course[]> {
  const conditions = { status: opts.status ?? ["ongoing", "notStarted", "ended"], ...(opts.semester === undefined ? {} : { semester_id: [opts.semester].flat().map((v) => Number(id(v))) }), ...(opts.keyword ? { keyword: opts.keyword } : {}) };
  return client.all<Course>(`/api/my-courses?conditions=${encodeURIComponent(JSON.stringify(conditions))}`, "courses", opts.pageSize ?? 50);
}

export function getCourse(client: Xuezai, courseId: number | string): Promise<Course> {
  return client.json<Course>(`/api/courses/${id(courseId)}`);
}

export async function listModules(client: Xuezai, courseId: number | string): Promise<CourseModule[]> {
  const data = await client.json<{ modules: CourseModule[] }>(`/api/courses/${id(courseId)}/modules`);
  if (!Array.isArray(data.modules)) throw new BadResponse("章节响应缺少 modules");
  return data.modules;
}

export async function listActivities(client: Xuezai, courseId: number | string): Promise<Activity[]> {
  const data = await client.json<{ activities: Activity[] }>(`/api/courses/${id(courseId)}/activities`);
  if (!Array.isArray(data.activities)) throw new BadResponse("课程活动响应缺少 activities");
  return data.activities;
}

export function getActivity(client: Xuezai, activityId: number | string): Promise<Activity> {
  return client.json<Activity>(`/api/activities/${id(activityId)}`);
}

export function courseTree(modules: CourseModule[], activities: Activity[]) {
  const placed = new Set<number>();
  const sorted = <T extends { sort?: number }>(rows: T[]) => [...rows].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const tree = sorted(modules).map((module) => {
    const direct = activities.filter((a) => Number(a.module_id) === module.id && !a.syllabus_id);
    direct.forEach((a) => placed.add(a.id));
    const syllabuses = sorted(module.syllabuses ?? []).map((syllabus) => {
      const rows = activities.filter((a) => Number(a.module_id) === module.id && Number(a.syllabus_id) === syllabus.id);
      rows.forEach((a) => placed.add(a.id));
      return { ...syllabus, activities: sorted(rows) };
    });
    return { ...module, activities: sorted(direct), syllabuses };
  });
  return { modules: tree, unassigned: sorted(activities.filter((a) => !placed.has(a.id))) };
}

export async function getCourseContent(client: Xuezai, courseId: number | string) {
  const [modules, activities] = await Promise.all([listModules(client, courseId), listActivities(client, courseId)]);
  return { courseId: Number(id(courseId)), ...courseTree(modules, activities) };
}

// ----- 输出视图：课程、章节与活动只给名称、时间、说明和文件，平台原字段留在 API 层 -----

const ACTIVITY_TYPES: Record<string, string> = {
  material: "资料", homework: "作业", exam: "在线测验", online_video: "视频", web_link: "链接", page: "页面",
  forum: "讨论", questionnaire: "问卷", vote: "投票", lesson: "课堂",
};
export const activityType = (type: unknown) => ACTIVITY_TYPES[String(type ?? "")] ?? String(type ?? "");
const names = (rows: { name: string }[] | undefined) => (rows ?? []).map((r) => r.name);

export function courseRow(c: Course) {
  return { name: c.name, semester: c.semester?.name ?? null, teachers: names(c.instructors), link: courseLink(c.id) };
}

/** 活动的一行：说明（作业要求、页面正文）给全文，链接类给地址，附件给文件名。 */
export function activityRow(a: Activity) {
  const files = names(a.uploads);
  const description = typeof a.data?.description === "string" ? htmlToText(a.data.description) : "";
  const link = a.data?.link;
  return {
    title: a.title, type: activityType(a.type),
    ...(a.start_time ? { opensAt: beijingMinute(a.start_time) } : {}), ...(a.end_time ? { deadline: beijingMinute(a.end_time) } : {}),
    ...(description ? { description } : {}), ...(typeof link === "string" && link ? { link } : {}),
    ...(files.length ? { files } : {}),
  };
}

/** 课程详情：简介加章节树，每章列出其中的活动；空的章、节不占位。 */
export function courseView(c: Course, modules: CourseModule[], activities: Activity[]) {
  const outline = (c.course_outline as { comment_chinese?: { description?: unknown } } | null)?.comment_chinese?.description;
  const tree = courseTree(modules, activities);
  const rows = (list: Activity[]) => list.length ? { activities: list.map(activityRow) } : {};
  return {
    ...courseRow(c), department: (c.department as { name?: string } | null)?.name ?? null, startDate: c.start_date ?? null,
    ...(typeof outline === "string" && outline.trim() ? { outline: htmlToText(outline) } : {}),
    chapters: tree.modules.map((m) => ({ name: m.name, ...rows(m.activities),
      ...(m.syllabuses.length ? { sections: m.syllabuses.map((s) => ({ name: s.name, ...rows(s.activities) })) } : {}) })),
    ...(tree.unassigned.length ? { unassigned: tree.unassigned.map(activityRow) } : {}),
  };
}
