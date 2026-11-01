/** Private read-only input for sign-in. It is transported with the existing Zhiyun SSH configuration. */
import { ConfigError } from "../core/errors.ts";
import { queryLiveText } from "./live.ts";
import { liveStatus, startLive, stopLive } from "./live-task.ts";

export type LiveInputRequest = { action: "start"; requestId: string; until: number }
  | { action: "text"; course: string; from: number; to: number }
  | { action: "stop"; requestId: string };

export async function liveInput(request: LiveInputRequest) {
  if ((process.env.ZJU_DISABLED_MODULES ?? "").split(",").some(x => x.trim().toLowerCase() === "zhiyun")) throw new ConfigError("智云模块已禁用");
  if (request.action === "text") {
    if (!request.course?.trim() || !Number.isSafeInteger(request.from) || !Number.isSafeInteger(request.to) || request.to < request.from || request.to - request.from > 600000) throw new ConfigError("签到字幕窗口无效");
    return queryLiveText({ course: request.course, at: request.to, before: (request.to - request.from) / 1000, after: 0 });
  }
  // The id becomes the collector's task id and process argument.
  if (!/^[0-9a-f-]{36}$/.test(request.requestId)) throw new ConfigError("字幕输入任务标识无效");
  // Stopping only affects the task this sign-in started; a lost start response is bounded by its own until.
  if (request.action === "stop") return stopLive(request.requestId);
  if (request.action !== "start" || !Number.isSafeInteger(request.until) || request.until <= Date.now()) throw new ConfigError("字幕输入截止时间无效");
  const current = liveStatus();
  if (["running", "starting"].includes(current.status)) return { ...current, reused: true };
  return startLive(undefined, { id: request.requestId, until: request.until });
}
