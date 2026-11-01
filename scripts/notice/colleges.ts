/**
 * 生成 lib/notice/colleges.json：学校主页的学院（系）名录 → 各学院官网 → 面向学生的通知类栏目。
 * 开发时运行，不属于日常命令；学院改版或栏目失效时重跑。只读，全部经 WebVPN。
 *
 *   node scripts/notice/colleges.ts              全部学院
 *   node scripts/notice/colleges.ts 计算机、控制   只重查名字含这些文字的学院，其余保留原结果
 *
 * 做法（不按学院写规则）：
 * 1. 名录：www.zju.edu.cn/xywxw/list.htm 页面脚本里的 list._college。
 * 2. 站点：学院首页常是语言选择页或跳转页，真正的中文站在 /xxcn、/chinese 之类的子路径下，有的另有办公网。
 *    中文栏目链接不少于 6 个的页面才算站点；选择页下取栏目最多的一个作主站，再加办公网。
 * 3. 栏目：站点导航里名字像通知的栏目逐个打开，用通用解析器读第一页，读得出条目的才算；
 *    面包屑（没有时用导航里的上级栏目）给出它挂在哪个栏目下。
 * 4. 取舍：去掉一年多没更新的、面向教职工或校外的（招聘、招生、校友、科研、新闻），去掉内容已被另一栏覆盖的。
 */
import fs from "node:fs";
import path from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { openContext } from "../../lib/webvpn/transport.ts";
import { unwrapUrl } from "../../lib/webvpn/client.ts";
import { decodeEntities } from "../../lib/core/html.ts";
import { paths } from "../../lib/core/paths.ts";
import { splitPhrases } from "../../lib/core/match.ts";
import { parseList } from "../../lib/notice/adapters/webplus.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const DIRECTORY = "https://www.zju.edu.cn/xywxw/list.htm";
const OUT = path.join(paths.root, "lib/notice/colleges.json");
/** 栏目名像通知的才打开看 */
const WANTED = /通知|公告|公示|提示|消息|本科|研究生|硕士|博士生|教务|教学|教育|培养|学生|学工|思政|团学|团委|评奖|评优|资助|奖助|奖学金|讲座|学术活动|学术报告|竞赛|就业|实习|交流|学籍|学位/;
/** 面向教职工或校外的，栏目名或上级栏目名里出现就不要；学生、本科、研究生名下的党建和就业招聘除外 */
const UNWANTED = /招聘|博士后|师资|教师|人事|人才(?!培养)|校友|工会|党建|党务|党委|纪检|科研|科学研究|学科建设|继续教育|因公|English|国际学生|留学生|实验室|委员会/i;
/** 不是在读学生的通知，只看栏目自己的名字（上级栏目叫「学生风采」「招生就业」「招生教育」的不算） */
const NOT_NOTICE = /招生|新闻|动态|风采|成果|获奖|概况|简介|介绍|下载|表格|名录|影集|方案|课程/;
const STUDENT = /学生|本科|研究生|硕士|博士生|学工|团学|就业/;
const CHINESE = /[一-鿿]/;
const STALE_DAYS = 400, MAX_COLUMNS = 12, MIN_LINKS = 6;

interface Page { url: string; html: string }
interface Link { name: string; parent?: string }
interface Found { base: string; id: string; path: string[]; office: boolean; total: number; latest: string; items: { id: string; date: string }[] }
interface CollegeColumn { base: string; id: string; name: string; audience: "all" | "undergrad" | "grad"; latest: string }
interface College { id: string; name: string; faculty: string; home: string; columns: CollegeColumn[] }
interface Catalog { generatedAt: string; colleges: College[]; skipped: { name: string; home: string; reason: string }[] }

const ctx = await openContext({ name: "notice-colleges", title: "学院官网盘点", hosts: ["zju.edu.cn"], auth: "none", network: "campus", writes: false }, { maxSockets: 8, timeout: 12_000 });
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
const daysAgo = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(Date.now() - n * 86_400_000);
const clean = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, "");
const isElement = (n: Node): n is Element => "tagName" in n;
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value ?? "";
const text = (n: Node): string => "value" in n ? n.value : isElement(n) && n.tagName !== "script" && n.tagName !== "style" ? n.childNodes.map(text).join("") : "";
const firstAnchor = (e: Element): Element | undefined => e.tagName === "a" ? e : e.childNodes.filter(isElement).map(firstAnchor).find(Boolean);

async function get(url: string) {
  for (let attempt = 0; ; attempt++) {
    try { return await ctx.fetchFollow(url); } catch (err) { if (attempt >= 2) throw err; await new Promise((r) => setTimeout(r, 700)); }
  }
}
/** 取页面，跟随 meta refresh（学院首页常用它跳到中文站） */
async function page(url: string): Promise<Page> {
  let res = await get(url), at = unwrapUrl(res.url);
  for (let hop = 0; hop < 2; hop++) {
    const refresh = res.body.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)/i)?.[1];
    if (!refresh) break;
    res = await get(new URL(decodeEntities(refresh.trim()), at).href); at = unwrapUrl(res.url);
  }
  return { url: at, html: res.body };
}

/** 本站的栏目链接：栏目地址（去掉 /list.htm）→ 栏目名和导航里的上级栏目名 */
function columnLinks(p: Page): Map<string, Link> {
  const host = new URL(p.url).hostname, out = new Map<string, Link>();
  const walk = (n: Node, items: Element[]) => {
    if (!isElement(n)) { if ("childNodes" in n) n.childNodes.forEach((c) => walk(c, items)); return; }
    if (n.tagName === "a" && attr(n, "href")) {
      let url: URL | undefined;
      try { url = new URL(unwrapUrl(new URL(attr(n, "href").trim(), p.url).href)); } catch { /* 非法链接 */ }
      const name = clean(text(n)) || clean(attr(n, "title"));
      if (url && url.hostname === host && /\/list\.(?:htm|psp)$/.test(url.pathname) && name && name.length <= 14) {
        const key = url.origin + url.pathname.replace(/\/list\.(?:htm|psp)$/, "");
        // 上级：由内到外第一个「首个链接不是自己」的 li
        const parent = [...items].reverse().map(firstAnchor).find((a) => a && a !== n);
        const parentName = parent ? clean(text(parent)) : "";
        if (!out.has(key)) out.set(key, { name, ...(parentName && parentName !== name && parentName.length <= 14 ? { parent: parentName } : {}) });
      }
    }
    const inner = n.tagName === "li" ? [...items, n] : items;
    n.childNodes.forEach((c) => walk(c, inner));
  };
  walk(parse(p.html), []);
  return out;
}
const chineseLinks = (p: Page) => [...columnLinks(p).values()].filter((l) => CHINESE.test(l.name)).length;

/** 学院的中文站点：主站，以及办公网（有的话） */
async function sites(home: string): Promise<{ page: Page; office: boolean }[]> {
  const start = await page(home), host = new URL(start.url).hostname, domain = host.replace(/^www\./, "");
  // 首页里指向本学院其他入口的地址：链接、跳转脚本都算
  const names = new Map<string, string>();
  for (const m of start.html.matchAll(/<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) { try { names.set(new URL(decodeEntities(m[2]!.trim()), start.url).href, clean(m[3]!)); } catch { /* 非法链接 */ } }
  const entries = new Map<string, string>();
  for (const m of start.html.matchAll(/(?:href|url|location(?:\.href)?)\s*[=:]\s*(["'])(.*?)\1/gi)) {
    let url: URL;
    try { url = new URL(unwrapUrl(new URL(decodeEntities(m[2]!.trim()), start.url).href)); } catch { continue; }
    if (!url.hostname.endsWith("zju.edu.cn") || !/^\/[\w-]*\/?(?:main\.(?:htm|psp))?$/.test(url.pathname)) continue;
    if (url.href.replace(/\/$/, "") !== start.url.replace(/\/$/, "") && !entries.has(url.href)) entries.set(url.href, names.get(url.href) ?? "");
  }
  const real = chineseLinks(start) >= MIN_LINKS;
  // 办公网：名字或地址写明的；选择页上指向另一个域名的入口也算（计算机学院的 cspo）。完整站点首页上的外站链接多是友情链接，不看
  const isOffice = (url: string, name: string) => /办公|内网|内部|院内/.test(name) || new URL(url).hostname.startsWith("office.") || /office|bgw?\/?(?:main\.\w+)?$/i.test(new URL(url).pathname)
    || (!real && new URL(url).hostname !== host && !new URL(url).hostname.endsWith("." + domain));
  // 已经是完整站点时只再看办公网入口；是选择页时每个入口都看
  const visit = [...entries].filter(([url, name]) => !real || isOffice(url, name)).slice(0, real ? 2 : 6);
  const opened: { page: Page; office: boolean; links: number }[] = [];
  for (const [url, name] of visit) {
    try {
      const p = await page(url), links = chineseLinks(p);
      if (links >= MIN_LINKS && p.url !== start.url && !opened.some((o) => o.page.url === p.url)) opened.push({ page: p, office: isOffice(url, name), links });
    } catch { /* 入口打不开就跳过 */ }
  }
  const main = real ? { page: start, office: false } : opened.filter((o) => !o.office).sort((a, b) => b.links - a.links)[0];
  return [...(main ? [main] : []), ...opened.filter((o) => o.office)];
}

function breadcrumb(html: string): string[] {
  const at = html.indexOf("当前位置");
  if (at < 0) return [];
  const chunk = html.slice(at, at + 1500).split(/<\/(?:li|div|p|td)>/i)[0]!;
  return [...chunk.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => clean(m[1]!)).filter((n) => n && !/^(?:首页|Home|主页)$/i.test(n));
}

async function inspect(address: string, link: Link, office: boolean): Promise<Found | undefined> {
  const url = `${address}/list.htm`;
  try {
    const res = await get(url), list = parseList(res.body, url);
    if (!list.items.length) return undefined;
    const crumbs = breadcrumb(res.body);
    return { base: address.slice(0, address.lastIndexOf("/")), id: address.slice(address.lastIndexOf("/") + 1), office,
      path: crumbs.length ? crumbs : link.parent ? [link.parent, link.name] : [link.name], total: list.total,
      latest: list.items.map((i) => i.date).sort().at(-1)!, items: list.items.map((i) => ({ id: i.id, date: i.date })) };
  } catch (err) { unreadable.set(url, (err as Error).message); return undefined; }
}
/** 打不开或读不出条目的栏目地址 → 原因，排查用 */
const unreadable = new Map<string, string>();

/** a 的第一页时间范围内，b 的条目几乎都在 a 里：b 没有带来新内容 */
function covers(a: Found, b: Found): boolean {
  const oldest = a.items.map((i) => i.date).sort()[0]!, ids = new Set(a.items.map((i) => i.id));
  const recent = b.items.filter((i) => i.date >= oldest);
  return recent.length >= 3 && recent.filter((i) => ids.has(i.id)).length >= recent.length * 0.8;
}

function choose(found: Found[]): { kept: CollegeColumn[]; dropped: string[] } {
  const dropped: string[] = [], label = (f: Found) => f.path.join("·") + (f.office ? "（办公网）" : "");
  const live = found.filter((f) => {
    const names = f.path.join(" ");
    if (f.latest < daysAgo(STALE_DAYS)) { dropped.push(`${label(f)}（最新 ${f.latest}，已停更）`); return false; }
    if (NOT_NOTICE.test(f.path.at(-1)!) || (UNWANTED.test(names) && !(STUDENT.test(names) && /党建|招聘|就业/.test(names) && !/招生|人才(?!培养)|教师|博士后/.test(names)))) { dropped.push(`${label(f)}（非学生通知）`); return false; }
    return true;
  });
  // 条数多的先留：更可能是汇总栏
  const kept: Found[] = [];
  for (const f of [...live].sort((x, y) => y.total - x.total)) {
    const by = kept.find((k) => covers(k, f));
    if (by) dropped.push(`${label(f)}（内容已在「${label(by)}」里）`); else kept.push(f);
  }
  kept.sort((x, y) => y.latest.localeCompare(x.latest));
  for (const f of kept.splice(MAX_COLUMNS)) dropped.push(`${label(f)}（超过 ${MAX_COLUMNS} 栏，更新较少）`);
  // 栏目名：同名的带上上级栏目，还同名的标出办公网，再同名的编号
  const used = new Map<string, number>();
  const name = (f: Found) => {
    const short = f.path.at(-1)!, clash = (n: (k: Found) => string) => kept.filter((k) => n(k) === n(f)).length > 1;
    const two = (k: Found) => k.path.slice(-2).join("·"), three = (k: Found) => two(k) + (k.office ? "（办公网）" : "");
    const picked = !clash((k) => k.path.at(-1)!) ? short : !clash(two) ? two(f) : three(f), n = (used.get(picked) ?? 0) + 1;
    used.set(picked, n);
    return n === 1 ? picked : `${picked}${n}`;
  };
  return { dropped, kept: kept.map((f) => {
    const names = f.path.join(" ");
    return { base: f.base, id: f.id, name: name(f),
      audience: /本科/.test(names) && !/研究生|硕士|博士/.test(names) ? "undergrad" as const : /研究生|硕士|博士/.test(names) && !/本科/.test(names) ? "grad" as const : "all" as const, latest: f.latest };
  }) };
}

async function directory(): Promise<{ name: string; faculty: string; home: string }[]> {
  const html = (await get(DIRECTORY)).body, data = html.match(/list\._college\s*=\s*(\[[\s\S]*?\])\s*;?\s*<\/script>/)?.[1];
  if (!data) throw new Error("学校主页的学院名录结构变了：找不到 list._college");
  const out: { name: string; faculty: string; home: string }[] = [];
  let faculty = "";
  for (const m of data.matchAll(/id:\s*'(i[\d-]+)',\s*title:\s*'([^']*)',\s*link:\s*'([^']*)'/g)) {
    if (!m[1]!.includes("-")) faculty = m[2]!.trim(); else if (/^https?:/.test(m[3]!)) out.push({ name: m[2]!.trim(), faculty, home: m[3]!.split("?")[0]! });
  }
  return out;
}

async function survey(entry: { name: string; faculty: string; home: string }): Promise<{ college?: College; skipped?: Catalog["skipped"][number]; report: string }> {
  const skip = (reason: string) => ({ skipped: { name: entry.name, home: entry.home, reason }, report: `✗ ${entry.name}：${reason}` });
  let roots: Awaited<ReturnType<typeof sites>>;
  try { roots = await sites(entry.home); } catch (err) { return skip(`首页打不开：${(err as Error).message.slice(0, 60)}`); }
  if (!roots.length) return skip("没有找到网站群栏目（不是这套系统，或首页结构特殊）");
  const candidates = new Map<string, { link: Link; office: boolean }>();
  for (const root of roots) for (const [address, link] of columnLinks(root.page)) if (WANTED.test(link.name) && !candidates.has(address)) candidates.set(address, { link, office: root.office });
  const queue = [...candidates], found: Found[] = [];
  await Promise.all(Array.from({ length: 6 }, async () => { for (;;) { const next = queue.shift(); if (!next) return; const f = await inspect(next[0], next[1].link, next[1].office); if (f) found.push(f); } }));
  const { kept, dropped } = choose(found);
  if (!kept.length) {
    const failed = [...candidates.keys()].map((a) => unreadable.get(`${a}/list.htm`)).filter(Boolean), reasons = [...new Set(failed)].map((r) => `${r}×${failed.filter((f) => f === r).length}`);
    return skip(`打开了 ${candidates.size} 个栏目，读出 ${found.length} 个，没有留下可用的通知栏。${dropped.slice(0, 4).join("；")}${reasons.length ? `；读不出的原因：${reasons.join("、")}` : ""}（${roots.map((r) => r.page.url).join(" + ")}）`);
  }
  const host = new URL(roots[0]!.page.url).hostname, aud = { all: "通用", undergrad: "本科", grad: "研究生" };
  return { college: { id: host.replace(/^www\./, "").replace(/\.zju\.edu\.cn$/, ""), name: entry.name, faculty: entry.faculty, home: roots[0]!.page.url, columns: kept },
    report: `✓ ${entry.name}（${roots.map((r) => r.page.url + (r.office ? " 办公网" : "")).join(" + ")}）候选 ${candidates.size}，可读 ${found.length}，留 ${kept.length}\n    留：${kept.map((c) => `${c.name}[${aud[c.audience]} ${c.latest} ${c.base.replace(/^https?:\/\//, "")}/${c.id}]`).join("、")}\n    去：${dropped.join("；") || "无"}` };
}

const only = process.argv[2] ? splitPhrases(process.argv[2]) : [];
const previous: Catalog = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { generatedAt: "", colleges: [], skipped: [] };
try {
  const entries = await directory(), catalog: Catalog = { generatedAt: today, colleges: [], skipped: [] };
  const todo = [...entries], results = new Map<string, Awaited<ReturnType<typeof survey>>>();
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (;;) {
      const entry = todo.shift(); if (!entry) return;
      if (only.length && !only.some((p) => entry.name.includes(p))) continue;
      results.set(entry.name, await survey(entry));
      process.stderr.write(`\r${results.size} 个学院已查`);
    }
  }));
  process.stderr.write("\n");
  for (const entry of entries) {
    const r = results.get(entry.name);
    if (r) { console.log(r.report); if (r.college) catalog.colleges.push(r.college); else catalog.skipped.push(r.skipped!); continue; }
    const old = previous.colleges.find((c) => c.name === entry.name), oldSkip = previous.skipped.find((s) => s.name === entry.name);
    if (old) catalog.colleges.push(old); else if (oldSkip) catalog.skipped.push(oldSkip);
  }
  fs.writeFileSync(OUT, JSON.stringify(catalog, null, 1) + "\n");
  console.log(`\n${catalog.colleges.length} 个学院已收录，${catalog.skipped.length} 个未收录；共 ${catalog.colleges.reduce((n, c) => n + c.columns.length, 0)} 个栏目 → ${path.relative(paths.root, OUT)}`);
} finally { ctx.close(); }
