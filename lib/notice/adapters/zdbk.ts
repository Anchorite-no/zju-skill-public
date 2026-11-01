/**
 * 教务网通知公告（xtgl/xwgl），借用 zdbk 模块的会话。
 *
 * 列表：POST xtgl/xwgl_cxXwListAlltzgg.html?doType=query&gnmkdm=index（全部，2026-09-17 共 3804 条）
 *       表单 xwbt（标题模糊）、gglb（本科生院通知公告 | 各院系通知公告 | 空=全部）+ queryModel.*，
 *       默认排序 "sfzd desc, fbsj" desc（置顶优先，再按发布日期）；这里一律按 fbsj，旧置顶不挤掉新通知。
 * 列表里 xwbt 被截断到约 20 字并以 "..." 结尾，完整标题要看详情。
 * 详情：GET xtgl/xwgl_ckXw.html?xwbh=<id>&doType=save（HTML；doType=save 会把该条标为已读 sfyd=1）。
 *       有 fbdz（外链）的通知，前端直接跳外链，不走详情页。
 */
import path from "node:path";
import { MODULE, ZDBK_HOST, type Zdbk } from "../../zdbk/client.ts";
import { decodeEntities } from "../../core/html.ts";
import { BadResponse } from "../../core/errors.ts";
import { paths } from "../../core/paths.ts";
import { readJson, writeJson } from "../../core/fsjson.ts";
import { unwrapUrl } from "../../webvpn/client.ts";
import type { Context } from "../../webvpn/transport.ts";
import { attachmentDetail, isAttachment, parseArticle } from "../article.ts";
import { patiently } from "../read.ts";
import type { ListQuery, ListResult, Notice, NoticeDetail } from "../types.ts";

interface NoticeRow {
  xwbh: string;
  xwbt: string;
  fbr?: string;
  fbsj?: string;
  gglb?: string;
  sfzd?: string;
  fbdz?: string;
  [k: string]: unknown;
}

type Campus = () => Promise<Context>;
const truncated = (title: string) => /\.{3}$|…$/.test(title);

export function detailUrl(id: string): string {
  return `https://${ZDBK_HOST}/jwglxt/xtgl/xwgl_ckXw.html?xwbh=${encodeURIComponent(id)}&doType=save`;
}

function toNotice(r: NoticeRow): Notice {
  const title = decodeEntities(String(r.xwbt ?? "")).trim(), category = String(r.gglb ?? "");
  const n: Notice = { id: String(r.xwbh), title, titleTruncated: truncated(title), publisher: String(r.fbr ?? ""), date: String(r.fbsj ?? ""),
    source: category ? `教务网·${category}` : "教务网", sourceId: "zdbk", pinned: String(r.sfzd) === "1", url: detailUrl(String(r.xwbh)) };
  if (typeof r.fbdz === "string" && r.fbdz.trim()) n.externalUrl = new URL(decodeEntities(r.fbdz.trim()), n.url).href;
  return n;
}

async function listPage(z: Zdbk, opts: { keyword?: string; category: string; page: number }) {
  const r = await patiently((quick) => z.grid<NoticeRow>(z.url("xtgl/xwgl_cxXwListAlltzgg.html", MODULE.index), { xwbt: opts.keyword ?? "", gglb: opts.category }, { sort: "fbsj", order: "desc", page: opts.page, size: 50 }, quick));
  return { notices: r.items.map(toNotice), total: r.total, totalPages: r.totalPages };
}

/** 教务网详情，或它指向的外站页面。id 为空表示只有链接。 */
export async function getNotice(z: Zdbk, id: string, opts: { url?: string; title?: string }, campus: Campus): Promise<NoticeDetail> {
  const url = opts.url ?? detailUrl(id);
  if (isAttachment(url)) return attachmentDetail(id, url, opts.title);
  // 详情页重取没有别的影响：doType=save 只是把这条标为已读
  let res = await patiently((quick) => z.get(url, quick));
  // WebPlus explicitly redirects off-campus readers to this page. Retry only this
  // observed campus restriction, through the existing VPN transport; no preflight.
  const denied = new URL(res.url), parent = denied.searchParams.get("parentUrl");
  if (denied.hostname.endsWith(".zju.edu.cn") && denied.pathname === "/nopermit_zjusub.jsp" && parent) {
    const target = new URL(parent);
    if (/^https?:$/.test(target.protocol) && target.hostname === denied.hostname && target.pathname !== denied.pathname) res = await (await campus()).fetchFollow(target.href);
  }
  if (res.status !== 200) throw new BadResponse(`通知详情 HTTP ${res.status}`, { id });
  const final = unwrapUrl(res.url), d = parseArticle(id, res.body, final);
  // 一部分院系通知的详情页直接跳到学院官网
  if (new URL(final).hostname !== ZDBK_HOST || new URL(final).pathname !== "/jwglxt/xtgl/xwgl_ckXw.html") { d.external = true; d.externalUrl = final; }
  return d;
}

/** Scan pages internally; date sorting prevents old pinned notices hiding newer notices. */
async function noticeRows(z: Zdbk, category: string, keyword: string | undefined, q: ListQuery) {
  const found: Notice[] = [], seen = new Set<string>();
  for (let page = 1; page <= 1000; page++) {
    const r = await listPage(z, { ...(keyword ? { keyword } : {}), category, page });
    for (const n of r.notices) {
      if (!n.id || seen.has(n.id)) throw new BadResponse("通知分页出现重复或缺少标识，不能确认检索完整");
      seen.add(n.id);
      if (q.until && n.date.slice(0, 10) > q.until) continue;
      if (q.since && n.date.slice(0, 10) < q.since) return { notices: found, hasMore: false };
      found.push(n);
      if (found.length > q.limit) return { notices: found.slice(0, q.limit), hasMore: true };
    }
    if (seen.size >= r.total) return { notices: found, hasMore: false };
    if (!r.notices.length) throw new BadResponse("通知分页提前为空，结果不完整");
  }
  throw new BadResponse("通知检索分页超限");
}

// 教务网的标题检索只比对列表里那段被截断的标题（约前 24 字）：「关于…本科课程第三轮选课的通知」搜「选课」搜不到。
// 所以另取最近 RECENT_ROWS 条通知，用完整标题在本地再比一遍；完整标题要从详情页取，取过的记在缓存里。
const RECENT_ROWS = 100;
const detailMemo = new Map<string, NoticeDetail>();
const titleCacheFile = () => path.join(paths.cache(), "zdbk-notice-titles.json");

/** 把截断的标题换成完整标题；取不到的保持原样 */
export async function withFullTitles(z: Zdbk, notices: Notice[], campus: Campus): Promise<Notice[]> {
  const cache = readJson<Record<string, string>>(titleCacheFile()) ?? {};
  const missing = notices.filter(n => n.titleTruncated && !cache[n.id]);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, missing.length) }, async () => {
    for (;;) {
      const n = missing[next++]; if (!n) return;
      try {
        const d = await getNotice(z, n.id, { ...(n.externalUrl ? { url: n.externalUrl } : {}), title: n.title }, campus);
        detailMemo.set(n.id, d);
        // 详情页给不出标题的（外链、纯附件）记下截断标题，免得每次重取。
        cache[n.id] = d.contentStatus !== "unavailable" && d.title ? d.title : n.title;
      } catch { /* 取不到完整标题的仍按截断标题比对 */ }
    }
  }));
  if (missing.length) writeJson(titleCacheFile(), cache);
  return notices.map(n => cache[n.id] && cache[n.id] !== n.title ? { ...n, title: cache[n.id]!, titleTruncated: false } : n);
}

async function recentByFullTitle(z: Zdbk, category: string, q: ListQuery, campus: Campus): Promise<Notice[]> {
  const rows: Notice[] = [];
  for (let page = 1; rows.length < RECENT_ROWS; page++) {
    const r = await listPage(z, { category, page });
    rows.push(...r.notices);
    if (!r.notices.length || page >= r.totalPages) break;
  }
  const inRange = rows.filter(n => (!q.since || n.date.slice(0, 10) >= q.since) && (!q.until || n.date.slice(0, 10) <= q.until));
  return (await withFullTitles(z, inRange, campus)).filter(n => q.terms.some(t => n.title.includes(t)));
}

/** categories 是来源表里选中的通知类别；两类都选时不按类别筛。 */
export async function listZdbk(z: Zdbk, categories: string[], q: ListQuery, campus: Campus): Promise<ListResult> {
  const category = categories.length === 1 ? categories[0]! : "";
  const [byTerm, recent] = await Promise.all([
    Promise.all((q.terms.length ? q.terms : [undefined]).map(keyword => noticeRows(z, category, keyword, q))),
    q.terms.length ? recentByFullTitle(z, category, q, campus) : [],
  ]);
  const seen = new Set<string>();
  // 本地比对出的条目带完整标题，排在前面以便去重时留下它。
  const found = [...recent, ...byTerm.flatMap(r => r.notices)].filter(n => !seen.has(n.id) && seen.add(n.id)).sort((a, b) => b.date.slice(0, 10).localeCompare(a.date.slice(0, 10)));
  return { notices: found.slice(0, q.limit), hasMore: byTerm.some(r => r.hasMore) || found.length > q.limit };
}

export function zdbkDetail(z: Zdbk, n: Notice, campus: Campus): Promise<NoticeDetail> {
  const memo = detailMemo.get(n.id);
  return memo ? Promise.resolve(memo) : getNotice(z, n.sourceId === "zdbk" ? n.id : "", { url: n.externalUrl ?? n.url, title: n.title }, campus);
}
