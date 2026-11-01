import { API, BASE, id, jsonContent, object, type Zhiyun } from "./client.ts";
import { BadResponse, RemoteRejected } from "../core/errors.ts";
import type { Asset, Caption, Lesson } from "./types.ts";

export async function slides(client: Zhiyun, courseId: string, subId: string): Promise<Asset[]> {
  const items: Asset[] = [], seen = new Set<string>();
  for (let page = 1; page <= 200; page++) {
    const j = await client.json(BASE + "/pptnote/v1/schedule/search-ppt", { course_id: id(courseId), sub_id: id(subId), page, per_page: 100 });
    if (!Array.isArray(j.list)) throw new BadResponse("PPT 响应缺少 list");
    let added = 0;
    for (const raw of j.list) {
      const row = object(raw), content = jsonContent(row.content), seconds = Number(row.created_sec ?? content.created ?? 0);
      if (typeof content.pptimgurl !== "string" || !/^https?:\/\//.test(content.pptimgurl) || !Number.isFinite(seconds) || seconds < 0) throw new BadResponse("PPT 时间轴字段无效");
      const key = `${seconds}:${content.pptimgurl}`;
      if (!seen.has(key)) { seen.add(key); added++; items.push({ kind: "slide", name: `slide-${String(items.length + 1).padStart(4, "0")}-${seconds}s.jpg`, url: content.pptimgurl, seconds }); }
    }
    const count = Number(j.total);
    if (!j.list.length || (Number.isSafeInteger(count) && count >= 0 && seen.size >= count)) return items.sort((a, b) => a.seconds! - b.seconds!);
    if (!added) throw new BadResponse("PPT 分页重复，未能取完时间轴");
  }
  throw new BadResponse("PPT 分页超过 200 页");
}
export function parseTranscript(value: unknown): Caption[] {
  const j = object(value); if (!Array.isArray(j.list)) throw new BadResponse("字幕响应缺少 list");
  const captions: Caption[] = [];
  for (const raw of j.list) {
    const row = object(raw);
    const entries = Array.isArray(row.all_content) ? row.all_content : [row];
    for (const rawEntry of entries) {
      const e = object(rawEntry), start = Number(e.BeginSec ?? e.start_time), end = e.EndSec == null ? null : Number(e.EndSec), text = e.Text ?? e.text;
      if (!Number.isFinite(start) || start < 0 || typeof text !== "string" || (end !== null && (!Number.isFinite(end) || end < start))) throw new BadResponse("字幕时间戳/文本无效");
      captions.push({ start, end, text });
    }
  }
  return captions.sort((a, b) => a.start - b.start);
}
export async function transcript(client: Zhiyun, courseId: string, subId: string): Promise<Caption[]> {
  return parseTranscript(await client.json(API + "/courseapi/v3/web-socket/search-trans-result", { sub_id: id(subId), format: "json" }, `${BASE}/livingroom?course_id=${id(courseId)}&sub_id=${subId}`));
}

const clock = (seconds: number) => {
  const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};
/** Keyword search over the site captions of the given lessons; each hit carries its neighbours so "点名" can be read in context. */
export async function searchCaptions(client: Zhiyun, lessons: Lesson[], keywords: string[], limit = 100) {
  const counts: Record<string, number> = Object.fromEntries(keywords.map(k => [k, 0]));
  const hits: { lesson: number; date: string | null; at: string; keywords: string[]; text: string }[] = [];
  const withoutCaptions: number[] = [];
  let searched = 0, total = 0;
  for (const lesson of lessons) {
    let captions: Caption[];
    try { captions = await transcript(client, lesson.courseId, lesson.subId); }
    catch (error) {
      // The site answers this for lessons whose speech has not been processed yet (e.g. today's class).
      if (error instanceof RemoteRejected && error.message.includes("未查询到语音数据")) { withoutCaptions.push(lesson.lesson); continue; }
      throw error;
    }
    if (!captions.length) { withoutCaptions.push(lesson.lesson); continue; }
    searched++;
    captions.forEach((caption, i) => {
      const found = keywords.filter(k => caption.text.includes(k));
      if (!found.length) return;
      total++;
      for (const k of found) counts[k]!++;
      if (hits.length < limit) hits.push({ lesson: lesson.lesson, date: lesson.startsAt?.slice(0, 10) ?? null, at: clock(caption.start), keywords: found,
        text: [captions[i - 1]?.text, caption.text, captions[i + 1]?.text].filter(Boolean).join(" ") });
    });
  }
  return { lessonsSearched: searched, lessonsWithoutCaptions: withoutCaptions, counts, total, hits, ...(total > hits.length ? { truncated: true } : {}) };
}
