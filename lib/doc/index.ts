/**
 * 通用文档转文字：本地文件或链接 → 文字。供所有模块下载到的 PDF、Word、PPT、Excel 等使用。
 * 另有 PDF 处理：图片、Word、PDF 合成一个 PDF，取出指定页，找关键词所在页。
 *
 * Python 依赖（pypdf、openpyxl、xlrd、olefile、Pillow）装在 data/tools/doc/.venv，由 `zju doc setup` 安装；
 * DOC、RTF、ODT、WPS、ODS 需要系统里的 LibreOffice（soffice，只用 Writer 与 Calc）；PPT 用 olefile 直接读。均在本机执行，不走智云远程执行机。
 * 链接下载：*.zju.edu.cn 与 cc98.org 经 WebVPN，教务网附件使用教务网会话，其余直连。
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { paths } from "../core/paths.ts";
import { env } from "../core/env.ts";
import { BadResponse, ConfigError, ZjuError } from "../core/errors.ts";
import { log } from "../core/output.ts";
import type { HttpResponse } from "../core/http.ts";
import type { ModuleRequirements } from "../core/module.ts";
import { openContext } from "../webvpn/transport.ts";
import { unwrapUrl } from "../webvpn/client.ts";
import { openZdbk, ZDBK_HOST } from "../zdbk/client.ts";

export const PACKAGES = ["pypdf>=5,<7", "openpyxl>=3.1,<4", "xlrd>=2,<3", "olefile>=0.46,<1", "Pillow>=10,<13", "PyMuPDF>=1.24,<2"];
const INLINE_CHARS = 20_000;
const LIBREOFFICE_HINT = "Ubuntu：sudo apt install --no-install-recommends libreoffice-writer-nogui libreoffice-calc-nogui；Windows：安装 LibreOffice";
const CAMPUS = ["zju.edu.cn", "cc98.org"];

interface Page { page: number; title?: string; text: string }
interface Extracted { status: "text" | "no_text" | "unsupported" | "error"; format: string; pages: Page[]; reason: string | null; convertedVia?: string }

export function docPython(): string {
  return env("ZJU_DOC_PYTHON") || path.join(paths.data(), "tools", "doc", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(process.stderr); child.stderr.pipe(process.stderr);
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new ZjuError("BAD_RESPONSE", `${path.basename(executable)} 退出 ${code}`)));
  });
}

async function python<T>(args: string[], script = "extract.py"): Promise<T> {
  const executable = docPython();
  if (!await exists(executable)) throw new ZjuError("DEPENDENCY_MISSING", "文档解析环境尚未安装", { hint: "zju doc setup" });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const child = spawn(executable, ["-X", "utf8", path.join(paths.root, "scripts", "doc", script), ...args], {
      cwd: paths.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONUTF8: "1" },
    });
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
      if (stdout.length > 40 * 1024 * 1024) { child.kill(); reject(new BadResponse("文档提取输出过大")); }
    });
    child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-2000); });
    child.once("error", reject);
    child.once("close", code => {
      try { resolve(JSON.parse(stdout) as T); } catch { reject(new BadResponse("文档提取脚本未返回有效 JSON", { exitCode: code, stderr })); }
    });
  });
}

export async function checkDoc() {
  const venv = docPython();
  if (!await exists(venv)) return { ready: false, python: null, hint: "zju doc setup" };
  const info = await python<Record<string, unknown>>(["--check"]);
  return { ready: Boolean(info.pdf && info.xlsx && info.xls && info.ppt && info.images && info.render), ...info, pythonPath: venv, ...(info.libreoffice ? {} : { libreofficeHint: LIBREOFFICE_HINT }) };
}

/** 在 data/tools/doc 建独立环境并安装 Python 依赖；LibreOffice 属系统软件，只检查并给出安装方法 */
export async function setupDoc() {
  const executable = docPython();
  if (!env("ZJU_DOC_PYTHON") && !await exists(executable)) {
    const venv = path.dirname(path.dirname(executable));
    await fs.mkdir(path.dirname(venv), { recursive: true });
    log(`创建文档解析环境：${venv}`);
    await run(process.platform === "win32" ? "python" : "python3", ["-m", "venv", venv]);
  }
  await run(executable, ["-m", "pip", "install", "--disable-pip-version-check", "-q", ...PACKAGES]);
  return { installed: PACKAGES, ...await checkDoc() };
}

function outputDir(key: string): string {
  return path.join(paths.output(), "doc", crypto.createHash("sha256").update(key).digest("hex").slice(0, 12));
}

function markdown(name: string, result: Extracted): string {
  const multi = result.pages.length > 1;
  const body = result.pages.map(p => multi || p.title ? `## ${p.title ? `工作表 ${p.title}` : `第 ${p.page} 页`}\n\n${p.text}` : p.text).join("\n\n");
  return `# ${name}\n\n${body}\n`;
}

/** 本地文件转文字；全文另存 Markdown，结果内联前 2 万字 */
export async function extractFile(file: string, source?: string) {
  const absolute = path.resolve(file);
  const stat = await fs.stat(absolute).catch(() => undefined);
  if (!stat?.isFile()) throw new ConfigError(`文件不存在：${absolute}`);
  const result = await python<Extracted>([absolute]);
  const name = path.basename(absolute);
  const text = markdown(name, result).trimEnd();
  const dir = outputDir(source ?? absolute);
  await fs.mkdir(dir, { recursive: true });
  const md = path.join(dir, `${name}.md`);
  if (result.pages.length) await fs.writeFile(md, text + "\n", "utf8");
  const chars = result.pages.reduce((sum, p) => sum + p.text.length, 0);
  const out = {
    file: absolute, ...(source ? { source } : {}), format: result.format, status: result.status,
    pageCount: result.pages.length, chars, ...(result.convertedVia ? { convertedVia: result.convertedVia } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.pages.length ? { markdown: md, text: text.length > INLINE_CHARS ? text.slice(0, INLINE_CHARS) : text } : {}),
    ...(text.length > INLINE_CHARS ? { truncated: true, note: `正文较长，这里只给前 ${INLINE_CHARS} 字，全文见 markdown 文件` } : {}),
  };
  if (result.status === "error") throw new BadResponse(`文档提取失败：${result.reason ?? "未知错误"}`, { file: absolute });
  return out;
}

const TYPES: [RegExp, string][] = [
  [/pdf/, ".pdf"], [/wordprocessingml/, ".docx"], [/msword/, ".doc"], [/spreadsheetml/, ".xlsx"], [/ms-excel/, ".xls"],
  [/presentationml/, ".pptx"], [/ms-powerpoint/, ".ppt"], [/html/, ".html"], [/text\/plain/, ".txt"], [/csv/, ".csv"],
];

function decodeName(raw: string): string {
  let name = raw;
  try { name = decodeURIComponent(raw); } catch { /* 保留原值 */ }
  // 服务器常把 UTF-8 或 GBK 文件名按字节放进头部，Node 按 latin1 读出
  if (/[\u0080-ÿ]/.test(name) && !/[^\u0000-ÿ]/.test(name)) {
    const bytes = Buffer.from(name, "latin1");
    const utf8 = bytes.toString("utf8");
    name = utf8.includes("�") ? new TextDecoder("gb18030").decode(bytes) : utf8;
  }
  return name;
}

function filenameOf(res: HttpResponse, url: URL): string {
  const cd = String(res.headers["content-disposition"] ?? "");
  const star = cd.match(/filename\*\s*=\s*(?:utf-8|UTF-8)''([^;]+)/)?.[1];
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/)?.[1];
  let name = star ? decodeName(star) : plain ? decodeName(plain) : decodeName(path.posix.basename(url.pathname));
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(-120) || "download";
  if (!path.extname(name) || /\.(htm|html|aspx|jsp|php)$/i.test(name) && !/html/.test(res.contentType)) {
    const ext = TYPES.find(([re]) => re.test(res.contentType.toLowerCase()))?.[1];
    if (ext) name = name.replace(/\.(htm|html|aspx|jsp|php)$/i, "") + ext;
  }
  return name;
}

async function download(url: URL): Promise<HttpResponse> {
  const host = url.hostname.toLowerCase();
  if (host === ZDBK_HOST) {
    const z = await openZdbk();
    try { return await z.get(url.href); } finally { z.close(); }
  }
  const campus = CAMPUS.some(h => host === h || host.endsWith("." + h));
  const requirements: ModuleRequirements = { name: "doc", title: "文档下载", hosts: campus ? CAMPUS : [], auth: "none", network: campus ? "campus" : "public", writes: false };
  const ctx = await openContext(requirements, { timeout: 60_000 });
  try { return await ctx.fetchFollow(url.href); } finally { ctx.close(); }
}

/** 下载链接指向的文件并转文字 */
export async function extractUrl(link: string) {
  let url: URL;
  try { url = new URL(link); } catch { throw new ConfigError("链接不是有效 URL"); }
  if (!/^https?:$/.test(url.protocol)) throw new ConfigError("只支持 HTTP(S) 链接");
  const res = await download(url);
  if (res.status !== 200) throw new ZjuError(res.status === 404 || res.status === 403 ? "REMOTE_REJECTED" : "BAD_RESPONSE", `下载失败 HTTP ${res.status}`, { detail: { url: link } });
  if (!res.raw.length) throw new ZjuError("REMOTE_REJECTED", "下载内容为空，源文件可能已不存在", { detail: { url: link } });
  const finalUrl = new URL(unwrapUrl(res.url));
  if (finalUrl.hostname === "webvpn.zju.edu.cn" && /\/login/.test(finalUrl.pathname)) throw new ZjuError("AUTH_EXPIRED", "WebVPN 要求重新登录", { hint: "zju webvpn session login" });
  const dir = outputDir(link);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, filenameOf(res, url));
  await fs.writeFile(file, res.raw);
  log(`已下载 ${path.basename(file)}（${res.raw.length} 字节）`);
  return extractFile(file, link);
}

// PDF 处理：scripts/doc/pdf_tool.py，改自机主的交互式工具 pdf_tool，改为参数调用、输出 JSON。

async function pdfTool<T extends object>(args: string[]): Promise<T> {
  const r = await python<T & { error?: string; input?: boolean }>(args, "pdf_tool.py");
  if (r.error) throw r.input ? new ConfigError(r.error) : new BadResponse(`PDF 处理失败：${r.error}`);
  return r;
}

async function inputFile(file: string): Promise<string> {
  const absolute = path.resolve(file);
  const stat = await fs.stat(absolute).catch(() => undefined);
  if (!stat?.isFile()) throw new ConfigError(`文件不存在：${absolute}`);
  return absolute;
}

/** 明确给出的输出路径不覆盖已有文件；省略时按输入存到 data/output/doc/<哈希>/ */
async function outputFile(out: string | undefined, key: string, name: string, inputs: string[]): Promise<string> {
  let target: string;
  if (out) {
    target = path.resolve(out);
    if (await exists(target)) throw new ConfigError(`输出文件已存在：${target}`);
  } else target = path.join(outputDir(key), name);
  if (inputs.includes(target)) throw new ConfigError("输出文件不能与输入相同");
  await fs.mkdir(path.dirname(target), { recursive: true });
  return target;
}

const stem = (file: string) => path.basename(file, path.extname(file));

/** 图片、Word、PDF 按给出的顺序合成一个 PDF；图片按 EXIF 转正，默认居中放在 A4 页上 */
export async function toPdf(files: string[], size: string, out?: string) {
  if (!files.length) throw new ConfigError("需要 --file");
  const inputs = await Promise.all(files.map(inputFile));
  const name = inputs.length > 1 ? `${stem(inputs[0]!)}等${inputs.length}个文件.pdf` : `${stem(inputs[0]!)}.pdf`;
  const target = await outputFile(out, JSON.stringify(["pdf", size, ...inputs]), name, inputs);
  const r = await pdfTool<{ out: string; pages: number; bytes: number; inputs: unknown[] }>(["combine", target, size, ...inputs]);
  return { file: r.out, pages: r.pages, bytes: r.bytes, inputs: r.inputs };
}

/** 从 PDF 取出指定页另存为新 PDF */
export async function pdfPages(file: string, pages: string, out?: string) {
  const input = await inputFile(file);
  const label = pages.replace(/[^\d,-]/g, "").slice(0, 60);
  const target = await outputFile(out, JSON.stringify(["pages", input, pages]), `${stem(input)}_第${label}页.pdf`, [input]);
  const r = await pdfTool<{ out: string; pages: number[]; totalPages: number; bytes: number }>(["pages", input, pages, target]);
  return { file: r.out, pages: r.pages, pageCount: r.pages.length, totalPages: r.totalPages, bytes: r.bytes };
}

/** 找关键词在 PDF 的哪几页，每页附一段上下文；每个关键词最多列 50 页 */
export async function pdfFind(file: string, keywords: string[]) {
  if (!keywords.length) throw new ConfigError("需要 --keyword");
  const input = await inputFile(file);
  const r = await pdfTool<{ totalPages: number; textPages: number; matches: Record<string, { page: number; snippet: string }[]> }>(["find", input, ...keywords]);
  const matches = Object.fromEntries(Object.entries(r.matches).map(([keyword, hits]) => [keyword, { count: hits.length, hits: hits.slice(0, 50) }]));
  return { file: input, totalPages: r.totalPages, textPages: r.textPages, matches, ...(r.textPages ? {} : { note: "没有文字层，可能是扫描件；未做 OCR" }) };
}

/** 取出 PDF 里嵌入的原始图片（字帖、照片、扫描页），按像素从大到小；省略 pages 时取全部页 */
export async function pdfImages(file: string, pages?: string) {
  const input = await inputFile(file);
  const dir = path.join(outputDir(JSON.stringify(["images", input, pages ?? ""])), "images");
  await fs.mkdir(dir, { recursive: true });
  const r = await pdfTool<{ outDir: string; totalPages: number; images: unknown[]; skippedSmall: number }>(["images", input, pages ?? "", dir]);
  return { file: input, ...r, ...(r.images.length ? {} : { note: "没有可取的嵌入图片；页面可能是矢量绘制或文字，用 doc render 渲染整页" }) };
}

/** 把 PDF 指定页渲染成 PNG（含文字和排版），一次最多 30 页 */
export async function pdfRender(file: string, pages: string, dpi: number) {
  const input = await inputFile(file);
  const dir = path.join(outputDir(JSON.stringify(["render", input, pages, dpi])), "render");
  await fs.mkdir(dir, { recursive: true });
  const r = await pdfTool<{ outDir: string; totalPages: number; dpi: number; pages: unknown[] }>(["render", input, pages, String(dpi), dir]);
  return { file: input, ...r };
}
