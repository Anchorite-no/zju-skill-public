/**
 * 搜索编排。CC98 服务端搜索只做标题子串匹配、只按最新排序、1 次/秒限流，也没有同义词/分词：
 * 搜"数据结构"搜不到"fds"。所以几种说法由调用方一次给全，这里串行限速查询、合并去重、排序。
 */
import type { Cc98Api, TopicSummary } from "./api.ts";
import { ConfigError } from "../core/errors.ts";
import { log } from "../core/output.ts";
import { splitPhrases } from "../core/match.ts";

export type SortKey = "relevance" | "recent" | "replies";

export interface SearchPlan {
  /** 每个元素是一次服务端查询；"A B" 表示标题同时含 A 和 B（服务端唯一支持的语法） */
  keywords: string[];
  boardId?: number;
  sort?: SortKey;
  /** 只保留最近 N 天有回复的 */
  withinDays?: number;
  limit?: number;
}

interface RankedTopic extends TopicSummary {
  /** 命中的查询词 */
  matched: string[];
  score: number;
}

const MAX_KEYWORDS = 10;
const PAGE_SIZE = 20;

const normalize = (v: string) => v.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export { splitPhrases };

/** --keyword 的写法：最多 10 个说法（每个是一次限速 1 秒的查询） */
export function parseKeywords(raw: string): string[] {
  const keywords = splitPhrases(raw);
  if (!keywords.length) throw new ConfigError("需要 --keyword 关键词");
  if (keywords.length > MAX_KEYWORDS) throw new ConfigError(`一次最多查 ${MAX_KEYWORDS} 个关键词（给了 ${keywords.length} 个），挑最可能出现在标题里的说法`);
  return keywords;
}

const daysAgo = (iso: string) => (Date.now() - (Date.parse(iso) || 0)) / 86400000;

/** 相关度：命中查询数为主，标题命中的查询词越多越靠前，再叠加热度与新鲜度做微调 */
function relevance(t: RankedTopic, keywords: string[]): number {
  const title = normalize(t.title);
  let score = t.matched.length * 100;
  for (const k of keywords) {
    // "A B" 语法拆开看标题里出现了几个
    const parts = normalize(k).split(" ").filter(Boolean);
    score += parts.filter((p) => title.includes(p)).length * 10;
    if (parts.length && title.startsWith(parts[0]!)) score += 5;
  }
  score += Math.log10((t.replyCount ?? 0) + 1) * 8 + Math.log10((t.hitCount ?? 0) + 1) * 3;
  const d = daysAgo(t.lastPostTime || t.time);
  return score + (d <= 7 ? 15 : d <= 30 ? 10 : d <= 180 ? 5 : d <= 365 ? 2 : 0);
}

/** 每个关键词取最新 20 条，串行执行（api 内部限速）；单个关键词失败不影响其它 */
export async function runSearch(api: Cc98Api, plan: SearchPlan): Promise<{ results: RankedTopic[]; queries: { keyword: string; fetched: number; error?: string }[]; total: number }> {
  const found = new Map<number, RankedTopic>();
  const queries: { keyword: string; fetched: number; error?: string }[] = [];
  for (const keyword of plan.keywords) {
    try {
      const topics = await api.search(keyword, { size: PAGE_SIZE, ...(plan.boardId !== undefined ? { boardId: plan.boardId } : {}) });
      log(`cc98 search "${keyword}"：${topics.length} 条`);
      queries.push({ keyword, fetched: topics.length });
      for (const t of topics) {
        const seen = found.get(t.id);
        if (seen) seen.matched.push(keyword);
        else found.set(t.id, { ...t, matched: [keyword], score: 0 });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`cc98 search "${keyword}" 失败：${error}`);
      queries.push({ keyword, fetched: 0, error });
    }
  }
  const kept = [...found.values()].filter((t) => plan.withinDays === undefined || daysAgo(t.lastPostTime || t.time) <= plan.withinDays);
  for (const t of kept) t.score = relevance(t, plan.keywords);
  const latest = (t: RankedTopic) => Date.parse(t.lastPostTime || t.time) || 0;
  const order: Record<SortKey, (a: RankedTopic, b: RankedTopic) => number> = {
    relevance: (a, b) => b.score - a.score || latest(b) - latest(a),
    recent: (a, b) => latest(b) - latest(a),
    replies: (a, b) => (b.replyCount ?? 0) - (a.replyCount ?? 0) || latest(b) - latest(a),
  };
  kept.sort(order[plan.sort ?? "relevance"]);
  return { results: kept.slice(0, plan.limit ?? 30), queries, total: kept.length };
}
