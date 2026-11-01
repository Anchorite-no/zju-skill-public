/**
 * 新站点探索工具（不参与运行时决策）：判断一个主机大概率是 campus 还是 public，以及是否走 CAS。
 * 结果用于人工填写模块的 requirements；填完后运行时不再调用。
 *
 * 本机判断不可信：若有 TUN 级代理（FlClash/Clash/ZJU Connect/Tailscale）在 IP 层劫持流量，
 * 即使用公共 DNS 解析真实 IP 再直连，包仍走隧道进校园网。因此：
 *   - 默认在本机跑，用公共 DoH（阿里 223.5.5.5、腾讯 119.29.29.29）解析 + 直连解析出的 IP，
 *     但检测到 TUN 接口时在 caveats 里明确警告结果不可信；
 *   - 传 --via <ssh目标> 时改为在该外部主机上用 curl 实测（干净国内云主机 = ground truth）。
 */
import https from "node:https";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
import { HttpClient } from "../core/http.ts";
import { TransportError } from "../core/errors.ts";

export interface ProbeReport {
  host: string;
  via: "local" | string;
  resolver: string;
  addresses: string[];
  privateAddress: boolean;
  direct: { ip?: string; reachable: boolean; status?: number; error?: string; ms?: number };
  casRedirect?: { service?: string };
  suggested: { network: "campus" | "public"; auth: "cas" | "unknown"; casService?: string };
  caveats: string[];
}

const PRIVATE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const DOH: { name: string; url: (h: string) => string }[] = [
  { name: "alidns", url: (h) => `https://223.5.5.5/resolve?name=${encodeURIComponent(h)}&type=A` },
  { name: "dnspod", url: (h) => `https://119.29.29.29/dns-query?name=${encodeURIComponent(h)}&type=A` },
];

async function resolvePublic(host: string): Promise<{ resolver: string; addresses: string[] }> {
  const client = new HttpClient({ timeout: 6000 });
  try {
    for (const d of DOH) {
      try {
        const r = await client.request(d.url(host), { headers: { Accept: "application/dns-json" } });
        const j = r.json<{ Answer?: { type: number; data: string }[] }>();
        if (j) return { resolver: d.name, addresses: (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data) };
      } catch {
        /* 换下一个 */
      }
    }
    return { resolver: "none", addresses: [] };
  } finally {
    client.destroy();
  }
}

/** 直连指定 IP 发 GET /，不经系统 DNS */
function fetchByIp(host: string, ip: string, secure = true, timeoutMs = 8000): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const mod = secure ? https : http;
    const req = mod.request(
      { host: ip, servername: host, port: secure ? 443 : 80, path: "/", method: "GET", headers: { Host: host, "User-Agent": "zju-skill-probe" }, rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        res.resume();
        const loc = res.headers.location;
        resolve(loc === undefined ? { status: res.statusCode ?? 0 } : { status: res.statusCode ?? 0, location: loc });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function tunCaveat(): string | undefined {
  const tun = Object.keys(os.networkInterfaces()).filter((n) => /clash|mihomo|tun|wintun|tailscale|zju-connect|sing-box/i.test(n));
  return tun.length ? `本机存在隧道接口 ${tun.join(", ")}；IP 直连可能被隧道劫持，结果不可信。请用 --via <外部主机> 复核` : undefined;
}

/** 在外部主机上 ssh + curl 实测（ground truth）。target 是 ~/.ssh/config 里的 Host 别名或 user@ip。 */
function probeVia(host: string, target: string): Promise<{ status: number; ip: string }> {
  return new Promise((resolve, reject) => {
    const remote = `ip=$(getent ahostsv4 ${host} 2>/dev/null | awk '{print $1; exit}'); code=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' https://${host}/ 2>/dev/null || echo 000); echo "$ip $code"`;
    execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12", target, remote], { timeout: 40000 }, (err, stdout) => {
      if (err) return reject(new TransportError(`ssh ${target} 探测失败：${err.message}`));
      const [ip, code] = stdout.trim().split(/\s+/);
      resolve({ ip: ip ?? "", status: Number(code) || 0 });
    });
  });
}

export async function probeHost(host: string, opts: { via?: string } = {}): Promise<ProbeReport> {
  const { resolver, addresses } = await resolvePublic(host);
  const privateAddress = addresses.length === 0 || addresses.every((ip) => PRIVATE.test(ip));
  const report: ProbeReport = { host, via: opts.via ?? "local", resolver, addresses, privateAddress, direct: { reachable: false }, suggested: { network: "campus", auth: "unknown" }, caveats: [] };
  if (addresses.length === 0) report.caveats.push("公共 DNS 无 A 记录：校内专用域名");

  if (opts.via) {
    try {
      const r = await probeVia(host, opts.via);
      report.direct = { ip: r.ip, reachable: r.status > 0 && r.status < 500 && r.status !== 0, status: r.status };
      if (!report.direct.reachable) report.direct.error = `curl 返回 ${r.status}`;
    } catch (e) {
      report.direct = { reachable: false, error: e instanceof Error ? e.message : String(e) };
      report.caveats.push("外部主机探测失败，无法确定");
    }
  } else {
    const tc = tunCaveat();
    if (tc) report.caveats.push(tc);
    const ip = addresses.find((a) => net.isIPv4(a));
    if (ip && !privateAddress) {
      const t = performance.now();
      try {
        const r = await fetchByIp(host, ip);
        report.direct = { ip, reachable: true, status: r.status, ms: Math.round(performance.now() - t) };
        if (r.location) {
          try {
            const next = new URL(r.location, `https://${host}/`);
            if (next.hostname === "zjuam.zju.edu.cn" && next.pathname.startsWith("/cas")) report.casRedirect = next.searchParams.get("service") ? { service: next.searchParams.get("service")! } : {};
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        report.direct = { ip, reachable: false, error: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t) };
      }
    } else if (ip) {
      report.direct = { ip, reachable: false, error: "私网地址，校外不可达" };
    }
  }

  report.suggested.network = report.direct.reachable ? "public" : "campus";
  if (report.casRedirect) {
    report.suggested.auth = "cas";
    if (report.casRedirect.service) report.suggested.casService = report.casRedirect.service;
  } else {
    report.caveats.push("auth 只看首页重定向；SPA 站点的 CAS 入口通常在具体接口上，需人工确认");
  }
  return report;
}
