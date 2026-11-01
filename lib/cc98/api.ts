/**
 * CC98 REST 客户端（api.cc98.org）。端点与响应形状来自官方前端源码（ZJU-CC98/Forum、CC98-PWA），
 * 经 WebVPN 实测，端点清单与核对日期见 lib/cc98/README.md。
 *
 * 礼仪：搜索接口服务端限 1 次/秒（403 "last_search_in_1_seconds"），本客户端主动间隔 ≥1.1s，
 * 撞限流再退避 0.75/1.25/2s 重试；其它读接口间隔 ≥250ms。按需查询，不做全站抓取。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Context } from "../webvpn/transport.ts";
import type { Cc98Auth } from "./auth.ts";
import type { RequestOptions } from "../core/http.ts";
import { ZjuError, RateLimited, RemoteRejected, BadResponse, AuthExpired, WriteGateClosed, ConfigError } from "../core/errors.ts";
import { writeAllowed } from "../core/env.ts";
import { fileJournal } from "../core/journal.ts";
import { debug, log } from "../core/output.ts";

export const API_BASE = "https://api.cc98.org";
export const WEB_BASE = "https://www.cc98.org";

// ---------- 类型（只列会用到的字段，服务端还有更多） ----------

/** 搜索/收藏/浏览记录等列表里的主题摘要 */
export interface TopicSummary {
  id: number;
  boardId: number;
  boardName?: string;
  title: string;
  time: string;
  userId: number | null;
  userName: string | null;
  isAnonymous: boolean;
  replyCount: number;
  hitCount: number;
  lastPostUser: string;
  lastPostTime: string;
  lastPostContent?: string;
  contentType?: number;
  state?: number;
  /** 版面列表/热门等接口才有 */
  likeCount?: number;
  dislikeCount?: number;
  topState?: number;
  bestState?: number;
  tag1?: number;
  tag2?: number;
  isVote?: boolean;
  lastBrowsingTime?: string;
}

export interface Award {
  id: number;
  postId: number;
  /** 如 "风评值 +1" / "财富值 +100" */
  content: string;
  reason: string;
  operatorName: string;
  type: number;
  time: string;
  deleted?: boolean;
}

export interface Post {
  id: number;
  parentId: number;
  boardId: number;
  topicId: number;
  userId: number | null;
  userName: string | null;
  floor: number;
  content: string;
  /** 0 UBB，1 Markdown（主题里还见到 4，同样按 Markdown 渲染） */
  contentType: number;
  time: string;
  isAnonymous: boolean;
  isDeleted: boolean;
  isLZ: boolean;
  likeCount: number;
  dislikeCount: number;
  /** 当前账号对该楼的态度：0 无 1 赞 2 踩 */
  likeState: 0 | 1 | 2;
  awards: Award[];
  lastUpdateTime: string | null;
  lastUpdateAuthor: string | null;
  isMe?: boolean;
}

export interface LikeInfo {
  likeCount: number;
  dislikeCount: number;
  likeState: 0 | 1 | 2;
}

export interface SignInInfo {
  hasSignedInToday: boolean;
  lastSignInCount: number;
  lastSignInTime: string;
  lastReward: number;
}

export interface SignInDay {
  year: number;
  month: number;
  day: number;
  useCard: boolean;
  reward: number;
}

export interface User {
  id: number;
  name: string;
  postCount: number;
  prestige: number;
  privilege: string;
  groupName?: string;
  registerTime: string;
  lastLogOnTime: string;
  portraitUrl: string;
  signatureCode: string;
  gender: number;
  isVerified?: boolean;
  wealth: number;
  fanCount: number;
  followCount: number;
  isFollowing: boolean;
  levelTitle: string;
  introduction: string | null;
  popularity: number;
  lockState: number;
  customBoards: number[];
  receivedLikeCount: number;
  deleteCount: number;
  signInCardCount?: number;
  activityPoint?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface BasicUser {
  id: number;
  name: string;
  portraitUrl: string;
}

export interface BoardBrief {
  id: number;
  name: string;
  boardMasters: string[];
  topicCount: number;
  postCount: number;
  todayCount: number;
  description: string;
  anonymousState?: number;
  canVote?: boolean;
}

export interface BoardGroup {
  id: number;
  name: string;
  order: number;
  masters: string[];
  boards: BoardBrief[];
}

export interface HotTopic {
  id: number;
  title: string;
  boardId: number;
  boardName: string;
  participantCount: number;
  replyCount: number;
  hitCount: number;
  authorName: string | null;
  createTime: string;
  isAnonymous: boolean;
}

export interface Notification {
  id: number;
  type: number;
  title?: string;
  content?: string;
  topicId: number | null;
  postId: number | null;
  boardId?: number;
  time: string;
  isRead: boolean;
  postBasicInfo: { id: number; floor: number; userId: number; userName: string; isDeleted: boolean; boardId: number } | null;
}

export interface UnreadCount {
  systemCount: number;
  atCount: number;
  replyCount: number;
  messageCount: number;
}

export interface RecentContact {
  userId: number;
  senderId: number;
  time: string;
  isRead: boolean;
  lastContent: string;
}

export interface Message {
  id: number;
  senderId: number;
  receiverId: number;
  time: string;
  /** 接收方是否已读 */
  isRead: boolean;
  content: string;
}

export interface BoardTag {
  id: number;
  name: string;
  subTags: BoardTag[];
}

export interface Paged<T> {
  data: T[];
  count: number;
  from: number;
  size: number;
}

export interface FavoriteGroup {
  id: number;
  name: string;
  count: number;
  createTime: string;
}

export interface RatingReason {
  id: number;
  reason: string;
  type: number;
  enabled: boolean;
}

// ---------- 客户端 ----------

const POST_ERRORS: Record<string, string> = {
  content_is_empty: "内容为空",
  content_too_long: "内容超过 8000 字",
  topic_is_locked: "主题已锁定",
  board_is_locked: "版面已锁定",
  cannot_entry_board: "没有进入版面的权限",
  cannot_post_in_this_board: "该版面禁止发帖",
  cannot_post_anonymous: "该版面不能匿名",
  wealth_not_enough_for_anonymous_post: "匿名所需财富值不足",
  wealth_not_enough_for_anonymous_topic: "匿名发主题所需财富值不足",
  user_state_is_abnormal: "账号状态异常（被禁言/锁定）",
  tag_id_error: "版面标签错误",
  board_not_exists: "版面不存在",
};

const SEARCH_MIN_GAP_MS = 1100;
const READ_MIN_GAP_MS = 250;
const SEARCH_BACKOFF_MS = [750, 1250, 2000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WriteOptions {
  confirm?: boolean;
  /** 写前日志；默认每个客户端一个 data/journal/cc98-*.jsonl。begin 写不进去就不发请求。 */
  journal?: (event: Cc98JournalEvent) => void;
}

/** begin 在请求前落盘；done/rejected 是确定结果；verified 是结果不明后只读回查到的写入；unknown 需要人工核对，不能直接重发 */
export interface Cc98JournalEvent {
  at: string;
  action: string;
  stage: "begin" | "done" | "rejected" | "verified" | "unknown";
  detail: Record<string, unknown>;
}

export class Cc98Api {
  readonly ctx: Context;
  readonly auth: Cc98Auth;
  private lastSearchAt = 0;
  private lastReadAt = 0;
  private journalSink: { file: string; append: (event: Cc98JournalEvent) => void } | undefined;

  constructor(ctx: Context, auth: Cc98Auth) {
    this.ctx = ctx;
    this.auth = auth;
  }

  // ----- 底层 -----

  private async request<T>(method: string, path: string, opts: { body?: unknown; form?: { body: Buffer; contentType: string }; timeout?: number; search?: boolean; expectJson?: boolean } = {}): Promise<{ status: number; data: T; text: string }> {
    const gap = opts.search ? SEARCH_MIN_GAP_MS - (Date.now() - this.lastSearchAt) : READ_MIN_GAP_MS - (Date.now() - this.lastReadAt);
    if (gap > 0) await sleep(gap);
    const url = `${API_BASE}/${path.replace(/^\//, "")}`;
    const headers: Record<string, string> = { Accept: "application/json", Authorization: await this.auth.authorization(), Origin: WEB_BASE, Referer: WEB_BASE + "/" };
    const ro: RequestOptions = { method, headers, ...(opts.timeout ? { timeout: opts.timeout } : {}) };
    if (opts.form) {
      ro.body = opts.form.body;
      headers["Content-Type"] = opts.form.contentType;
    } else if (opts.body !== undefined) {
      ro.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    } else if (method !== "GET") {
      ro.body = "";
      headers["Content-Type"] = "application/json";
    }
    let res = await this.ctx.fetch(url, ro);
    if (opts.search) this.lastSearchAt = Date.now();
    else this.lastReadAt = Date.now();
    if (res.status === 401) {
      // access_token 被服务端拒绝：强制刷新一次再试
      headers["Authorization"] = await this.auth.authorization(true);
      res = await this.ctx.fetch(url, ro);
      if (res.status === 401) throw new AuthExpired("cc98", `CC98 拒绝访问 ${path}：${res.body.slice(0, 120) || "401"}`);
    }
    const text = res.body;
    if (res.status === 403 && /last_search_in_1_seconds/.test(text)) throw new RateLimited("CC98 搜索限流：1 秒内只能搜一次", 1000);
    if (/name="_csrf"|wengine_vpn_ticket/.test(text) && /<html/i.test(text)) throw new AuthExpired("webvpn", "WebVPN 会话失效，API 返回了登录页");
    if (res.status === 404) throw new RemoteRejected(`CC98：不存在（${path}）`, text.slice(0, 200));
    if (res.status === 403) throw new RemoteRejected(`CC98 拒绝：${text.replace(/^"|"$/g, "").slice(0, 200) || "403"}`, text.slice(0, 200));
    if (res.status >= 400) throw new RemoteRejected(`CC98 HTTP ${res.status}：${text.replace(/^"|"$/g, "").slice(0, 200)}`, text.slice(0, 200));
    if (opts.expectJson === false) return { status: res.status, data: undefined as T, text };
    let data: T;
    try {
      data = (text === "" ? null : JSON.parse(text)) as T;
    } catch {
      throw new BadResponse(`CC98 ${path} 返回非 JSON`, { status: res.status, snippet: text.slice(0, 200) });
    }
    return { status: res.status, data, text };
  }

  private async get<T>(path: string): Promise<T> {
    return (await this.request<T>("GET", path)).data;
  }

  /** 搜索类请求：限流自动退避重试 */
  private async getSearch<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.request<T>("GET", path, { search: true })).data;
      } catch (err) {
        if (!(err instanceof RateLimited) || attempt >= SEARCH_BACKOFF_MS.length) throw err;
        const wait = SEARCH_BACKOFF_MS[attempt]!;
        debug(`cc98: 搜索限流，${wait}ms 后重试`);
        await sleep(wait);
      }
    }
  }

  private gate(action: string, opts: WriteOptions): void {
    if (!writeAllowed() || !opts.confirm) throw new WriteGateClosed(action);
  }

  /**
   * 所有写请求的唯一出口：请求前落盘 begin（失败即不发送），之后记录结果。
   * 拒绝、限流、认证失败是确定未写入；超时等结果不明时只用 verify 只读回查，绝不重发（CC98 发出去删不掉）。
   */
  private async write<T>(action: string, detail: Record<string, unknown>, opts: WriteOptions, send: () => Promise<T>, verify?: (startedAt: number) => Promise<T | undefined>): Promise<T> {
    this.gate(action, opts);
    const sink = opts.journal ? { file: undefined, append: opts.journal } : (this.journalSink ??= fileJournal<Cc98JournalEvent>("cc98"));
    const record = (stage: Cc98JournalEvent["stage"], extra: Record<string, unknown> = {}) => sink.append({ at: new Date().toISOString(), action, stage, detail: { ...detail, ...extra } });
    const after = (stage: Cc98JournalEvent["stage"], extra: Record<string, unknown>) => {
      // 请求已经发出，结果日志失败不能改变写入结论，否则调用方会误以为可以重发
      try { record(stage, extra); } catch (err) { log(`cc98: 写后日志失败（${err instanceof Error ? err.message : String(err)}），写入结果不受影响`); }
    };
    const startedAt = Date.now();
    record("begin");
    try {
      const result = await send();
      after("done", { result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof RemoteRejected || err instanceof RateLimited || err instanceof AuthExpired) {
        after("rejected", { message });
        throw err;
      }
      let found: T | undefined;
      let verifyError: string | undefined;
      if (verify) {
        try { found = await verify(startedAt); } catch (e) { verifyError = e instanceof Error ? e.message : String(e); }
      }
      if (found !== undefined) {
        after("verified", { result: found, message });
        return found;
      }
      after("unknown", { message, ...(verifyError ? { verifyError } : {}) });
      if (err instanceof ZjuError) Object.assign(err.detail, { outcome: "unknown", note: "请求可能已生效，先到 CC98 核对再决定是否重发", ...(sink.file ? { journalFile: sink.file } : {}) });
      throw err;
    }
  }

  private static q(params: Record<string, string | number | boolean | undefined>): string {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
    const str = s.toString();
    return str ? `?${str}` : "";
  }

  // ----- 账号 / 个人中心 -----

  me(): Promise<User> {
    return this.get<User>("me");
  }

  signInInfo(): Promise<SignInInfo> {
    return this.get<SignInInfo>("me/signin");
  }

  /** 签到。空 body 的 POST；成功返回 200，body 可能是奖励数字或空 */
  async signIn(): Promise<{ status: number; raw: string }> {
    const r = await this.request<unknown>("POST", "me/signin", { expectJson: false });
    return { status: r.status, raw: r.text.trim() };
  }

  signInMonth(year: number, month: number): Promise<SignInDay[]> {
    return this.get<SignInDay[]>(`me/signin-in-month${Cc98Api.q({ year, month })}`);
  }

  unreadCount(): Promise<UnreadCount> {
    return this.get<UnreadCount>("me/unread-count");
  }

  myRecentTopics(from = 0, size = 10): Promise<TopicSummary[]> {
    return this.get<TopicSummary[]>(`me/recent-topic${Cc98Api.q({ from, size })}`);
  }

  /** hot=true 取被赞多的回复 */
  myRecentPosts(from = 0, size = 10, hot = false): Promise<Paged<Post>> {
    return this.get<Paged<Post>>(`me/${hot ? "hot" : "recent"}-post${Cc98Api.q({ from, size })}`);
  }

  browsingRecord(from = 0, size = 10): Promise<Paged<TopicSummary>> {
    return this.get<Paged<TopicSummary>>(`me/browsing-record${Cc98Api.q({ from, size })}`);
  }

  favoriteGroups(): Promise<Paged<FavoriteGroup>> {
    return this.get<Paged<FavoriteGroup>>("me/favorite-topic-group");
  }

  /** order：0 收藏时间 1 最后回复时间 */
  favorites(from = 0, size = 10, groupId = 0, order: 0 | 1 = 1): Promise<TopicSummary[]> {
    return this.get<TopicSummary[]>(`topic/me/favorite${Cc98Api.q({ from, size, order, groupid: groupId })}`);
  }

  searchFavorites(keyword: string, from = 0, size = 10): Promise<TopicSummary[]> {
    return this.get<TopicSummary[]>(`topic/me/search-favorite${Cc98Api.q({ from, size, keyword })}`);
  }

  followees(from = 0, size = 10): Promise<number[]> {
    return this.get<number[]>(`me/followee${Cc98Api.q({ from, size })}`);
  }

  followers(from = 0, size = 10): Promise<number[]> {
    return this.get<number[]>(`me/follower${Cc98Api.q({ from, size })}`);
  }

  customBoardTopics(from = 0, size = 10): Promise<TopicSummary[]> {
    return this.get<TopicSummary[]>(`me/custom-board/topic${Cc98Api.q({ from, size })}`);
  }

  followeeTopics(from = 0, size = 10): Promise<TopicSummary[]> {
    return this.get<TopicSummary[]>(`me/followee/topic${Cc98Api.q({ from, size, order: 0 })}`);
  }

  notifications(kind: "reply" | "at" | "system", from = 0, size = 10): Promise<Notification[]> {
    return this.get<Notification[]>(`notification/${kind}${Cc98Api.q({ from, size })}`);
  }

  recentContacts(from = 0, size = 10): Promise<RecentContact[]> {
    return this.get<RecentContact[]>(`message/recent-contact-users${Cc98Api.q({ from, size })}`);
  }

  /** 与某人的私信，新的在前，单页最多 20；服务端在返回的同时把对方发来的标为已读 */
  messagesWith(userId: number, from = 0, size = 10): Promise<Message[]> {
    return this.get<Message[]>(`message/user/${userId}${Cc98Api.q({ from, size: Math.min(size, 20) })}`);
  }

  // ----- 用户 / 版面 -----

  user(id: number): Promise<User> {
    return this.get<User>(`user/${id}`);
  }

  userByName(name: string): Promise<User> {
    return this.get<User>(`user/name/${encodeURIComponent(name)}`);
  }

  async basicUsers(ids: number[]): Promise<BasicUser[]> {
    const uniq = [...new Set(ids.filter((n) => Number.isFinite(n) && n > 0))];
    if (!uniq.length) return [];
    const out: BasicUser[] = [];
    for (let i = 0; i < uniq.length; i += 50) {
      out.push(...(await this.get<BasicUser[]>(`user/basic?${uniq.slice(i, i + 50).map((n) => `id=${n}`).join("&")}`)));
    }
    return out;
  }

  userRecentTopics(userId: number, from = 0, size = 10): Promise<TopicSummary[]> {
    return this.get<TopicSummary[]>(`user/${userId}/recent-topic${Cc98Api.q({ from, size })}`);
  }

  boardsAll(): Promise<BoardGroup[]> {
    return this.get<BoardGroup[]>("board/all");
  }

  board(id: number): Promise<BoardBrief & Record<string, unknown>> {
    return this.get<BoardBrief & Record<string, unknown>>(`board/${id}`);
  }

  boardsByIds(ids: number[]): Promise<BoardBrief[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.get<BoardBrief[]>(`board/?${ids.map((n) => `id=${n}`).join("&")}`);
  }

  boardSearch(keyword: string): Promise<BoardBrief[]> {
    return this.get<BoardBrief[]>(`board/search${Cc98Api.q({ keyword })}`);
  }

  boardTopics(boardId: number, from = 0, size = 10): Promise<TopicSummary[]> {
    return this.get<TopicSummary[]>(`board/${boardId}/topic${Cc98Api.q({ from, size })}`);
  }

  topTopics(boardId: number): Promise<TopicSummary[]> {
    return this.get<TopicSummary[]>(`topic/toptopics${Cc98Api.q({ boardid: boardId })}`);
  }

  // ----- 主题 / 楼层 -----

  topic(id: number): Promise<TopicSummary & Record<string, unknown>> {
    return this.get<TopicSummary & Record<string, unknown>>(`topic/${id}`);
  }

  /** 楼层，from 从 0 起；服务端单页最多 10 */
  posts(topicId: number, from = 0, size = 10): Promise<Post[]> {
    return this.get<Post[]>(`topic/${topicId}/post${Cc98Api.q({ from, size: Math.min(size, 10) })}`);
  }

  /** 按楼层号取单楼（服务端没有按 postId 查楼的接口，/post/{id} 与 /post/basic 都是 405） */
  async postByFloor(topicId: number, floor: number): Promise<Post> {
    if (!Number.isInteger(floor) || floor < 1) throw new ConfigError("楼层号必须是 ≥1 的整数");
    const [p] = await this.posts(topicId, floor - 1, 1);
    if (!p || p.floor !== floor) throw new RemoteRejected(`CC98：主题 ${topicId} 没有第 ${floor} 楼`);
    return p;
  }

  /**
   * 只看某一楼的作者在本帖发的全部楼层（网页上的“只看楼主”“追踪”），按楼层 ID 定位，匿名帖同样可用。
   * 每条的 count 是该作者在本帖的总楼数；单页最多 20。
   */
  postsBySameAuthor(topicId: number, postId: number, from = 0, size = 20): Promise<(Post & { count: number })[]> {
    return this.get(`post/topic/specific-user${Cc98Api.q({ topicid: topicId, postid: postId, from, size: Math.min(size, 20) })}`);
  }

  hotPosts(topicId: number): Promise<Post[]> {
    return this.get<Post[]>(`topic/${topicId}/hot-post`);
  }

  likeInfo(postId: number): Promise<LikeInfo> {
    return this.get<LikeInfo>(`post/${postId}/like`);
  }

  isFavorite(topicId: number): Promise<boolean> {
    return this.get<boolean>(`topic/${topicId}/isfavorite`);
  }

  /** 十大 */
  hot(): Promise<HotTopic[]> {
    return this.get<HotTopic[]>("topic/hot");
  }

  hotPeriod(period: "weekly" | "monthly" | "history"): Promise<TopicSummary[]> {
    return this.get<TopicSummary[]>(`topic/hot-${period}`);
  }

  /** 全站/版内搜索。size ≤ 20，超过返回 400 invalid_from_or_size。服务端不排序，只按最新。 */
  search(keyword: string, opts: { boardId?: number; from?: number; size?: number } = {}): Promise<TopicSummary[]> {
    const size = Math.min(opts.size ?? 20, 20);
    const path = opts.boardId ? `topic/search/board/${opts.boardId}` : "topic/search";
    return this.getSearch<TopicSummary[]>(`${path}${Cc98Api.q({ keyword, size, from: opts.from ?? 0 })}`);
  }

  ratingReasons(type: 1 | 2): Promise<RatingReason[]> {
    return this.get<RatingReason[]>(`post/rating-reason${Cc98Api.q({ type })}`);
  }

  // ----- 写操作（闸：ZJU_ALLOW_WRITE=1 + --confirm）-----

  /** 赞/踩：state 1 赞 2 踩；再次发送当前状态即取消（2026-09-17 实测）。连续操作过快服务端返回空 403。 */
  async like(postId: number, state: 1 | 2, opts: WriteOptions = {}): Promise<LikeInfo> {
    await this.write("cc98.like", { postId, state }, opts, async () => {
      try {
        await this.request<unknown>("PUT", `post/${postId}/like`, { body: String(state), expectJson: false });
      } catch (err) {
        if (err instanceof RemoteRejected && /403$|拒绝：403/.test(err.message)) throw new RateLimited("CC98 赞/踩操作太频繁，稍后再试", 3000);
        throw err;
      }
      return true;
    });
    return this.likeInfo(postId);
  }

  /** 评分（风评）：type 1 加 2 扣，reasonId 来自 ratingReasons() */
  async rate(postId: number, type: 1 | 2, reasonId: number, opts: WriteOptions = {}): Promise<{ ok: true }> {
    return this.write("cc98.rate", { postId, type, reasonId }, opts, async () => {
      await this.request<unknown>("PUT", `post/${postId}/rating-v2`, { body: { reasonId, type }, expectJson: false });
      return { ok: true as const };
    });
  }

  async setFavorite(topicId: number, on: boolean, opts: WriteOptions = {}): Promise<{ favorite: boolean }> {
    await this.write("cc98.favorite", { topicId, on }, opts,
      () => this.request<unknown>(on ? "PUT" : "DELETE", `me/favorite/${topicId}${on ? "?groupid=0" : ""}`, { expectJson: false }).then(() => true),
      async () => (await this.isFavorite(topicId)) === on || undefined);
    return { favorite: await this.isFavorite(topicId) };
  }

  // ----- 发布内容（写闸）。请求体与官方前端一致（Forum Topic-SendTopic.tsx / Edit.tsx）-----
  // 注意：普通用户不能删除楼层/主题（DELETE /post/{id} 返回 cannot_operate_board，那是版主接口），发出去只能编辑。

  /**
   * 回帖。返回新楼层 postId。服务端拒绝时 400/402/403 的 body 是原因字符串：
   * last_post_in_10_seconds / content_is_empty / content_too_long(>8000) / topic_is_locked /
   * board_is_locked / cannot_entry_board / cannot_post_in_this_board / cannot_post_anonymous /
   * wealth_not_enough_for_anonymous_post / user_state_is_abnormal
   */
  async reply(topicId: number, content: string, o: { contentType?: 0 | 1; anonymous?: boolean; parentPostId?: number; notifyAllReplier?: boolean; force?: boolean } & WriteOptions = {}): Promise<{ postId: number }> {
    this.gate(`cc98 topic reply ${topicId}`, o);
    const text = content.trim();
    if (!text) throw new ConfigError("回帖内容为空");
    if (text.length > 8000) throw new ConfigError("回帖内容超过 8000 字");
    // 发出去删不掉：最后一楼是自己 5 分钟内发的相同内容就拒绝，防止重复回帖
    if (!o.force) {
      const t = await this.topic(topicId);
      const [last] = await this.posts(topicId, t.replyCount, 1);
      if (last?.isMe && last.content.trim() === text && Date.now() - Date.parse(last.time) < 5 * 60 * 1000) {
        throw new ConfigError(`第 ${last.floor} 楼已经是你刚发的同样内容（postId ${last.id}），不重复发`, "确实要再发一条就加 --force");
      }
    }
    const body: Record<string, unknown> = { content: text, contentType: o.contentType ?? 0, title: "", isAnonymous: o.anonymous ?? false, notifyAllReplier: o.notifyAllReplier ?? false, clientType: 1 };
    if (o.parentPostId) body["parentId"] = o.parentPostId;
    return this.write("cc98.reply", { topicId, ...body }, o, async () => ({ postId: await this.postContent(`topic/${topicId}/post`, body) }), async (startedAt) => {
      const t = await this.topic(topicId);
      const recent = await this.posts(topicId, Math.max(0, t.replyCount - 9), 10);
      const mine = recent.reverse().find((p) => p.isMe && p.content.trim() === text && Date.parse(p.time) >= startedAt - 60_000);
      return mine ? { postId: mine.id } : undefined;
    });
  }

  /** 发主题。返回新 topicId。tag1/tag2 按版面 boardTags() 要求给；type 0 普通 1 校园活动 2 学术信息 */
  async createTopic(boardId: number, title: string, content: string, o: { contentType?: 0 | 1; anonymous?: boolean; tag1?: number; tag2?: number; type?: number; notifyPoster?: boolean } & WriteOptions = {}): Promise<{ topicId: number }> {
    this.gate(`cc98 create topic in board ${boardId}`, o);
    if (!title.trim()) throw new ConfigError("标题为空");
    if (!content.trim()) throw new ConfigError("正文为空");
    if (content.length > 8000) throw new ConfigError("正文超过 8000 字");
    const body: Record<string, unknown> = { content, contentType: o.contentType ?? 0, title: title.trim(), type: o.type ?? 0, notifyPoster: o.notifyPoster ?? true, isAnonymous: o.anonymous ?? false, clientType: 1 };
    if (o.tag1) body["tag1"] = o.tag1;
    if (o.tag2) body["tag2"] = o.tag2;
    return this.write("cc98.topic", { boardId, ...body }, o, async () => ({ topicId: await this.postContent(`board/${boardId}/topic`, body) }), async (startedAt) => {
      const mine = (await this.myRecentTopics(0, 10)).find((t) => t.boardId === boardId && t.title === body["title"] && Date.parse(t.time) >= startedAt - 60_000);
      return mine ? { topicId: mine.id } : undefined;
    });
  }

  /** 编辑自己的楼层/主题（主题楼 title 才生效）。没指定的标题和格式沿用原帖，与官方前端一致 */
  async editPost(postId: number, content: string, o: { title?: string; contentType?: 0 | 1 } & WriteOptions = {}): Promise<{ ok: true }> {
    this.gate(`cc98 floor edit ${postId}`, o);
    if (!content.trim()) throw new ConfigError("内容为空");
    const original = await this.originalPost(postId);
    const body = { content, title: o.title ?? original.title ?? "", contentType: o.contentType ?? (original.contentType === 0 ? 0 : 1) };
    return this.write("cc98.edit", { postId, ...body }, o, async () => {
      await this.request<unknown>("PUT", `post/${postId}`, { body, expectJson: false });
      return { ok: true as const };
    }, async () => (await this.originalPost(postId)).content === content ? { ok: true as const } : undefined);
  }

  /** 自己楼层的原文（编辑用，UBB/Markdown 原样）；别人的楼返回 403 */
  originalPost(postId: number): Promise<Pick<Post, "id" | "topicId" | "floor" | "content" | "contentType"> & { title: string | null }> {
    return this.get(`post/${postId}/original`);
  }

  /** 版面标签（发主题时可能必选）：第一层标签各自带一份第二层标签 */
  boardTags(boardId: number): Promise<{ layers: number; tags: BoardTag[] }> {
    return this.get(`board/${boardId}/tag-v2`);
  }

  /**
   * 把本地图片传到 file.cc98.org，按给出的顺序返回链接；服务端会压缩图片（与网页默认一致）。
   * 传上去的图片只有被正文引用才会被人看到，所以失败或结果不明时正文还没发，可以直接重试。
   */
  async uploadImages(files: string[], opts: WriteOptions = {}): Promise<string[]> {
    this.gate("cc98 upload", opts);
    const images = checkImages(files);
    const boundary = `----zju${crypto.randomUUID().replace(/-/g, "")}`;
    const field = (head: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; ${head}\r\n\r\n`);
    const chunks = [field('name="contentType"'), Buffer.from("multipart/form-data\r\n")];
    // 文件名只影响服务端取扩展名：用序号命名，不把本机文件名带出去
    for (const [i, image] of images.entries()) chunks.push(field(`name="files"; filename="image-${i + 1}.${image.ext}"\r\nContent-Type: ${image.type}`), await fs.promises.readFile(image.path), Buffer.from("\r\n"));
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    try {
      return await this.write("cc98.upload", { files: images.map((image) => ({ path: image.path, bytes: image.bytes })) }, opts, async () => {
        const urls = (await this.request<unknown>("POST", "file", { form: { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }, timeout: 120_000 })).data;
        if (!Array.isArray(urls) || urls.length !== images.length || urls.some((u) => typeof u !== "string" || !/^https?:\/\//.test(u))) throw new BadResponse("CC98 上传后没有返回图片链接", { snippet: JSON.stringify(urls ?? null).slice(0, 200) });
        return urls as string[];
      });
    } catch (err) {
      if (err instanceof ZjuError) {
        delete err.detail["outcome"];
        Object.assign(err.detail, { note: "图片没有传成功，正文还没有发出，可以直接重试" });
        err.message = `图片上传失败，内容没有发出：${err.message}`;
      }
      throw err;
    }
  }

  /**
   * 发私信，发出后不能撤回。成功是 200（官方前端不读响应体），这里再读一次会话取回刚发的那条；
   * 403 是发送太快或账号被禁言。5 分钟内给同一人发过相同内容则拒绝，防止重复发送。
   */
  async sendMessage(userId: number, content: string, o: { force?: boolean } & WriteOptions = {}): Promise<{ id?: number; time?: string }> {
    this.gate(`cc98 private-message send ${userId}`, o);
    const text = content.trim();
    if (!text) throw new ConfigError("私信内容为空");
    const mine = async (since: number) => (await this.messagesWith(userId, 0, 10)).find((m) => m.receiverId === userId && m.content.trim() === text && Date.parse(m.time) >= since);
    if (!o.force && await mine(Date.now() - 5 * 60_000)) throw new ConfigError("5 分钟内已经给对方发过同样的内容，不重复发", "确实要再发一条就加 --force");
    const found = async (startedAt: number) => { const m = await mine(startedAt - 60_000); return m && { id: m.id, time: m.time }; };
    return this.write("cc98.message", { receiverId: userId, content: text }, o, async () => {
      const startedAt = Date.now();
      try {
        await this.request<unknown>("POST", "message", { body: { receiverId: userId, content: text }, expectJson: false });
      } catch (err) {
        if (err instanceof RemoteRejected) throw new RemoteRejected(`CC98 拒绝发送私信：${String(err.detail["raw"] ?? "").replace(/^"|"$/g, "") || "发送太快，或账号被禁言"}`, err.detail["raw"]);
        throw err;
      }
      // 请求已被接受；回查只为取回消息时间，读不到也不能当作发送失败
      return (await found(startedAt).catch(() => undefined)) ?? {};
    }, found);
  }

  private async postContent(path: string, body: Record<string, unknown>): Promise<number> {
    let r;
    try {
      r = await this.request<unknown>("POST", path, { body, expectJson: false });
    } catch (err) {
      if (err instanceof RemoteRejected) {
        const reason = String(err.detail["raw"] ?? "").replace(/^"|"$/g, "");
        if (/last_post_in_10_seconds/.test(reason)) throw new RateLimited("CC98：10 秒内只能发一次", 10000);
        throw new RemoteRejected(`CC98 拒绝发布：${POST_ERRORS[reason] ?? (reason || err.message)}`, reason);
      }
      throw err;
    }
    const id = Number(r.text.trim().replace(/^"|"$/g, ""));
    if (!Number.isFinite(id) || id <= 0) throw new BadResponse("CC98 发布后未返回 id", { snippet: r.text.slice(0, 120) });
    return id;
  }
}

const IMAGE_TYPES: { ext: string; type: string; match: (head: Buffer) => boolean }[] = [
  { ext: "jpg", type: "image/jpeg", match: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  { ext: "png", type: "image/png", match: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "gif", type: "image/gif", match: (h) => h.subarray(0, 4).toString("latin1") === "GIF8" },
  { ext: "webp", type: "image/webp", match: (h) => h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WEBP" },
  { ext: "bmp", type: "image/bmp", match: (h) => h.subarray(0, 2).toString("latin1") === "BM" },
];

/** 检查要上传的本地图片：按文件头认格式，不看扩展名（聊天软件缓存的图片常常没有或写错扩展名） */
export function checkImages(files: string[]): { path: string; bytes: number; ext: string; type: string }[] {
  if (!files.length) throw new ConfigError("没有给出图片");
  return files.map((file) => {
    const absolute = path.resolve(file);
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new ConfigError(`找不到图片文件：${absolute}`);
    const head = Buffer.alloc(12);
    const fd = fs.openSync(absolute, "r");
    try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
    const kind = IMAGE_TYPES.find((t) => t.match(head));
    if (!kind) throw new ConfigError(`不是可上传的图片（支持 JPG、PNG、GIF、WebP、BMP）：${absolute}`, "HEIC 等格式先转成 JPG；PDF 页面用 doc render 转成图片");
    return { path: absolute, bytes: stat.size, ext: kind.ext, type: kind.type };
  });
}

/** 一个不含更内层引用的引用块 */
const QUOTE = /\[quote(?:=[^\]]*)?\]((?:(?!\[quote(?:=[^\]]*)?\])[\s\S])*?)\[\/quote\]/gi;
/** 官方前端生成的引用头 */
const QUOTE_HEAD = /^以下是引用(\d+)楼：用户(.+?)在[\d\- :]+的发言：\s*/;

/** 原文 → [作者自己写的, 它引用的那一楼写的]。引用层层嵌套：每轮去掉最内层，最后一轮去掉的就是直接引用的那一楼 */
function peelQuotes(raw: string): [own: string, quoted: string | undefined] {
  let quoted: string | undefined;
  for (let previous = ""; previous !== raw;) {
    previous = raw;
    let first: string | undefined;
    raw = raw.replace(QUOTE, (_m, inner: string) => { first ??= inner; return ""; });
    quoted = first ?? quoted;
  }
  return [raw, quoted];
}

/** 去掉引用块后的原文：引用里是别人的话和别人的文件 */
export function stripQuotes(content: string): string {
  return peelQuotes(content ?? "")[0];
}

/**
 * 楼层 → 作者自己的话，加上它引用的那一楼（楼层号、作者、那一楼自己的话），都是纯文本。
 * 引用块层层嵌套且排在正文前面，分开后 content 只有作者自己的话。
 */
export function splitQuote(content: string, contentType = 0): { own: string; quote?: { floor?: number; author?: string; text: string } } {
  let [own, quoted] = peelQuotes(content ?? "");
  // Markdown 回复没有 [quote]：开头连续的 > 行是引用，去掉一层 > 后仍以 > 开头的是更早的引用
  const block = contentType !== 0 && /^\s*>\s*\*\*以下是引用/.test(own) ? /^(?:[ \t]*>.*\n?|[ \t]*\r?\n)+/.exec(own)![0] : "";
  if (block) [own, quoted] = [own.slice(block.length), block.replace(/^[ \t]*>[ \t]?/gm, "").replace(/^[ \t]*>.*$/gm, "").replace(/\*\*/g, "")];
  if (quoted === undefined) return { own: plainContent(own, contentType) };
  const text = plainContent(quoted, contentType);
  const head = QUOTE_HEAD.exec(text);
  return { own: plainContent(own, contentType), quote: { ...(head ? { floor: Number(head[1]), author: head[2]! } : {}), text: head ? text.slice(head[0].length) : text } };
}

const HTML_TAG =/<\/?(?:p|div|span|a|b|i|u|s|strong|em|font|center|details|summary|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|hr|blockquote|pre|code|sub|sup|del|ins|kbd|mark|small|iframe|source)\b[^>]*>/gi;

/**
 * 把 UBB / Markdown 压成可读纯文本：图片、视频、附件留链接，其余排版标记去掉。楼层里的引用由 splitQuote 先分出去。
 * Markdown 正文（contentType 非 0）里嵌的 HTML 标签也去掉，只认常见标签名，代码里的 vector<int> 不受影响。
 */
export function plainContent(content: string, contentType = 0): string {
  let s = content ?? "";
  if (contentType !== 0) {
    s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<(img|video|audio)\b[^>]*?\bsrc=["']?([^"'\s>]+)[^>]*>/gi, (_m, tag: string, url: string) => `（${tag.toLowerCase() === "img" ? "图片" : tag.toLowerCase() === "video" ? "视频" : "音频"} ${url}）`);
    s = s.replace(/!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g, "（图片 $1）").replace(HTML_TAG, "");
  }
  s = s.replace(/\[url=[^\]]*\]>>查看原帖<<\[\/url\]/g, "");
  s = s.replace(/\[img(?:=[^\]]*)?\]([^\[]*)\[\/img\]/gi, "（图片 $1）");
  s = s.replace(/\[(video|audio|upload)(?:=[^\]]*)?\]([^\[]*)\[\/\1\]/gi, (_m, tag: string, url: string) => `（${tag.toLowerCase() === "video" ? "视频" : tag.toLowerCase() === "audio" ? "音频" : "附件"} ${url}）`);
  s = s.replace(/\[url=([^\]]*)\]([\s\S]*?)\[\/url\]/gi, "$2 ($1)");
  s = s.replace(/\[\/?(?:b|i|u|s|color|size|align|font|del|center|table|tr|td|th|list|li|\*|code|pre|md|bili|video|audio|upload|url|img|quote)(?:=[^\]]*)?\]/gi, "");
  s = s.replace(/\[(?:ac|em|tb|ms|cc98)\d+\]/g, "");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

export function topicUrl(id: number, page = 1): string {
  return `${WEB_BASE}/topic/${id}${page > 1 ? `/${page}` : ""}`;
}

/** 总回复数 → 楼层页数（每页 10 楼） */
export function pageCount(replyCount: number): number {
  return Math.max(1, Math.ceil((replyCount + 1) / 10));
}
