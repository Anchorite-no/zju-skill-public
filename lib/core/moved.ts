/**
 * 学校搬了家、旧地址又没有留跳转的网站：旧地址 → 现在的地址。表在同目录的 moved.json，加一行就多认一个。
 * 旧地址还印在学校的旧文件里，同学会照着去点（用户 2026-10-12 要的：都改成新的地址）。用在三处：
 *   命令结果里出现的旧地址换成现在的（output.ts 的 envelope）；
 *   请求旧地址时改去请求现在的（webvpn/transport.ts）；
 *   校园智能体里看网页的窗口打开旧地址时改开现在的（desktop/reader.cjs，读的是同一张表）。
 * from 写主机名，后面可以带一段路径（这段路径和它下面的都算）；学校自己已经跳转好的旧域名不用列。
 */
import path from "node:path";
import { paths } from "./paths.ts";
import { readJson } from "./fsjson.ts";

interface Entry { host: string; path: string; to: string; pattern: RegExp }

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 地址后面还跟着的那一截（路径、参数）到哪为止：空白、引号、括号、中文和中文标点都不算地址的一部分 */
const TAIL = String.raw`(?:[/?#][^\s"'<>()\[\]　-〿一-鿿＀-￯]*)?`;

let cache: Entry[] | undefined;
function entries(): Entry[] {
  if (cache) return cache;
  const rows = readJson<{ moved?: { from?: unknown; to?: unknown }[] }>(path.join(paths.root, "lib", "core", "moved.json"))?.moved ?? [];
  cache = rows.flatMap((row) => {
    if (typeof row.from !== "string" || typeof row.to !== "string") return [];
    const [host = "", ...rest] = row.from.toLowerCase().replace(/\/+$/, "").split("/"), tail = rest.length ? "/" + rest.join("/") : "";
    // 前面不能还连着别的主机名，后面不能还连着别的字（/sztz 不认 /sztzabc，主机名不认 x.cn.evil）
    const pattern = new RegExp(String.raw`(?<![\w.-])(?:https?://)?${escaped(host)}${tail ? escaped(tail) + String.raw`(?![\w-])` : String.raw`(?![\w.-])`}${TAIL}`, "gi");
    return host ? [{ host, path: tail, to: row.to, pattern }] : [];
  });
  return cache;
}

/** 一个地址是旧地址就给现在的地址，不是就原样返回。 */
export function currentUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `http://${url}`); } catch { return url; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
  const host = parsed.hostname.toLowerCase(), at = parsed.pathname.toLowerCase();
  return entries().find((entry) => host === entry.host && (!entry.path || at === entry.path || at.startsWith(entry.path + "/")))?.to ?? url;
}

/** 一段文字里出现的旧地址换成现在的地址。 */
export function currentText(text: string): string {
  let out = text;
  for (const entry of entries()) if (out.toLowerCase().includes(entry.host)) out = out.replace(entry.pattern, entry.to);
  return out;
}

/** 一个结果里所有字符串都过一遍 currentText；别的值原样。 */
export function currentAddresses<T>(value: T, depth = 0): T {
  if (typeof value === "string") return currentText(value) as T;
  if (depth > 20 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => currentAddresses(item, depth + 1)) as T;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, currentAddresses(item, depth + 1)])) as T;
}
