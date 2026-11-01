/**
 * 通知正文页解析，不分来源：教务网详情页、考试中心、网站群（webplus）和学院 CMS 的正文容器。
 * 按 DOM 提取完整嵌套结构；无可识别正文时明确标记摘要/不可用，不能把标题或 meta description 当全文。
 */
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { htmlToText, extractLinks } from "../core/html.ts";
import { BadResponse } from "../core/errors.ts";
import { unwrapUrl } from "../webvpn/client.ts";
import type { NoticeDetail } from "./types.ts";

export function isAttachment(url: string): boolean { return /file_download\.html|download(att|file)|\.(pdf|docx?|xlsx?|pptx?|zip|rar)(\?|$)/i.test(url); }

/** 列表条目直接指向文件时的正文记录 */
export function attachmentDetail(id: string, url: string, title?: string): NoticeDetail {
  const item = { url, text: title ?? "通知原始附件" };
  return { id, title: title ?? "附件通知", publisher: "", publishedAt: "", text: "该通知以附件发布，正文请读取原始附件。", url,
    links: [{ ...item, attachment: true }], attachments: [item], contentStatus: "attachment-only" };
}

/** url 是跟随重定向后的最终地址，相对链接按它补全。 */
export function parseArticle(id: string, html: string, url: string): NoticeDetail {
  type Node = DefaultTreeAdapterMap["node"];
  type Element = DefaultTreeAdapterMap["element"];
  const elements: Element[] = [];
  const walk = (node: Node) => { if ("tagName" in node) elements.push(node); if ("childNodes" in node) node.childNodes.forEach(walk); };
  walk(parse(html));
  const attr = (e: Element | undefined, name: string) => e?.attrs.find(a => a.name === name)?.value ?? "";
  const hasClass = (e: Element, cls: string) => attr(e, "class").split(/\s+/).includes(cls);
  const txt = (e: Element | undefined) => e ? htmlToText(serialize(e)) : "";
  const meta = (name: string) => attr(elements.find(e => e.tagName === "meta" && (attr(e, "name").toLowerCase() === name.toLowerCase() || attr(e, "property") === name)), "content");
  const inside = (outer: Node, inner: Element): boolean => outer === inner || ("childNodes" in outer && outer.childNodes.some(child => inside(child, inner)));
  // 教务网正文在 news_con；有的网站群模板把导航栏也叫 news_con（信息技术中心），这时以 wp_articlecontent 为准
  const newsCon = elements.find(e => hasClass(e, "news_con")), webplus = elements.find(e => hasClass(e, "wp_articlecontent"));
  const body = (newsCon && (!webplus || inside(newsCon, webplus)) ? newsCon : undefined)
    ?? elements.find(e => hasClass(e, "wp_articlecontent") || hasClass(e, "v_news_content") || attr(e, "id") === "vsb_content")
    ?? elements.find(e => hasClass(e, "col-lg-offset-2") && hasClass(e, "col-md-offset-1"))
    ?? elements.find(e => e.tagName === "article");
  // 网站群把不存在或无权查看的文章渲染成 200 的提示页
  const notice = elements.find(e => hasClass(e, "wp_error_msg"));
  if (!body && notice) throw new BadResponse(`页面提示：${txt(notice)}`, { id, url });
  const bodyHtml = body ? serialize(body) : "";
  // 网站群的文章窗口：标题和「发布者 / 来源 / 时间」一行都排在正文容器之前，各站 class 不同
  const articleWindow = elements.find(e => attr(e, "portletmode") === "simpleArticleAttri");
  const windowHtml = articleWindow ? serialize(articleWindow) : "";
  const cut = bodyHtml ? windowHtml.indexOf(bodyHtml) : -1, windowHead = cut > 0 ? windowHtml.slice(0, cut) : "";
  const windowTitle = [...windowHead.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(m => htmlToText(m[1]!)).find(Boolean) ?? "";
  const title = meta("ArticleTitle") || txt(elements.find(e => e.tagName === "h3" && hasClass(e, "text-center"))) || meta("og:title")
    || txt(elements.find(e => hasClass(e, "arti_title"))) || windowTitle || txt(elements.find(e => e.tagName === "title")) || txt(elements.find(e => e.tagName === "h1"));
  if (!title.replace(/​/g, "").trim()) throw new BadResponse("通知详情页缺少标题", { id, url });
  const headText = txt(elements.find(e => hasClass(e, "news_title1")) ?? elements.find(e => hasClass(e, "info") && /发布日期/.test(txt(e)))
    ?? elements.find(e => hasClass(e, "article-title") && /时间[:：]/.test(txt(e)))) || htmlToText(windowHead);
  const publisher = headText.match(/发布[人者][:：]\s*(.*?)(?=发布(?:时间|日期)|浏览[人次]数|$)/s)?.[1]?.trim() || meta("ArticleSource");
  const origin = headText.match(/来源[:：]\s*([^\s:：]+)/)?.[1];
  const time = headText.match(/(?:发布)?(?:时间|日期)[:：]\s*(\d{4}-[\d-]+(?:\s+[\d:]+)?|\d{4}年\d{1,2}月\d{1,2}日)/)?.[1] ?? "";
  const cn = time.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  const publishedAt = (cn ? `${cn[1]}-${cn[2]!.padStart(2, "0")}-${cn[3]!.padStart(2, "0")}` : time) || meta("PubDate");
  const text = body ? txt(body) : meta("description").trim();
  const links = extractLinks(bodyHtml, url).filter(l => /^https?:/.test(l.url)).map(l => ({ ...l, url: unwrapUrl(l.url), attachment: isAttachment(l.url) }));
  // webplus 用 <div pdfsrc="…"> 内嵌 PDF，没有 <a> 链接
  const embedded: Element[] = [];
  const collect = (node: Node) => { if ("tagName" in node && attr(node, "pdfsrc")) embedded.push(node); if ("childNodes" in node) node.childNodes.forEach(collect); };
  if (body) collect(body);
  for (const e of embedded) links.push({ url: unwrapUrl(new URL(attr(e, "pdfsrc"), url).href), text: "PDF 附件", attachment: true });
  const attachments = links.filter(l => l.attachment).map(({ url, text }) => ({ url, text }));
  return { id, title: title.replace(/​/g, "").trim(), publisher, publishedAt, ...(origin ? { origin } : {}), text, links, attachments, url,
    contentStatus: body && text ? "full" : body && attachments.length ? "attachment-only" : body && links.length ? "full" : text ? "summary-only" : "unavailable" };
}
