/**
 * CC98 模块入口：声明、会话组装，以及 CLI 直接调用的任务函数。
 *
 * 声明：auth=own（OAuth password grant，自有账号）、network=campus（10.10.98.98 仅校网，默认经 WebVPN）。
 * 多账号：profile.env 里 cc98_username(_N)/cc98_password(_N)，--account 选用户名或序号。
 * 这里的函数返回整理后的结果：北京时间、纯文本正文、只留后续命令要用的 ID；平台原始字段留在 api.ts。
 */
import type { ModuleRequirements } from "../core/module.ts";
import { openContext, type Context, type OpenOptions } from "../webvpn/transport.ts";
import { cc98Account, cc98Accounts, type Cc98Account } from "../profile/profile.ts";
import { Cc98Auth } from "./auth.ts";
import { Cc98Api, WEB_BASE, plainContent, splitQuote, pageCount, topicUrl, type Award, type BoardBrief, type HotTopic, type Message, type Post, type TopicSummary, type User, type WriteOptions } from "./api.ts";
import { runSearch, splitPhrases, type SearchPlan } from "./query.ts";
import { fileLinks } from "./download.ts";
import { ConfigError, NeedsUser, RemoteRejected } from "../core/errors.ts";
import { uniqueMatch } from "../core/match.ts";
import { beijingMinute, log } from "../core/output.ts";

export const requirements: ModuleRequirements = {
  name: "cc98",
  title: "CC98 论坛",
  hosts: ["cc98.org"],
  auth: "own",
  network: "campus",
  writes: true,
  sessionProbe: "https://api.cc98.org/config/now",
};

export interface Cc98Session {
  ctx: Context;
  account: Cc98Account;
  auth: Cc98Auth;
  api: Cc98Api;
  close(): void;
}

export async function openCc98(opts: { account?: string; fresh?: boolean } & OpenOptions = {}): Promise<Cc98Session> {
  const account = cc98Account(opts.account);
  const ctx = await openContext(requirements, opts);
  const auth = new Cc98Auth({ username: account.username, password: account.password, ctx });
  if (opts.fresh) auth.logout();
  await auth.accessToken();
  return { ctx, account, auth, api: new Cc98Api(ctx, auth), close: () => ctx.close() };
}

/** 对全部账号依次执行（签到等）；单个失败不影响其它 */
export async function forEachAccount<T>(fn: (s: Cc98Session) => Promise<T>): Promise<{ account: string; index: number; ok: boolean; result?: T; error?: string }[]> {
  const out: { account: string; index: number; ok: boolean; result?: T; error?: string }[] = [];
  for (const a of cc98Accounts()) {
    let s: Cc98Session | undefined;
    try {
      s = await openCc98({ account: a.username });
      out.push({ account: a.username, index: a.index, ok: true, result: await fn(s) });
    } catch (err) {
      out.push({ account: a.username, index: a.index, ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      s?.close();
    }
  }
  return out;
}

// ---------- 整理输出用的基本件 ----------

const withZone = (value: string) => (/(?:Z|[+-]\d\d:?\d\d)$/i.test(value) ? value : `${value}+08:00`);

/** 平台时间 → 北京时间「YYYY-MM-DD HH:mm」。多数带 +08:00；十大、签到等不带时区的也是北京时间 */
export function when(value: string | null | undefined): string | null {
  return beijingMinute(value ? withZone(value) : value);
}

export function postDisplayName(p: Pick<Post, "isAnonymous" | "userName">): string {
  return p.isAnonymous ? `匿名${(p.userName ?? "").toUpperCase()}` : (p.userName ?? "（已删除）");
}

/** 楼层在网页里的锚点（官方前端格式：前 10 楼 /topic/ID#楼，之后 /topic/ID/页#页内楼） */
export function floorAnchor(topicId: number, floor: number): string {
  if (floor <= 10) return `/topic/${topicId}#${floor}`;
  return `/topic/${topicId}/${Math.ceil(floor / 10)}#${floor % 10 || 10}`;
}

/** 列表里的主题：搜索、版面、收藏、浏览记录、热门共用 */
export function briefTopic(t: TopicSummary) {
  return {
    id: t.id,
    title: t.title,
    boardId: t.boardId,
    ...(t.boardName ? { boardName: t.boardName } : {}),
    author: t.isAnonymous ? "匿名" : t.userName,
    time: when(t.time),
    lastPostTime: when(t.lastPostTime),
    replyCount: t.replyCount,
    hitCount: t.hitCount,
    ...(t.likeCount || t.dislikeCount ? { likeCount: t.likeCount, dislikeCount: t.dislikeCount } : {}),
    ...(t.isVote ? { isVote: true } : {}),
    url: topicUrl(t.id),
  };
}

/** 十大的条目字段与普通主题不同（authorName、createTime、participantCount） */
function briefHot(t: HotTopic) {
  return { id: t.id, title: t.title, boardId: t.boardId, boardName: t.boardName, author: t.isAnonymous ? "匿名" : t.authorName, time: when(t.createTime), replyCount: t.replyCount, hitCount: t.hitCount, participantCount: t.participantCount, url: topicUrl(t.id) };
}

function briefBoard(b: BoardBrief) {
  return { id: b.id, name: b.name, boardMasters: b.boardMasters ?? [], topicCount: b.topicCount, todayCount: b.todayCount, description: b.description };
}

/** 评分记录合成一行：同一项的分值相加，如「风评值 +5，财富值 +1000」 */
function ratingSummary(awards: Award[]): string {
  const sums = new Map<string, number | undefined>();
  for (const a of awards) {
    const m = /^(.*?)\s*([+-]\s*\d+)$/.exec(a.content.trim());
    if (m) sums.set(m[1] || "评分", (sums.get(m[1] || "评分") ?? 0) + Number(m[2]!.replace(/\s/g, "")));
    else sums.set(a.content.trim(), sums.get(a.content.trim()));
  }
  return [...sums].map(([label, value]) => (value === undefined ? label : `${label} ${value > 0 ? "+" : ""}${value}`)).join("，");
}

/**
 * 楼层：content 是作者自己写的话（纯文本，全文）；quote 是它引用的那一楼（楼层、作者和那一楼自己的话）；
 * files 是本楼自己发的图片、视频、附件链接。踩数、评分、编辑时间、自己的赞踩只在有的时候出现。
 */
export function viewPost(p: Post) {
  const awards = (p.awards ?? []).filter((a) => !a.deleted);
  const { own, quote } = splitQuote(p.content, p.contentType);
  const files = fileLinks(p.content, p.contentType !== 0);
  return {
    postId: p.id,
    floor: p.floor,
    author: postDisplayName(p),
    time: when(p.time),
    ...(p.isLZ ? { isLZ: true } : {}),
    ...(p.isDeleted ? { isDeleted: true } : {}),
    likeCount: p.likeCount,
    ...(p.dislikeCount ? { dislikeCount: p.dislikeCount } : {}),
    ...(p.likeState ? { myReaction: p.likeState === 1 ? "like" : "dislike" } : {}),
    ...(awards.length ? { ratings: ratingSummary(awards) } : {}),
    ...(p.lastUpdateTime ? { edited: when(p.lastUpdateTime) } : {}),
    ...(quote ? { quote } : {}),
    content: own,
    ...(files.length ? { files } : {}),
  };
}

function viewUser(u: User) {
  const signature = plainContent(u.signatureCode ?? "");
  return {
    id: u.id,
    name: u.name,
    levelTitle: u.levelTitle,
    privilege: u.privilege,
    ...(u.groupName ? { groupName: u.groupName } : {}),
    postCount: u.postCount,
    wealth: u.wealth,
    popularity: u.popularity,
    prestige: u.prestige,
    fanCount: u.fanCount,
    followCount: u.followCount,
    receivedLikeCount: u.receivedLikeCount,
    registerTime: when(u.registerTime),
    lastLogOnTime: when(u.lastLogOnTime),
    ...(u.introduction ? { introduction: u.introduction } : {}),
    ...(signature ? { signature } : {}),
    ...(u.isFollowing ? { isFollowing: true } : {}),
    ...(u.lockState ? { state: u.lockState === 3 ? "全站禁言" : "锁定" } : {}),
    portrait: u.portraitUrl,
    url: `${WEB_BASE}/user/id/${u.id}`,
  };
}

// ---------- 名称到 ID ----------

/** 用户名 → 用户。纯数字且没有同名用户时按用户 ID 取 */
async function resolveUser(s: Cc98Session, name: string): Promise<User> {
  const wanted = name.trim();
  try {
    return await s.api.userByName(wanted);
  } catch (err) {
    if (!(err instanceof RemoteRejected)) throw err;
    if (/^\d+$/.test(wanted)) return s.api.user(Number(wanted));
    throw new NeedsUser(`CC98 没有用户“${wanted}”`, "用户名要完整一致，可从私信列表的 user 或帖子楼层的 author 取");
  }
}

/** 版面名称或 ID → 版面 ID；名称不唯一时报出候选，不猜 */
export async function resolveBoard(s: Cc98Session, board: string): Promise<number> {
  const wanted = board.trim();
  if (/^\d+$/.test(wanted)) return Number(wanted);
  return uniqueMatch(await s.api.boardSearch(wanted), wanted, (b) => [b.name], (b) => ({ id: b.id, name: b.name }), "版面").id;
}

// ---------- 签到与个人中心 ----------

export interface SignInResult {
  username: string;
  /** signed：本次签到成功；already：今天已签；failed：服务端拒绝 */
  status: "signed" | "already" | "failed";
  reward?: number;
  streak: number;
  lastSignInTime: string | null;
  raw?: string;
}

export async function doSignIn(s: Cc98Session, opts: WriteOptions): Promise<SignInResult> {
  const before = await s.api.signInInfo();
  if (before.hasSignedInToday) {
    return { username: s.account.username, status: "already", reward: before.lastReward, streak: before.lastSignInCount, lastSignInTime: when(before.lastSignInTime) };
  }
  if (!opts.confirm) {
    // 签到幂等、不发布任何内容：只要求 --confirm，不要求 ZJU_ALLOW_WRITE（见 references/cc98.md）
    throw new ConfigError("签到需要 --confirm", "zju cc98 account signin --confirm（多账号加 --all）");
  }
  let raw = "";
  let status: SignInResult["status"] = "failed";
  try {
    const r = await s.api.signIn();
    raw = r.raw;
    status = r.status === 200 ? "signed" : "failed";
  } catch (err) {
    raw = err instanceof Error ? err.message : String(err);
    if (/has_signed_in_today/.test(raw)) status = "already";
  }
  const after = await s.api.signInInfo();
  const out: SignInResult = { username: s.account.username, status: after.hasSignedInToday && status === "failed" ? "already" : status, streak: after.lastSignInCount, lastSignInTime: when(after.lastSignInTime) };
  if (/^\d+$/.test(raw)) out.reward = Number(raw);
  else if (after.hasSignedInToday) out.reward = after.lastReward;
  if (raw && !/^\d+$/.test(raw)) out.raw = raw.slice(0, 200);
  log(`CC98 ${s.account.username} 签到：${out.status}${out.reward !== undefined ? ` +${out.reward}` : ""} 连续 ${out.streak} 天`);
  return out;
}

export async function signInMonth(s: Cc98Session, year: number, month: number) {
  const days = await s.api.signInMonth(year, month);
  return { year, month, signedDays: days.length, totalReward: days.reduce((sum, d) => sum + d.reward, 0), days: days.map((d) => ({ day: d.day, reward: d.reward, ...(d.useCard ? { useCard: true } : {}) })) };
}

export async function overview(s: Cc98Session) {
  const me = await s.api.me();
  const signIn = await s.api.signInInfo();
  const unread = await s.api.unreadCount();
  const boards = await s.api.boardsByIds(me.customBoards ?? []);
  return {
    user: { ...viewUser(me), ...(me.signInCardCount !== undefined ? { signInCardCount: me.signInCardCount } : {}) },
    signIn: { hasSignedInToday: signIn.hasSignedInToday, streak: signIn.lastSignInCount, lastReward: signIn.lastReward, lastSignInTime: when(signIn.lastSignInTime) },
    unread,
    customBoards: boards.map((b) => ({ id: b.id, name: b.name, todayCount: b.todayCount })),
  };
}

export async function myTopics(s: Cc98Session, from: number, size: number) {
  return { topics: (await s.api.myRecentTopics(from, size)).map(briefTopic) };
}

export async function myPosts(s: Cc98Session, o: { from: number; size: number; hot: boolean }) {
  const r = await s.api.myRecentPosts(o.from, o.size, o.hot);
  return { count: r.count, posts: r.data.map((p) => ({ topicId: p.topicId, url: WEB_BASE + floorAnchor(p.topicId, p.floor), ...viewPost(p) })) };
}

export async function history(s: Cc98Session, from: number, size: number) {
  const r = await s.api.browsingRecord(from, size);
  return { count: r.count, topics: r.data.map((t) => ({ ...briefTopic(t), lastBrowsingTime: when(t.lastBrowsingTime) })) };
}

export async function favorites(s: Cc98Session, o: { from: number; size: number; group: number; keyword?: string }) {
  const groups = (await s.api.favoriteGroups()).data.map((g) => ({ id: g.id, name: g.name, count: g.count }));
  const topics = o.keyword ? await s.api.searchFavorites(o.keyword, o.from, o.size) : await s.api.favorites(o.from, o.size, o.group, 1);
  return { groups, topics: topics.map(briefTopic) };
}

export async function following(s: Cc98Session, o: { from: number; size: number; fans: boolean }) {
  const ids = o.fans ? await s.api.followers(o.from, o.size) : await s.api.followees(o.from, o.size);
  return { users: (await s.api.basicUsers(ids)).map((u) => ({ id: u.id, name: u.name, url: `${WEB_BASE}/user/id/${u.id}` })) };
}

export async function feed(s: Cc98Session, kind: "boards" | "users", from: number, size: number) {
  const topics = kind === "users" ? await s.api.followeeTopics(from, size) : await s.api.customBoardTopics(from, size);
  return { kind, topics: topics.map(briefTopic) };
}

// ---------- 消息与私信 ----------

type NotificationKind = "reply" | "at" | "system";

/**
 * 回复和 @ 只带主题 ID 与楼层号，这里补上主题标题和该楼作者自己的话；
 * 系统通知直接给正文。逐条读取，单条失败只标注该条。
 */
async function viewNotifications(s: Cc98Session, kind: NotificationKind, from: number, size: number) {
  const rows = await s.api.notifications(kind, from, size);
  if (kind === "system") return rows.map((n) => ({ time: when(n.time), title: n.title ?? "", content: plainContent(n.content ?? ""), ...(n.topicId ? { url: topicUrl(n.topicId) } : {}), read: n.isRead }));
  const titles = new Map<number, string | null>();
  const out = [];
  for (const n of rows) {
    const info = n.postBasicInfo;
    const base = { time: when(n.time), from: info?.userName ?? null, read: n.isRead };
    if (!n.topicId || !info) { out.push({ ...base, content: plainContent(n.content ?? "") }); continue; }
    if (!titles.has(n.topicId)) titles.set(n.topicId, await s.api.topic(n.topicId).then((t) => t.title, () => null));
    let content: string | null = "（该楼已删除）";
    if (!info.isDeleted) {
      try {
        const post = await s.api.postByFloor(n.topicId, info.floor);
        content = splitQuote(post.content, post.contentType).own;
      } catch { content = null; }
    }
    out.push({ ...base, topic: titles.get(n.topicId), floor: info.floor, content, ...(content === null ? { note: "该楼正文读取失败，可打开链接查看" } : {}),
      url: WEB_BASE + floorAnchor(n.topicId, info.floor) });
  }
  return out;
}

/** 消息：不指定类型时汇总回复、@、系统通知；有未读私信时附上各会话最新一条（不读会话，不会标成已读） */
export async function notifications(s: Cc98Session, kind: NotificationKind | undefined, from: number, size: number) {
  const unread = await s.api.unreadCount();
  if (kind) return { unread, kind, items: await viewNotifications(s, kind, from, size) };
  const groups: { kind: string; items: unknown[]; note?: string }[] = await Promise.all((["reply", "at", "system"] as const).map(async (type) => ({ kind: type, items: await viewNotifications(s, type, from, size) })));
  if (unread.messageCount) {
    const items = (await contacts(s, 0, 10)).filter((c) => c.unread).map((c) => ({ time: c.time, from: c.user, content: c.last, read: false }));
    groups.push({ kind: "message", items, note: "未读私信，每个会话只列最新一条；完整对话用 cc98 private-message list，回复用 cc98 private-message send" });
  }
  return { unread, groups };
}

/** 最近联系人：对方用户名、最新一条和是否有未读（最新一条是对方发的且未读） */
async function contacts(s: Cc98Session, from: number, size: number) {
  const rows = await s.api.recentContacts(from, size);
  const names = new Map((await s.api.basicUsers(rows.map((c) => c.userId))).map((u) => [u.id, u.name]));
  return rows.map((c) => ({ userId: c.userId, user: names.get(c.userId) ?? `用户${c.userId}`, time: when(c.time), unread: !c.isRead && c.senderId === c.userId, lastFrom: c.senderId === c.userId ? "received" as const : "sent" as const, last: plainContent(c.lastContent) }));
}

/** 一条私信：received 是对方发来的；sent 是自己发的，带对方是否已读 */
function viewMessage(m: Message, peerId: number) {
  const [time, content] = [when(m.time), plainContent(m.content)];
  return m.senderId === peerId ? { time, direction: "received" as const, content } : { time, direction: "sent" as const, readByPeer: m.isRead, content };
}

/** 与某人的私信，按时间从早到晚 */
async function thread(s: Cc98Session, peerId: number, from: number, size: number) {
  return (await s.api.messagesWith(peerId, from, size)).reverse().map((m) => viewMessage(m, peerId));
}

/**
 * 私信。不指定用户：列最近会话，有未读的会话直接带上最近 10 条对话；指定用户：与该用户的对话。
 * 读对话的同时 CC98 会把对方发来的消息标为已读，与在网页上点开一样。
 */
export async function messages(s: Cc98Session, o: { user?: string; from: number; size: number }) {
  if (o.user !== undefined) {
    const peer = await resolveUser(s, o.user);
    const rows = await thread(s, peer.id, o.from, o.size);
    return { user: peer.name, messages: rows, message: rows.length ? `与 ${peer.name} 的 ${rows.length} 条私信，从早到晚。${rows.length === o.size ? `更早的加 --from ${o.from + o.size}。` : ""}` : `与 ${peer.name} 没有${o.from ? "更早的" : ""}私信。` };
  }
  const unreadMessages = (await s.api.unreadCount()).messageCount;
  const conversations = [];
  for (const { userId, ...c } of await contacts(s, o.from, o.size)) conversations.push(c.unread ? { ...c, messages: await thread(s, userId, 0, 10) } : c);
  const senders = conversations.filter((c) => c.unread).map((c) => c.user);
  return { unreadMessages, conversations,
    message: senders.length ? `${senders.join("、")} 发来了未读私信，对话在该会话的 messages 里（从早到晚）；读取后 CC98 上已标为已读。`
      : unreadMessages ? `还有 ${unreadMessages} 条未读私信不在这一页，加 --from ${o.from + o.size} 继续看。` : "没有未读私信。" };
}

/** 把本地图片传到 CC98，接在正文后面，每张一行：UBB 用 [img]，Markdown 用 ![]() */
async function withImages(s: Cc98Session, text: string, images: string[] | undefined, markdown: boolean, gate: WriteOptions) {
  if (!images?.length) return { content: text, urls: [] as string[] };
  const urls = await s.api.uploadImages(images, gate);
  return { content: [text.trim(), ...urls.map((url) => (markdown ? `![](${url})` : `[img]${url}[/img]`))].filter(Boolean).join("\n"), urls };
}

/** 发私信：按用户名找到对方，有图片先上传，发送后回查会话确认 */
export async function sendMessage(s: Cc98Session, user: string, text: string, o: { force?: boolean; images?: string[] } & WriteOptions) {
  const peer = await resolveUser(s, user);
  const { content, urls } = await withImages(s, text, o.images, false, o);
  const sent = await s.api.sendMessage(peer.id, content, o);
  const confirmed = sent.id !== undefined;
  return { status: "sent", user: peer.name, content: text.trim(), ...(urls.length ? { images: urls } : {}), time: when(sent.time), confirmed,
    message: confirmed ? `私信已发给 ${peer.name}。` : `CC98 已接受发送，但回查会话时没读到这条私信。不要重发，用 cc98 private-message view --user ${peer.name} 核对。` };
}

// ---------- 看帖、版面、用户 ----------

const MAX_TOPICS = 10;
const MAX_PAGES = 10;
const MAX_FIND_PAGES = 30;

const folded = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");

/**
 * 看一个帖，返回的一项里直接是标题等主题信息。
 * - 第 1 页：mainPost（主楼全文）、hot（CC98 列出的全部热门回复，按赞数从高到低）和其余楼层。
 * - only 给出楼层号：只看该楼作者在本帖的全部楼层（1 即只看楼主），每页 20 楼。
 * - find 给出几个词：只留作者自己的话里含任意一个词的楼层，并给出扫了哪些页、多少楼、命中多少；不给页码时从头扫，一次最多 30 页。
 */
async function viewTopic(s: Cc98Session, id: number, o: { pages?: [number, number]; only?: number; find?: string[] }) {
  const t = await s.api.topic(id);
  const anchor = o.only === undefined ? undefined : await s.api.postByFloor(id, o.only);
  const perPage = anchor ? 20 : 10;
  const from = o.pages?.[0] ?? 1;
  const to = o.pages?.[1] ?? (o.find ? from + MAX_FIND_PAGES - 1 : from);
  // 总页数：普通看帖由回复数算出；只看某人时读到第一批楼层才知道他一共多少楼
  let pages = anchor ? undefined : pageCount(t.replyCount);
  let authorPosts: number | undefined;
  let last = from;
  const posts: Post[] = [];
  for (let p = from; p <= to && (pages === undefined || p <= pages); p++) {
    const rows = anchor ? await s.api.postsBySameAuthor(id, anchor.id, (p - 1) * 20, 20) : await s.api.posts(id, (p - 1) * 10, 10);
    if (anchor && rows[0]) pages = Math.max(1, Math.ceil((authorPosts = (rows[0] as Post & { count: number }).count) / 20));
    posts.push(...rows);
    last = p;
    if (rows.length < perPage) break;
  }
  if (anchor && from === 1 && !posts.length) [authorPosts, pages] = [0, 1];
  const head = {
    ...briefTopic(t),
    ...(t["isMe"] ? { isMe: true } : {}),
    ...(anchor ? { only: { floor: o.only, author: postDisplayName(anchor), ...(authorPosts !== undefined ? { postCount: authorPosts } : {}) } } : {}),
  };
  const page = last > from ? `${from}-${last}` : from;
  if (o.find) {
    const words = o.find.map(folded);
    const hits = posts.filter((p) => { const own = folded(splitQuote(p.content, p.contentType).own); return words.some((w) => own.includes(w)); });
    const more = pages !== undefined && last < pages ? `只扫到第 ${last} 页，全帖共 ${pages} 页；接着扫用 --page ${last + 1}-${Math.min(pages, last + MAX_FIND_PAGES)}` : undefined;
    return { ...head, find: { words: o.find, scannedPages: page, scannedFloors: posts.length, matched: hits.length, ...(more ? { note: more } : {}) }, ...(pages !== undefined ? { pageCount: pages } : {}), posts: hits.map(viewPost) };
  }
  if (anchor || from > 1) return { ...head, page, ...(pages !== undefined ? { pageCount: pages } : {}), posts: posts.map(viewPost) };
  const hot = (await s.api.hotPosts(id)).sort((a, b) => b.likeCount - a.likeCount);
  const main = posts.find((p) => p.floor === 1);
  return {
    ...head,
    ...(main ? { mainPost: viewPost(main) } : {}),
    hot: hot.map(viewPost),
    hotNote: hot.length ? `CC98 列出的热门回复共 ${hot.length} 条，已全部给出，按赞数从高到低` : "这个帖子没有热门回复",
    page,
    pageCount: pages,
    posts: posts.filter((p) => p !== main).map(viewPost),
  };
}

/** 看帖：结果总是 topics 列表，一个帖一项；看多个帖时各给第一页，读不到的列在 failed */
export async function viewTopics(s: Cc98Session, ids: number[], o: { pages?: [number, number]; only?: number; find?: string[] }) {
  if (ids.length === 1) return { topics: [await viewTopic(s, ids[0]!, o)] };
  const topics = [];
  const failed: { id: number; error: string }[] = [];
  for (const id of ids) {
    try { topics.push(await viewTopic(s, id, o)); } catch (err) { failed.push({ id, error: err instanceof Error ? err.message : String(err) }); }
  }
  if (!topics.length) throw new RemoteRejected(`这 ${ids.length} 个帖子都读不到：${failed[0]!.error}`, failed);
  return { topics, ...(failed.length ? { failed } : {}) };
}

/** --id 的写法：主题 ID 或帖子链接，多个用 | 分隔 */
export function parseTopicIds(value: string): number[] {
  const ids = value.split(/[|｜,，\s]+/).filter(Boolean).map((token) => {
    const id = /^\d+$/.test(token) ? token : /cc98\.org\/topic\/(\d+)/i.exec(token)?.[1];
    if (!id) throw new ConfigError(`不是主题 ID 或帖子链接：${token}`);
    return Number(id);
  });
  const unique = [...new Set(ids)];
  if (!unique.length) throw new ConfigError("需要 --id 主题ID");
  if (unique.length > MAX_TOPICS) throw new ConfigError(`一次最多看 ${MAX_TOPICS} 个帖子（给了 ${unique.length} 个）`);
  return unique;
}

/** --page 的写法：3 或 2-5；普通看帖一次最多 10 页，按词筛选时最多 30 页 */
export function parsePages(value: string, finding = false): [number, number] {
  const m = /^(\d+)(?:\s*[-~－—]\s*(\d+))?$/.exec(value.trim());
  const [from, to] = m ? [Number(m[1]), Number(m[2] ?? m[1])] : [0, 0];
  if (!m || from < 1 || to < from) throw new ConfigError(`--page 写成 3 或 2-5：${value}`);
  const max = finding ? MAX_FIND_PAGES : MAX_PAGES;
  if (to - from >= max) throw new ConfigError(`一次最多读 ${max} 页，分几次读`);
  return [from, to];
}

/** --find 的写法：几个词用 | 、 ， ； 任一种分隔 */
export function parseFindWords(value: string): string[] {
  const words = splitPhrases(value);
  if (!words.length) throw new ConfigError("--find 需要至少一个词");
  return words;
}

export async function hot(s: Cc98Session, period: "today" | "weekly" | "monthly" | "history") {
  return { period, topics: period === "today" ? (await s.api.hot()).map(briefHot) : (await s.api.hotPeriod(period)).map(briefTopic) };
}

export async function boards(s: Cc98Session, o: { all?: boolean; keyword?: string }) {
  if (o.keyword !== undefined) return { boards: (await s.api.boardSearch(o.keyword)).map(briefBoard) };
  if (o.all) return { groups: (await s.api.boardsAll()).map((g) => ({ name: g.name, boards: g.boards.map((b) => ({ id: b.id, name: b.name, todayCount: b.todayCount })) })) };
  return { boards: (await s.api.boardsByIds((await s.api.me()).customBoards ?? [])).map(briefBoard) };
}

export async function viewBoard(s: Cc98Session, boardId: number, o: { from: number; size: number; top: boolean }) {
  const info = await s.api.board(boardId);
  const topics = o.top ? await s.api.topTopics(boardId) : await s.api.boardTopics(boardId, o.from, o.size);
  return { board: briefBoard(info), topics: topics.map(briefTopic) };
}

/** 发主题用的标签：tag1、tag2 各选一个 ID；只有一层标签的版面 tag2 为空 */
export async function boardTags(s: Cc98Session, boardId: number) {
  const tags = (await s.api.boardTags(boardId)).tags ?? [];
  const second = new Map(tags.flatMap((t) => (t.subTags ?? []).map((sub) => [sub.id, sub.name] as const)));
  return { boardId, tag1: tags.map((t) => ({ id: t.id, name: t.name })), tag2: [...second].map(([id, name]) => ({ id, name })) };
}

export async function viewUserPage(s: Cc98Session, o: { id?: number; name?: string; topics: boolean }) {
  const u = o.name !== undefined ? await resolveUser(s, o.name) : await s.api.user(o.id!);
  return { user: viewUser(u), ...(o.topics ? { topics: (await s.api.userRecentTopics(u.id, 0, 10)).map(briefTopic) } : {}) };
}

/** 搜索：只查一个说法时附一句提示；查多个时每条标出命中的说法 */
export async function search(s: Cc98Session, plan: SearchPlan) {
  const out = await runSearch(s.api, plan);
  const several = plan.keywords.length > 1;
  return {
    total: out.total,
    queries: out.queries,
    ...(several ? {} : { tip: "只查了一个说法。标题里可能用简称或别的叫法时，把几种说法一次给完，不要一个词调一次：--keyword \"说法一、说法二、说法三\"" }),
    results: out.results.map((t) => {
      const { boardId: _boardId, ...row } = briefTopic(t);
      return several ? { ...row, matched: t.matched } : row;
    }),
  };
}

// ---------- 赞踩、评分 ----------

/** 赞、踩或取消。服务端规则：再次发送当前状态即取消，切到相反状态直接发目标状态 */
export async function setReaction(s: Cc98Session, postId: number, want: "like" | "dislike" | "none", opts: WriteOptions) {
  const name = (state: 0 | 1 | 2) => (state === 1 ? "like" : state === 2 ? "dislike" : "none");
  const before = await s.api.likeInfo(postId);
  if (name(before.likeState) === want) return { postId, state: want, changed: false, likeCount: before.likeCount, dislikeCount: before.dislikeCount };
  const after = await s.api.like(postId, want === "none" ? (before.likeState as 1 | 2) : want === "like" ? 1 : 2, opts);
  return { postId, state: name(after.likeState), changed: true, likeCount: after.likeCount, dislikeCount: after.dislikeCount };
}

export async function ratingReasons(s: Cc98Session) {
  const list = async (type: 1 | 2) => (await s.api.ratingReasons(type)).filter((r) => r.enabled !== false).map((r) => ({ id: r.id, reason: r.reason }));
  return { plus: await list(1), minus: await list(2) };
}

// ---------- 回帖、发主题、编辑 ----------

/** 与网页一致的引用块 + 回复正文（UBB 是 [quote]，Markdown 是 > 行） */
function withQuote(quoted: Post, reply: string, markdown: boolean): string {
  const time = new Date(Date.parse(withZone(quoted.time)) + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  const head = `以下是引用${quoted.floor}楼：用户${postDisplayName(quoted)}在${time}的发言：`;
  if (markdown) return `> **${head}**\n\n> ${quoted.content.trim().split(/\r?\n/).join("\n> ")}\n\n${reply}`;
  return `[quote][b]${head}[color=blue][url=${floorAnchor(quoted.topicId, quoted.floor)}]>>查看原帖<<[/url][/color][/b]\n${quoted.content}[/quote]\n${reply}`;
}

/** 回帖。quote 给出楼层号时引用该楼；有图片先上传再接在正文后。返回新楼层的位置 */
export async function reply(s: Cc98Session, topicId: number, text: string, o: { quote?: number; markdown: boolean; anonymous: boolean; force: boolean; images?: string[] } & WriteOptions) {
  const quoted = o.quote === undefined ? undefined : await s.api.postByFloor(topicId, o.quote);
  if (quoted?.isDeleted) throw new ConfigError(`第 ${o.quote} 楼已被删除，不能引用`);
  if (!quoted && o.images?.length) await s.api.topic(topicId); // 主题不存在就不白传图片
  const { content, urls } = await withImages(s, text, o.images, o.markdown, o);
  const sent = await s.api.reply(topicId, quoted ? withQuote(quoted, content, o.markdown) : content, { confirm: o.confirm ?? false, anonymous: o.anonymous, force: o.force, contentType: o.markdown ? 1 : 0, ...(quoted ? { parentPostId: quoted.id } : {}) });
  const floor = (await s.api.topic(topicId)).replyCount + 1;
  return { postId: sent.postId, floor, url: WEB_BASE + floorAnchor(topicId, floor), ...(quoted ? { quotedFloor: quoted.floor } : {}), ...(urls.length ? { images: urls } : {}) };
}

/** 发主题：版面按名称或 ID；有图片先上传再接在正文后 */
export async function post(s: Cc98Session, board: string, title: string, text: string, o: { markdown: boolean; anonymous: boolean; type: number; tag1?: number; tag2?: number; images?: string[] } & WriteOptions) {
  const boardId = await resolveBoard(s, board);
  const { content, urls } = await withImages(s, text, o.images, o.markdown, o);
  const sent = await s.api.createTopic(boardId, title, content, { confirm: o.confirm ?? false, anonymous: o.anonymous, contentType: o.markdown ? 1 : 0, type: o.type, ...(o.tag1 !== undefined ? { tag1: o.tag1 } : {}), ...(o.tag2 !== undefined ? { tag2: o.tag2 } : {}) });
  return { ...sent, ...(urls.length ? { images: urls } : {}), url: topicUrl(sent.topicId) };
}

export async function original(s: Cc98Session, postId: number) {
  const p = await s.api.originalPost(postId);
  return { postId: p.id, topicId: p.topicId, floor: p.floor, ...(p.title ? { title: p.title } : {}), format: p.contentType === 0 ? "ubb" : "markdown", content: p.content };
}

export { download } from "./download.ts";
