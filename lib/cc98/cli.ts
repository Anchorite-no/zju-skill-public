/** CC98 命令注册：参数在这里声明，业务在 index.ts；写命令先过写闸再建会话。 */
import { command, group, retired, sessionCommands, bool, type Command, type Flags, type Option } from "../core/command.ts";
import { exclusive } from "../core/cli.ts";
import { ConfigError, WriteGateClosed } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { cc98Accounts } from "../profile/profile.ts";
import { Cc98Auth } from "./auth.ts";
import { checkImages } from "./api.ts";
import { parseKeywords, type SortKey } from "./query.ts";
import * as cc98 from "./index.ts";

type Options = Record<string, Option>;
type Session = cc98.Cc98Session;

const ACCOUNT: Options = { account: { description: "CC98 用户名或序号，有多个账号时选用；默认第 1 个" } };
const PAGING: Options = {
  from: { description: "从第几条开始，0 为最新一条", type: "integer", min: 0, default: 0 },
  size: { description: "取几条，服务端单次最多 20", type: "integer", min: 1, max: 20, default: 10 },
};
const CONFIRM: Options = { confirm: { description: "确认执行；同时需要环境变量 ZJU_ALLOW_WRITE=1", type: "boolean" } };
const IMAGE: Options = { image: { description: "附带的本地图片路径，多张用 | 分隔；上传后按顺序接在正文后面" } };
const postId = (what: string): Option => ({ description: `${what}的楼层 ID（topic 结果里的 postId）`, type: "integer", min: 1, required: true });
const TOPIC: Option = { description: "主题 ID 或帖子链接", required: true };
/** --id 给出的那一个帖子 */
const topicOf = (f: Flags): number => {
  const ids = cc98.parseTopicIds(text(f, "id") ?? "");
  if (ids.length > 1) throw new ConfigError("这条命令一次只对一个帖子");
  return ids[0]!;
};

const text = (f: Flags, key: string) => (typeof f[key] === "string" ? f[key] : undefined);
const int = (f: Flags, key: string) => (f[key] === undefined ? undefined : Number(f[key]));
const page = (f: Flags) => ({ from: int(f, "from") ?? 0, size: int(f, "size") ?? 10 });
/** --image 给出的图片路径；格式不对或文件不存在在这里就报错，不等到登录之后 */
const images = (f: Flags) => {
  const list = text(f, "image")?.split(/[|｜]/).map((file) => file.trim()).filter(Boolean);
  return list?.length ? checkImages(list).map((image) => image.path) : undefined;
};
/** 发送类命令：正文和图片至少给一样；返回检查过的图片路径 */
const needsContent = (f: Flags) => {
  const attached = images(f);
  if (!text(f, "content")?.trim() && !attached) throw new ConfigError("需要 --content 正文，或用 --image 附带图片");
  return attached;
};
const localAuth = (a: { username: string; password: string }) => new Cc98Auth({ ...a, ctx: undefined as never });

export function createCc98Commands(open: typeof cc98.openCc98 = cc98.openCc98): Record<string, Command> {
  async function session<T>(f: Flags, fn: (s: Session) => Promise<T>, fresh = false): Promise<T> {
    const account = text(f, "account");
    const s = await open({ ...(account ? { account } : {}), ...(fresh ? { fresh } : {}) });
    try {
      return await fn(s);
    } finally {
      s.close();
    }
  }
  const read = (description: string, options: Options, fn: (s: Session, f: Flags) => Promise<unknown>) =>
    command(description, { ...options, ...ACCOUNT }, (f) => session(f, (s) => fn(s, f)));
  /** 写命令：缺 ZJU_ALLOW_WRITE=1 或 --confirm 时不登录、不发请求 */
  const write = <P = undefined>(action: string, description: string, options: Options, fn: (s: Session, f: Flags, gate: { confirm: true }, prepared: P) => Promise<unknown>, prepare?: (f: Flags) => P) =>
    command(description, { ...options, ...CONFIRM, ...ACCOUNT }, (f) => {
      const prepared = prepare?.(f) as P;
      if (!bool(f, "confirm") || !writeAllowed()) throw new WriteGateClosed(action);
      return session(f, (s) => fn(s, f, { confirm: true }, prepared));
    });

  /** 版面命令共用：--name 版面名称 或 --id 版面ID */
  const BOARD: Options = { name: { description: "版面名称" }, id: { description: "版面 ID，与 --name 二选一", type: "integer", min: 1 } };
  const boardOf = (s: Session, f: Flags) => {
    exclusive(f, ["name", "id"]);
    const target = text(f, "name") ?? text(f, "id");
    if (!target) throw new ConfigError("需要 --name 版面名称 或 --id 版面ID");
    return cc98.resolveBoard(s, target);
  };

  const commands: Record<string, Command> = {
    login: command("取 CC98 token 并缓存", { ...ACCOUNT, fresh: { description: "丢弃缓存重新登录", type: "boolean" } },
      (f) => session(f, async (s) => ({ ...s.auth.status(), accounts: cc98Accounts().map((a) => `${a.index}:${a.username}`) }), bool(f, "fresh"))),
    status: command("本地 token 缓存状态（不联网）", {}, async () => ({ accounts: cc98Accounts().map((a) => localAuth(a).status()) })),
    logout: command("清除本地 token 缓存", { ...ACCOUNT, all: { description: "清除全部账号", type: "boolean" } }, async (f) => {
      exclusive(f, ["account", "all"]);
      const selected = text(f, "account");
      const list = bool(f, "all") ? cc98Accounts() : cc98Accounts().filter((a, i) => (selected ? a.username === selected || String(a.index) === selected : i === 0));
      if (!list.length) throw new ConfigError(`找不到 CC98 账号${selected ? `“${selected}”` : ""}`);
      return { cleared: list.map((a) => ({ username: a.username, removed: localAuth(a).logout() })) };
    }),

    // ----- 全站页面与用户 -----
    hot: read("十大，或本周、本月、历史热门", { period: { description: "时间范围", choices: ["today", "weekly", "monthly", "history"], default: "today" } },
      (s, f) => cc98.hot(s, text(f, "period") as "today" | "weekly" | "monthly" | "history")),
    search: read("搜帖子标题。服务端只做子串匹配，标题里可能出现的几种说法（全名、简称、别的叫法）一次给完", {
      keyword: { description: "关键词；几种说法用顿号或 | 分隔，一次最多 10 个；'A B'（空格）表示标题同时含 A 和 B", required: true },
      board: { description: "只搜该版面，版面名称或 ID" },
      sort: { description: "relevance 相关度，recent 最后回复时间，replies 回复数", choices: ["relevance", "recent", "replies"], default: "relevance" },
      "within-days": { description: "只留最近 N 天有回复的", type: "integer", min: 1 },
      limit: { description: "最多返回几条", type: "integer", min: 1, max: 100, default: 30 },
    }, async (s, f) => {
      const [keywords, board, withinDays] = [parseKeywords(text(f, "keyword")!), text(f, "board"), int(f, "within-days")];
      return cc98.search(s, { keywords, sort: text(f, "sort") as SortKey, limit: int(f, "limit")!, ...(board ? { boardId: await cc98.resolveBoard(s, board) } : {}), ...(withinDays !== undefined ? { withinDays } : {}) });
    }),
    user: read("用户资料", { name: { description: "用户名" }, id: { description: "用户 ID，与 --name 二选一", type: "integer", min: 1 }, topics: { description: "附上其最近 10 个主题", type: "boolean" } }, (s, f) => {
      exclusive(f, ["name", "id"]);
      const [name, id] = [text(f, "name"), int(f, "id")];
      if (name === undefined && id === undefined) throw new ConfigError("需要 --name 用户名 或 --id 用户ID");
      return cc98.viewUserPage(s, { ...(name !== undefined ? { name } : {}), ...(id !== undefined ? { id } : {}), topics: bool(f, "topics") });
    }),

    // ----- 版面 -----
    board: group("版面：版面列表、版内主题、发主题用的标签、发主题", {
      list: read("我关注的版面；也可按名称找版面或列出全站版面", { keyword: { description: "按名称找版面" }, all: { description: "列出全站版面（按分区）", type: "boolean" } }, (s, f) => {
        exclusive(f, ["keyword", "all"]);
        const keyword = text(f, "keyword");
        return cc98.boards(s, { all: bool(f, "all"), ...(keyword ? { keyword } : {}) });
      }),
      topics: read("版面的主题列表", { ...BOARD, top: { description: "只看置顶", type: "boolean" }, ...PAGING },
        async (s, f) => cc98.viewBoard(s, await boardOf(s, f), { ...page(f), top: bool(f, "top") })),
      tags: read("该版发主题用的标签", BOARD, async (s, f) => cc98.boardTags(s, await boardOf(s, f))),
      post: write("cc98 board post", "发主题，可带图片。发出后不能删只能编辑，正文先给用户过目；有的版面必须选标签，先用 board tags 查", {
        board: { description: "版面名称或 ID", required: true },
        title: { description: "标题", required: true },
        content: { description: "正文；只发图片时可以不给" },
        ...IMAGE,
        markdown: { description: "正文按 Markdown 发，默认 UBB", type: "boolean" },
        anonymous: { description: "匿名发帖（限允许匿名的版面）", type: "boolean" },
        tag1: { description: "第一层标签 ID", type: "integer", min: 1 },
        tag2: { description: "第二层标签 ID", type: "integer", min: 1 },
        type: { description: "0 普通，1 校园活动，2 学术信息", type: "integer", min: 0, max: 2, default: 0 },
      }, (s, f, gate, attached) => {
        const [tag1, tag2] = [int(f, "tag1"), int(f, "tag2")];
        return cc98.post(s, text(f, "board")!, text(f, "title")!, text(f, "content") ?? "", {
          ...gate, anonymous: bool(f, "anonymous"), markdown: bool(f, "markdown"), type: int(f, "type")!,
          ...(tag1 !== undefined ? { tag1 } : {}), ...(tag2 !== undefined ? { tag2 } : {}), ...(attached ? { images: attached } : {}),
        });
      }, needsContent),
    }),

    // ----- 帖子 -----
    topic: group("帖子：看帖、回帖、收藏、下载帖内文件", {
      view: read("看帖：主楼、全部热门回复和一页楼层，正文都是全文；可一次看多个帖、连读多页、只看楼主或某一楼的作者、只留含某些词的楼层", {
        id: { description: "主题 ID 或帖子链接；多个用 | 分隔，最多 10 个，各给第一页", required: true },
        page: { description: "第几页，每页 10 楼，默认第 1 页；连读多页写成 2-5，一次最多 10 页" },
        lz: { description: "只看楼主在本帖的全部楼层（每页 20 楼）", type: "boolean" },
        trace: { description: "只看第 N 楼的作者在本帖的全部楼层，匿名帖也可以（每页 20 楼）", type: "integer", min: 1 },
        find: { description: "只返回作者自己的话里含这些词之一的楼层，并给出扫了多少楼、命中多少；几个词用顿号或 | 分隔。不给 --page 时从头扫整个帖，一次最多 30 页" },
      }, (s, f) => {
        exclusive(f, ["lz", "trace"]);
        const [ids, only, words, range] = [cc98.parseTopicIds(text(f, "id")!), bool(f, "lz") ? 1 : int(f, "trace"), text(f, "find"), text(f, "page")];
        const find = words === undefined ? undefined : cc98.parseFindWords(words);
        const pages = range === undefined ? undefined : cc98.parsePages(range, find !== undefined);
        if (ids.length > 1 && (only !== undefined || find || (pages && pages[1] > 1))) throw new ConfigError("多个帖子只给各自的第一页；翻页、只看楼主、按词筛选请一次只看一个帖");
        return cc98.viewTopics(s, ids, { ...(pages ? { pages } : {}), ...(only !== undefined ? { only } : {}), ...(find ? { find } : {}) });
      }),
      reply: write<{ id: number; attached: string[] | undefined }>("cc98 topic reply", "回帖，可引用某一楼、可带图片。发出后不能删只能编辑，正文先给用户过目；内容必须是用户自己的话", {
        id: TOPIC,
        content: { description: "回复正文；只发图片时可以不给" },
        quote: { description: "引用第几楼（楼层号来自 topic view），引用块由命令生成", type: "integer", min: 1 },
        ...IMAGE,
        markdown: { description: "正文按 Markdown 发，默认 UBB", type: "boolean" },
        anonymous: { description: "匿名回复（限允许匿名的版面）", type: "boolean" },
        force: { description: "最后一楼已是自己 5 分钟内发的相同内容时仍然发送", type: "boolean" },
      }, (s, f, gate, target) => {
        const quote = int(f, "quote");
        return cc98.reply(s, target.id, text(f, "content") ?? "", { ...gate, ...(quote !== undefined ? { quote } : {}), markdown: bool(f, "markdown"), anonymous: bool(f, "anonymous"), force: bool(f, "force"), ...(target.attached ? { images: target.attached } : {}) });
      }, (f) => ({ id: topicOf(f), attached: needsContent(f) })),
      favorite: write("cc98 topic favorite", "收藏主题，加 --cancel 是取消收藏", {
        id: TOPIC,
        cancel: { description: "取消收藏", type: "boolean" },
      }, (s, f, gate, id) => s.api.setFavorite(id, !bool(f, "cancel"), gate), topicOf),
      download: read("下载帖子某一楼的全部图片、视频、附件，或单个 file.cc98.org 链接；存到 data/output/cc98/，返回本地路径，下载过的直接复用", {
        id: { ...TOPIC, required: false },
        floor: { description: "楼层号，默认 1 楼", type: "integer", min: 1 },
        url: { description: "单个文件链接（私信、消息里的图片也用它），与 --id 二选一" },
      }, (s, f) => {
        exclusive(f, ["id", "url"]);
        exclusive(f, ["url", "floor"]);
        const url = text(f, "url");
        if (text(f, "id") === undefined && url === undefined) throw new ConfigError("需要 --id 主题ID 或 --url 文件链接");
        return cc98.download(s, url !== undefined ? { url } : { topicId: topicOf(f), floor: int(f, "floor") ?? 1 });
      }),
    }),

    // ----- 楼层 -----
    floor: group("楼层：赞踩、评分、编辑自己的楼层", {
      like: write("cc98 floor like", "赞、踩楼层，或取消", {
        post: postId("目标"),
        state: { description: "like 赞，dislike 踩，none 取消", choices: ["like", "dislike", "none"], required: true },
      }, (s, f, gate) => cc98.setReaction(s, int(f, "post")!, text(f, "state") as "like" | "dislike" | "none", gate)),
      rate: write("cc98 floor rate", "给楼层评分（风评）；每天有次数限制，发帖数不足 500 不能评", {
        post: postId("目标"),
        type: { description: "plus 加分，minus 扣分", choices: ["plus", "minus"], default: "plus" },
        reason: { description: "理由 ID，来自 floor rating-reasons", type: "integer", min: 1, required: true },
      }, (s, f, gate) => s.api.rate(int(f, "post")!, text(f, "type") === "minus" ? 2 : 1, int(f, "reason")!, gate)),
      "rating-reasons": read("评分可选的理由（加分、扣分各一组）", {}, (s) => cc98.ratingReasons(s)),
      original: read("自己某一楼的原文（UBB/Markdown 原样），编辑前用", { post: postId("自己") }, (s, f) => cc98.original(s, int(f, "post")!)),
      edit: write("cc98 floor edit", "编辑自己的楼层；先用 floor original 取原文。标题和格式不给时沿用原帖", {
        post: postId("要编辑"),
        content: { description: "新的完整正文", required: true },
        title: { description: "新标题，只对主题楼（1 楼）有效" },
        markdown: { description: "正文改按 Markdown 发", type: "boolean" },
      }, (s, f, gate) => {
        const title = text(f, "title");
        return s.api.editPost(int(f, "post")!, text(f, "content")!, { ...gate, ...(title !== undefined ? { title } : {}), ...(bool(f, "markdown") ? { contentType: 1 as const } : {}) });
      }),
    }),

    // ----- 私信 -----
    "private-message": group("私信：会话列表、与某人的对话、发私信", {
      list: read("最近的私信会话；有未读的会话直接带出对话", PAGING, (s, f) => cc98.messages(s, page(f))),
      view: read("与某人的私信对话，从早到晚", { user: { description: "对方用户名", required: true }, ...PAGING }, (s, f) => cc98.messages(s, { ...page(f), user: text(f, "user")! })),
      send: write("cc98 private-message send", "发私信，可带图片。发出后不能撤回，内容用用户给的原话；5 分钟内给同一人的相同内容不重复发", {
        user: { description: "对方用户名", required: true },
        content: { description: "私信内容；只发图片时可以不给" },
        ...IMAGE,
        force: { description: "确实要把相同内容再发一遍", type: "boolean" },
      }, (s, f, gate, attached) => cc98.sendMessage(s, text(f, "user")!, text(f, "content") ?? "", { ...gate, force: bool(f, "force"), ...(attached ? { images: attached } : {}) }), needsContent),
    }),

    // ----- 个人中心 -----
    account: group("个人中心：资料、我的主题与回复、收藏、关注、消息、签到", {
      overview: read("个人中心总览：财富、风评、发帖数、签到状态、各类未读数、关注的版面", {}, (s) => cc98.overview(s)),
      topics: read("我发的主题", PAGING, (s, f) => cc98.myTopics(s, page(f).from, page(f).size)),
      posts: read("我的回复", { hot: { description: "按被赞数排序", type: "boolean" }, ...PAGING }, (s, f) => cc98.myPosts(s, { ...page(f), hot: bool(f, "hot") })),
      history: read("浏览记录", PAGING, (s, f) => cc98.history(s, page(f).from, page(f).size)),
      favorites: read("收藏的主题，同时列出收藏分组", { group: { description: "收藏分组 ID，默认分组为 0", type: "integer", min: 0, default: 0 }, keyword: { description: "在收藏里按标题搜" }, ...PAGING }, (s, f) => {
        const keyword = text(f, "keyword");
        return cc98.favorites(s, { ...page(f), group: int(f, "group")!, ...(keyword ? { keyword } : {}) });
      }),
      following: read("我关注的用户，或我的粉丝", { fans: { description: "看粉丝", type: "boolean" }, ...PAGING }, (s, f) => cc98.following(s, { ...page(f), fans: bool(f, "fans") })),
      feed: read("关注的版面或关注的用户的新帖", { kind: { description: "boards 关注的版面，users 关注的用户", choices: ["boards", "users"], default: "boards" }, ...PAGING },
        (s, f) => cc98.feed(s, text(f, "kind") as "boards" | "users", page(f).from, page(f).size)),
      notifications: read("消息：回复我的、@ 我的、系统通知，带主题和正文；有未读私信时一并列出", { kind: { description: "只看一类；不给则汇总全部", choices: ["reply", "at", "system"] }, ...PAGING },
        (s, f) => cc98.notifications(s, text(f, "kind") as "reply" | "at" | "system" | undefined, page(f).from, page(f).size)),
      signin: command("论坛签到，今天已签则直接返回", { confirm: { description: "确认签到（签到不发布内容，不需要 ZJU_ALLOW_WRITE）", type: "boolean" }, all: { description: "依次签 profile 里的全部账号", type: "boolean" }, ...ACCOUNT }, async (f) => {
        exclusive(f, ["account", "all"]);
        const confirm = bool(f, "confirm");
        if (bool(f, "all")) return { accounts: await cc98.forEachAccount((s) => cc98.doSignIn(s, { confirm })) };
        return session(f, (s) => cc98.doSignIn(s, { confirm }));
      }),
      "signin-month": read("某月签到记录与奖励", { year: { description: "年，默认今年", type: "integer", min: 2000 }, month: { description: "月，默认本月", type: "integer", min: 1, max: 12 } }, (s, f) => {
        const now = new Date(Date.now() + 8 * 3600_000);
        return cc98.signInMonth(s, int(f, "year") ?? now.getUTCFullYear(), int(f, "month") ?? now.getUTCMonth() + 1);
      }),
      messages: retired("cc98 private-message list"),
    }),
  };
  sessionCommands(commands, "cc98");
  // 旧的平铺入口只提示新路径，不转发执行
  const moved: Record<string, string> = {
    boards: "board list", "board-tags": "board tags", post: "board post",
    reply: "topic reply", quote: "topic reply --quote 楼层号", favorite: "topic favorite", download: "topic download",
    like: "floor like", rate: "floor rate", "rating-reasons": "floor rating-reasons", original: "floor original", edit: "floor edit",
    messages: "private-message list", message: "private-message send",
    me: "account overview", topics: "account topics", posts: "account posts", history: "account history", favorites: "account favorites",
    following: "account following", feed: "account feed", notifications: "account notifications", signin: "account signin", "signin-month": "account signin-month",
  };
  for (const [old, next] of Object.entries(moved)) commands[old] = retired(`cc98 ${next}`);
  return commands;
}

export const cc98Commands = createCc98Commands();
