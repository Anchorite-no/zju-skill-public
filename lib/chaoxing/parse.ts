/** 超星页面解析：章节目录、章节卡片里的附件、资料栏的文件行。只处理文本，不发请求。 */
import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const isElement = (n: Node): n is Element => "tagName" in n;
const children = (n: Node): Node[] => ("childNodes" in n ? n.childNodes : []);
function* elements(root: Node): Generator<Element> {
  for (const child of children(root)) if (isElement(child)) { yield child; yield* elements(child); }
}
const attr = (e: Element, name: string) => e.attrs.find((a) => a.name === name)?.value ?? "";
const hasClass = (e: Element, name: string) => attr(e, "class").split(/\s+/).includes(name);
const textOf = (n: Node): string => (n.nodeName === "#text" ? (n as DefaultTreeAdapterMap["textNode"]).value : children(n).map(textOf).join(""));
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
function first(root: Node, test: (e: Element) => boolean): Element | undefined {
  for (const e of elements(root)) if (test(e)) return e;
  return undefined;
}
/** e 在 root 里被几层 tag 包着。 */
function nesting(e: Element, root: Node, tag: string): number {
  let count = 0;
  for (let p: Node | null = e.parentNode; p && p !== root; p = isElement(p) ? p.parentNode : null) if (isElement(p) && p.tagName === tag) count++;
  return count;
}

export interface Chapter {
  /** 知识点编号，取章节卡片用 */
  id: string;
  title: string;
  /** 从大章到本节的标题 */
  path: string[];
  locked: boolean;
}

/**
 * 章节目录（mycourse/studentcourse）：每个 div.chapter_unit 是一个大章，里面 id="cur<编号>" 的块是可以点开的节，
 * 节可以再嵌套（外面多一层 li）。
 */
export function parseChapters(html: string): Chapter[] {
  const doc = parse(html), out: Chapter[] = [], seen = new Set<string>();
  const scan = (root: Node) => {
    const head = first(root, (e) => hasClass(e, "catalog_name") && nesting(e, root, "li") === 0);
    const unit = head ? clean(textOf(head)) : "";
    const trail: string[] = [];
    for (const e of elements(root)) {
      const id = attr(e, "id").match(/^cur(\d+)$/)?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const number = first(e, (x) => hasClass(x, "catalog_sbar"));
      const label = number ? clean(textOf(number)) : "";
      const link = first(e, (x) => x.tagName === "a" && hasClass(x, "clicktitle"));
      const name = clean(link ? attr(link, "title") || textOf(link) : attr(e, "title")) || `章节 ${id}`;
      const title = label && !name.startsWith(label) ? `${label} ${name}` : name;
      const depth = nesting(e, root, "li");
      trail.length = Math.max(0, depth - 1);
      const path = depth === 0 ? [title] : [...(unit && unit !== title ? [unit] : []), ...trail, title];
      if (depth > 0) trail[depth - 1] = title;
      const tips = first(e, (x) => hasClass(x, "bntHoverTips"));
      out.push({ id, title, path, locked: /解锁|未开放/.test(tips ? textOf(tips) : "") });
    }
  };
  const units = [...elements(doc)].filter((e) => hasClass(e, "chapter_unit"));
  if (units.length) units.forEach(scan); else scan(doc);
  return out;
}

/** 从 start 处的 { 起取出配对完整的对象文本（跳过字符串里的括号）。 */
function objectAt(text: string, start: number): string | undefined {
  let depth = 0, quote = "";
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

export interface CardFile { objectId: string; name: string; size: number | null }

/**
 * 章节卡片（knowledge/cards）：页面脚本里 mArg = {attachments:[…]}，每个附件的 property 带 objectid、name、type（扩展名）。
 * found 为 false 表示这一页没有卡片（num 已经越过最后一张）。
 */
export function parseCards(html: string): { found: boolean; notOpen: boolean; files: CardFile[] } {
  const notOpen = /章节未开放/.test(html);
  for (const m of html.matchAll(/mArg\s*=\s*\{/g)) {
    const raw = objectAt(html, m.index + m[0].length - 1);
    let data: { attachments?: unknown } | undefined;
    try { data = raw ? JSON.parse(raw) as { attachments?: unknown } : undefined; } catch { continue; }
    if (!data || !Array.isArray(data.attachments)) continue;
    const files: CardFile[] = [];
    for (const item of data.attachments as Record<string, unknown>[]) {
      const p = (item?.property && typeof item.property === "object" ? item.property : {}) as Record<string, unknown>;
      const objectId = String(p.objectid ?? item?.objectId ?? "");
      if (!/^[0-9a-f]{32}$/i.test(objectId)) continue;
      let name = clean(String(p.name ?? p.title ?? ""));
      const ext = String(p.type ?? "").trim().toLowerCase();
      if (/^\.\w{1,8}$/.test(ext) && !name.toLowerCase().endsWith(ext)) name += ext;
      if (!name) continue;
      const size = Number(p.size);
      files.push({ objectId, name, size: Number.isFinite(size) && size > 0 ? size : null });
    }
    return { found: true, notOpen, files };
  }
  return { found: false, notOpen, files: [] };
}

/** onclick 里 fn('a','b',3,…) 的参数，去掉引号和转义。 */
function callArgs(source: string, fn: string): string[] {
  const at = source.indexOf(fn + "(");
  if (at < 0) return [];
  const args: string[] = [];
  let current = "", quote = "";
  for (let i = at + fn.length + 1; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) { if (ch === "\\" && i + 1 < source.length) current += source[++i]; else if (ch === quote) quote = ""; else current += ch; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ",") { args.push(current.trim()); current = ""; }
    else if (ch === ")") { args.push(current.trim()); return args; }
    else current += ch;
  }
  return args;
}

function decoded(value: string): string {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try { return decodeURIComponent(value); } catch { return value; }
}

export interface DataRow {
  dataId: string;
  name: string;
  /** 扩展名；afolder 为文件夹，tch-courseware 为「教师课件」入口 */
  type: string;
  objectId: string;
  downloadable: boolean;
  /** 页面显示的约数，如 14KB */
  size: string;
  /** 打开文件夹用的校验串，每一行各自带 */
  enc: string;
}

/** 资料栏一层（coursedata/stu-datalist）：每行一个 ul.dataBody_td；一页 30 行，总页数在 input#totalPages。 */
export function parseDataList(html: string): { rows: DataRow[]; totalPages: number } {
  const doc = parse(html), rows: DataRow[] = [];
  for (const ul of elements(doc)) {
    if (ul.tagName !== "ul" || !hasClass(ul, "dataBody_td")) continue;
    const call = [ul, ...elements(ul)].map((e) => attr(e, "onclick")).find((v) => v.includes("toOpen(")) ?? "";
    const args = callArgs(call, "toOpen");
    const size = first(ul, (e) => hasClass(e, "dataBody_size_stu"));
    rows.push({
      dataId: attr(ul, "id") || (args[2] ?? ""),
      name: clean(decoded(attr(ul, "dataname") || (args[0] ?? ""))),
      type: (attr(ul, "type") || (args[1] ?? "")).toLowerCase(),
      objectId: attr(ul, "objectid") || (args[4] ?? ""),
      downloadable: attr(ul, "isdown") !== "0",
      size: size ? clean(textOf(size)) : "",
      enc: args[9] ?? "",
    });
  }
  const pages = first(doc, (e) => e.tagName === "input" && attr(e, "id") === "totalPages");
  return { rows, totalPages: Math.max(1, Number(pages ? attr(pages, "value") : 1) || 1) };
}
