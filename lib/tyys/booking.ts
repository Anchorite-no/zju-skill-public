import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Decimal } from "decimal.js";
import { paths } from "../core/paths.ts";
import { fileJournal } from "../core/journal.ts";
import { writeAllowed } from "../core/env.ts";
import { readProfileAll } from "../profile/profile.ts";
import { BadResponse, ConfigError, NeedsUser, RateLimited, RemoteRejected, WriteGateClosed } from "../core/errors.ts";
import { CaptchaSolver } from "./captcha.ts";
import { atDate, beijingDate, chooseSite, localTime, nearbyTimes, openVenue, releaseAt, row, rows, siteName, targetDate, text, type DayInfo, type Row, type Site, type Slot, type TimeRange, type VenueApi } from "./venue.ts";

export interface Order { id: string; number: string; siteId: string; venue: string; date: string; start: string; end: string; description: string; status: number; payStatus: number; amount: string; expires: string }
export interface VenueResult { status: string; message: string; [key: string]: unknown }
function serverTime(v: unknown): string {
  if (typeof v === "number") return localTime(v);
  const s = text(v);
  if (/Z$|[+-]\d\d:\d\d$/.test(s) && Number.isFinite(Date.parse(s))) return localTime(Date.parse(s));
  return s.replace("T", " ").slice(0, 19);
}
export function parseOrder(value: unknown): Order {
  const outer = row(value), r = Object.keys(row(outer.orderInfo)).length ? row(outer.orderInfo) : outer;
  const start = serverTime(r.reservationStartDate), end = serverTime(r.reservationEndDate);
  return { id: text(r.id), number: text(r.tradeNo), siteId: text(r.venueSiteId ?? row(outer.venueInfoBean).venueSiteId),
    venue: [r.campusName, r.venueName, r.siteName].map(text).join(""), date: start.slice(0, 10) || text(r.reservationDate).slice(0, 10),
    start: start.slice(11, 16), end: end.slice(11, 16), description: text(r.reservationDateDetail), status: Number(r.orderStatus), payStatus: Number(r.payStatus),
    amount: r.amountFee == null ? "" : text(r.amountFee), expires: serverTime(r.expireTime) };
}
function orderView(o: Order) { return { number: o.number, venue: o.venue, date: o.date, time: o.start && o.end ? `${o.start}-${o.end}` : o.description,
  description: o.description, status: o.status === 2 ? "已取消" : o.status === 1 ? "正常" : "待核对", payment: o.payStatus === 2 ? "已支付或已零元确认" : o.payStatus === 1 ? "未支付" : "退款或待核对", amount: o.amount, expiresAt: o.expires || null }; }
export async function readOrders(client: VenueApi): Promise<{ orders: Order[]; complete: boolean }> {
  const orders: Order[] = [], seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const data = row(await client.request("GET", "/api/orders/mine", { page, size: 50 }));
    if (!Array.isArray(data.content)) throw new BadResponse("本人订单响应缺少列表，无法确认预约状态");
    let added = 0;
    for (const r of data.content) {
      const order = parseOrder(r); if (!order.number) throw new BadResponse("本人订单缺少订单号");
      if (!seen.has(order.number)) { seen.add(order.number); orders.push(order); added++; }
    }
    const hasPages = Number.isInteger(data.totalPages) && Number(data.totalPages) >= 0;
    if (data.last === true || (hasPages && page + 1 >= Number(data.totalPages))) return { orders, complete: true };
    if (typeof data.last !== "boolean" && !hasPages) throw new BadResponse("本人订单缺少分页完整性信息，不能把当前页视为全部订单");
    if (!added) break;
    await sleep(500);
  }
  return { orders, complete: false };
}
export async function listOrders(client: VenueApi, filter: { date?: string; venue?: string } = {}): Promise<VenueResult> {
  const { orders, complete } = await readOrders(client);
  const selected = orders.filter(o => (filter.date ? o.date === filter.date : o.date >= beijingDate()) && (!filter.venue || venueMatches(o, filter.venue)));
  return { status: complete ? "listed" : "partial", message: complete ? `找到 ${selected.length} 笔符合条件的本人预约` : "订单尚未取全，以下仅为已查到的记录", orders: selected.map(orderView), observedAt: localTime() };
}
export function selectSlots(day: DayInfo, range: TimeRange, maximum: number, now: number): Slot[] | undefined {
  const available = day.slots.filter(s => s.status === 1 && atDate(day.date, s.start) > now);
  for (const first of available.filter(s => s.start === range.start).sort((a, b) => a.space.localeCompare(b.space, "zh"))) {
    if (!range.end || first.end === range.end) return [first];
    if (maximum >= 2) {
      const next = available.find(s => s.spaceId === first.spaceId && s.start === first.end && s.end === range.end);
      if (next) return [first, next];
    }
  }
  return undefined;
}
function sameTarget(o: Order, site: Site, date: string, time: TimeRange): boolean { return o.siteId === site.id && o.date === date && o.start === time.start && (!time.end || o.end === time.end); }
function active(o: Order) { return o.status === 1 && (o.payStatus === 1 || o.payStatus === 2); }
function venueMatches(o: Order, venue: string) { return (o.venue + o.description).replace(/校区|\s/g, "").includes(venue.replace(/校区|\s/g, "")); }
function done(o: Order) { return o.status === 1 && o.payStatus === 2; }
function money(value: string): Decimal {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new BadResponse("场馆订单金额缺失或无效，未付款");
  return new Decimal(value);
}
export function cardSecret(password: string): string {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from("c1h2i5n6g2o2k4a7"), Buffer.from("C2H3I4N5G2O3K1E4"));
  return Buffer.concat([cipher.update(password, "utf8"), cipher.final()]).toString("hex");
}
function captchaPackage(value: string, secret: string): string {
  if (!secret) return value;
  if (Buffer.byteLength(secret) !== 16) throw new BadResponse("验证码密钥格式已变化");
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(secret), null);
  return Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64");
}
export interface Solver { start(): Promise<void>; solve(image: string, words: string[]): Promise<{ x: number; y: number }[]>; close(): void }
async function captcha(client: VenueApi, solver: Solver): Promise<string> {
  await solver.start();
  for (let attempt = 0; attempt < 2; attempt++) {
    const challenge = row(await client.request("GET", "/api/captcha/get", { captchaType: "clickWord", clientUid: "point-" + randomUUID(), ts: Date.now() }));
    if (text(challenge.repCode) !== "0000") throw new NeedsUser("场馆验证码暂不可用");
    const data = row(challenge.repData), words = data.wordList;
    if (!Array.isArray(words) || words.length !== 3 || words.some(w => typeof w !== "string") || !data.token || !data.originalImageBase64) throw new BadResponse("验证码题目不完整");
    let points: { x: number; y: number }[];
    try { points = await solver.solve(text(data.originalImageBase64), words as string[]); }
    catch (e) { if (e instanceof NeedsUser && attempt === 0) continue; throw e; }
    const json = JSON.stringify(points), secret = text(data.secretKey);
    const checked = row(await client.request("POST", "/api/captcha/check", { captchaType: "clickWord", token: data.token, pointJson: captchaPackage(json, secret) }));
    if (text(checked.repCode) === "0000") return captchaPackage(text(data.token) + "---" + json, secret);
  }
  throw new NeedsUser("验证码两次未通过，本次没有提交预约");
}

export async function companionParams(client: VenueApi, preview: Row, names: string | undefined, signal?: AbortSignal): Promise<Row> {
  const info = row(preview.venueInfoBean), minimum = Number(info.buddyNumMin) || 0, maximum = Number(info.buddyNumMax) || 0;
  const requested = names ? names.split(/[|｜]/).map(s => s.trim()).filter(Boolean) : [];
  if (requested.length !== new Set(requested).size) throw new ConfigError("同伴姓名重复");
  if (!minimum && !requested.length) return {};
  const buddies = rows(preview.buddyList), config = readProfileAll();
  const accounts = Object.keys(config).filter(k => /^tyys_buddy_username(?:_\d+)?$/.test(k)).sort().map(k => ({ username: config[k]!, password: config[k.replace("username", "password")] ?? "" }));
  if (!accounts.length) throw new NeedsUser("该场馆需要同伴，请先配置获同伴本人授权的 tyys_buddy_username / tyys_buddy_password");
  const selected: { buddy: Row; code: string }[] = [];
  for (const account of accounts) {
    if (!account.password) throw new NeedsUser("已配置的同伴账号缺少密码");
    const other = await openVenue({ account, ...(signal ? { signal } : {}) });
    try {
      const identity = await other.identity(), userId = text(identity.id ?? identity.userId);
      const matches = buddies.filter(b => userId && text(b.userId) === userId);
      if (matches.length !== 1) throw new NeedsUser("同伴登录身份无法与本人同伴列表唯一对应，请核对同伴配置");
      const buddy = matches[0]!;
      if (requested.length && !requested.includes(text(buddy.name))) continue;
      if (selected.some(s => text(s.buddy.id) === text(buddy.id))) continue;
      const code = text(await other.request("POST", "/api/vip/view/buddy_no"));
      if (!/^\d{5}$/.test(code)) throw new BadResponse("未取得有效五位同伴码");
      const checked = row(await client.request("POST", "/api/vip/check/buddy_no", { buddyUserId: buddy.userId, buddyRoleId: buddy.userRoleId, buddyNo: code }));
      if (checked.checkResult !== true && checked.checkResult !== 1) throw new NeedsUser("同伴码校验未通过，本次未提交");
      selected.push({ buddy, code });
      if (selected.length >= (requested.length || minimum)) break;
    } finally { other.close(); }
  }
  if (selected.length < minimum || (requested.length && requested.some(n => !selected.some(s => text(s.buddy.name) === n))) || selected.length > maximum) throw new NeedsUser("可用同伴不满足本次姓名或人数要求");
  return { buddyIds: selected.map(s => text(s.buddy.id)).join(","), buddyNo: selected.map(s => s.code).join(",") };
}

interface Operation { id: string; action: "submit" | "pay" | "cancel"; siteId: string; date: string; start: string; end: string; number?: string }
/** Existing JSONL is also the recovery record; no task database or lock service. */
export class VenueJournal {
  readonly file: string;
  private readonly append: (event: Row) => void;
  constructor(username: string, file?: string) {
    const sink = fileJournal<Row>("tyys-venue", file ?? path.join(paths.journal(), `tyys-venue-${createHash("sha256").update(username).digest("hex").slice(0, 16)}.jsonl`));
    this.file = sink.file; this.append = sink.append;
  }
  pending(): Operation[] {
    let content: string;
    try { content = fs.readFileSync(this.file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    const unresolved = new Map<string, Operation>();
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      let event: Row; try { event = row(JSON.parse(line)); } catch { throw new NeedsUser("预约日志不完整，需核对已有订单后再写入"); }
      if (event.stage === "begin") unresolved.set(text(event.id), event as unknown as Operation);
      if (event.stage === "resolved") unresolved.delete(text(event.id));
    }
    return [...unresolved.values()];
  }
  begin(action: Operation["action"], site: Site, date: string, time: TimeRange, number?: string): Operation {
    const op: Operation = { id: randomUUID(), action, siteId: site.id, date, start: time.start, end: time.end ?? "", ...(number ? { number } : {}) };
    this.append({ ...op, stage: "begin", at: localTime() }); return op;
  }
  resolve(op: Operation, status: string, number?: string): void { this.append({ id: op.id, stage: "resolved", status, ...(number ? { number } : {}), at: localTime() }); }
}
async function recover(client: VenueApi, journal: VenueJournal, date: string, time: TimeRange): Promise<VenueResult | undefined> {
  const pending = journal.pending().filter(op => op.date === date && op.start === time.start && (!time.end || op.end === time.end)); if (!pending.length) return undefined;
  const { orders, complete } = await readOrders(client);
  if (!complete) return { status: "unknown", message: "上次写入尚未确认，订单未取全，本次未重复执行" };
  const recovered: Order[] = [];
  for (const op of pending) {
    const matches = orders.filter(o => op.number ? o.number === op.number : o.siteId === op.siteId && o.date === op.date && o.start === op.start && o.end === op.end);
    if (matches.length !== 1 || (op.action === "pay" && !done(matches[0]!) && matches[0]!.status !== 2) || (op.action === "cancel" && matches[0]!.status !== 2)) return { status: "unknown", message: "上次提交、付款或取消仍无法确认，请在 App 核对；本次没有重复写入" };
    journal.resolve(op, "recovered", matches[0]!.number); recovered.push(matches[0]!);
  }
  return { status: "recovered-previous-operation", message: "已回查上次操作；本次未创建新订单或再次付款，请按订单状态处理", orders: recovered.map(orderView) };
}
async function verify(client: VenueApi, number: string): Promise<Order | undefined> {
  const { orders, complete } = await readOrders(client);
  if (!complete) return undefined;
  return orders.find(o => o.number === number);
}
export interface BookingOptions {
  date: string; time: TimeRange; sport?: string; campus?: string; venue?: string; buddy?: string; maxFee?: string;
  confirm: boolean; deadline: number; signal?: AbortSignal; journal: VenueJournal;
  now?: () => number; wait?: (ms: number) => Promise<void>; solver?: Solver;
  companions?: (client: VenueApi, preview: Row) => Promise<Row>;
}
async function payAndVerify(client: VenueApi, site: Site, order: Order, opts: BookingOptions): Promise<VenueResult> {
  if (done(order)) {
    const checked = await verify(client, order.number);
    return checked && done(checked) && sameTarget(checked, site, order.date, { start: order.start, end: order.end }) ? { status: "booked", message: "预约已回查确认", order: orderView(checked) } : { status: "unknown", message: "提交显示已付款，但订单回查尚未确认，未重复付款", order: orderView(order) };
  }
  if (order.status !== 1 || order.payStatus !== 1) return { status: "unknown", message: "订单当前不是明确的待支付状态，未付款", order: orderView(order) };
  let amount: Decimal;
  try { amount = money(order.amount); } catch { return { status: "unknown", message: "已创建订单，但金额缺失或格式无法确认，未付款", order: orderView(order) }; }
  const password = readProfileAll().tyys_card_password;
  const pending = (reason: string): VenueResult => ({ status: "pending-payment", message: reason, order: orderView(order) });
  if (order.expires && Date.parse(order.expires.replace(" ", "T") + "+08:00") <= (opts.now ?? Date.now)()) return { status: "expired", message: "订单有效期已过，未执行付款", order: orderView(order) };
  if (opts.maxFee !== undefined && amount.gt(new Decimal(opts.maxFee))) return pending("已建单，实际费用超出预算，未自动付款");
  if (amount.gt(0) && !password) return pending("已建单但缺少校园卡查询密码，请在订单有效期内到 App 付款");
  if ((opts.now ?? Date.now)() >= opts.deadline || opts.signal?.aborted) return pending("预约任务已到期或被取消，订单尚未付款");
  const op = opts.journal.begin("pay", site, order.date, { start: order.start, end: order.end }, order.number);
  try {
    await client.request("POST", "/api/venue/finances/order/pay", { venueTradeNo: order.number, isApp: 0, ...(amount.gt(0) ? { payType: 1, paySecret: cardSecret(password!) } : {}) }, opts.confirm);
  } catch (e) {
    if (e instanceof RemoteRejected) { opts.journal.resolve(op, "rejected", order.number); return pending(e.message); }
    if (e instanceof RateLimited) return { status: "unknown", message: "付款过程中被限流，无法确认是否扣款；已停止，不重复付款", order: orderView(order) };
    // A transport or authentication failure cannot prove payment was rejected.
  }
  let confirmed: Order | undefined;
  try { confirmed = await verify(client, order.number); } catch { /* Preserve pending journal for the next invocation. */ }
  if (confirmed && done(confirmed) && confirmed.siteId === site.id && confirmed.date === order.date && confirmed.start === order.start && confirmed.end === order.end) {
    opts.journal.resolve(op, "booked", order.number); return { status: "booked", message: "预约、付款或零元确认均已完成，并已回查", order: orderView(confirmed) };
  }
  return { status: "unknown", message: "付款或零元确认尚无法核实，未重复付款，请到 App 核对", order: orderView(confirmed ?? order) };
}
export async function bookVenue(client: VenueApi, opts: BookingOptions): Promise<VenueResult> {
  if (!opts.confirm || !writeAllowed()) throw new WriteGateClosed("体艺场馆预约");
  if (!opts.sport && !opts.venue) throw new ConfigError("预约需指定运动或场馆名称");
  if (opts.maxFee !== undefined && (!/^\d+(?:\.\d{1,2})?$/.test(opts.maxFee))) throw new ConfigError("最高费用须为非负金额，最多两位小数");
  const now = opts.now ?? Date.now, wait = opts.wait ?? (ms => sleep(ms, undefined, opts.signal ? { signal: opts.signal } : {}));
  targetDate(opts.date, now());
  if (atDate(opts.date, opts.time.start) <= now()) throw new ConfigError("目标时段已经开始或已过期，请选择当天尚未开始或未来日期的时段");
  const recovered = await recover(client, opts.journal, opts.date, opts.time); if (recovered) return recovered;
  const catalog = await client.catalog(), site = chooseSite(catalog.sites, opts), notice = await client.notice();
  if (opts.time.end && /羽毛球|网球/.test(site.sport + site.name) && /每个账户单天最多可预约1场次/.test(notice.content.replace(/\s/g, "")) && atDate(opts.date, opts.time.end) - atDate(opts.date, opts.time.start) > 3600_000) return { status: "needs-input", message: "当前预约须知限制该类场地每账号每天一场次、每场次一小时，不能自动缩短您指定的时段", venue: siteName(site) };
  const existing = await readOrders(client);
  if (!existing.complete) return { status: "unknown", message: "本人订单尚未取全，未开始新预约" };
  const same = existing.orders.filter(o => sameTarget(o, site, opts.date, opts.time) && active(o));
  if (same.length > 1) return { status: "needs-input", message: "同一目标有多笔订单，需先核对", orders: same.map(orderView) };
  if (same[0]) return done(same[0]) ? { status: "already-booked", message: "该时段已有有效预约，无需重复预约", order: orderView(same[0]) } : payAndVerify(client, site, same[0], opts);
  const solver = opts.solver ?? new CaptchaSolver(opts.signal);
  try {
    if (now() >= opts.deadline || opts.signal?.aborted) return { status: "aborted", message: "预约处理已到期或取消，未提交" };
    const day = await client.day(site, opts.date);
    if (!day.open) {
      const release = Number.isFinite(day.days) ? releaseAt(site, opts.date, day.days, notice, now()) : undefined;
      return { status: "not-released", message: "目标日期尚未开放预约，请在放号后重新选择；本次未等待或提交",
        date: opts.date, venue: siteName(site), ...(release !== undefined ? { releaseAt: localTime(release) } : {}) };
    }
    if (atDate(opts.date, opts.time.start) <= now()) return { status: "unavailable", message: "目标时段已开始，未提交预约" };
    const maximum = Math.min(2, catalog.maxSlots, site.maxSlots);
    const possible = selectSlots({ ...day, slots: day.slots.map(slot => ({ ...slot, status: 1 })) }, opts.time, maximum, now());
    if (!possible) return { status: "needs-input", message: "指定时间不对应该场馆一至两格连续时段，请从相邻时段中明确选择；未缩短或拆分预约", venue: siteName(site), date: opts.date, alternatives: nearbyTimes(day, opts.time) };
    const slots = selectSlots(day, opts.time, maximum, now());
    if (!slots) return { status: "unavailable", message: "当前没有指定完整时段的空场，本次未等待或提交", date: opts.date, venue: siteName(site) };
    if (!day.token || !day.weekStart) throw new BadResponse("预约时段缺少提交凭据");
    const effectiveTime = { start: slots[0]!.start, end: slots.at(-1)!.end };
    const params = { venueSiteId: site.id, reservationDate: opts.date, weekStartDate: day.weekStart,
      reservationOrderJson: JSON.stringify(slots.map(s => ({ spaceId: s.spaceId, timeId: s.timeId, venueSpaceGroupId: null }))), schoolType: 1, token: day.token };
    const previewAt = now(), preview = row(await client.request("POST", "/api/reservation/order/info", params));
    if (!Object.keys(row(preview.venueInfoBean)).length) throw new BadResponse("预下单未返回场馆规则");
    if (!text(preview.phone)) throw new NeedsUser("预约账号未返回联系电话，请在场馆平台补齐");
    const buddies = opts.companions ? await opts.companions(client, preview) : await companionParams(client, preview, opts.buddy, opts.signal);
    const verification = Number(preview.isCaptchaCheck) === 1 ? await captcha(client, solver) : undefined;
    await wait(Math.max(0, 1500 - (now() - previewAt)));
    if (now() >= opts.deadline || opts.signal?.aborted) return { status: "aborted", message: "预约处理已到期或取消，未提交" };
    if (atDate(opts.date, effectiveTime.start) <= now()) return { status: "unavailable", message: "目标时段已经开始，未提交预约" };
    const op = opts.journal.begin("submit", site, opts.date, effectiveTime);
    let submitted: unknown;
    try {
      submitted = await client.request("POST", "/api/reservation/order/submit", { ...params, phone: preview.phone, ...buddies, ...(verification ? { captchaVerification: verification } : {}), isOfflineTicket: 1 }, opts.confirm);
    } catch (e) {
      if (e instanceof RemoteRejected) {
        opts.journal.resolve(op, "rejected");
        return { status: "rejected", message: e.message };
      }
      if (!(e instanceof RateLimited)) {
        try {
          const check = await readOrders(client), found = check.orders.filter(o => sameTarget(o, site, opts.date, effectiveTime) && active(o));
          if (check.complete && found.length === 1) { opts.journal.resolve(op, "recovered", found[0]!.number); return payAndVerify(client, site, found[0]!, opts); }
        } catch { /* Ambiguous write remains unresolved. */ }
      }
      return { status: "unknown", message: e instanceof RateLimited ? "提交后遇到限流，结果未确认，已停止且未重复提交" : "预约提交结果不明，回查未能确认；本次未重复提交" };
    }
    const raw = row(row(submitted).orderInfo), number = text(raw.tradeNo);
    if (!number) return { status: "unknown", message: "提交返回缺少订单号，不能确认预约成功，请到 App 核对" };
    opts.journal.resolve(op, "created", number);
    const parsed = parseOrder(raw);
    const order: Order = { ...parsed, number, siteId: site.id, venue: siteName(site), date: opts.date, start: effectiveTime.start, end: effectiveTime.end,
      status: Number.isFinite(parsed.status) ? parsed.status : 1, payStatus: Number.isFinite(parsed.payStatus) ? parsed.payStatus : 1 };
    return payAndVerify(client, site, order, opts);
  } catch (e) {
    if (opts.journal.pending().some(op => op.date === opts.date && op.start === opts.time.start)) return { status: "unknown", message: "写入已经发起，但记录或回查未完成，请到 App 核对；本次没有重复写入" };
    if (opts.signal?.aborted) return { status: "aborted", message: "预约处理已结束；没有再次提交" };
    if (e instanceof RateLimited) return { status: "rate-limited", message: e.message };
    throw e;
  } finally { solver.close(); }
}

export async function cancelVenue(client: VenueApi, opts: { date: string; time: TimeRange; venue?: string; confirm: boolean; journal: VenueJournal }): Promise<VenueResult> {
  if (!opts.confirm || !writeAllowed()) throw new WriteGateClosed("取消体艺场馆预约");
  const recovered = await recover(client, opts.journal, opts.date, opts.time); if (recovered) return recovered;
  const list = await readOrders(client);
  if (!list.complete) return { status: "unknown", message: "本人订单尚未取全，未执行取消" };
  const matches = list.orders.filter(o => o.date === opts.date && o.start === opts.time.start && (!opts.time.end || o.end === opts.time.end) && (!opts.venue || venueMatches(o, opts.venue)));
  const found = matches.some(o => o.status !== 2) ? matches.filter(o => o.status !== 2) : matches;
  if (found.length !== 1) return { status: "needs-input", message: found.length ? "有多笔符合条件的订单，请指定场馆" : "未找到指定预约", orders: found.map(orderView) };
  const order = found[0]!;
  if (order.status === 2) return { status: "already-cancelled", message: "该预约已经取消", order: orderView(order) };
  if (money(order.amount).gt(0)) return { status: "not-cancellable", message: "按场馆已知规则，收费预约不执行取消", order: orderView(order) };
  const site: Site = { id: order.siteId, venue: order.venue, campus: "", name: "", sport: "", maxSlots: 1 };
  const op = opts.journal.begin("cancel", site, order.date, { start: order.start, end: order.end }, order.number);
  try { await client.request("POST", "/api/venue/finances/order/cancel", { venueTradeNo: order.number }, opts.confirm); }
  catch (e) {
    if (e instanceof RemoteRejected) { opts.journal.resolve(op, "rejected"); return { status: "not-cancellable", message: e.message, order: orderView(order) }; }
    if (e instanceof RateLimited) return { status: "unknown", message: "取消时遇到限流，结果无法确认，未重复取消", order: orderView(order) };
  }
  let checked: Order | undefined; try { checked = await verify(client, order.number); } catch { /* Unresolved journal survives. */ }
  if (checked?.status === 2) { opts.journal.resolve(op, "cancelled", order.number); return { status: "cancelled", message: "预约已取消并回查确认", order: orderView(checked) }; }
  return { status: "unknown", message: "取消结果尚未确认，未重复取消，请到 App 核对", order: orderView(order) };
}
