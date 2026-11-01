# 学在浙大

## 命令

```text
xuezai
├─ todos                                    待办
├─ course    list · view                    我的课程；一门课的章节与活动
├─ material  list · download                课件等文件
├─ homework  list · view · download · attachments · submit · retract 作业
├─ rollcall  status · history                点名：当前点名、历史记录（只读）
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

点名只能查看：`xuezai rollcall status` 看现在有没有点名、本人是否已签。本版本不提交签到，学在签到请在官方 App 里完成。

## 点名记录

`xuezai rollcall history [--course 课程名]` 列出以往每次点名：时间（北京时间）、方式（雷达/数字/二维码）、状态（已签到、缺勤、未签（点名未结束）；其他平台状态原样给出）。省略 course 查全部学期的课程；course 按名称模糊匹配，同名课程一并返回。课程按最近一次点名排序，每门课的记录最近的在前，附 total/signed/notSigned。message 已汇总总次数和每次未签到的课程与时间，直接转述。部分课程读取失败返回 BAD_RESPONSE，`error.detail.result` 保留已取得的记录与逐课程错误。

## 边界与错误

当前边界：支持个人文件/文字作业提交；点名只读，不提交签到；小组作业提交、在线考试答题、PTA 和学习进度写入未在此模块实现。todos 自动合并平台待办（含考试/测验）与各课作业补查，按课程作业的提交状态纠正残留待办；默认排除已交作业，`--done` 时保留并标为已完成。

待办遇到部分读取失败时返回 BAD_RESPONSE，error.detail.result 保留已取得的待办与逐课程错误。
