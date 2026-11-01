# CC98 请求与协议

CLI 用法、搜索策略与发帖规则见 [CC98](../../references/cc98.md)。本文件记录鉴权、端点与传输细节，供开发和排障使用。

- 声明：`auth=own network=campus writes=true`。10.10.98.98 私网地址，只在校网，默认经 WebVPN（`transport=direct` 才直连）。

- 会话：`data/sessions/cc98-<用户名>.json`（0600），存 access_token（1h）+ refresh_token（按 30 天算）。过期前 60s 自动 refresh，refresh 失败再 password grant；密码错误抛 `NEEDS_USER` 不重试。

## 鉴权

`POST https://openid.cc98.org/connect/token`（`application/x-www-form-urlencoded`，Origin/Referer 为 `https://www.cc98.org`）

| grant | 字段 | 返回 |
|---|---|---|
| password | `client_id=9a1fd200-8687-44b1-4c20-08d50a96e5cd` `client_secret=8b53f727-08e2-4509-8857-e34bf92b27f2` `username` `password` `scope=cc98-api openid offline_access` | `{access_token, expires_in:3600, token_type:"Bearer", refresh_token, scope}` |
| refresh_token | 同 client + `refresh_token` | 同上（refresh_token 不变，多一个 id_token） |
| 密码错 | — | 400 `{"error":"invalid_grant","error_description":"invalid_username_or_password"}` |

客户端凭据是官方前端（ZJU-CC98/Forum、CC98-PWA）源码内置的公开常量。所有 API 请求带 `Authorization: Bearer <token>`；未登录读帖/搜索返回 401（`"cannot_entry_board"`）。

## 端点清单（已实测）

最近核对：2026-10-01（私信、只看某人、各列表 size 上限、`/post/basic`、`/topic/basic`；其余 2026-09-17）。列表类端点 `size` 最大 20，超过返回 400 `invalid_from_or_size`（`/me/browsing-record` 例外）；楼层每页最多 10。

| 短名 | 方法 | 路径 | 说明 |
|---|---|---|---|
| me | GET | `/me` | 自己：wealth 财富、prestige 威望、popularity 风评、postCount、fanCount、followCount、receivedLikeCount、customBoards[]、signInCardCount 补签卡、activityPoint |
| signin-info | GET | `/me/signin` | `{hasSignedInToday, lastSignInCount 连续天数, lastSignInTime, lastReward}` |
| signin | POST | `/me/signin`（空 body，`Content-Type: application/json`） | 200，body 为本次奖励数字；已签则非 200 + `has_signed_in_today` |
| signin-month | GET | `/me/signin-in-month?year&month` | `[{year,month,day,useCard,reward}]` |
| unread | GET | `/me/unread-count` | `{systemCount, atCount, replyCount, messageCount}`；`/me/all-message-count` 是历史总数 |
| my-topics | GET | `/me/recent-topic?from&size` | 主题数组 |
| my-posts | GET | `/me/recent-post?from&size` / `/me/hot-post` | `{data: Post[], count}`，hot 按被赞 |
| history | GET | `/me/browsing-record?from&size` | `{data: Topic[], count}`，多 `lastBrowsingTime` |
| fav-groups | GET | `/me/favorite-topic-group` | `{data:[{id,name,count}]}`，id 0 默认分组 |
| favorites | GET | `/topic/me/favorite?from&size&order=1&groupid=` | order 0 收藏时间 1 最后回复；`/topic/me/search-favorite?keyword` 搜收藏 |
| follow | GET | `/me/followee?from&size` / `/me/follower` | 用户 id 数组，再 `/user/basic?id=&id=` 取名字头像 |
| feed | GET | `/me/custom-board/topic?from&size` / `/me/followee/topic?…&order=0` | 关注版面 / 关注用户的新帖 |
| notifications | GET | `/notification/reply|at|system?from&size` | `{id,type,topicId,postId,time,isRead,postBasicInfo{floor,userName}}`，system 多 title/content；回复和 @ 不带正文，CLI 按 topicId 取标题、按 floor 取该楼正文 |
| contacts | GET | `/message/recent-contact-users?from&size` | 最近联系人 `{userId, time, isRead, lastContent, senderId}`：只有 id，名字再查 `/user/basic`；`lastContent` 是最新一条全文；`senderId == userId` 且 `isRead=false` 才是我有未读 |
| messages | GET | `/message/user/{uid}?from&size` | 与某人的私信，新的在前：`{id, senderId, receiverId, time, isRead, content, senderDeleted, receiverDeleted, isBookMessage}`。**请求本身就把对方发来的标为已读**，返回里已是 `isRead=true`，分不出哪几条原本未读；自己发的 `isRead` 表示对方是否已读。内容是 UBB，图片为 `[img]` |
| topic | GET | `/topic/{id}` | 主题：replyCount、hitCount、likeCount/dislikeCount、isMe、tag1/2 |
| posts | GET | `/topic/{id}/post?from&size` | 楼层数组，**每页最多 10**；含 `likeCount dislikeCount likeState(0/1/2 自己的态度) awards[] floor isLZ isAnonymous isDeleted contentType` |
| hot-posts | GET | `/topic/{id}/hot-post` | 热门回复，由服务端挑选：2026-10-02 实测 4 回复的帖 0 条、193 回复的帖 2 条、500 回复以上的帖 10–12 条，没有翻页；看帖第 1 页时总是一并取 |
| same-author | GET | `/post/topic/specific-user?topicid&postid&from&size` | 某一楼的作者在本帖的全部楼层（网页的“只看楼主”“追踪”），按楼层 ID 定位，实名和匿名帖都可用；每条多一个 `count`（该作者在本帖的总楼数），`size` 最大 20，越界页返回空数组。`/post/topic/user?topicid&userid`、`/post/topic/anonymous/user?topicid&postid` 是同一功能的旧入口，未使用 |
| like-info | GET | `/post/{pid}/like` | `{likeCount, dislikeCount, likeState}` |
| awards | GET | `/post/{pid}/awards` | 评分/奖惩记录：`{content:"风评值 +1", reason, operatorName, type, time, deleted}`（楼层里已内嵌） |
| rating-reasons | GET | `/post/rating-reason?type=1|2` | 加分/扣分可选理由 `{id, reason}` |
| hot | GET | `/topic/hot` | 十大 `{id,title,boardName,participantCount,replyCount,hitCount,authorName}`；`/topic/hot-weekly|monthly|history` |
| new | GET | `/topic/new?from&size` | 新帖 |
| board | GET | `/board/{id}` / `/board/?id=&id=` / `/board/all` / `/board/search?keyword` | 版面信息、批量、版面树（12 组）、搜版面 |
| board-topics | GET | `/board/{id}/topic?from&size` / `/topic/toptopics?boardid=` | 版内列表 / 置顶 |
| user | GET | `/user/{id}` / `/user/name/{name}` / `/user/basic?id=…` / `/user/{id}/recent-topic` | 用户 |
| isfavorite | GET | `/topic/{id}/isfavorite` | bool |
| **like** | PUT | `/post/{pid}/like`，body `"1"` 赞 `"2"` 踩 | **再次发送当前状态即取消**；太快返回空 403（脚本抛 RATE_LIMITED） |
| **rate** | PUT | `/post/{pid}/rating-v2`，body `{reasonId, type}` | 风评。4xx body 是原因：`cannot_rate_yourself` `has_rated_tody` `you_cannot_rate`（发帖不足 500）`has_rated_this_post` |
| **favorite** | PUT/DELETE | `/me/favorite/{tid}?groupid=0` | 收藏/取消 |
| **reply** | POST | `/topic/{tid}/post`，body `{content, contentType:0|1, title:"", isAnonymous, notifyAllReplier, clientType:1, parentId?}` | 返回新 postId（纯文本）。引用时 `parentId` 指向被引用楼 |
| **post** | POST | `/board/{bid}/topic`，body `{title, content, contentType, type:0, tag1?, tag2?, notifyPoster, isAnonymous, clientType:1}` | 返回新 topicId。有的版面标签必选，先 `GET /board/{bid}/tag-v2` |
| **edit** | PUT | `/post/{pid}`，body `{content, title, contentType}` | 只能改自己的楼；`GET /post/{pid}/original` 取原文（别人的楼返回 403 `cannot_edit_post`） |
| **message** | POST | `/message`，body `{receiverId, content}` | 发私信。200 即成功，官方前端不读响应体（发后 0.2 秒重取会话）；403 是发送太快、被全站禁言或服务器维护；不存在的用户在 `/user/name/{name}` 就返回 400 `user_not_exists`。发出后不能撤回 |
| **upload** | POST | `/file`，multipart：字段 `contentType=multipart/form-data`，每个文件一个 `files` | 返回链接数组，顺序与文件一致。默认由服务端压缩图片，`?compressImage=false` 为无损（未使用）。官方前端对图片不限大小，非图片限 10 MB。**只做了离线模拟，真实上传未验证** |
| ~~delete~~ | DELETE | `/post/{pid}` | **普通用户不能删**（403 `cannot_operate_board`，是版主接口）。发出去只能编辑 |

`/post/basic?id=` 与 `/post/{id}` 都是 405（官方前端源码里仍有调用）：**没有按 postId 查楼的接口**，脚本用 `/topic/{tid}/post?from=楼层-1&size=1` 按楼层号取（`postByFloor`）。`/topic/basic?id=&id=` 可用，返回 `{id, boardId, title, isVote, contentType}`，目前未使用。

## 写入流程

所有写请求经 `Cc98Api.write`：请求前把 `begin`（动作、目标、正文）写进 `data/journal/cc98-<时间>-<uuid>.jsonl`，落盘失败不发请求；之后记 `done` 或 `rejected`（服务端拒绝、限流、认证失败，确定未写入）。超时、返回无 id 等结果不明时只读回查、不重发：回帖查最后 10 楼中本人在开始前 1 分钟之后发的同内容楼，发主题查本人最近 10 个主题的同版同标题，编辑比对原文，收藏查收藏状态，私信查与对方最近 10 条里自己发的同内容；查到记 `verified` 并按成功返回，查不到记 `unknown`，错误 detail 带 `outcome: "unknown"` 与 `journalFile`。写后日志失败只打印提示，不改变写入结论。库调用可传 `journal` 回调替代默认文件。

- 私信发送成功后再读一次会话取回消息时间；读不到时仍按已发出返回（`confirmed: false`），不重发。发送前同样读会话做 5 分钟同内容去重，所以给对方发私信会顺带把对方的来信标为已读。
- 带图发送：先确认目标存在（私信的用户、回帖的主题或被引用楼、发主题的版面），再上传，最后把链接接在正文后面发出（UBB `[img]链接[/img]`，Markdown `![](链接)`，每张一行）。上传也经 `Cc98Api.write` 记日志（`cc98.upload`）；上传失败或结果不明时正文还没发，错误里不带 `outcome: "unknown"`，可直接重试，已传上去而没被引用的图片没有人看得到。图片按文件头识别格式，上传用序号文件名，不带出本机文件名。上传超时 120 秒。
- 编辑先取 `/post/{pid}/original`，没指定的 `title`、`contentType` 沿用原帖，与官方前端一致（否则主题楼标题被清空、Markdown 楼变成 UBB）。官方前端编辑主题楼时还会带上原 `tag1/tag2`，这里没带，编辑带标签的主题楼后标签是否保留未验证。
- CLI 的写命令在建会话前检查 `ZJU_ALLOW_WRITE=1` 与 `--confirm`；`Cc98Api` 内仍有同样的检查，供库调用。

## 输出整理

`index.ts` 的任务函数把平台对象投影成结果：时间经 `when()` 转北京时间（十大的 `createTime`、签到的 `lastSignInTime` 不带时区，按北京时间解释）；正文经 `plainContent()` 转纯文本（`[img]` 等留链接，引用头里的“查看原帖”链接去掉；Markdown 楼里的常见 HTML 标签去掉，不认识的尖括号内容保留）。楼层经 `splitQuote()` 拆成作者自己的话和直接引用的那一楼：UBB 取第一个最外层 `[quote]`，Markdown 只认以官方引用头 `> **以下是引用` 开头的块；被引用楼里更早的嵌套引用丢掉，带官方引用头时解析出楼层号和作者。正文一律给全文，不截断；一次调用的规模由数量上限控制（连读 10 页、按词筛选 30 页、一次 10 个帖、一次 10 个搜索说法）。私信、签名、系统通知不拆引用，引用标记去掉后文字留在原处。`original` 是唯一返回 UBB/Markdown 原文的命令。用户资料去掉隐私字段与设置项（`lastIpAddress`、`themeSetting`、手机号等）；`gender` 多为默认值，不输出。

## 未封装的端点

2026-10-01 对照官方前端（ZJU-CC98/Forum main）整理，均未实测、没有命令；出现真实需求时再做。

| 用途 | 端点 | 备注 |
|---|---|---|
| 投票 | GET `/topic/{id}/vote`；投票 POST 同路径 `{items}` | 主题带 `isVote`；看帖结果只标出是投票帖 |
| 上传视频、音频、附件 | POST `/file`，正文标签为 `[video]`、`[audio]`、`[upload]` | 目前只上传图片；编辑时补图也未做 |
| 通知标已读 | PUT `/notification/read-all-reply|at|system` | 2026-09-17 实测过，曾有库函数、无命令，已删 |
| 关注版面 / 用户 | PUT、DELETE `/me/custom-board/{id}`；PUT、DELETE `/me/followee/{id}` | |
| 补签 | POST `/me/make-up-missed-signin` | 消耗补签卡 |
| 收藏分组 | POST、PUT、DELETE `/me/favorite-topic-group` | 收藏时固定进默认分组 |
| 按标签看版面 | GET `/topic/search/board/{id}/tag?tag1=&tag2=&from&size` | |
| 首页栏目与新帖 | GET `/config/index`、`/topic/new`、`/topic/school-event|academics|study|emotion|flea-market|full-time-job|part-time-job` | |
| 版面事件、小黑屋、精华 | GET `/board/{id}/events`、`/board/{id}/stop-post-user`、`/topic/best/board/{id}` | |
| 转账、个人设置、版务 | `/me/transfer-wealth`、PUT `/me` 等 | 不做 |

## 帖内文件传输

- 经模块传输（`ctx.resolve` 重写 + WebVPN cookie）用 fetch 流式落盘，不受 HttpClient 16MB 缓冲上限；WebVPN 返回登录页时重登一次。

## 坑

- `/me/follower` 等只返回 id，需要再批量查 `/user/basic`（脚本已做，每批 50）。
- `/user/basic` 查不到已注销的用户，私信列表里显示为「用户<id>」。
