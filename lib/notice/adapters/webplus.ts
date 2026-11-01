/**
 * 苏迪 webplus 网站群：学校主页、综合服务网、绝大多数部处官网和学院官网都是这一套。站点和栏目是数据（sources.ts、colleges.json），这里不按站分支。
 *
 * 列表：GET /<栏目>/list.htm，第 N 页 list<N>.htm；分页条 #wp_paging_w<n> 里有 all_pages、all_count、per_count、curr_page。
 * 条目：各站模板不同（li、div、tr 都有），共同点是分页条之前紧挨着的一组同级元素，每个里面有文章链接和日期。
 *       从分页条前最后一个链接往上找，第一层「同名兄弟元素不少于本页条数」的就是条目；条数由分页条算出，对不上就报错。
 *       日期可能是 2026-09-30、2026.09.30、22-09-05，只有 2026-09（日从文章地址取），或把日和年月拆成两个元素。
 * 文章：/<年>/<月日>/c<栏目>a<文章号>/page.htm，文章号全站群唯一；同一篇挂在几个栏目时栏目号不同、文章号相同。
 *       也有条目直接指向外站或附件。
 */
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { HttpResponse } from "../../core/http.ts";
import { BadResponse } from "../../core/errors.ts";
import { unwrapUrl } from "../../webvpn/client.ts";
import type { Column, ListQuery, ListResult, Notice, Source } from "../types.ts";

export type Get = (url: string) => Promise<HttpResponse>;
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

/** 给了起始日期时最多往回读的页数；只给关键词时少读一些 */
const SINCE_PAGES = 40, KEYWORD_PAGES = 12, UNORDERED_PAGES = 10;
/** 只给关键词时往回找多少天 */
const KEYWORD_DAYS = 365;
const BATCH = 4;

const SPACE = new RegExp(`[\\s${String.fromCharCode(0x200b, 0xa0)}]+`, "g");
const clean = (s: string) => s.replace(SPACE, " ").trim();
const isElement = (n: Node): n is Element => "tagName" in n;
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value ?? "";
const text = (n: Node): string => "value" in n ? n.value : isElement(n) && n.tagName !== "script" && n.tagName !== "style" ? n.childNodes.map(text).join("") : "";
const descendants = (e: Element): Element[] => e.childNodes.filter(isElement).flatMap((c) => [c, ...descendants(c)]);
const usable = (e: Element) => e.tagName === "a" && !/^(?:javascript:|#|$)/i.test(attr(e, "href").trim());

const iso = (y: string, m: string, d: string) => {
  const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31 && Number.isFinite(Date.parse(date)) ? date : undefined;
};
const daysAgo = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(Date.now() - n * 86_400_000);

/** 条目里的短文本（日期总是单独成段）→ 日期；年月、日分开放或只有年月时用文章地址里的日期补全 */
function dateOf(item: Element, url: string): string | undefined {
  const short = [item, ...descendants(item)].flatMap((e) => [clean(text(e)), ...e.childNodes.filter((n) => !isElement(n)).map((n) => clean(text(n)))])
    .filter((s) => s && s.length <= 24).map((s) => s.replace(/^[[(（【]\s*|\s*[\])）】]$/g, "").replace(/^(?:发布)?(?:时间|日期)\s*[:：]\s*/, ""));
  const find = (re: RegExp) => { for (const s of short) { const m = s.match(re); if (m) return m; } return undefined; };
  const full = find(/^(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?$/);
  if (full) return iso(full[1]!, full[2]!, full[3]!);
  const yy = find(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (yy) return iso(`20${yy[1]}`, yy[2]!, yy[3]!);
  const u = url.match(/\/(\d{4})\/(\d{2})(\d{2})\/c\w+a\d+\//), ym = find(/^(\d{4})[-./年](\d{1,2})月?$/), md = find(/^(\d{1,2})[-./月](\d{1,2})日?$/);
  if (ym) {
    const sameMonth = u && u[1] === ym[1] && Number(u[2]) === Number(ym[2]);
    const day = short.map((s) => s.match(/^(\d{1,2})日?$/)?.[1]).find((d) => d && Number(d) >= 1 && Number(d) <= 31);
    return iso(ym[1]!, ym[2]!, sameMonth ? u[3]! : day ?? "1");
  }
  if (md) { const year = find(/^(20\d{2})年?$/)?.[1] ?? u?.[1]; if (year) return iso(year, md[1]!, md[2]!); }
  return u ? iso(u[1]!, u[2]!, u[3]!) : undefined;
}

export interface WebplusItem { id: string; title: string; date: string; url: string }

function parseItem(item: Element, pageUrl: string): WebplusItem {
  const links = [item, ...descendants(item)].filter(usable);
  const main = links.find((a) => attr(a, "title").trim() || clean(text(a))) ?? links[0]!;
  const url = unwrapUrl(new URL(attr(main, "href").trim(), pageUrl).href), date = dateOf(item, url);
  const inside = [main, ...descendants(main)];
  // 标题：title 属性（链接上或里面的标题元素上）、链接里的标题元素或第一段、链接文字（日期写在链接里时去掉）
  const block = inside.find((e) => /^h[1-6]$/.test(e.tagName)) ?? inside.find((e) => e !== main && /tit|(?:^|[\s_-])bt/i.test(attr(e, "class"))) ?? inside.find((e) => e.tagName === "p");
  const title = clean(inside.map((e) => attr(e, "title")).find((t) => t.trim()) || (block ? text(block) : clean(text(main)).replace(/\s*\d{4}[-./]\d{1,2}[-./]\d{1,2}$/, "")));
  if (!title || !date) throw new BadResponse("栏目列表条目缺少标题或日期", { url: pageUrl, href: attr(main, "href") });
  return { id: articleId(url), title, date, url };
}

/** 文章号；外链和附件没有文章号，用链接本身 */
export function articleId(url: string): string {
  const id = url.match(/\/c\w+a(\d+)\/page\.(?:htm|psp)/)?.[1];
  return id ? `wp-${id}` : url;
}

export function parseList(html: string, pageUrl: string): { items: WebplusItem[]; pages: number; total: number } {
  if (!/id=["']wp_paging_w\d+["']/.test(html)) {
    const notice = html.match(/class="wp_error_msg"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    throw new BadResponse(notice ? `栏目页面提示：${clean(notice.replace(/<[^>]+>/g, " "))}` : "栏目列表页没有分页信息，无法确认条目范围", { url: pageUrl });
  }
  const count = (cls: string) => Number(html.match(new RegExp(`<em class="${cls}">(\\d+)</em>`))?.[1]);
  const pages = count("all_pages") || 1, total = count("all_count"), per = count("per_count"), current = count("curr_page") || 1;
  if (!Number.isFinite(total) || !Number.isFinite(per)) throw new BadResponse("栏目列表页缺少条数信息", { url: pageUrl });
  const expected = current < pages ? per : total - per * (pages - 1);
  if (expected <= 0) return { items: [], pages, total };
  // 按文档顺序收集链接，到最后一个分页条为止；分页条里面的翻页链接不算
  const before: Element[] = [];
  let anchors: Element[] = [];
  const walk = (n: Node) => {
    if (!isElement(n)) { if ("childNodes" in n) n.childNodes.forEach(walk); return; }
    if (/^wp_paging_w\d+$/.test(attr(n, "id"))) { before.push(...anchors); anchors = []; return; }
    if (usable(n)) anchors.push(n);
    n.childNodes.forEach(walk);
  };
  walk(parse(html));
  const last = before.at(-1), known = new Set(before);
  const holds = (e: Element) => known.has(e) || descendants(e).some((d) => known.has(d));
  let items: Element[] | undefined;
  for (let x: Element | undefined = last; x && !items; x = x.parentNode && isElement(x.parentNode) ? x.parentNode : undefined) {
    const parent = x.parentNode;
    if (!parent || !("childNodes" in parent)) break;
    const siblings = parent.childNodes.filter(isElement).filter((c) => c.tagName === x.tagName && holds(c));
    if (siblings.at(-1) !== x || siblings.length < expected) continue;
    // 链接本身并排时，只有日期写在链接里才是条目（整条通知包在一个链接里的模板）；本页只有一条时没有兄弟可比，取到能读出日期的那一层
    if (x.tagName === "a" || expected === 1 ? /^(?:li|tr|dd|dl|article)$/.test(x.tagName) || dateOf(x, pageUrl) : true) items = siblings.slice(-expected);
  }
  if (!items) throw new BadResponse("栏目列表里找不到与页面标注条数相符的条目", { url: pageUrl, expected });
  return { items: items.map((item) => parseItem(item, pageUrl)), pages, total };
}

/** 一个栏目里符合条件的条目，按日期由新到旧 */
export async function listColumn(get: Get, source: Source, column: Column, q: ListQuery): Promise<ListResult> {
  const base = column.base ?? source.base;
  const page = async (n: number) => {
    const url = `${base}/${column.id}/list${n === 1 ? "" : n}.htm`;
    return parseList((await get(url)).body, url);
  };
  const match = (i: WebplusItem) => (!q.since || i.date >= q.since) && (!q.until || i.date <= q.until) && (!q.terms.length || q.terms.some(t => i.title.includes(t)));
  const first = await page(1), rows = [...first.items];
  let read = 1, scannedTo: string | undefined, hasMore = false;
  if (column.unordered) {
    const rest = await Promise.all(Array.from({ length: Math.min(first.pages, UNORDERED_PAGES) - 1 }, (_, i) => page(i + 2)));
    rows.push(...rest.flatMap(p => p.items));
  } else {
    // 按时间排列（个别置顶或错位一两天）：以每页末尾几条的日期判断读到了哪里
    const floor = q.since ?? (q.terms.length ? daysAgo(KEYWORD_DAYS) : undefined), cap = q.since ? SINCE_PAGES : KEYWORD_PAGES;
    const tail = () => rows.slice(-3).map(i => i.date).sort().at(-1) ?? "";
    const enough = () => {
      const dates = rows.filter(match).map(i => i.date).sort().reverse();
      return dates.length >= q.limit && tail() < dates[q.limit - 1]!;
    };
    while (read < first.pages) {
      if (floor && tail() < floor) break;
      if (enough()) { hasMore = true; break; }
      if (read >= cap) { scannedTo = tail(); hasMore = true; break; }
      const batch = await Promise.all(Array.from({ length: Math.min(BATCH, first.pages - read, cap - read) }, (_, i) => page(read + 1 + i)));
      for (const p of batch) rows.push(...p.items);
      read += batch.length;
    }
  }
  const seen = new Set<string>();
  const notices: Notice[] = rows.filter(i => match(i) && !seen.has(i.id) && seen.add(i.id)).sort((a, b) => b.date.localeCompare(a.date))
    .map(i => ({ id: i.id, title: i.title, titleTruncated: false, publisher: source.name, date: i.date, source: `${source.name}·${column.name}`, sourceId: source.id, pinned: false, url: i.url }));
  return { notices: notices.slice(0, q.limit), hasMore: hasMore || notices.length > q.limit, ...(scannedTo ? { scannedTo } : {}) };
}
