# 学在浙大

## 命令

```text
xuezai
├─ todos                                    待办
├─ course    list · view                    我的课程；一门课的章节与活动
├─ material  list · download                课件等文件
├─ homework  list · view · download · attachments · submit · retract 作业
├─ rollcall  （本身即 GPS 签到）· number · all · status · history
└─ session   login · status · logout        排障用
```

课程一律写名称，可用常见简称（计组、概统）；同名课程优先当前学期，仍不唯一时返回候选。`course list` 的每门课带着课程页面的链接（`link`），把它原样写进 `--course` 也行，用户给了学在浙大的课程链接时照此办。作业、文件也按名称定位，不需要任何 ID。结果时间都是北京时间 `YYYY-MM-DD HH:mm`，并附 currentTime，用它判断今天截止或已过期。

| 用户目标 | 命令 | 结果 |
|---|---|---|
| 有什么作业、DDL | `todos`，只看一门课加 `--course` | 当前学期各课未交的作业和测验，按截止先后：course、title、type、deadline、requirement（作业要求全文）。加 `--done` 时已交的作业也列出来，带 `done: true` |
| 这学期有哪些课 | `course list` | 当前学期的课程、教师；往年加 `--semester 2025-2026春夏`（或只写学年 `2025-2026`），全部学期加 `--all` |
| 一门课讲什么、每章有什么 | `course view --course 课程名` | 简介、开课日期，章节下的每个活动：类型、说明、链接、截止时间、文件名 |
| 找课件 | `material list --course 课程名`，只看一章加 `--chapter 章节名` | 照课程里的先后：文件名、大小、在哪一章（`chapter`，有小节时还有 `section`）、所在活动，视频带 `video`；网页上只能预览、没有下载按钮的文件同样能下载 |
| 下载课件 | `material download --course 课程名 --name 文件名` | 本地路径。`--name` 可写文件名或所在活动名，多个用竖线分隔；某一章的全部写 `--chapter 章节名`（章节名照用户的说法写，对到几章时返回候选），整门课全部用 `--all`，这两种都不含视频（结果的 `note` 会说跳过了几个、共多大），用户要连视频一起下再加 `--video`；某一个视频直接写进 `--name`。各章有同名文件（都叫「课件.pdf」）时 `--chapter` 和 `--name` 一起给。下载过的直接复用，中断的下次接着下 |
| 一门课的作业 | `homework list --course 课程名` | 全部作业（含已交）：status 为 未交 / 已交 / 已截止未交，requirement、score |
| 某个作业的要求和我交了什么 | `homework view --course 课程名 --name 作业名` | 完整要求、老师附件、提交方式与次数、能否撤回，本人提交记录（文件、分数、老师评语、批改附件；老师只在网页上批注时为 `annotation`） |
| 把我交的作业文件发我、老师批改后传回的文件 | `homework download --course 课程名 --name 作业名` | 最近一次提交的文件在 `files`，老师传回的批改文件在 `correctionFiles`，都是本地路径。老师只在网页上批注时给 `annotation` 说明；这次提交没有文件时 `count` 为 0 并在 `note` 说明原因 |
| 下载作业的附件（老师给的题目、模板） | `homework attachments --course 课程名 --name 作业名` | 本地路径，在 `files`。只要其中一个加 `--file 附件名`（多个用竖线分隔）；下载过的直接复用 |
| 交作业 | `homework submit --course 课程名 --name 作业名 --file 文件 --confirm` | 多个文件用竖线分隔；文字作业或留言用 `--comment`。提交后自动回查，`verified: true` 才算交上 |
| 撤回作业 | `homework retract --course 课程名 --name 作业名 --confirm` | 撤回最近一次提交到草稿（老师允许时）并回查 |

下载结果总在 `files` 列表里（一个文件也是），个别失败的列在 `failed`。下载到的文件直接用返回的本地路径读取或发送。

签到的日常调用：

`ZJU_ALLOW_WRITE=1 node scripts/zju.ts xuezai rollcall --confirm`

单次签到不传 duration，挂 10 分钟（600 秒），每 4 秒检查一次，确认成功立即停止。用户说了时长才加 `--duration 秒数`，不设上限；指定间隔才加 `--interval 秒数`。只查有没有点名用 `xuezai rollcall status`，不作为签到前置步骤。

| 用户说法 | 命令 |
|---|---|
| 帮我签到 / GPS 签到 / 雷达签到 | `xuezai rollcall --confirm`，只运行 GPS/雷达 |
| 开启数字签到 | `xuezai rollcall number --confirm`，自动准备字幕、取码、提交和回查 |
| 签到全开 | `xuezai rollcall all --confirm`，组合两路，任一路成功就全部停止 |

三者均需 `ZJU_ALLOW_WRITE=1`，时长、间隔的单位和默认值相同。数字签到应在课前开启，用户指定的 duration 要覆盖所需课堂；启动晚了不能补回先前文字。默认 GPS 不连接智云。数字和全开内部复用智云远程配置，执行机需要在线；失败不会冒充签到成功。仅停止本次签到创建的采集，用户原来独立开启的课堂采集继续运行。

## 点名记录

`xuezai rollcall history [--course 课程名]` 列出以往每次点名：时间（北京时间）、方式（雷达/数字/二维码）、状态（已签到、缺勤、未签（点名未结束）；其他平台状态原样给出）。省略 course 查全部学期的课程；course 按名称模糊匹配，同名课程一并返回。课程按最近一次点名排序，每门课的记录最近的在前，附 total/signed/notSigned。message 已汇总总次数和每次未签到的课程与时间，直接转述。部分课程读取失败返回 BAD_RESPONSE，`error.detail.result` 保留已取得的记录与逐课程错误。

## 执行结果

GPS 与数字分别只检查自己类型的点名，其他类型的已签记录不当作本次成功。全开复用两套执行器，任一路 confirmed success 后取消另一条；一条不可用时另一条仍继续。

数字只从同课程时间窗口的定稿文字提取带签到语境的完整四位码，不补全缺位或枚举。明确错码才换下一个有证据的候选；其他结果先回查，仍未签上就下一轮重试同一码。回查确认 signed/already-signed 才是成功；缺码时附 windowText 与原因。到期、取消、字幕无法读取或平台拒绝均明确报告。

结果以 status/message 为准；未完成返回非零，error.detail.result 保留业务结果。每次提交前写 journal，日志失败不提交。cleanupWarning 表示本次字幕采集的停止尚未确认，后台仍受原任务截止时间限制。

## 边界与错误

当前边界：支持个人文件/文字作业提交，以及雷达/数字点名应答；小组作业提交、在线考试答题、PTA 和学习进度写入未在此模块实现。todos 自动合并平台待办（含考试/测验）与各课作业补查，按课程作业的提交状态纠正残留待办；默认排除已交作业，`--done` 时保留并标为已完成。

待办遇到部分读取失败时返回 BAD_RESPONSE，error.detail.result 保留已取得的待办与逐课程错误。
