/**
 * 学校订购的电子图书：有没有某本书的电子版、在哪个平台，给出平台上的直达地址。只查找，不下载、不打开全文。
 * 两个来源并在一起：
 *
 * 一、图书馆电子书刊导航（图书馆主页「电子图书」入口，Serials Solutions 360）。文泉学堂、科学文库、书递和各外文平台的书目都在里面。
 *   请求：GET /?V=1.0&N=<每页条数>&tab=BOOKS&L=GK4PB6YY8Y&S=<方式>&C=<词>，翻页加 &sortby=SB_T&B=<起始>
 *     S：A_T_B 标题开头为、A_T_M 标题等于、T_W_A 标题包含所有词、I_M ISBN 等于。
 *     含汉字的书名用「包含所有词」35 秒没有响应（2026-10-07 实测四个词都如此），所以中文按开头匹配，不含汉字的开头匹配不够数时再按包含所有词补。
 *     每页 100 条要 10 秒以上，20 条约 2.7 秒，所以一页取 20 条。
 *   页面：每条是一个 div.SS_Holding：书名 .SS_JournalTitle>strong、.SS_BookISBN、.SS_Edition、.SS_Authors、.SS_Publisher、.SS_Date；
 *     a.SS_JournalHyperLink 的文字是平台名，地址是 /log?…&U=<平台上的地址>。条目总数在 .SS_ResultsCount。结果按书名排序。
 *
 * 二、超星电子书（www.sslibrary.com，汇雅）。导航的书目里没有它，所以单独查。
 *   请求：GET /book/search/do?sw=<词>&field=<1 书名|2 作者|6 目录|all 全文>&page=1&pagesize=<n>，返回 JSON {success, data:{result,total,maxpage}}。
 *     书名是包含匹配，正好补上导航对中文只能按开头匹配的不足。没有单独的 ISBN 字段，但 field=all 能按 ISBN 找到（带不带连字符都行）。
 *   每本书的页面：/book/card?cnFenlei=…&ssid=…&d=<bookCardD>&isFromBW=…&websiteId=…；只带 ssid 会报 500。
 *   阅读方式看来源标记（和它的结果页模板一致）：isFromNewLib 或 isFromZX 有 EPUB 阅读，isFromBW 有 PDF 阅读，isFromBK 有图像阅读。
 *
 * 声明：auth=none network=campus。两个站都按 IP 认证：校外出口分别被转到 Serials Solutions 的登录页和超星的登录页，所以经 WebVPN。
 * 同一本书在几个平台各有一条，按 ISBN 合并。
 */
import type { ModuleRequirements } from "../core/module.ts";
import { openContext, type Context } from "../webvpn/transport.ts";
import { BadResponse, ConfigError, TransportError } from "../core/errors.ts";
import { decodeEntities } from "../core/html.ts";

export const HOST = "gk4pb6yy8y.search.serialssolutions.com";
const BASE = `https://${HOST}/`, LIBRARY = "GK4PB6YY8Y", PAGE = 20, MAX_PAGES = 6;
const CHAOXING = "https://www.sslibrary.com", CHAOXING_SITE = "383503", NAVIGATOR_NAME = "电子书刊导航", CHAOXING_NAME = "超星电子书";
export const requirements: ModuleRequirements = { name: "ebook", title: "学校订购的电子图书（电子书刊导航与超星电子书）", hosts: [HOST, "sslibrary.com"], auth: "none", network: "campus", writes: false };

/** 图书馆数据库导航页对这几个平台写明的用法（2026-10-07 摘录）；没写明的平台不加说明 */
const ACCESS: Record<string, string> = {
  科学文库: "要先在平台注册并登录，登录后可以下载",
  书递: "用统一身份认证登录，校内外都能打开；在线阅读，每本限 5 人同时",
};

const text = (html: string | undefined) => decodeEntities((html ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const cjk = (s: string) => /\p{Script=Han}/u.test(s);
const isbn13 = (value: unknown) => { const digits = String(value ?? "").replace(/[^\dXx]/g, ""); return digits.length === 13 ? digits : undefined; };

interface Link { platform: string; url: string; access?: string }
interface Record_ { title: string; isbn?: string; author?: string; edition?: string; publisher?: string; year?: string; links: Link[] }
const record = (r: { title: string; isbn?: string | undefined; author?: string | undefined; edition?: string | undefined; publisher?: string | undefined; year?: string | undefined; links: Link[] }): Record_ =>
  ({ title: r.title, ...(r.isbn ? { isbn: r.isbn } : {}), ...(r.author ? { author: r.author } : {}), ...(r.edition ? { edition: r.edition } : {}), ...(r.publisher ? { publisher: r.publisher } : {}), ...(r.year ? { year: r.year } : {}), links: r.links });

// ---------- 电子书刊导航 ----------

function parseNavigator(html: string): { records: Record_[]; total: number } {
  if (/Serials Solutions Authentication Service/.test(html)) throw new BadResponse("电子书刊导航要求登录：这次请求不是从学校的地址出去的");
  const count = /class="SS_ResultsCount"[^>]*>\s*(\d+)/.exec(html)?.[1];
  if (count === undefined) throw new BadResponse("电子书刊导航没有返回检索结果页");
  const records = html.split(/<div class="SS_Holding">/).slice(1).flatMap((block): Record_[] => {
    const part = (name: string) => text(new RegExp(`class="${name}"[^>]*>([\\s\\S]*?)</span>`).exec(block)?.[1]) || undefined;
    const title = text(/class="SS_JournalTitle"[^>]*>\s*<strong>([\s\S]*?)<\/strong>/.exec(block)?.[1]);
    const links = [...block.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*class="SS_JournalHyperLink"[^>]*>([\s\S]*?)<\/a>/g)].flatMap((m): Link[] => {
      const target = /[?&](?:amp;)?U=([^&"]+)/.exec(m[1]!)?.[1], platform = text(m[2]);
      try { return target ? [{ platform, url: decodeURIComponent(target), ...(ACCESS[platform] ? { access: ACCESS[platform] } : {}) }] : []; } catch { return []; }
    });
    if (!title || !links.length) return [];
    // 「(7-302-62729-0, 978-7-302-62729-6)」取 13 位的那个；个别记录的号码缺位，不足 13 位的不要。日期有的只写年，有的是「02/01/2019」
    const isbn = (part("SS_BookISBN") ?? "").replace(/[()]/g, "").split(/,\s*/).map(isbn13).find(Boolean);
    return [record({ title, isbn, author: part("SS_Authors"), edition: part("SS_Edition"), publisher: part("SS_Publisher"), year: /\d{4}/.exec(part("SS_Date") ?? "")?.[0], links })];
  });
  return { records, total: Number(count) };
}

// ---------- 超星电子书 ----------

interface ChaoxingBook {
  bookName?: string; author?: string; publisher?: string; date?: string; isbn?: string; ssid?: string; bookCardD?: string; cnFenlei?: string;
  isFromNewLib?: boolean; isFromZX?: boolean; isFromBW?: boolean; isFromBK?: boolean; isFromHW?: boolean;
}

function chaoxingRecord(b: ChaoxingBook): Record_[] {
  const title = (b.bookName ?? "").replace(/\s+/g, " ").trim();
  if (!title || !b.ssid || !b.bookCardD) return [];
  const formats = [b.isFromNewLib || b.isFromZX ? "EPUB" : "", b.isFromBW ? "PDF" : "", b.isFromBK ? "图像" : ""].filter(Boolean);
  const url = `${CHAOXING}/book/card?cnFenlei=${encodeURIComponent(b.cnFenlei ?? "")}&ssid=${b.ssid}&d=${b.bookCardD}&isFromBW=${b.isFromBW ?? ""}&fromType=&websiteId=${CHAOXING_SITE}`;
  return [record({ title, isbn: isbn13(b.isbn), author: b.author?.trim(), publisher: b.publisher?.replace(/^[^：:]*[：:]\s*/, "").trim(), year: /^\d{4}/.exec(b.date ?? "")?.[0],
    links: [{ platform: CHAOXING_NAME, url, ...(formats.length ? { access: `在线阅读（${formats.join("、")}）` } : {}) }] })];
}

// ---------- 会话 ----------

export class Ebook {
  readonly ctx: Context;
  constructor(ctx: Context) { this.ctx = ctx; }

  /** 两个站都慢而稳：超时放宽，连接出错时重发一次 */
  private async get(url: string, headers: Record<string, string> = {}): Promise<string> {
    const once = () => this.ctx.fetchFollow(url, { headers });
    const res = await once().catch((err: unknown) => { if (err instanceof TransportError) return once(); throw err; });
    if (res.status !== 200) throw new BadResponse(`${new URL(url).hostname} HTTP ${res.status}`);
    return res.body;
  }

  /** 导航的一页结果 */
  async navigator(mode: string, term: string, offset: number): Promise<{ records: Record_[]; total: number }> {
    return parseNavigator(await this.get(`${BASE}?V=1.0&N=${PAGE}&tab=BOOKS&L=${LIBRARY}&S=${mode}&C=${encodeURIComponent(term)}${offset ? `&sortby=SB_T&B=${offset}` : ""}`));
  }

  /** 超星检索：field 为 1 按书名，all 是全文（按 ISBN 找书用它） */
  async chaoxing(term: string, field: "1" | "all", size: number): Promise<{ records: Record_[]; total: number }> {
    const body = await this.get(`${CHAOXING}/book/search/do?sw=${encodeURIComponent(term)}&allsw=&bCon=&field=${field}&searchtype=&page=1&pagesize=${size}`, { Referer: `${CHAOXING}/book/search` });
    let reply: { success?: boolean; data?: { result?: ChaoxingBook[]; total?: number } };
    try { reply = JSON.parse(body); } catch { throw new BadResponse(/登录页|showlogin/.test(body) ? "超星电子书要求登录：这次请求不是从学校的地址出去的" : "超星电子书没有返回检索结果"); }
    if (!reply.success || !Array.isArray(reply.data?.result)) throw new BadResponse("超星电子书的检索结果格式不对");
    return { records: reply.data.result.flatMap(chaoxingRecord), total: Number(reply.data.total ?? 0) };
  }

  close(): void { this.ctx.close(); }
}

export async function openEbook(): Promise<Ebook> {
  return new Ebook(await openContext(requirements, { timeout: 30_000 }));
}

// ---------- 查找 ----------

/** 同一本书在几个平台各有一条：按 ISBN 合并，没有 ISBN 的按书名、著者、出版社合并 */
function merge(records: Record_[]) {
  const books = new Map<string, Record_>();
  for (const r of records) {
    const key = r.isbn ?? [r.title, r.author ?? "", r.publisher ?? ""].join("|").toLowerCase(), had = books.get(key);
    if (!had) { books.set(key, { ...r, links: [...r.links] }); continue; }
    for (const field of ["author", "edition", "publisher", "year"] as const) if (!had[field] && r[field]) had[field] = r[field];
    for (const link of r.links) if (!had.links.some((x) => x.url === link.url)) had.links.push(link);
  }
  return [...books.values()].map((b) => ({ title: b.title, ...(b.author ? { author: b.author } : {}), ...(b.publisher ? { publisher: b.publisher } : {}), ...(b.year ? { year: b.year } : {}),
    ...(b.edition ? { edition: b.edition } : {}), ...(b.isbn ? { isbn: b.isbn } : {}), platforms: b.links }));
}
/** 两个来源的结果轮流取，免得一个来源把条数占满 */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((list) => i < list.length); i++) for (const list of lists) if (i < list.length) out.push(list[i]!);
  return out;
}

export interface EbookQuery { title?: string; isbn?: string; limit?: number }

/** 学校订购的电子图书里有没有这本书、在哪个平台 */
export async function searchEbooks(e: Ebook, q: EbookQuery) {
  const title = q.title?.trim(), isbn = q.isbn?.trim(), limit = q.limit ?? 10;
  if (Boolean(title) === Boolean(isbn)) throw new ConfigError("--title 和 --isbn 给一个");
  if (isbn && !/^[\dXx -]{10,17}$/.test(isbn)) throw new ConfigError("ISBN 应为 10 位或 13 位数字，可以带连字符");
  const term = isbn ?? title!;

  /** 导航：一种匹配方式读到够数为止。结果按书名排序，所以先按开头匹配，以这几个字开头的书排在最前 */
  const fromNavigator = async () => {
    const records: Record_[] = [];
    const scan = async (mode: string) => {
      let total = 0, read = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const got = await e.navigator(mode, term, page * PAGE);
        total = got.total; read += got.records.length; records.push(...got.records);
        if (!got.records.length || page * PAGE + PAGE >= total || merge(records).length > limit) break;
      }
      return { total, more: read < total };
    };
    let { total, more } = await scan(isbn ? "I_M" : "A_T_B"), matchedBy = isbn ? "ISBN" : "书名开头";
    // 不含汉字的书名，开头匹配不够数时再按「包含全部词」补；含汉字的这样查导航站不响应
    if (!isbn && !cjk(term) && merge(records).length < limit) {
      const wider = await scan("T_W_A");
      total = Math.max(total, wider.total); more = more || wider.more; matchedBy = "书名开头，不够时按书名包含全部词";
    }
    return { records, total, more, matchedBy };
  };
  // 超星按 ISBN 走的是全文检索，只留 ISBN 确实相同的
  const fromChaoxing = async () => {
    if (!isbn) return e.chaoxing(term, "1", Math.min(Math.max(limit, 10), 40));
    const wanted = isbn.replace(/[^\dXx]/g, ""), same = (await e.chaoxing(term, "all", 10)).records.filter((r) => r.isbn === wanted);
    return { records: same, total: same.length };
  };

  const [nav, cx] = await Promise.allSettled([fromNavigator(), fromChaoxing()]);
  if (nav.status === "rejected" && cx.status === "rejected") throw nav.reason;
  const reason = (r: PromiseRejectedResult) => r.reason instanceof Error ? r.reason.message : String(r.reason);
  const sourceErrors = [...(nav.status === "rejected" ? [{ source: NAVIGATOR_NAME, error: reason(nav) }] : []), ...(cx.status === "rejected" ? [{ source: CHAOXING_NAME, error: reason(cx) }] : [])];
  const navigator = nav.status === "fulfilled" ? nav.value : undefined, chaoxing = cx.status === "fulfilled" ? cx.value : undefined;
  const books = merge(interleave([navigator?.records ?? [], chaoxing?.records ?? []]));
  const total = (navigator?.total ?? 0) + (chaoxing?.total ?? 0);
  return { books: books.slice(0, limit), count: Math.min(books.length, limit),
    found: { ...(navigator ? { [NAVIGATOR_NAME]: navigator.total } : {}), ...(chaoxing ? { [CHAOXING_NAME]: chaoxing.total } : {}) },
    hasMore: books.length > limit || Boolean(navigator?.more) || (chaoxing ? chaoxing.total > chaoxing.records.length : false),
    matchedBy: isbn ? "ISBN" : `${NAVIGATOR_NAME}按${navigator?.matchedBy ?? "书名开头"}，${CHAOXING_NAME}按书名包含`,
    ...(sourceErrors.length ? { sourceErrors } : {}),
    note: "这是学校订购的电子图书：platforms 是有这本书全文的平台，url 是它在平台上的地址，在校内网络或登录学校 WebVPN 后用浏览器打开，阅读或下载在平台上进行。"
      + "access 是这个平台上怎么看，没有这一项的平台按它页面上的提示操作。found 是两个来源各自查到的条数，导航里同一本书在几个平台各算一条。"
      + (sourceErrors.length ? "sourceErrors 里的来源这次没查到，结果只来自另一个来源。" : "")
      + (total === 0 && !sourceErrors.length ? "没有结果说明学校订购的电子图书里没有按这个写法登记的书，不代表没有纸质书；中文书名在导航里只按开头匹配，可以换个写法或用 --isbn 再试。" : "") };
}
