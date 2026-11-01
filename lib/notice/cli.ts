import { command, type Command, type Flags } from "../core/command.ts";
import { queryNotices, findNotices, newNotices, listSources, type NoticeQuery } from "./index.ts";

const text = (f: Flags, ...keys: string[]) => Object.fromEntries(keys.filter((k) => typeof f[k] === "string").map((k) => [k, f[k] as string]));

export const noticeCommands: Record<string, Command> = {
  list: command("最新通知的完整标题、正文和附件；默认读本人学院官网、团委、综合服务网，以及按本科生或研究生选的教务、学工来源，自动翻页", {
    keyword: { description: "标题关键词，几个说法用顿号分隔" },
    source: { description: "只看这些来源，写来源名、栏目名或学院名（本人学院写 学院），多个用顿号分隔；全部 表示所有已接来源" },
    since: { description: "起始日期 YYYY-MM-DD" },
    until: { description: "截止日期 YYYY-MM-DD" },
    limit: { description: "条数", type: "integer", min: 1, max: 100, default: 10 },
  }, (f) => queryNotices({ limit: Number(f.limit), ...text(f, "keyword", "source", "since", "until") } as NoticeQuery)),
  view: command("通知的全文、日期和附件；标题不唯一时返回候选", {
    url: { description: "通知链接，多个用竖线分隔；与 --title 二选一" },
    title: { description: "通知标题" },
  }, (f) => findNotices(text(f, "title", "url"))),
  new: command("上次查看之后新发布的通知：只有标题、日期、来源和链接，含本人学院和综合服务网全校通知", {}, () => newNotices()),
  sources: command("已接入的通知来源和栏目，本人学院和可指定的其他学院", {}, () => listSources(), "local"),
};
