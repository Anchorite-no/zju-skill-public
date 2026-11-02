# 智云课堂

使用说明统一见 [智云](../../references/zhiyun.md)，参数见 [命令总表](../../references/commands.md#zhiyun)。本文只说明内部组件与 API。

- selection.ts / acquire.ts 处理查询选择、下载和缓存；公开课件 kind=ppt，兼容旧清单的 courseware。
- local.ts 的 localTranscribe / transcribeCourseware 输出 Markdown、原始 JSON 和原图；local-cli.ts 定义 check/trans 参数。
- 旧 prepare/read/notes 组合与渲染库已移除。cache.ts 保留下载与转写所需的哈希/内容核验；已有旧 JSON 和 Markdown 仍可直接读取。

底层 TypeScript API 仍可单独组合，例如：

```ts
import { openZhiyun, catalogue, selectLessons, playbackAssets, selectQuality, Transfer, downloadMedia } from "./index.ts";
const client = await openZhiyun();
try {
  const lessons = await catalogue(client, "88105");
  const [lesson] = selectLessons(lessons, { lesson: "1" });
  const available = await playbackAssets(client, lesson!);
  const source = available.find(a => a.kind === "audio") ?? selectQuality(available.filter(a => a.kind === "video"), 360);
  if (source && lesson!.playable) await downloadMedia(new Transfer({ threads: 4 }), source, {
    out: "lecture.wav", audioOnly: true, audioFormat: "wav",
  });
} finally { client.close(); }
```

- `courses.ts` 返回精简课程和课次，不输出内部路径、API 密钥。整个课程先编号，再筛选。
- `materials.ts` 获取 PPT 截图时间轴和原站字幕；原始课件链接来自 `Lesson.assets`。
- `Transfer` 统一限制所有文件/分片的活跃请求，流式 I/O 不占用整文件内存。
- `downloadFile` 提供 Range 分块、失败重试、断点续传、独占锁、完整文件原子发布，不覆盖成品。锁文件（`<目标>.lock`）里记着持有它的进程号：下载被杀掉后留下的锁，下一次运行发现持有者已不在就接管，不需要人工删除；没有进程号的旧锁仍按占用处理。超星、学在模块的下载也用它。续传默认按地址认同一个文件；地址里的签名会变时用 `source` 给一个稳定的标识（学在）。
- `hls.ts` 并发下载完整 HLS 回放的分片、初始化段和 AES-128 密钥；FFmpeg 只读本地清单。
- `media.ts` 使用本模块 ffmpeg.ts；Python 处理脚本在 scripts/zhiyun。安装统一通过 zhiyun setup，普通视频和课件下载不依赖 FFmpeg。

清晰度策略由 quality.ts 统一处理：下载视频优先 1080p，音频转写优先独立音轨或 360p 视频；无独立音轨的混合下载复用 1080p。播放器 playurl 由 playbackAssets 补充，实际选择在下载预览中可见，不能把数字档位等同于分辨率。

## 接口维护

复用 zjuam，经 tgmedia auth/login → CAS oauth2.0/authorize → callbackAuthorize → tgmedia get-info。门户发放 `JWTUser` 和 `_token`，Cookie 保存在 `data/sessions/zhiyun.json`。API 遇 401/登录页重登一次，并发请求共用重登；认证拒绝不反复尝试凭据。模块声明为 `auth=cas/network=public`，全部 CMC CDN 的无校园网环境可达性尚未逐一验证。

以下 GET 接口供维护时查阅，日常通过 CLI 调用：

| 接口 | 参数与响应要点 |
|---|---|
| `education.cmc.zju.edu.cn/personal/courseapi/vlabpassportapi/v1/account-profile/course` | `nowpage,per-page,force_mycourse=1`；`params.result.{data,total}` |
| `classroom.zju.edu.cn/pptnote/v1/searchlist` | `title,realname,tenant_id,user_id,user_name,page,per_page,source=1`；`total.{list,total}` |
| `yjapi.cmc.zju.edu.cn/courseapi/v2/course/catalogue` | `course_id`；`result.data[]`，解析 content.playback/download/file_list。type 为 course_live、live、ilive 的是课次（ilive 如中国古代小说鉴赏，字段相同）；其他类型跳过，全部未识别时报错，不返回空列表。未选的课同样可查 |
| `classroom.zju.edu.cn/pptnote/v1/schedule/search-ppt` | `course_id,sub_id,page,per_page`；list[].content.pptimgurl、created_sec、total；可能忽略 per_page |
| `yjapi.cmc.zju.edu.cn/courseapi/v3/web-socket/search-trans-result` | `sub_id,format=json`；list[].all_content[] 的 BeginSec/EndSec/Text；Content-Type 可能错标为 HTML |
| `yjapi.cmc.zju.edu.cn/courseapi/v3/portal-home-setting/get-sub-info` | `course_id,sub_id`；data.playurl 补充媒体源，依据实际 URL 尺寸或 HLS RESOLUTION 选源 |
| 目录返回的课件、视频和 CDN URL | 原始字节、HTTP Range |
| `yjapi.cmc.zju.edu.cn/courseapi/v2/course-live/get-my-course-day` | `date=YYYY-MM-DD`；`list` 以时段起始时间戳为键（上午/下午/晚上），每段 `course[]` 含 `course_id,sub_id,sub_title,course_begin,course_over`（秒）、`room_name,room,live_status,sub_status,multi_type(course_live/ilive)`。本人当天课次，用于直播监听选课次。2026-09-30 核对 |
| `yjapi.cmc.zju.edu.cn/courseapi/v2/course-live/search-live-course-list` | `page,per_page`；全站当天直播课次，字段同上。前端另带 `need_time_quantum=1&unique_course=1&with_sub_duration=1&with_sub_data=1`。2026-09-30 核对 |
| `get-sub-info` 的直播字段 | course_live 课次在开课前后都返回 `data.live_url.{output,output_tts,output_student}.{m3u8,m3u8_lhd,m3u8_lsd,flv,rtmp}`；播放器只用 `output`（教师机位）和 `output_student`，不用 `output_tts`。m3u8 的 `auth_key` 自本次查询起约 4 小时有效，flv/rtmp 的 key 是陈旧值。已测教室 `_lhd` 清单为空，`m3u8_lsd` 指向 `livepgcabroad` 域（503）。`content.trans_socket_url` 开课前为空，直播开始后为 `http://qlite2.cmc.zju.edu.cn/<id>`（官方实时字幕，见下） |
| `yjapi.cmc.zju.edu.cn/courseapi/index.php/v2/meta/getscreenstream` | `sub_id`；ilive 课次的流列表 `result.data[]`：`type` 3 教师、2 PPT、4 学生，`stream_m3u8`（同 livepgc 域和 auth_key 形式）、`stream_play`（webrtc）、`is_gortc`。course_live 课次返回空数组。2026-09-30 核对 |

官方实时字幕（2026-09-30 核对）：`trans_socket_url` 是 desertbit/glue 1.9.1 服务，主机解析到校内 10.204.4.14，校外经 WebVPN 访问；前端按页面协议改写后调用 `glue(url)`，`voice_live_gn` 只控制页面是否显示，不控制服务端是否推送。WebSocket 路径为 `<url>/glue/ws`；AJAX 长轮询为 `POST <url>/glue/ajax`：正文 `i` 返回 `uid&令牌`，`u<uid>&<消息>` 发送，`o<uid>&<令牌>` 轮询（前端客户端请求超时为 45 秒，并非已证明的服务端最长挂起时间，返回 `新令牌&消息`，`t` 超时、`c` 关闭）。三种请求都要带 `Origin`（2026-10-12 实测）：直连不带时回 HTTP 400、正文为空，带上即 200，值不限（`https://classroom.zju.edu.cn`、WebVPN 域、qlite2 自身都通过），`X-Requested-With`、`Referer` 不能代替；经 WebVPN 不带也是 200，所以只走 WebVPN 的机器看不出这个要求。实现固定发官方页面的 `https://classroom.zju.edu.cn`。连接后先发 `in{"version":"1.9.1"}`，服务端回 `in{"socketID":…}`；`pi`/`po` 心跳，前端每 35 秒一次。字幕为 `cd` 频道数据，格式 `<频道名长度>&<频道名><JSON>`，频道 `m`；JSON 为 `sourcetext`（原文）、`transtext`（译文，常为空）、`end_time`（1 为整句定稿，-1 为中间结果，中间结果约每 1–2 秒一条、内容累积）、`time`（=`text_end_time`）、`text_begin_time`，两者为绝对毫秒端点；上午记录为反序，13:31 计算机组成实测为正常顺序，实现归一化两个端点并保留 fieldOrder/rawTimes、`payloadtype`、`taskid`、`error`。相邻定稿首尾相接，句长 2–11 秒，定稿在句末约 5 秒后到达。只推送连接之后的内容，没有补发。抽样 6 节正在上的课中 2 节 90 秒内无任何字幕消息，原因未明。

直播 HLS（`livepgc.cmc.zju.edu.cn/pgc/<流键>.m3u8`）2026-09-30 实测：流键按教室机位固定，不上课时也在推流（空教室无语音）；H.264 1080p 25 fps + AAC 32 kHz 单声道；`EXT-X-VERSION:3`，2 秒分片，清单只保留最近 6 片，没有 `PROGRAM-DATE-TIME`；分片文件名末尾的 13 位毫秒时间戳约为该片生成时刻（比取回清单早约 5 秒，与本机时钟有 ±3 秒偏差），`MEDIA-SEQUENCE` 会归零并伴随 `EXT-X-DISCONTINUITY`（一上午观察到两次），去重须按文件名时间戳而不是序号。分片和清单不需要 Cookie。东京服务器拉一个 2 秒分片约 20 秒（约 20 KB/s），不能实时消费；本机约 3.5 MB/s。

`courseapi/v3/multi-search/get-course-detail` 用于取得课程标题，其 `sub_list` 年月分组不是教学周。只取课件、截图或字幕时不额外查询媒体清晰度。

端点依据当前官方前端、[login-zju](https://github.com/5dbwat4/login-zju/blob/main/src/classroom.ts) 与本地历史项目核对，独立实现。已完成真实查询、下载、转写、课件提取和远程执行验证，

## 实时采集实现

`live-socket.ts` 复用 WebVPN 接收 glue AJAX；滚动令牌不能复用已消费值（实测 HTTP 400），任何不确定轮询重建会话。`live.ts` 处理当天课次、定稿与窗口，`live-task.ts` 管理后台进程，入口为 `scripts/zhiyun/live.ts`。Windows 用 WMI 隐藏创建进程，数据目录显式传入，任务文件与采集租约防止重复启动；停止按任务标识协作退出。

字幕保存在 `data/live/<日期>/<courseId>-<subId>/transcript.jsonl`。中间结果仅更新 status.json 的预览；定稿按课次、时间与内容去重，保留原时间端点。查询返回缺失监听区间，不承诺官方没有漏识别。后台任务仅跟随启动当日本人剩余课次；未来日期需再次启动或由既有调度调用。所有 live 命令继续使用统一远程转发。音频补充尚未接入。

## 同名课程的取法（2026-10-03）

课程名匹配到多门时，`resolveCourse` 只看已经开始的学期里最近的那一个：当前学期（8 月到次年 1 月为秋冬，2 月到 7 月为春夏，北京时间）有就取当前学期，没有就取最近一次；那个学期只有一门就直接用，仍有多门（不同教师或教学班）时候选只列这几门。学期码 `2026-20271` 是学年加第几学期（1 秋冬、2 春夏），旧课程是 `2024-2025秋,2024-2025冬` 这种写法，`termOrder` 两种都认；认不出学期的不参与默认，照旧给候选。
