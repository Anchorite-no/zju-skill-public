/**
 * HTML → 纯文本的最小实现（不引入解析器）。用于通知正文、简介等富文本。
 * 块级标签换行、<br> 换行、去掉 script/style、解码常见实体、折叠空白。
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", hellip: "…", mdash: "—", ndash: "–", middot: "·", copy: "©" };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

const BLOCK = /<\/?(?:p|div|br|tr|li|h[1-6]|table|ul|ol|section|article|blockquote|pre|hr)\b[^>]*>/gi;

/** 富文本转纯文本：段落间空行，行内空白折叠，去掉首尾空白 */
export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<\/(td|th)>/gi, "\t").replace(BLOCK, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s).replace(/ /g, " ");
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 取 HTML 里全部链接（href / src），相对路径按 base 补全 */
export function extractLinks(html: string, base: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      out.push({ url: new URL(decodeEntities(m[1]!), base).href, text: htmlToText(m[2]!) });
    } catch {
      /* 非法 URL 跳过 */
    }
  }
  for (const m of html.matchAll(/<img\b[^>]*src=["']([^"']+)["']/gi)) {
    try {
      out.push({ url: new URL(decodeEntities(m[1]!), base).href, text: "[图片]" });
    } catch {
      /* 跳过 */
    }
  }
  return out;
}

/** <select id=X> 里的 option 列表 */
export function selectOptions(html: string, id: string): { value: string; label: string; selected: boolean }[] {
  const m = html.match(new RegExp(`<select\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</select>`, "i"));
  if (!m) return [];
  return [...m[1]!.matchAll(/<option\b([^>]*)value=["']([^"']*)["']([^>]*)>([^<]*)/gi)].map((o) => ({ value: o[2]!, label: decodeEntities(o[4]!).trim(), selected: /\bselected\b/i.test(o[1]! + o[3]!) }));
}
