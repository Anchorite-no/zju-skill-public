import path from "node:path";
import { createHash } from "node:crypto";
import { openContext, type Context, type OpenOptions } from "../webvpn/transport.ts";
import { Zjuam } from "../zjuam/login.ts";
import { SessionStore } from "../zjuam/session.ts";
import { readJson, writeJson } from "../core/fsjson.ts";
import { paths } from "../core/paths.ts";
import { htmlToText } from "../core/html.ts";
import { writeAllowed } from "../core/env.ts";
import { AuthExpired, BadResponse, ConfigError, NeedsUser, RateLimited, RemoteRejected, WriteGateClosed } from "../core/errors.ts";
import { requirements } from "./client.ts";

export type Row = Record<string, unknown>;
export const row = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
export const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(row) : [];
export const text = (v: unknown): string => v == null ? "" : String(v);
export const VENUE_BASE = "http://www.tyys.zju.edu.cn/venue-server";
const SERVICE = "http://tyys.zju.edu.cn/venue-server/sso/manageLogin";
const PROTOCOL = "/api/front/website/protocols/code/RESERVATION_PROTOCOL";
const READ_POSTS = new Set(["/api/reservation/order/info", "/api/captcha/check", "/api/vip/view/buddy_no", "/api/vip/check/buddy_no"]);
const WRITES = new Set(["/api/reservation/order/submit", "/api/venue/finances/order/pay", "/api/venue/finances/order/cancel"]);
const DAY = 86400_000;
export const beijingDate = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
export const localTime = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
export const atDate = (date: string, time = "00:00") => Date.parse(`${date}T${time}:00+08:00`);
export const addDays = (date: string, n: number) => beijingDate(atDate(date) + n * DAY);
export function targetDate(input: string, now = Date.now(), bounded = true): string {
  const today = beijingDate(now), offsets: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2 };
  const m = input.trim().match(/^(\d+)\s*天后$/), offset = offsets[input.trim()] ?? (m ? Number(m[1]) : undefined);
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset > (bounded ? 3 : 36500))) throw new ConfigError(bounded ? "场馆查询与预约仅支持今天至三天后（含当天）" : "相对日期天数超出可处理范围");
  const date = offset === undefined ? input.trim() : addDays(today, offset);
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(date) ? atDate(date) : NaN;
  if (!Number.isFinite(stamp) || beijingDate(stamp) !== date) throw new ConfigError("日期须为今天、明天、后天、0至3天后或 YYYY-MM-DD");
  if (bounded && (date < today || date > addDays(today, 3))) throw new ConfigError("场馆查询与预约仅支持今天至三天后（含当天），不会自动更换日期");
  return date;
}
export interface TimeRange { start: string; end?: string }
export function timeRange(input: string): TimeRange {
  const m = input.trim().match(/^([01]\d|2[0-3]):([0-5]\d)(?:-([01]\d|2[0-3]):([0-5]\d))?$/);
  if (!m) throw new ConfigError("时间须为 HH:mm 或 HH:mm-HH:mm");
  const start = `${m[1]}:${m[2]}`, end = m[3] ? `${m[3]}:${m[4]}` : undefined;
  if (end && end <= start) throw new ConfigError("结束时间须晚于开始时间，暂不支持跨午夜预约");
  return { start, ...(end ? { end } : {}) };
}
export interface Site { id: string; campus: string; venue: string; name: string; sport: string; maxSlots: number }
export interface Catalog { sites: Site[]; maxSlots: number; fetchedAt: string }
export interface Notice { title: string; content: string; releaseTimes: { scope: string; time: string }[]; fetchedAt: string; source: string }
export interface Slot { spaceId: string; space: string; timeId: string; start: string; end: string; status: number }
export interface DayInfo { date: string; open: boolean; days: number; weekStart: string; token: string; slots: Slot[]; message: string }
export interface VenueApi {
  username: string;
  request(method: "GET" | "POST", endpoint: string, params?: Row, confirm?: boolean): Promise<unknown>;
  catalog(): Promise<Catalog>;
  notice(): Promise<Notice>;
  day(site: Site, date: string): Promise<DayInfo>;
  identity(): Promise<Row>;
  close(): void;
}

export function venueSignature(endpoint: string, params: Row, timestamp: string): string {
  const salt = "c640ca392cd45fb3a55b00a63a86c618";
  const values = Object.keys(params).sort().filter(k => params[k] != null && params[k] !== "" && typeof params[k] !== "object").map(k => k + String(params[k])).join("");
  return createHash("md5").update(salt + endpoint + values + timestamp + " " + salt).digest("hex");
}
export function parseNotice(data: unknown, now = Date.now()): Notice {
  const r = row(data), content = htmlToText(text(r.content));
  if (!content) throw new BadResponse("预约须知正文为空");
  const releaseTimes = [...content.matchAll(/((?:紫金港|玉泉|华家池|西溪|之江|海宁|舟山)[^。；\n]*?)[-－—]\s*每天\s*(\d{1,2}:\d{2})/g)]
    .flatMap(m => m[1]!.split("、").map(scope => ({ scope: scope.trim(), time: m[2]!.padStart(5, "0") })));
  return { title: text(r.title), content, releaseTimes, fetchedAt: localTime(now), source: VENUE_BASE + PROTOCOL };
}
const normalize = (s: string) => s.normalize("NFKC").replace(/校区|[\s··]/g, "");
export const siteName = (s: Site) => `${s.campus}${s.venue}${s.name}`;
export function matchSites(sites: Site[], filter: { sport?: string; campus?: string; venue?: string }): Site[] {
  return sites.filter(s => (!filter.campus || normalize(s.campus).includes(normalize(filter.campus))) &&
    (!filter.sport || normalize(s.sport + s.name).includes(normalize(filter.sport))) &&
    (!filter.venue || normalize(siteName(s)).includes(normalize(filter.venue))));
}
export function chooseSite(sites: Site[], filter: { sport?: string; campus?: string; venue?: string }): Site {
  const found = matchSites(sites, filter);
  if (found.length === 1) return found[0]!;
  const err = new NeedsUser(found.length ? "有多个符合条件的场馆，请指定场馆名称" : "未找到符合条件的体育场馆");
  err.detail.candidates = (found.length ? found : sites).map(s => ({ campus: s.campus, venue: s.venue, site: s.name, sport: s.sport }));
  throw err;
}
export function releaseTime(site: Site, notice: Notice): string | undefined {
  const campus = normalize(site.campus), full = normalize(siteName(site));
  const matches = notice.releaseTimes.filter(r => {
    const scope = normalize(r.scope);
    if (!scope.includes(campus)) return false;
    const sport = /羽毛球|网球|游泳|足球|篮球/.exec(scope)?.[0];
    return !!sport && (site.sport + site.name).includes(sport) && (!scope.includes("膜顶") || full.includes("膜顶"));
  });
  return new Set(matches.map(r => r.time)).size === 1 ? matches[0]!.time : undefined;
}
/** N includes today. The next release adds one day; never reinterpret the user's date. */
export function releaseAt(site: Site, date: string, days: number, notice: Notice, now = Date.now()): number | undefined {
  const time = releaseTime(site, notice);
  if (!time || !Number.isInteger(days) || days < 1) return undefined;
  const today = beijingDate(now), latest = addDays(today, days - 1);
  if (date <= latest) return undefined;
  const additions = Math.round((atDate(date) - atDate(latest)) / DAY);
  const nextDate = atDate(today, time) > now ? today : addDays(today, 1);
  return atDate(addDays(nextDate, additions - 1), time);
}
export function parseDay(data: unknown, date: string): DayInfo {
  const d = row(data), dateMap = row(d.reservationDateSpaceInfo), spaces = dateMap[date];
  if (Number(d.notReserveType) === 1) throw new NeedsUser("场馆平台提示无权限预约该时段，请联系场地管理方");
  if (!Array.isArray(spaces) || !Array.isArray(d.reservationDateList)) throw new BadResponse("场馆时段响应缺少目标日期，无法判定是否有空场");
  const slots: Slot[] = [];
  for (const space of rows(spaces)) for (const [key, value] of Object.entries(space)) {
    const r = row(value);
    if (r.reservationStatus == null) continue;
    const start = text(r.startDate).match(/(\d{2}:\d{2})(?::\d{2})?$/)?.[1], end = text(r.endDate).match(/(\d{2}:\d{2})(?::\d{2})?$/)?.[1];
    if (!start || !end || !space.id || !Number.isFinite(Number(r.reservationStatus))) throw new BadResponse("场馆时段字段不完整，停止预约");
    slots.push({ spaceId: text(space.id), space: text(space.spaceName), timeId: key, start, end, status: Number(r.reservationStatus) });
  }
  return { date, open: slots.length > 0, days: Number(d.advanceReservationDays), weekStart: text(d.reservationDateList[0]), token: text(d.token), slots, message: slots.length ? "目标日期已开放" : "目标日期暂未发布时段" };
}
export function nearbyTimes(day: DayInfo, time: TimeRange): { start: string; end: string; availableCourts: number }[] {
  const groups = new Map<string, { start: string; end: string; availableCourts: number }>();
  for (const s of day.slots.filter(s => atDate(day.date, s.start) > Date.now())) {
    const key = s.start + s.end, value = groups.get(key) ?? { start: s.start, end: s.end, availableCourts: 0 };
    if (s.status === 1) value.availableCourts++;
    groups.set(key, value);
  }
  return [...groups.values()].sort((a, b) => Math.abs(atDate(day.date, a.start) - atDate(day.date, time.start)) - Math.abs(atDate(day.date, b.start) - atDate(day.date, time.start))).slice(0, 3).sort((a, b) => a.start.localeCompare(b.start));
}

export class VenueClient implements VenueApi {
  readonly username: string;
  readonly ctx: Context;
  private readonly store: SessionStore;
  private token = "";
  private user: Row = {};
  private queue: Promise<unknown> = Promise.resolve();
  private catalogValue: Catalog | undefined;
  constructor(ctx: Context) {
    this.ctx = ctx; this.username = ctx.zjuam?.username ?? "";
    this.store = new SessionStore({ system: "tyys-venue-" + createHash("sha256").update(this.username).digest("hex").slice(0, 16), username: this.username, ttlMs: 4 * 3600_000 - 30_000 });
    const cached = this.username ? this.store.load() : undefined;
    if (cached) { this.token = text(cached.extra.token); this.user = row(cached.extra.user); }
  }
  private async send(method: "GET" | "POST", endpoint: string, params: Row, extra: Record<string, string> = {}): Promise<Row> {
    const timestamp = String(Date.now()), values = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null));
    if (method === "GET") values.nocache = timestamp;
    const encoded = new URLSearchParams(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]))).toString();
    const res = await this.ctx.fetch(VENUE_BASE + endpoint + (method === "GET" ? "?" + encoded : ""), {
      method, headers: { "app-key": "8fceb735082b5a529312040b58ea780b", timestamp, sign: venueSignature(endpoint, values, timestamp),
        ...(this.token ? { cgAuthorization: this.token } : {}), ...extra, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      ...(method === "POST" ? { body: encoded } : {}),
    });
    const b = res.json<Row>();
    if (Number(b?.code) === 408 || res.status === 429) throw new RateLimited("场馆服务器限制访问，本次已停止；不会自动重新运行", 0);
    if (res.status === 401 || Number(b?.code) === 401) return { code: 401 };
    if (!b || b.code == null || !Number.isFinite(Number(b.code)) || res.status < 200 || res.status >= 300) throw new BadResponse("场馆响应无有效业务状态，无法确认请求结果", { endpoint, httpStatus: res.status });
    return b;
  }
  private async login(): Promise<void> {
    if (this.token) return;
    if (!this.ctx.zjuam) throw new AuthExpired("tyys-venue", "此操作需要统一认证账号");
    const front = await this.ctx.zjuam.loginService(SERVICE), oauth = new URL(front.url).searchParams.get("oauth_token");
    if (!oauth) throw new AuthExpired("tyys-venue", "场馆网页登录未取得 oauth_token");
    const login = await this.send("POST", "/api/login", {}, { "oauth-token": oauth });
    if (Number(login.code) !== 200) throw new AuthExpired("tyys-venue");
    const initial = row(login.data); this.token = text(row(initial.token).access_token);
    const roles = rows(initial.roles);
    if (!this.token || !roles.some(r => text(r.id) === "3")) { this.token = ""; throw new NeedsUser("账号没有场馆学生预约角色"); }
    const role = await this.send("POST", "/roleLogin", { roleid: 3 });
    if (Number(role.code) !== 200) { this.token = ""; throw new AuthExpired("tyys-venue"); }
    const data = row(role.data); this.token = text(row(data.token).access_token);
    if (!this.token) throw new AuthExpired("tyys-venue");
    // Current front-end loginSuccess uses top-level identity when userInfo is absent.
    this.user = { name: data.name ?? initial.name, username: data.username ?? initial.username, userId: data.userId ?? initial.userId,
      ...row(initial.user), ...row(initial.userInfo), ...row(data.user), ...row(data.userInfo) };
    this.store.save(this.ctx.http.jar, { token: this.token, user: this.user });
  }
  request(method: "GET" | "POST", endpoint: string, params: Row = {}, confirm = false): Promise<unknown> {
    if (!/^\/(?:api\/[A-Za-z0-9_/-]+)$/.test(endpoint)) throw new ConfigError("无效场馆接口路径");
    if (method === "POST" && !READ_POSTS.has(endpoint) && !WRITES.has(endpoint)) throw new ConfigError("未支持的场馆操作");
    if (WRITES.has(endpoint) && (!confirm || !writeAllowed())) throw new WriteGateClosed("体艺场馆预约");
    const execute = async () => {
      const publicRead = endpoint === PROTOCOL;
      if (!publicRead) await this.login();
      let result = await this.send(method, endpoint, params);
      if (Number(result.code) === 401) {
        this.token = ""; this.store.clear();
        if (method !== "GET" || publicRead) throw new AuthExpired("tyys-venue", "场馆会话失效；写请求未自动重放");
        await this.login(); result = await this.send(method, endpoint, params);
      }
      if (Number(result.code) === 401) throw new AuthExpired("tyys-venue");
      if (Number(result.code) === 250 && endpoint === "/api/reservation/day/info") return { notReleased: true, message: text(result.message) };
      if (Number(result.code) !== 200) throw new RemoteRejected(text(result.message) || "场馆拒绝本次操作", { code: result.code, endpoint });
      return result.data;
    };
    const pending = this.queue.then(execute); this.queue = pending.catch(() => undefined); return pending;
  }
  async identity(): Promise<Row> {
    if (this.token && !this.user.id && !this.user.userId) this.token = "";
    await this.login(); return this.user;
  }
  async notice(): Promise<Notice> {
    const file = path.join(paths.cache(), "tyys-venue-notice.json"), cached = readJson<{ savedAt: number; data: Notice }>(file);
    if (cached && Date.now() - cached.savedAt < DAY && cached.data?.content) return cached.data;
    const data = parseNotice(await this.request("GET", PROTOCOL)); writeJson(file, { savedAt: Date.now(), data }); return data;
  }
  async catalog(): Promise<Catalog> {
    if (this.catalogValue) return this.catalogValue;
    const file = path.join(paths.cache(), "tyys-venue-catalog.json"), cached = readJson<{ savedAt: number; data: Catalog }>(file);
    if (cached && Date.now() - cached.savedAt < DAY && Array.isArray(cached.data?.sites)) return this.catalogValue = cached.data;
    const data = row(await this.request("GET", "/api/reservation/campus/venue/info")), sites: Site[] = [];
    const visit = (v: unknown) => {
      if (Array.isArray(v)) { v.forEach(visit); return; }
      const r = row(v);
      if (r.siteName != null && r.id != null) {
        if (Number(r.isArt) === 1 || Number(r.isSupportReservation) !== 1) return;
        sites.push({ id: text(r.id), campus: text(r.campusName), venue: text(r.venueName), name: text(r.siteName),
          sport: text(r.sportName) || /羽毛球|网球|足球|篮球|游泳|健身|乒乓球/.exec(text(r.siteName))?.[0] || "", maxSlots: Number(r.reservationSpaceCount) || Number(data.reservationNumMax) || 1 });
      } else Object.values(r).forEach(visit);
    };
    visit(data.venueSiteInfo);
    if (!sites.length) throw new BadResponse("场馆目录未返回可预约的体育场馆");
    const result = { sites, maxSlots: Number(data.reservationNumMax) || 1, fetchedAt: localTime() };
    writeJson(file, { savedAt: Date.now(), data: result }); return this.catalogValue = result;
  }
  async day(site: Site, date: string): Promise<DayInfo> {
    const data = await this.request("GET", "/api/reservation/day/info", { venueSiteId: site.id, searchDate: date });
    if (row(data).notReleased) return { date, open: false, days: NaN, weekStart: "", token: "", slots: [], message: text(row(data).message) };
    return parseDay(data, date);
  }
  close(): void { this.ctx.close(); }
}
export async function openVenue(options: OpenOptions & { publicOnly?: boolean; account?: { username: string; password: string } } = {}): Promise<VenueClient> {
  const ctx = await openContext({ ...requirements, casService: SERVICE, auth: options.publicOnly || options.account ? "none" : "cas" }, options);
  if (options.account) ctx.zjuam = new Zjuam({ ...options.account, http: ctx.http, resolve: ctx.resolve });
  return new VenueClient(ctx);
}

export async function listVenues(client: VenueApi, filter: { sport?: string; campus?: string; venue?: string; date: string; time?: TimeRange }) {
  const catalog = await client.catalog(), found = matchSites(catalog.sites, filter);
  const summaries = found.map(s => ({ campus: s.campus, venue: s.venue, site: s.name, sport: s.sport }));
  if ((!filter.sport && !filter.campus && !filter.venue) || found.length !== 1) return { status: "catalog", message: found.length ? "已列出匹配场馆；请指定一个场馆后查询余量" : "没有匹配的体育场馆", venues: summaries, fetchedAt: catalog.fetchedAt };
  const site = found[0]!, day = await client.day(site, filter.date), notice = await client.notice();
  if (day.open && filter.time && !day.slots.some(s => s.start === filter.time!.start)) return {
    status: "needs-time", message: `该场馆没有 ${filter.time.start} 开始的时段；已列出相邻可选时段，请明确开始时间`, venue: summaries[0], date: filter.date,
    alternatives: nearbyTimes(day, filter.time), observedAt: localTime(),
  };
  let release: number | undefined;
  if (!day.open && filter.date > beijingDate()) {
    const days = Number.isFinite(day.days) ? day.days : (await client.day(site, beijingDate())).days;
    release = releaseAt(site, filter.date, days, notice);
  }
  const slots = day.slots.filter(s => s.status === 1 && atDate(filter.date, s.start) > Date.now() && (!filter.time || (filter.time.end ? s.start >= filter.time.start && s.end <= filter.time.end : s.start === filter.time.start)));
  const grouped = new Map<string, { start: string; end: string; courts: string[] }>();
  for (const s of slots) { const key = s.start + s.end; const g = grouped.get(key) ?? { start: s.start, end: s.end, courts: [] }; g.courts.push(s.space); grouped.set(key, g); }
  return { status: !day.open ? "not-released" : slots.length ? "available" : "unavailable", message: !day.open ? (release ? `目标日期尚未开放，按须知和当前窗口预计 ${localTime(release)} 放号` : "目标日期尚未发布时段，放号日期暂无法确定") : slots.length ? "已查询目标日期空场" : "目标日期已开放，但没有符合条件的空场", venue: summaries[0], date: filter.date,
    releaseAt: release ? localTime(release) : null, releaseTime: releaseTime(site, notice) ?? null, slots: [...grouped.values()].sort((a, b) => a.start.localeCompare(b.start)), observedAt: localTime() };
}
