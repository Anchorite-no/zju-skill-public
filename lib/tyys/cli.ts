import { command, group, retired, sessionCommands, bool, type Command, type Flags, type Option } from "../core/command.ts";
import { ConfigError, NeedsUser, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { readProfile } from "../profile/profile.ts";
import { openTyys, tyysSession } from "./client.ts";
import { attendance, history } from "./rollcall.ts";
import { openVenue, listVenues, targetDate, timeRange, type VenueApi } from "./venue.ts";
import { bookVenue, cancelVenue, listOrders, VenueJournal, type VenueResult } from "./booking.ts";
import { setupCaptcha, checkCaptcha } from "./captcha.ts";
const venueFilters: Record<string, Option> = {
  sport: { description: "运动名称，如羽毛球、网球" }, campus: { description: "校区名称，如紫金港" }, venue: { description: "场馆名称，可带校区；重名时返回候选" },
};
function venueFilter(f: Flags) {
  return { ...(typeof f.sport === "string" ? { sport: f.sport } : {}), ...(typeof f.campus === "string" ? { campus: f.campus } : {}), ...(typeof f.venue === "string" ? { venue: f.venue } : {}) };
}
async function useVenue<T>(run: (client: VenueApi) => Promise<T>, publicOnly = false): Promise<T> {
  const client = await openVenue({ publicOnly });
  try { return await run(client); } finally { client.close(); }
}
function finished(result: VenueResult): VenueResult {
  if (["booked", "already-booked", "cancelled", "already-cancelled"].includes(result.status)) return result;
  const error = new NeedsUser(result.message); error.detail.result = result; throw error;
}
const venueCommands = group("场馆：查空场、预约、本人订单和预约须知", {
  list: command("查询体育场馆；未指定唯一场馆时返回目录，日期默认今天", {
    ...venueFilters, date: { description: "今天、明天、后天、0至3天后或 YYYY-MM-DD", default: "今天" }, time: { description: "可选时间 HH:mm 或 HH:mm-HH:mm" },
  }, async f => {
    const date = targetDate(String(f.date)), time = typeof f.time === "string" ? timeRange(f.time) : undefined;
    return useVenue(client => listVenues(client, { ...venueFilter(f), date, ...(time ? { time } : {}) }));
  }),
  notice: command("预约须知全文、各场馆放号时刻及来源；自动复用缓存", {}, async () => useVenue(client => client.notice(), true)),
  book: command("预约当前已开放的空场，自动处理验证码、同伴、付款和回查", {
    ...venueFilters, date: { description: "今天至三天后；相对日期启动时固定", required: true }, time: { description: "HH:mm 或完整区间 HH:mm-HH:mm，最多连续两格且受场馆规则限制", required: true },
    buddy: { description: "已授权配置的同伴姓名；多人用竖线分隔，省略按最少人数自动选择" },
    "max-fee": { description: "可选最高自动付款金额，单位元；价格在建单后才出现，超额时保留未支付订单" },
    confirm: { description: "执行已授权预约，同时设置 ZJU_ALLOW_WRITE=1", type: "boolean", required: true },
  }, async f => {
    if (!bool(f, "confirm") || !writeAllowed()) throw new WriteGateClosed("体艺场馆预约");
    const now = Date.now(), date = targetDate(String(f.date), now), time = timeRange(String(f.time)), filter = venueFilter(f);
    if (!filter.sport && !filter.venue) throw new ConfigError("预约需指定 --sport 或 --venue");
    const maxFee = typeof f["max-fee"] === "string" ? f["max-fee"] : undefined;
    if (maxFee !== undefined && !/^\d+(?:\.\d{1,2})?$/.test(maxFee)) throw new ConfigError("最高费用须为非负金额，最多两位小数");
    const deadline = now + 600_000;
    const controller = new AbortController(), stop = () => controller.abort();
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => { const remaining = deadline - Date.now(); if (remaining <= 0) controller.abort(new Error("预约处理时间已到")); else timer = setTimeout(arm, Math.min(remaining, 2147483647)); };
    arm(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      const client = await openVenue({ signal: controller.signal });
      const journal = new VenueJournal(client.username);
      try { return finished({ ...await bookVenue(client, { ...filter, date, time, confirm: true, deadline, signal: controller.signal, journal,
        ...(typeof f.buddy === "string" ? { buddy: f.buddy } : {}), ...(maxFee !== undefined ? { maxFee } : {}) }), journalFile: journal.file }); }
      finally { client.close(); }
    } finally { clearTimeout(timer!); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  }),
  order: group("本人的场馆预约订单", {
    list: command("本人今天及以后的预约；日期筛选支持明确日期", {
      date: { description: "可选 YYYY-MM-DD 或今天、明天等；可查历史日期" }, venue: { description: "场馆名称筛选" },
    }, async f => {
      const date = typeof f.date === "string" ? targetDate(f.date, Date.now(), false) : undefined;
      return useVenue(client => listOrders(client, { ...(date ? { date } : {}), ...(typeof f.venue === "string" ? { venue: f.venue } : {}) }));
    }),
    cancel: command("定位一个明确的本人预约，取消并回查；收费预约不自动取消", {
      date: { description: "预约日期", required: true }, time: { description: "预约开始时刻或完整区间", required: true }, venue: { description: "场馆名称，用于消除歧义" },
      confirm: { description: "执行已授权取消，同时设置 ZJU_ALLOW_WRITE=1", type: "boolean", required: true },
    }, async f => {
      if (!bool(f, "confirm") || !writeAllowed()) throw new WriteGateClosed("取消体艺场馆预约");
      const date = targetDate(String(f.date), Date.now(), false), time = timeRange(String(f.time));
      return useVenue(async client => { const journal = new VenueJournal(client.username); return finished({ ...await cancelVenue(client, { date, time, confirm: true, journal, ...(typeof f.venue === "string" ? { venue: f.venue } : {}) }), journalFile: journal.file }); });
    }),
  }),
  setup: command("安装本地验证码识别环境与模型，不请求场馆服务器", {}, async () => setupCaptcha(), "local"),
  check: command("检查本地验证码检测、识别和模型，不请求场馆服务器", {}, async () => checkCaptcha(), "local"),
});
function localSession() {
  const username = readProfile().zju_username;
  if (!username) throw new ConfigError("缺少 zju_username");
  return tyysSession(username);
}
export function createTyysCommands(open: typeof openTyys = openTyys): Record<string, Command> {
  const commands = sessionCommands({
    venue: venueCommands,
    rollcall: group("体育课考勤状态与历史，只读", {
      status: command("现在的签到目标与当天到勤结果；只查看，不取码、不提交", {}, async () => {
        const client = await open();
        try { return await attendance(client); } finally { client.close(); }
      }),
      history: command("体育课历史考勤：各学期每次课的日期与到勤状态，最近的在前", {
        course: { description: "体育课名称，省略时查全部学期" },
      }, async f => {
        const client = await open();
        try { return await history(client, typeof f.course === "string" ? f.course : undefined); } finally { client.close(); }
      }),
    }),
    login: command("检查或更新体艺 App 会话", { fresh: { description: "强制重新登录", type: "boolean" } }, async f => {
      const client = await open({ fresh: bool(f, "fresh") });
      try { await client.checkSession(); return { authenticated: true }; } finally { client.close(); }
    }),
    status: command("本地体艺会话状态", {}, async () => localSession().status(), "local"),
    logout: command("移除本地体艺会话", {}, async () => ({ removed: localSession().clear() }), "local"),
  }, "tyys");
  commands.attendance = retired("tyys rollcall status");
  commands["rollcall-history"] = retired("tyys rollcall history");
  return commands;
}
export const tyysCommands = createTyysCommands();
