import { command, str, num, type Command } from "../core/command.ts";
import { ConfigError } from "../core/errors.ts";
import { extractFile, extractUrl, checkDoc, setupDoc, toPdf, pdfPages, pdfFind, pdfImages, pdfRender } from "./index.ts";

// File names may contain commas, so lists use "|", as cc98 search keywords do.
const list = (value: string) => value.split("|").map(s => s.trim()).filter(Boolean);
const out = { description: "输出 PDF 路径，如按作业要求命名；省略时存到 data/output/doc，已有文件不覆盖" };

export const docCommands: Record<string, Command> = {
  text: command("PDF、Word、PPT、Excel（含 doc/ppt/xls 老格式）、HTML、文本转文字；给本地文件或链接，校内与 CC98 链接自动经 WebVPN，教务网附件自动登录。全文另存 Markdown", {
    file: { description: "本地文件路径" },
    url: { description: "文件链接，下载后提取" },
  }, async f => {
    const file = typeof f.file === "string" ? f.file : undefined, url = typeof f.url === "string" ? f.url : undefined;
    if (Boolean(file) === Boolean(url)) throw new ConfigError("请给 --file 或 --url 其中一个");
    return file ? extractFile(file) : extractUrl(url!);
  }),
  pdf: command("把图片（拍的作业、截图）、Word、PDF 按顺序合成一个 PDF；图片按拍摄方向转正", {
    file: { description: "输入文件，多个用 | 分隔，按给出的顺序排页", required: true },
    size: { description: "图片页面：a4 居中放在 A4 白页上，original 保持原图大小", choices: ["a4", "original"], default: "a4" },
    out,
  }, f => toPdf(list(str(f, "file")), str(f, "size"), f.out ? str(f, "out") : undefined), "local"),
  pages: command("从 PDF 取出指定页另存为新 PDF，如只发课本里习题那几页", {
    file: { description: "PDF 文件", required: true },
    pages: { description: "页码从 1 起，如 43-49,390-391", required: true },
    out,
  }, f => pdfPages(str(f, "file"), str(f, "pages"), f.out ? str(f, "out") : undefined), "local"),
  find: command("找关键词在 PDF 的哪几页，返回页码和上下文；扫描件没有文字层时查不到", {
    file: { description: "PDF 文件", required: true },
    keyword: { description: "关键词，多个用 | 分隔", required: true },
  }, f => pdfFind(str(f, "file"), list(str(f, "keyword"))), "local"),
  images: command("取出 PDF 里嵌入的原始图片（字帖、照片、扫描页），不经渲染、分辨率最高，按像素从大到小；一页常有底纹、水印等多张，发之前看一眼确认", {
    file: { description: "PDF 文件", required: true },
    pages: { description: "只取这些页，如 1 或 2-3；省略时取全部页" },
  }, f => pdfImages(str(f, "file"), f.pages ? str(f, "pages") : undefined), "local"),
  render: command("把 PDF 指定页渲染成 PNG（含文字和排版），用于看这页长什么样或发整页图；一次最多 30 页", {
    file: { description: "PDF 文件", required: true },
    pages: { description: "页码从 1 起，如 1 或 2-3", required: true },
    dpi: { description: "清晰度", type: "integer", default: 150, min: 50, max: 300 },
  }, f => pdfRender(str(f, "file"), str(f, "pages"), num(f, "dpi")), "local"),
  check: command("检查文档处理依赖（Python 包与 LibreOffice）", {}, () => checkDoc(), "local"),
  setup: command("把文档处理的 Python 依赖装到 data/tools/doc；LibreOffice 需按提示用系统包管理器安装", {}, () => setupDoc(), "local"),
};
