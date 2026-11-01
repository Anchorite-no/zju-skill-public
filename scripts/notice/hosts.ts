/**
 * 生成 lib/notice/hosts.json：通知模块用到的每个网站（来源表里的部门站，加各学院的官网和办公网）从校外能不能直接访问。
 * public 是公网可达，可以直连；campus 是只在校园网里，校外要经 WebVPN。cas 为真的是打开通知栏目要先过统一身份认证的。
 * 开发时运行，不属于日常命令；来源表或学院名录变了以后重跑。只读，每个网站只请求一个通知栏目的列表页。
 *
 *   node scripts/notice/hosts.ts --via server
 *
 * 判断不能在本机做：本机常有隧道（Clash、ZJU Connect）把流量带进校园网，测出来全是可达（见 lib/webvpn/README.md）。
 * 所以到一台不在校园网里的外部主机上用 curl 实测，--via 给 ~/.ssh/config 里的主机别名。
 * 判法：跟着跳转走到底，最后停在统一身份认证的登录页 → public 且 cas；最后是 200 → public；
 * 别的（连不上、超时、403、5xx，或者被网站群挡到「无权访问」页 nopermit_zjusub.jsp）→ campus。
 * 标成 public 只说明这个栏目的列表页校外看得到；同一个网站上个别只给校内看的文章，用到的地方各自处理（改走 WebVPN）。教务网不是网站群的站，只能测首页，首页不会跳去统一身份认证，
 * 但读它的通知要登录：这类有自己模块的来源，要不要统一身份认证取模块自己的声明（lib/<模块>/module.json 的 auth）。模块整体仍声明为 network=campus，
 * 表里 public 的主机列进 publicHosts 直连（lib/notice/index.ts、lib/webvpn/transport.ts）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { paths } from "../../lib/core/paths.ts";
import { SOURCES } from "../../lib/notice/sources.ts";

interface College { name: string; home: string; columns: { base: string; id: string }[] }
interface Probe { url: string; sites: Set<string> }
interface Result { status: number; final: string }
export interface HostNote { network: "public" | "campus"; cas: boolean; status: number; checked: string; sites: string[] }

const OUT = path.join(paths.root, "lib/notice/hosts.json");
const CAS_HOST = "zjuam.zju.edu.cn";
const SAFE_URL = /^https?:\/\/[a-z0-9.-]+(?::\d+)?\/[A-Za-z0-9_./-]*$/;

/** 每个主机挑一个通知栏目的列表页来测；只有首页的（教务网、学院首页）测首页 */
export function targets(): Map<string, Probe> {
  const colleges = JSON.parse(fs.readFileSync(path.join(paths.root, "lib/notice/colleges.json"), "utf8")).colleges as College[];
  const found = new Map<string, Probe>();
  const add = (url: string, site: string, listPage: boolean) => {
    const host = new URL(url).host, had = found.get(host);
    if (!had) found.set(host, { url, sites: new Set([site]) });
    else { had.sites.add(site); if (listPage && new URL(had.url).pathname === "/") had.url = url; }
  };
  for (const source of SOURCES) {
    const first = source.adapter === "webplus" ? source.columns[0] : undefined;
    add(first ? `${source.base}/${first.id}/list.htm` : `${source.base}/`, source.name, !!first);
  }
  for (const college of colleges) {
    for (const column of college.columns) add(`${column.base}/${column.id}/list.htm`, college.name, true);
    add(new URL("/", college.home).href, college.name, false);
  }
  return found;
}

/** 交给外部主机执行的脚本：八个一起测，每个地址输出一行「地址 状态码 最后停在的地址」 */
export function remoteScript(urls: string[]): string {
  for (const url of urls) if (!SAFE_URL.test(url)) throw new Error(`地址里有不该出现的字符，不拿去测：${url}`);
  return [
    `probe() { out=$(curl -k -s -L --max-redirs 6 -o /dev/null -m 12 -A 'Mozilla/5.0 zju-skill-probe' -w '%{http_code} %{url_effective}' "$1" 2>/dev/null); echo "$1 \${out:-000 -}"; }`,
    "export -f probe",
    `printf '%s\\n' ${urls.map((url) => `'${url}'`).join(" ")} | xargs -P 8 -I{} bash -c 'probe {}'`,
    "",
  ].join("\n");
}

/** 外部主机的输出 → 每个地址测到的结果 */
export function parseResults(output: string): Map<string, Result> {
  const results = new Map<string, Result>();
  for (const line of output.split("\n")) {
    const [url, status, final] = line.trim().split(/\s+/);
    if (url && status) results.set(url, { status: Number(status) || 0, final: final ?? "-" });
  }
  return results;
}

/** 有自己模块的来源（教务网）里，模块声明要统一身份认证的那些主机 */
export function declaredCas(): Set<string> {
  const hosts = new Set<string>();
  for (const source of SOURCES) {
    if (source.adapter === "webplus") continue;
    const declared = JSON.parse(fs.readFileSync(path.join(paths.root, "lib", source.adapter, "module.json"), "utf8")) as { auth?: string };
    if (declared.auth === "cas") hosts.add(new URL(source.base).host);
  }
  return hosts;
}

export function judge(result: Result | undefined): Pick<HostNote, "network" | "cas" | "status"> {
  if (!result) return { network: "campus", cas: false, status: 0 };
  let finalHost = "";
  try { finalHost = new URL(result.final).hostname; } catch { /* 没走到任何地址 */ }
  if (finalHost === CAS_HOST) return { network: "public", cas: true, status: result.status };
  // 网站群把校外读者挡到这一页，状态码也是 200。
  if (/\/nopermit_zjusub\.jsp$/.test(result.final.split("?")[0] ?? "")) return { network: "campus", cas: false, status: result.status };
  return { network: result.status === 200 ? "public" : "campus", cas: false, status: result.status };
}

/** 在外部主机上一次测完 */
function probeAll(urls: string[], target: string): Promise<Map<string, Result>> {
  const script = remoteScript(urls);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12", target, "bash", "-s"], { stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ssh ${target} 一直没有结束`)); }, 300_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`ssh ${target} 没有连上或中途断了（退出码 ${code}），没有改动标注表`));
      else resolve(parseResults(output));
    });
    child.stdin.end(script);
  });
}

async function main(): Promise<void> {
  const via = process.argv[process.argv.indexOf("--via") + 1];
  if (!process.argv.includes("--via") || !via) {
    console.error("用法：node scripts/notice/hosts.ts --via <ssh 主机别名>（一台不在校园网里的外部主机）");
    process.exit(1);
  }
  const wanted = targets();
  const results = await probeAll([...wanted.values()].map((probe) => probe.url), via);
  // 一个都没测到多半是外部主机上没有 curl 或者出不了网，这时候不写表，免得把所有网站都标成 campus。
  if (![...results.values()].some((result) => result.status > 0)) throw new Error(`${via} 上一个网站都没连上，没有改动标注表；先在那台机器上确认 curl 能访问外网`);
  const hosts: Record<string, HostNote> = {}, needsCas = declaredCas();
  for (const [host, probe] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
    const judged = judge(results.get(probe.url));
    hosts[host] = { ...judged, cas: judged.cas || needsCas.has(host), checked: probe.url, sites: [...probe.sites] };
  }
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), via, hosts }, null, 1) + "\n");
  const all = Object.values(hosts), count = (network: string) => all.filter((note) => note.network === network).length;
  console.log(`${all.length} 个网站：public ${count("public")}（其中打开栏目要统一身份认证的 ${all.filter((note) => note.cas).length}），campus ${count("campus")}`);
  console.log(`已写入 ${OUT}`);
}

// 被别的文件引用时（检查脚本写法）不执行。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
