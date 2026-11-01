import { command, group, type Command } from "../core/command.ts";
import { openXuezai } from "./client.ts";
import { answered, listRollcalls, rollcallHistory } from "./rollcall.ts";

const TYPES = (row: { is_radar?: unknown; is_number?: unknown }) => row.is_radar ? "雷达" : row.is_number ? "数字" : "其他";
export const rollcallCommands: Record<string, Command> = {
  rollcall: group("点名：当前有没有点名、历史点名记录；只查看，不签到", {
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
  }),
};
