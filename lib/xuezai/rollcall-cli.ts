import { command, group, num, type Command } from "../core/command.ts";
import { NeedsUser, ZjuError } from "../core/errors.ts";
import { log } from "../core/output.ts";
import { openXuezai } from "./client.ts";
import { writeSetup } from "./cli-common.ts";
import { signin, answered, listRollcalls, rollcallHistory } from "./rollcall.ts";
import { signinNumber } from "./rollcall-number.ts";
import { signinAll } from "./rollcall-all.ts";

export function createRollcallCommand(open: typeof openXuezai = openXuezai, kind: "gps" | "number" | "all" = "gps"): Command {
  const description = kind === "gps" ? "GPS/雷达签到：仅监测雷达点名，不启动数字签到或字幕；成功立即停止"
    : kind === "number" ? "数字签到：准备课堂字幕，监测数字点名、取码并回查；成功立即停止"
    : "签到全开：组合 GPS 和数字执行器，任一路确认成功后两路一起停止";
  return command(description, {
    interval: { description: "轮询间隔，秒", type: "number", min: 1, max: 3600, default: 4 },
    duration: { description: "最长等待时间，秒，不设上限；默认 600 即单次签到挂 10 分钟，成功提前结束", type: "number", min: 1, default: 600 },
    confirm: { description: "执行已授权签到，同时设置 ZJU_ALLOW_WRITE=1", type: "boolean" },
  }, async f => {
    const setup = writeSetup(f, "学在浙大签到");
    const controller = new AbortController(), stop = () => controller.abort();
    // The deadline bounds login and in-flight requests too; re-arm instead of overflowing Node's 32-bit timer delay.
    const durationMs = num(f, "duration") * 1000, deadline = Date.now() + durationMs;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) controller.abort(new DOMException("签到等待时间已到", "TimeoutError"));
      else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
    };
    arm();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      const client = await open({ signal: controller.signal });
      try {
        const execute = kind === "gps" ? signin : kind === "number" ? signinNumber : signinAll;
        const result = { ...await execute(client, { confirm: true, journal: setup.journal, signal: controller.signal,
          pollMs: num(f, "interval") * 1000, durationMs, onEvent: log }), journalFile: setup.journalFile };
        if (result.status === "signed" || result.status === "already-signed") return result;
        const error = new NeedsUser(result.message);
        error.detail.result = result; throw error;
      } finally { client.close(); }
    } catch (error) {
      if (error instanceof ZjuError) error.detail.journalFile = setup.journalFile;
      throw error;
    } finally { clearTimeout(timer!); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  });
}
const TYPES = (row: { is_radar?: unknown; is_number?: unknown }) => row.is_radar ? "雷达" : row.is_number ? "数字" : "其他";
export const rollcallCommands: Record<string, Command> = {
  rollcall: group("签到：本身是 GPS/雷达签到；子命令为数字签到、全开、当前点名、历史记录", {
    number: createRollcallCommand(openXuezai, "number"),
    all: createRollcallCommand(openXuezai, "all"),
    status: command("现在有没有点名、本人是否已签；只查看，不签到", {}, async () => {
      const client = await openXuezai();
      try {
        const rows = await listRollcalls(client), pending = rows.filter(row => !answered(row)).length;
        return { status: rows.length ? "active" : "no-active-rollcall", pending,
          message: rows.length ? "当前 " + rows.length + " 个点名，" + pending + " 个未完成。" : "本次查询未发现当前点名。",
          items: rows.map(row => ({ course: row.course_title ?? row.title ?? "", type: TYPES(row), signed: answered(row) })) };
      } finally { client.close(); }
    }),
    history: command("历史点名记录：各课程每次点名的时间、方式和是否签到，最近的在前", {
      course: { description: "课程名称，省略时查全部课程" },
    }, async f => {
      const client = await openXuezai();
      try { return await rollcallHistory(client, typeof f.course === "string" ? f.course : undefined); } finally { client.close(); }
    }),
  }, createRollcallCommand()),
};
