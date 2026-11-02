/**
 * 网络探测：直连校园网是否可达、WebVPN 是否可达、WebVPN 会话是否有效。
 * 不改变配置；transport 由 profile init --transport 设置（默认 webvpn）。
 */
import { HttpClient } from "../core/http.ts";
import { WEBVPN_BASE, Webvpn } from "./client.ts";
import { currentTransport, readProfile } from "../profile/profile.ts";

// zdbk is public; only an actual campus host can establish campus reachability.
const CAMPUS_PROBE = "https://api.cc98.org/topic/hot";
const PUBLIC_PROBE = "https://zjuam.zju.edu.cn/cas/login";

export interface DoctorReport {
  transport: string;
  direct: { campus: boolean; public: boolean; ms?: number; error?: string };
  webvpn: { reachable: boolean; ms?: number; error?: string; credentials: boolean; sessionValid?: boolean };
  ok: boolean;
  advice: string[];
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T; ms: number } | { ok: false; error: string; ms: number }> {
  const t = performance.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: Math.round(performance.now() - t) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t) };
  }
}

export async function doctor(timeout = 5000): Promise<DoctorReport> {
  const http = new HttpClient({ timeout });
  const p = readProfile();
  const report: DoctorReport = {
    transport: currentTransport(),
    direct: { campus: false, public: false },
    webvpn: { reachable: false, credentials: !!(p.webvpn_username && p.webvpn_password) },
    ok: false,
    advice: [],
  };
  const [pub, campus, vpn] = await Promise.all([
    timed(() => http.request(PUBLIC_PROBE)),
    timed(() => http.request(CAMPUS_PROBE)),
    timed(() => http.request(`${WEBVPN_BASE}/login`)),
  ]);
  report.direct.public = pub.ok && pub.value.status < 500;
  report.direct.campus = campus.ok && campus.value.status < 500;
  report.direct.ms = campus.ms;
  if (!campus.ok) report.direct.error = campus.error;
  report.webvpn.reachable = vpn.ok && vpn.value.status === 200;
  report.webvpn.ms = vpn.ms;
  if (!vpn.ok) report.webvpn.error = vpn.error;

  if (report.webvpn.credentials && report.webvpn.reachable) {
    const w = new Webvpn({ username: p.webvpn_username!, password: p.webvpn_password!, http });
    report.webvpn.sessionValid = await w.probe(); // 只探测缓存 ticket，不登录
  }
  http.destroy();

  if (report.transport === "webvpn") {
    report.ok = report.webvpn.reachable && report.webvpn.credentials;
    if (!report.webvpn.reachable) report.advice.push("webvpn.zju.edu.cn 不可达，检查公网连接");
    if (!report.webvpn.credentials) report.advice.push("请运行 profile init --system webvpn 配置账号");
    if (report.webvpn.sessionValid === false) report.advice.push("WebVPN 会话未建立或已过期，运行 zju webvpn login");
  } else {
    report.ok = report.direct.campus;
    if (!report.direct.campus) report.advice.push("transport=direct 但校园网不可达；改回 transport=webvpn");
  }
  if (!report.direct.public) report.advice.push("zjuam.zju.edu.cn 不可达，统一身份认证无法进行");
  return report;
}
