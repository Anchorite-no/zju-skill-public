/** zjuam module CLI; business calls stay inside this module. */
import { command, sessionCommands, bool, type Command } from "../core/command.ts";
import { credentials } from "../profile/profile.ts";
import { HttpClient } from "../core/http.ts";
import { Zjuam, requirements } from "./login.ts";
import { openContext } from "../webvpn/transport.ts";

const local = () => new Zjuam({ ...credentials(), http: new HttpClient() });

export const zjuamCommands: Record<string, Command> = sessionCommands({
  login: command("统一身份认证登录并保存会话", { fresh: { description: "强制重新登录", type: "boolean" } }, async (f) => {
    const ctx = await openContext({ ...requirements, auth: "cas" });
    try {
      const z = ctx.zjuam!;
      await z.login(bool(f, "fresh"));
      return { username: z.username, session: { file: z.store.file, ageMs: z.store.status().ageMs ?? 0 } };
    } finally { ctx.close(); }
  }),
  status: command("本地会话状态（不联网）", {}, async () => { const z = local(); return { username: z.username, hasTgtInCache: z.hasTgt, ...z.store.status() }; }, "local"),
  logout: command("清除本地会话", {}, async () => { local().logout(); return { cleared: true }; }, "local"),
}, "zjuam");
