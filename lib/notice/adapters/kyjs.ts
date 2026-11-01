/**
 * 竞赛管理系统（kyjs.zju.edu.cn）的新闻正文。本科生院实践交流栏的学科竞赛、大创条目外链到这里。
 * 页面是前端渲染，正文取 GET /prod-api/home/news/detail?newsId=，免登录，附件在 files[]（公网 OSS）。只在校内可解析。
 */
import { BadResponse } from "../../core/errors.ts";
import { htmlToText, extractLinks } from "../../core/html.ts";
import type { NoticeDetail } from "../types.ts";
import type { Get } from "./webplus.ts";

interface KyjsNews { title?: string; content?: string; publishTime?: string; accountName?: string; files?: { fileName?: string; fileUrl?: string }[] }

/** 不是 kyjs 新闻链接时返回 undefined */
export async function kyjsNotice(get: Get, url: string): Promise<NoticeDetail | undefined> {
  const u = new URL(url), newsId = u.searchParams.get("newsId");
  if (u.hostname !== "kyjs.zju.edu.cn" || !newsId) return undefined;
  const api = `${u.protocol}//${u.host}/prod-api/home/news/detail?newsId=${encodeURIComponent(newsId)}`;
  let body: { code?: number; msg?: string; data?: KyjsNews };
  try { body = JSON.parse((await get(api)).body); } catch { throw new BadResponse("竞赛管理系统通知详情不是 JSON", { url }); }
  const d = body.data;
  if (body.code !== 0 || !d?.title) throw new BadResponse(`竞赛管理系统通知详情读取失败：${body.msg ?? "无数据"}`, { url });
  const text = htmlToText(d.content ?? ""), files = (d.files ?? []).filter((f) => f.fileUrl).map((f) => ({ url: f.fileUrl!, text: f.fileName ?? "附件" }));
  const links = [...extractLinks(d.content ?? "", url).filter((l) => /^https?:/.test(l.url)).map((l) => ({ ...l, attachment: false })), ...files.map((f) => ({ ...f, attachment: true }))];
  return { id: url, title: d.title, publisher: d.accountName ?? "", publishedAt: d.publishTime ?? "", text, links, attachments: files,
    contentStatus: text ? "full" : files.length ? "attachment-only" : "unavailable", url };
}
