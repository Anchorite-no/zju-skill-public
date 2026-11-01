import { command, group, retired, sessionCommands, str, num, bool, type Command, type Option, type Flags } from "../core/command.ts";

import { credentials } from "../profile/profile.ts";
import { API, openZhiyun, session, type Zhiyun } from "./client.ts";
import { findCourses, playbackAssets } from "./courses.ts";
import { selectQuality } from "./quality.ts";
import { slides, transcript, searchCaptions } from "./materials.ts";
import { acquire } from "./acquire.ts";
import { localCommands } from "./local-cli.ts";
import { startLive, stopLive, liveStatus, liveText } from "./live-task.ts";
import { selectionOptions, resolveSelection, selectedLessons, lessonRow, kinds } from "./selection.ts";
import { abbreviates, splitPhrases } from "../core/match.ts";
import { RemoteRejected } from "../core/errors.ts";
import { fileSize } from "../core/output.ts";
export { lessonSelectors } from "./selection.ts";

const fresh: Option = { description: "强制重新认证", type: "boolean" };
const integer = (description: string, value: number, min: number, max: number): Option => ({ description, type: "integer", default: value, min, max });
export function createZhiyunCommands(open: typeof openZhiyun = openZhiyun): Record<string, Command> {
  const withClient = async (f: Flags, work: (c: Zhiyun) => Promise<unknown>) => {
    const client = await open({ fresh: bool(f, "fresh") });
    try { return await work(client); } finally { client.close(); }
  };
  const courses = command("搜索课程，自动查完必要分页；直接返回课程、教师和学期", {
    scope: { description: "mine 只查我的课程，all 搜全站；省略时先查我的课程，没有匹配再搜全站", choices: ["mine", "all"] },
    keyword: { description: "课程名或其中一段，可用简称（计组）；几个说法用顿号分隔" }, teacher: { description: "教师名" },
    limit: integer("最多显示多少门课程", 20, 1, 200),
  }, f => withClient(f, async c => {
    const phrases = f.keyword ? splitPhrases(str(f, "keyword")) : [], by = f.teacher ? { teacher: str(f, "teacher") } : {};
    const collect = async (scope: string) => {
      const found = new Map<string, Awaited<ReturnType<typeof findCourses>>[number]>();
      for (const keyword of phrases.length ? phrases : [undefined]) {
        const rows = await findCourses(c, { scope, ...by, ...(keyword ? { keyword } : {}) }).catch((error: unknown) => {
          if (error instanceof RemoteRejected && error.message.includes("没有数据")) return [];
          throw error;
        });
        for (const row of rows) found.set(row.id, row);
      }
      return [...found.values()];
    };
    let scope = f.scope === undefined ? "mine" : str(f, "scope"), rows = await collect(scope);
    // 我的课程里按简称再找一遍（计组 → 计算机组成）。
    if (!rows.length && phrases.length && scope === "mine") rows = (await findCourses(c, { scope, ...by })).filter(r => phrases.some(p => abbreviates(p, r.title)));
    // Recordings are open to all students, so an unenrolled course is still a valid answer.
    if (!rows.length && f.scope === undefined && (phrases.length || f.teacher)) rows = await collect(scope = "all");
    return { scope, total: rows.length, courses: rows.slice(0, num(f, 'limit')).map(({ id, ...row }) => ({ ...row, courseId: id })) };
  }));
  const courseOf = async (c: Zhiyun, courseId: string) => {
    const detail = await c.json(API + "/courseapi/v3/multi-search/get-course-detail", { course_id: courseId });
    const title = (detail.data as { title?: unknown } | undefined)?.title;
    return typeof title === "string" ? title : undefined;
  };
  /** 结果开头说明是哪一门课：按名称定位的带教师和学期；同名课默认取了当前学期时写明。 */
  const heading = async (c: Zhiyun, selection: Awaited<ReturnType<typeof resolveSelection>>) => {
    const picked = "course" in selection ? selection.course : undefined, title = picked?.title ?? await courseOf(c, selection.courseId);
    return { ...(title ? { course: title } : {}), ...(picked ? { teacher: picked.teacher, term: picked.term } : {}),
      ...("otherTerms" in selection && selection.otherTerms ? { note: `同名课程还有另外 ${selection.otherTerms} 门（其他学期或教学班），这里取的是${selection.current ? "当前学期" : "最近一次开课"}的；要别的，用 zhiyun search courses 找到那一门的 courseId 写到 --course。` } : {}) };
  };
  const lessons = command("一门课的课次：第几次、日期与时间、能否回放、有哪些资源；按开课时间编号，含还没上的", { ...selectionOptions }, async f => {
    return withClient(f, async c => {
      const selection = await resolveSelection(f, false, c);
      const rows = await selectedLessons(c, selection);
      return { ...await heading(c, selection), count: rows.length, lessons: rows.map(lessonRow) };
    });
  });
  const resources = command("某几次课有哪些资源：回放视频、音频、课件、课堂截图张数、字幕句数；只查看，不下载", { ...selectionOptions, kind: { description: "只看哪些种类：video,audio,ppt,slides,subtitles，逗号分隔；默认全部", default: "all" } }, async f => {
    const requested = kinds(str(f, "kind"), true);
    return withClient(f, async c => {
      const selection = await resolveSelection(f, true, c);
      const rows = await selectedLessons(c, selection), items = [];
      for (const row of rows) {
        const available = requested.some(k => k === "video" || k === "audio") ? await playbackAssets(c, row) : row.assets;
        const resources: Record<string, unknown>[] = available.filter(a => requested.includes(a.kind === "courseware" ? "ppt" : a.kind as "video" | "audio")).map(a => ({ ...a, kind: a.kind === "courseware" ? "ppt" : a.kind }));
        // 课堂截图一节课几十张，只给张数；要图片用 download --kind slides。
        if (requested.includes("slides")) resources.push({ kind: "slides", count: (await slides(c, row.courseId, row.subId)).length });
        if (requested.includes("audio") && !available.some(a => a.kind === "audio") && selectQuality(available.filter(a => a.kind === "video"), 360)) resources.push({ kind: "audio", source: "下载时从视频里提取" });
        // 还没有字幕的课次站点是拒绝而不是给空表（下载那边同样处理）：记成 0 句，不让整条命令失败。
        if (requested.includes("subtitles")) resources.push({ kind: "subtitles", count: (await transcript(c, row.courseId, row.subId).catch((error: unknown) => {
          if (error instanceof RemoteRejected && error.message.includes("未查询到语音数据")) return [];
          throw error;
        })).length });
        items.push({ ...lessonRow(row), resources });
      }
      return { ...await heading(c, selection), count: items.length, lessons: items };
    });
  });
  const subtitles = command("在课程录播字幕里搜关键词（如老师有没有说点名、考试范围）：返回命中的课次、时间点和前后文；省略课次时搜全部有录像的课次", {
    ...selectionOptions, keyword: { description: "关键词，几个说法用顿号或竖线分隔，如 点名、签到、考勤", required: true },
  }, async f => {
    const keywords = splitPhrases(str(f, "keyword"));
    return withClient(f, async c => {
      const selection = await resolveSelection(f, false, c);
      const rows = (await selectedLessons(c, selection)).filter(row => row.playable);
      return { ...await heading(c, selection), keywords, lessonsWithRecording: rows.length, ...await searchCaptions(c, rows, keywords) };
    });
  });
  const search = group("找课程、看课次与资源、在录播字幕里搜老师说过的话；不下载", { courses, lessons, resources, subtitles });
  const download = command("下载课次的回放、音频、课件、课堂截图或字幕，返回本地路径；视频取 1080p，下载过的复用", { ...selectionOptions,
    kind: { description: "下载哪些：video,audio,ppt,slides,subtitles，逗号分隔", default: "ppt" },
    "audio-format": { description: "音频输出格式", choices: ["m4a", "wav", "mp3"], default: "m4a" },
    "out-dir": { description: "下载目录" },
    "dry-run": { description: "只列出将下载什么，不下载", type: "boolean" },
  }, async f => {
    const requested = kinds(str(f, "kind"));
    return withClient(f, async c => {
      const selection = await resolveSelection(f, true, c);
      const rows = await selectedLessons(c, selection);
      const head = await heading(c, selection), title = head.course;
      const controller = new AbortController(), abort = () => controller.abort();
      process.once("SIGINT", abort); process.once("SIGTERM", abort);
      try {
        const r = await acquire(c, rows, { kinds: requested, ...(title ? { title } : {}), ...(f["out-dir"] ? { outDir: str(f, "out-dir") } : {}),
          format: str(f, "audio-format") as "m4a" | "wav" | "mp3", threads: 4, retries: 2, timeoutMs: 120_000,
          dryRun: bool(f, "dry-run"), resume: true, signal: controller.signal });
        // 结果只列文件；哈希、来源键和课次编号在 manifest（download.json）里。outDir 供远程执行取回产物。
        const date = (n: number) => rows.find(l => l.lesson === n)?.startsAt?.slice(0, 10) ?? null;
        const skipped = r.skipped.map(s => ({ lesson: rows.find(l => l.subId === s.lessonId)?.lesson ?? null, kind: s.kind, reason: s.reason }));
        if (!("lessons" in r)) return { dryRun: true, ...head, outDir: r.outDir, planned: r.tasks.map(t => ({ lesson: t.lessonNumber, date: date(t.lessonNumber), kind: t.kind, path: t.path })), skipped };
        return { ...head, status: r.status, outDir: r.outDir, manifest: r.manifest,
          files: r.lessons.flatMap(l => l.files.map(file => ({ lesson: l.lessonNumber, date: date(l.lessonNumber), kind: file.kind, name: file.name, path: file.path, size: fileSize(file.bytes) }))), skipped };
      }
      finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
    });
  });
  const live = group("当天课堂实时字幕采集、状态、停止与文字窗口查询", {
    start: command("后台采集今天本人剩余课堂的官方字幕，末节结束后自动退出；重复调用复用当前任务", { course: { description: "只采集指定课程，省略时跟随当天本人剩余课次" } }, f => startLive(str(f, "course"))),
    status: command("查看后台采集状态、课程和最近字幕；连接成功不等于已有文字", {}, async () => liveStatus(), "local"),
    stop: command("停止当前后台字幕采集，保留已保存文字", {}, () => stopLive(), "local"),
    text: command("返回已保存的课堂文字窗口；未来部分由内部等待，缺失时段明确说明", {
      course: { description: "课程名；窗口对应多课时需要明确" }, at: { description: "北京时间 HH:mm[:ss]、日期时间或带时区 ISO，省略为现在" },
      before: integer("时刻之前多少秒", 300, 0, 3600), after: integer("时刻之后多少秒，未来部分自动等待", 0, 0, 3600),
    }, f => liveText({ ...(f.course ? { course: str(f, "course") } : {}), ...(f.at ? { at: str(f, "at") } : {}), before: num(f, "before"), after: num(f, "after") }), "local"),
  });
  const commands: Record<string, Command> = { search, download, live, ...localCommands,
    login: command("建立或复用学校认证", { fresh }, f => withClient(f, async c => ({ session: c.store.status() }))),
    status: command("查看本地会话", {}, async () => session(credentials().username).status(), "local"),
    logout: command("清除本地智云会话", {}, async () => ({ cleared: session(credentials().username).clear() }), "local"),
  };
  sessionCommands(commands, "zhiyun");
  for (const [name, replacement] of Object.entries({ courses: "zhiyun search courses", lessons: "zhiyun search lessons", catalogue: "zhiyun search lessons",
    "video-url": "zhiyun search resources --kind video,audio", materials: "zhiyun search resources --kind ppt,slides", transcript: "zhiyun download --kind subtitles",
    lecture: "zhiyun check / zhiyun trans audio / zhiyun trans ppt；其余内容交给 AI 按 references/zhiyun-notes-template.md 生成",
    "lecture-read": "直接读取转写输出文件", prepare: "zhiyun trans audio / zhiyun trans ppt", read: "直接读取转写输出文件", export: "AI 按模板直接生成 Markdown", notes: "AI 按 references/zhiyun-notes-template.md 直接生成 Markdown",
    "asr-check": "zhiyun check --component asr", "media-check": "zhiyun check --component media" })) commands[name] = retired(replacement);
  return commands;
}
export const zhiyunCommands = createZhiyunCommands();
