import { command, group, bool, type Command, type Flags, type Option } from "../core/command.ts";
import { WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { openSztz, cancelSignUp, listActivities, listBulletins, listProjects, myActivities, myCredits, newActivities, setFavorite, signUp, type Sztz } from "./index.ts";

const NAME: Option = { description: "活动名称，可以只写能唯一确定它的一部分", required: true };
const CONFIRM: Option = { description: "确认执行；同时需要环境变量 ZJU_ALLOW_WRITE=1", type: "boolean" };

const text = (f: Flags, ...keys: string[]) => Object.fromEntries(keys.filter((k) => typeof f[k] === "string").map((k) => [k, f[k] as string]));
const read = (description: string, options: Record<string, Option>, run: (s: Sztz, f: Flags) => Promise<unknown>) =>
  command(description, options, async (f) => { const s = await openSztz(); try { return await run(s, f); } finally { s.close(); } });
/** 写命令：一个命令管做和取消（--cancel）；没有授权时在建立会话之前拒绝 */
const write = (description: string, action: string, undo: string, run: (s: Sztz, name: string, cancel: boolean) => Promise<unknown>) =>
  command(description, { name: NAME, cancel: { description: undo, type: "boolean" }, confirm: CONFIRM }, async (f) => {
    if (!bool(f, "confirm") || !writeAllowed()) throw new WriteGateClosed(action);
    const s = await openSztz();
    try { return await run(s, f.name as string, bool(f, "cancel")); } finally { s.close(); }
  });

const activity = group("活动：活动中心里的活动、我报名和收藏的、报名与取消报名、收藏与取消收藏", {
  list: read("活动中心里还没结束的活动：记点、报名时间与方式、活动时间地点、名额，标出本人已报名和收藏的", {
    keyword: { description: "活动名称或举办单位里的文字" },
    date: { description: "只看这一天的活动 YYYY-MM-DD" },
    "include-ended": { description: "连已结束的活动一起给", type: "boolean" },
    limit: { description: "条数", type: "integer", min: 1, max: 100, default: 30 },
  }, (s, f) => listActivities(s, { limit: Number(f.limit), includeEnded: bool(f, "include-ended"), ...text(f, "keyword", "date") })),
  new: read("上次查看之后新出现、还能报名或还没开始报名的活动：名称、举办单位、记点、活动时间和报名起止，没有简介", {}, (s) => newActivities(s)),
  mine: read("本人在平台上报名的、收藏的和已认定记点的活动", {}, (s) => myActivities(s)),
  signup: write("报名一个活动并回查，加 --cancel 是取消报名（只能在报名截止前）；不在平台报名的活动会说明该怎么报", "二课活动报名或取消报名", "取消报名",
    (s, name, cancel) => cancel ? cancelSignUp(s, name, { confirm: true }) : signUp(s, name, { confirm: true })),
  favorite: write("收藏一个活动并回查，加 --cancel 是取消收藏", "二课活动收藏或取消收藏", "取消收藏",
    (s, name, cancel) => setFavorite(s, name, { confirm: true, cancel })),
});

export const sztzCommands: Record<string, Command> = {
  credits: read("本人第二、三、四课堂的记点、学分和是否达标，美育、劳育是否达标，以及成绩单上的每一条认定记录", {}, (s) => myCredits(s)),
  activity,
  projects: read("可以申请认定记点的项目（学科竞赛、社会实践、就业实习等）及各自的记点范围", {
    keyword: { description: "项目名称里的文字" },
    category: { description: "分类或类别，如 第三课堂、学科竞赛、劳育" },
  }, (s, f) => listProjects(s, text(f, "keyword", "category"))),
  notices: read("平台通知全文：项目审核时间、记点申请流程等", {}, (s) => listBulletins(s)),
};
