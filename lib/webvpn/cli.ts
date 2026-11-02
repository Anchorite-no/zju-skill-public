/** webvpn module CLI; business calls stay inside this module. */
import { command, group, retired, sessionCommands, bool, requiredString as str, type Command } from "../core/command.ts";
import { exclusive } from "../core/cli.ts";
import { ConfigError } from "../core/errors.ts";
import { webvpnCredentials } from "../profile/profile.ts";
import { HttpClient } from "../core/http.ts";
import { checkReachable } from "../core/reach.ts";
import { Webvpn, encodeHost, decodeHost, rewriteUrl, unwrapUrl } from "./client.ts";
import { doctor } from "./doctor.ts";
import { probeHost } from "./probe.ts";

const local = () => new Webvpn({ ...webvpnCredentials(), http: new HttpClient() });

export const webvpnCommands: Record<string, Command> = sessionCommands({
  check: command("网络诊断：直连与 WebVPN 是否可用、凭据与会话是否有效；给了 --host 时只测这些主机能否访问", {
    host: { description: "要测的主机名，多个用逗号分隔" },
    fresh: { description: "忽略上次的检测结果，重新检测", type: "boolean" },
  }, async (f) => {
    if (f.host === undefined) return doctor();
    const hosts = (f.host as string).split(",").map((s) => s.trim()).filter(Boolean);
    if (!hosts.length) throw new ConfigError("--host 不能为空");
    return { hosts: await checkReachable(hosts, { fresh: bool(f, "fresh") }) };
  }),
  probe: command("开发用：探测一个新站点该直连还是走 WebVPN", {
    host: { description: "主机名", required: true },
    via: { description: "从这台 SSH 主机实测；本机开着代理或 TUN 时结果不可信" },
  }, (f) => probeHost(str(f, "host"), typeof f.via === "string" ? { via: f.via } : {})),
  url: group("WebVPN 地址与真实地址互转（本地计算）", {
    encode: command("真实主机名或 URL → WebVPN 形式", { host: { description: "真实主机名" }, url: { description: "真实 URL" } }, async (f) => {
      exclusive(f, ["host", "url"]);
      return f.url !== undefined ? { url: str(f, "url"), webvpn: rewriteUrl(str(f, "url")) } : { host: str(f, "host"), encoded: encodeHost(str(f, "host")) };
    }, "local"),
    decode: command("WebVPN 形式 → 真实主机名或 URL", { enc: { description: "编码后的主机名" }, url: { description: "WebVPN URL" } }, async (f) => {
      exclusive(f, ["enc", "url"]);
      return f.url !== undefined ? { webvpn: str(f, "url"), url: unwrapUrl(str(f, "url")) } : { encoded: str(f, "enc"), host: decodeHost(str(f, "enc")) };
    }, "local"),
  }),
  login: command("WebVPN 登录并保存会话（校园网账号，与统一身份认证不同）", { fresh: { description: "强制重新登录", type: "boolean" } }, async (f) => {
    const w = local(), r = await w.login(bool(f, "fresh"));
    return { username: w.username, ...r, session: { file: w.store.file } };
  }),
  status: command("本地会话状态（不联网）", {}, async () => { const w = local(); return { username: w.username, hasTicketInCache: w.hasTicket, ...w.store.status() }; }, "local"),
  logout: command("清除本地会话", {}, async () => { local().logout(); return { cleared: true }; }, "local"),
  "import-cookie": command("从浏览器导入 WebVPN 会话（登录要验证码时用）", {
    ticket: { description: "浏览器里 wengine_vpn_ticketwebvpn_zju_edu_cn 这个 Cookie 的值", required: true },
    route: { description: "route Cookie 的值" },
  }, async (f) => {
    const w = local();
    w.importTicket(str(f, "ticket"), typeof f.route === "string" ? f.route : undefined);
    return { imported: true, valid: await w.probe() };
  }),
}, "webvpn");

// 旧入口只提示新路径。
for (const [old, now] of Object.entries({
  doctor: "webvpn check", "clear-cache": "webvpn check --fresh", encode: "webvpn url encode", rewrite: "webvpn url encode", decode: "webvpn url decode", unwrap: "webvpn url decode",
  requirements: "各模块声明见 lib/<module>/module.json",
})) webvpnCommands[old] = retired(now);
