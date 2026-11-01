# 当前命令总表

生成日期：2026-11-01。共 179 条公开命令路径、18 个模块。

入口为 `node scripts/zju.ts <module> <command> [参数]`。默认帮助逐级展示；`--help --all` 展开当前范围全部公开命令。参数类型与帮助来自实际注册定义，本生成器不执行登录或业务。

系统归属见 [架构](../dev/architecture.md)。未知参数、多余位置参数和错误类型会报错；业务对象的进一步校验由模块负责。

| 模块 | 公开路径数 | 范围 |
|---|---:|---|
| [profile](#profile) | 2 | 配置初始化与脱敏查看 |
| [webvpn](#webvpn) | 8 | 网络诊断、WebVPN 会话与 URL 工具 |
| [zjuam](#zjuam) | 3 | 统一身份认证维护 |
| [zdbk](#zdbk) | 18 | 课表、考试安排、成绩绩点、培养方案与自主选课 |
| [notice](#notice) | 4 | 学校各单位和本人学院的通知公告：教务网、学工部、研工部、团委、综合服务网、各学院官网等，检索、全文与新通知 |
| [sztz](#sztz) | 8 | 二三四课堂（素质拓展平台）：活动中心、可申请记点的项目、本人记点与成绩单，活动报名、取消报名与收藏 |
| [ebook](#ebook) | 1 | 学校订购的电子图书：有没有某本书的电子版、在哪个平台有全文（图书馆电子书刊导航和超星） |
| [lab](#lab) | 10 | 实验课表、报告成绩、班次余量与选课执行 |
| [xuezai](#xuezai) | 19 | 课程资料、作业、待办与点名 |
| [tyys](#tyys) | 12 | 体艺考勤查询与体育场馆预约 |
| [pta](#pta) | 14 | PTA 独立登录、作业进度、小题保存与提交 |
| [chaoxing](#chaoxing) | 9 | 超星学习通的课程、课件与视频下载 |
| [zhiyun](#zhiyun) | 16 | 课堂资源查询、下载、实时字幕与本地转写 |
| [cc98](#cc98) | 32 | 论坛查询、个人中心与互动发布 |
| [chalaoshi](#chalaoshi) | 3 | 教师评价与课程绩点 |
| [cnki](#cnki) | 5 | 中国知网文献检索、筛选与全文 PDF 下载 |
| [mail](#mail) | 7 | 浙大邮箱：邮件列表、正文、附件下载、发信和回复 |
| [doc](#doc) | 8 | PDF、Word、PPT、Excel 等文件或链接转文字；图片与 Word 转 PDF、合并、取页、找页、取图、渲染 |

## profile

配置初始化与脱敏查看

### profile init

```text
zju profile init [--zju-username VALUE] [--zju-password VALUE] [--webvpn-username VALUE] [--webvpn-password VALUE] [--pta-username VALUE] [--pta-password VALUE] [--transport webvpn|direct] 生成 profile.env 模板；已存在时只更新给出的项
```

`--zju-username`：文本/路径，允许空值清除配置；`--zju-password`：文本/路径，允许空值清除配置；`--webvpn-username`：文本/路径，允许空值清除配置；`--webvpn-password`：文本/路径，允许空值清除配置；`--pta-username`：文本/路径，允许空值清除配置；`--pta-password`：文本/路径，允许空值清除配置；`--transport`：webvpn / direct。

### profile show

```text
zju profile show  显示配置；密码只显示是否已填
```

无参数。

## webvpn

网络诊断、WebVPN 会话与 URL 工具

### webvpn check

```text
zju webvpn check [--host VALUE] [--fresh] 网络诊断：直连与 WebVPN 是否可用、凭据与会话是否有效；给了 --host 时只测这些主机能否访问
```

`--host`：文本/路径；`--fresh`：开关。

### webvpn probe

```text
zju webvpn probe --host VALUE [--via VALUE] 开发用：探测一个新站点该直连还是走 WebVPN
```

`--host`：文本/路径，必填；`--via`：文本/路径。

### webvpn url encode

```text
zju webvpn url encode [--host VALUE] [--url VALUE] 真实主机名或 URL → WebVPN 形式
```

`--host`：文本/路径；`--url`：文本/路径。

### webvpn url decode

```text
zju webvpn url decode [--enc VALUE] [--url VALUE] WebVPN 形式 → 真实主机名或 URL
```

`--enc`：文本/路径；`--url`：文本/路径。

### webvpn session login

```text
zju webvpn session login [--fresh] WebVPN 登录并保存会话（校园网账号，与统一身份认证不同）
```

`--fresh`：开关。

### webvpn session status

```text
zju webvpn session status  本地会话状态（不联网）
```

无参数。

### webvpn session logout

```text
zju webvpn session logout  清除本地会话
```

无参数。

### webvpn session import-cookie

```text
zju webvpn session import-cookie --ticket VALUE [--route VALUE] 从浏览器导入 WebVPN 会话（登录要验证码时用）
```

`--ticket`：文本/路径，必填；`--route`：文本/路径。

## zjuam

统一身份认证维护

### zjuam session login

```text
zju zjuam session login [--fresh] 统一身份认证登录并保存会话
```

`--fresh`：开关。

### zjuam session status

```text
zju zjuam session status  本地会话状态（不联网）
```

无参数。

### zjuam session logout

```text
zju zjuam session logout  清除本地会话
```

无参数。

## zdbk

课表、考试安排、成绩绩点、培养方案与自主选课

### zdbk timetable

```text
zju zdbk timetable [--year VALUE] [--term VALUE] 完整课表：每门课的教师、星期、节次、起止时间、周次与教室，附当前北京时间；自动缓存
```

`--year`：文本/路径；`--term`：文本/路径。

### zdbk exams

```text
zju zdbk exams [--course VALUE] [--year VALUE] [--term VALUE] 本人考试安排：期中与期末的日期、时间、考场和座位号，未公布的如实标出
```

`--course`：文本/路径；`--year`：文本/路径；`--term`：文本/路径。

### zdbk grades

```text
zju zdbk grades  本人全部成绩、学分与五分制平均绩点：总体、各学期和主修课程
```

无参数。

### zdbk student

```text
zju zdbk student  本人学籍：学号、姓名、学院、专业和行政班（本科教务网，研究生查不到）
```

无参数。

### zdbk plan view

```text
zju zdbk plan view [--major VALUE] [--year VALUE] 本人（或指定专业）的培养方案：学分、学位、核心课，并把完整 PDF 存到本地
```

`--major`：文本/路径；`--year`：文本/路径。

### zdbk plan list

```text
zju zdbk plan list [--year VALUE] [--college VALUE] [--major VALUE] 某一年级的培养方案列表，可按学院、专业名筛选
```

`--year`：文本/路径；`--college`：文本/路径；`--major`：文本/路径。

### zdbk selection context

```text
zju zdbk selection context  当前选课学年学期、每门课可填的志愿数和课程类别；页面可读不代表现在允许选课
```

无参数。

### zdbk selection courses

```text
zju zdbk selection courses [--category VALUE] 某个课程类别下的全部课程；不给类别时列出类别
```

`--category`：文本/路径。

### zdbk selection search

```text
zju zdbk selection search --keyword VALUE [--only-available] 按课程名搜索本学期开设的课程，自动查完全部分页
```

`--keyword`：文本/路径，必填；`--only-available`：开关。

### zdbk selection sections

```text
zju zdbk selection sections --course VALUE [--teacher VALUE] [--time VALUE] [--section VALUE] 一门课的教学班：教师、时间、地点、余量与容量
```

`--course`：文本/路径，必填；`--teacher`：文本/路径；`--time`：文本/路径；`--section`：文本/路径。

### zdbk selection selected

```text
zju zdbk selection selected  本人已选上的课和待筛选的志愿：教学班、志愿次序与状态，附选课系统汇总的学分
```

无参数。

### zdbk selection credits

```text
zju zdbk selection credits  选课系统汇总的本学期学分（total 总计、regular 长学期、short 短学期）；不据此推断低定资格
```

无参数。

### zdbk selection select

```text
zju zdbk selection select --course VALUE [--teacher VALUE] [--time VALUE] [--section VALUE] [--dry-run] [--confirm] 保存一个教学班志愿并回查；教学班不唯一时返回候选
```

`--course`：文本/路径，必填；`--teacher`：文本/路径；`--time`：文本/路径；`--section`：文本/路径；`--dry-run`：开关；`--confirm`：开关。

### zdbk selection reorder

```text
zju zdbk selection reorder --course VALUE --order VALUE [--dry-run] [--confirm] 调整一门课（或一个志愿组）的志愿顺序并回查，须给出完整顺序
```

`--course`：文本/路径，必填；`--order`：文本/路径，必填；`--dry-run`：开关；`--confirm`：开关。

### zdbk selection drop

```text
zju zdbk selection drop --course VALUE [--teacher VALUE] [--section VALUE] [--dry-run] [--confirm] 退掉一个已选或待筛选的教学班并回查
```

`--course`：文本/路径，必填；`--teacher`：文本/路径；`--section`：文本/路径；`--dry-run`：开关；`--confirm`：开关。

### zdbk session login

```text
zju zdbk session login [--fresh] 教务网登录（CAS 委托）并保存会话
```

`--fresh`：开关。

### zdbk session status

```text
zju zdbk session status  教务网会话状态（不联网）
```

无参数。

### zdbk session logout

```text
zju zdbk session logout  清除教务网会话
```

无参数。

## notice

学校各单位和本人学院的通知公告：教务网、学工部、研工部、团委、综合服务网、各学院官网等，检索、全文与新通知

### notice list

```text
zju notice list [--keyword VALUE] [--source VALUE] [--since VALUE] [--until VALUE] [--limit N] 最新通知的完整标题、正文和附件；默认读本人学院官网、团委、综合服务网，以及按本科生或研究生选的教务、学工来源，自动翻页
```

`--keyword`：文本/路径；`--source`：文本/路径；`--since`：文本/路径；`--until`：文本/路径；`--limit`：整数，默认 10，最小 1，最大 100。

### notice view

```text
zju notice view [--url VALUE] [--title VALUE] 通知的全文、日期和附件；标题不唯一时返回候选
```

`--url`：文本/路径；`--title`：文本/路径。

### notice new

```text
zju notice new  上次查看之后新发布的通知：只有标题、日期、来源和链接，含本人学院和综合服务网全校通知
```

无参数。

### notice sources

```text
zju notice sources  已接入的通知来源和栏目，本人学院和可指定的其他学院
```

无参数。

## sztz

二三四课堂（素质拓展平台）：活动中心、可申请记点的项目、本人记点与成绩单，活动报名、取消报名与收藏

### sztz credits

```text
zju sztz credits  本人第二、三、四课堂的记点、学分和是否达标，美育、劳育是否达标，以及成绩单上的每一条认定记录
```

无参数。

### sztz activity list

```text
zju sztz activity list [--keyword VALUE] [--date VALUE] [--include-ended] [--limit N] 活动中心里还没结束的活动：记点、报名时间与方式、活动时间地点、名额，标出本人已报名和收藏的
```

`--keyword`：文本/路径；`--date`：文本/路径；`--include-ended`：开关；`--limit`：整数，默认 30，最小 1，最大 100。

### sztz activity new

```text
zju sztz activity new  上次查看之后新出现、还能报名或还没开始报名的活动：名称、举办单位、记点、活动时间和报名起止，没有简介
```

无参数。

### sztz activity mine

```text
zju sztz activity mine  本人在平台上报名的、收藏的和已认定记点的活动
```

无参数。

### sztz activity signup

```text
zju sztz activity signup --name VALUE [--cancel] [--confirm] 报名一个活动并回查，加 --cancel 是取消报名（只能在报名截止前）；不在平台报名的活动会说明该怎么报
```

`--name`：文本/路径，必填；`--cancel`：开关；`--confirm`：开关。

### sztz activity favorite

```text
zju sztz activity favorite --name VALUE [--cancel] [--confirm] 收藏一个活动并回查，加 --cancel 是取消收藏
```

`--name`：文本/路径，必填；`--cancel`：开关；`--confirm`：开关。

### sztz projects

```text
zju sztz projects [--keyword VALUE] [--category VALUE] 可以申请认定记点的项目（学科竞赛、社会实践、就业实习等）及各自的记点范围
```

`--keyword`：文本/路径；`--category`：文本/路径。

### sztz notices

```text
zju sztz notices  平台通知全文：项目审核时间、记点申请流程等
```

无参数。

## ebook

学校订购的电子图书：有没有某本书的电子版、在哪个平台有全文（图书馆电子书刊导航和超星）

### ebook search

```text
zju ebook search [--title VALUE] [--isbn VALUE] [--limit N] 学校订购的电子图书里有没有某本书（同时查图书馆电子书刊导航和超星电子书）：书名、作者、出版社、ISBN，以及有全文的平台和直达地址
```

`--title`：文本/路径；`--isbn`：文本/路径；`--limit`：整数，默认 10，最小 1，最大 50。

## lab

实验课表、报告成绩、班次余量与选课执行

### lab timetable

```text
zju lab timetable [--term VALUE] 我的实验课表：每次实验的日期、开始时间、实验名、实验室和教师，附当前北京时间
```

`--term`：文本/路径。

### lab grades

```text
zju lab grades [--term VALUE] 每次实验的报告成绩：实验名、序号、教师、分数与是否出分，默认当前学期
```

`--term`：文本/路径。

### lab courses

```text
zju lab courses [--term VALUE] 我的实验课：星期、上午或下午、可选实验个数上限、已选个数和选课开放时间
```

`--term`：文本/路径。

### lab labs

```text
zju lab labs --course VALUE [--term VALUE] 一门课的全部实验：教师、实验室、容量、已选人数，以及排除本人已选、周次冲突和满员后还能选的周次
```

`--course`：文本/路径，必填；`--term`：文本/路径。

### lab selected

```text
zju lab selected [--term VALUE] 我已选的实验：实验名、教师、实验室、实验序号和上课日期
```

`--term`：文本/路径。

### lab select

```text
zju lab select --course VALUE --lab VALUE [--week VALUE] [--teacher VALUE] [--cancel] [--term VALUE] [--confirm] 选一个实验并回查，选之前先查容量，满员不提交；加 --cancel 是退掉一个已选的实验并回查
```

`--course`：文本/路径，必填；`--lab`：文本/路径，必填；`--week`：文本/路径；`--teacher`：文本/路径；`--cancel`：开关；`--term`：文本/路径；`--confirm`：开关。

### lab notices

```text
zju lab notices  实验选课平台的公告全文
```

无参数。

### lab session login

```text
zju lab session login [--fresh] 实验课选课平台登录（平台自己的账号，默认同学号），返回账号与姓名
```

`--fresh`：开关。

### lab session status

```text
zju lab session status  本地实验课会话状态，不联网
```

无参数。

### lab session logout

```text
zju lab session logout  清除本地实验课会话
```

无参数。

## xuezai

课程资料、作业、待办与点名

### xuezai todos

```text
zju xuezai todos [--course VALUE] [--done] 待办：当前学期各课未交的作业和测验，按截止先后，含作业要求
```

`--course`：文本/路径；`--done`：开关。

### xuezai course list

```text
zju xuezai course list [--semester VALUE] [--all] 本人课程：名称、学期、教师；默认当前学期
```

`--semester`：文本/路径；`--all`：开关。

### xuezai course view

```text
zju xuezai course view --course VALUE 一门课的简介和章节，每章列出其中的资料、作业、链接等活动及其说明、截止时间和文件名
```

`--course`：文本/路径，必填。

### xuezai material list

```text
zju xuezai material list --course VALUE [--chapter VALUE] 一门课的全部文件，照课程里的先后：文件名、大小、在哪一章和所在活动
```

`--course`：文本/路径，必填；`--chapter`：文本/路径。

### xuezai material download

```text
zju xuezai material download --course VALUE [--name VALUE] [--chapter VALUE] [--all] [--video] [--out-dir VALUE] 下载课程文件，返回本地路径；下载过的直接复用。默认存到 data/output/xuezai/课程名/
```

`--course`：文本/路径，必填；`--name`：文本/路径；`--chapter`：文本/路径；`--all`：开关；`--video`：开关；`--out-dir`：文本/路径。

### xuezai homework list

```text
zju xuezai homework list --course VALUE 一门课的全部作业（含已交），按截止先后：状态、要求、分数
```

`--course`：文本/路径，必填。

### xuezai homework view

```text
zju xuezai homework view --course VALUE --name VALUE 一个作业的完整要求、老师附件、提交规则和本人提交记录（文件、分数、评语）
```

`--course`：文本/路径，必填；`--name`：文本/路径，必填。

### xuezai homework download

```text
zju xuezai homework download --course VALUE --name VALUE [--out-dir VALUE] 下载本人交过的作业文件（最近一次提交）和老师批改后传回的文件，返回本地路径
```

`--course`：文本/路径，必填；`--name`：文本/路径，必填；`--out-dir`：文本/路径。

### xuezai homework attachments

```text
zju xuezai homework attachments --course VALUE --name VALUE [--file VALUE] [--out-dir VALUE] 下载老师随作业给的附件，返回本地路径；下载过的直接复用。默认存到 data/output/xuezai/课程名/作业附件/作业名/
```

`--course`：文本/路径，必填；`--name`：文本/路径，必填；`--file`：文本/路径；`--out-dir`：文本/路径。

### xuezai homework submit

```text
zju xuezai homework submit --course VALUE --name VALUE [--file VALUE] [--comment VALUE] [--confirm] 提交个人作业并回查；文件和文字至少给一样
```

`--course`：文本/路径，必填；`--name`：文本/路径，必填；`--file`：文本/路径；`--comment`：文本/路径；`--confirm`：开关。

### xuezai homework retract

```text
zju xuezai homework retract --course VALUE --name VALUE [--confirm] 撤回最近一次提交到草稿（老师允许时）并回查
```

`--course`：文本/路径，必填；`--name`：文本/路径，必填；`--confirm`：开关。

### xuezai rollcall

```text
zju xuezai rollcall [--interval VALUE] [--duration VALUE] [--confirm] GPS/雷达签到：仅监测雷达点名，不启动数字签到或字幕；成功立即停止
```

`--interval`：数值，默认 4，最小 1，最大 3600；`--duration`：数值，默认 600，最小 1；`--confirm`：开关。

### xuezai rollcall number

```text
zju xuezai rollcall number [--interval VALUE] [--duration VALUE] [--confirm] 数字签到：准备课堂字幕，监测数字点名、取码并回查；成功立即停止
```

`--interval`：数值，默认 4，最小 1，最大 3600；`--duration`：数值，默认 600，最小 1；`--confirm`：开关。

### xuezai rollcall all

```text
zju xuezai rollcall all [--interval VALUE] [--duration VALUE] [--confirm] 签到全开：组合 GPS 和数字执行器，任一路确认成功后两路一起停止
```

`--interval`：数值，默认 4，最小 1，最大 3600；`--duration`：数值，默认 600，最小 1；`--confirm`：开关。

### xuezai rollcall status

```text
zju xuezai rollcall status  现在有没有点名、本人是否已签；只查看，不签到
```

无参数。

### xuezai rollcall history

```text
zju xuezai rollcall history [--course VALUE] 历史点名记录：各课程每次点名的时间、方式和是否签到，最近的在前
```

`--course`：文本/路径。

### xuezai session login

```text
zju xuezai session login [--fresh] 检查或更新学在站点会话，返回当前账号；认证复用 zjuam
```

`--fresh`：开关。

### xuezai session status

```text
zju xuezai session status  本地会话状态（不联网）
```

无参数。

### xuezai session logout

```text
zju xuezai session logout  清除本地学在浙大会话
```

无参数。

## tyys

体艺考勤查询与体育场馆预约

### tyys venue list

```text
zju tyys venue list [--sport VALUE] [--campus VALUE] [--venue VALUE] [--date VALUE] [--time VALUE] 查询体育场馆；未指定唯一场馆时返回目录，日期默认今天
```

`--sport`：文本/路径；`--campus`：文本/路径；`--venue`：文本/路径；`--date`：文本/路径，默认 今天；`--time`：文本/路径。

### tyys venue notice

```text
zju tyys venue notice  预约须知全文、各场馆放号时刻及来源；自动复用缓存
```

无参数。

### tyys venue book

```text
zju tyys venue book [--sport VALUE] [--campus VALUE] [--venue VALUE] --date VALUE --time VALUE [--buddy VALUE] [--max-fee VALUE] --confirm 预约当前已开放的空场，自动处理验证码、同伴、付款和回查
```

`--sport`：文本/路径；`--campus`：文本/路径；`--venue`：文本/路径；`--date`：文本/路径，必填；`--time`：文本/路径，必填；`--buddy`：文本/路径；`--max-fee`：文本/路径；`--confirm`：开关，必填。

### tyys venue order list

```text
zju tyys venue order list [--date VALUE] [--venue VALUE] 本人今天及以后的预约；日期筛选支持明确日期
```

`--date`：文本/路径；`--venue`：文本/路径。

### tyys venue order cancel

```text
zju tyys venue order cancel --date VALUE --time VALUE [--venue VALUE] --confirm 定位一个明确的本人预约，取消并回查；收费预约不自动取消
```

`--date`：文本/路径，必填；`--time`：文本/路径，必填；`--venue`：文本/路径；`--confirm`：开关，必填。

### tyys venue setup

```text
zju tyys venue setup  安装本地验证码识别环境与模型，不请求场馆服务器
```

无参数。

### tyys venue check

```text
zju tyys venue check  检查本地验证码检测、识别和模型，不请求场馆服务器
```

无参数。

### tyys rollcall status

```text
zju tyys rollcall status  现在的签到目标与当天到勤结果；只查看，不取码、不提交
```

无参数。

### tyys rollcall history

```text
zju tyys rollcall history [--course VALUE] 体育课历史考勤：各学期每次课的日期与到勤状态，最近的在前
```

`--course`：文本/路径。

### tyys session login

```text
zju tyys session login [--fresh] 检查或更新体艺 App 会话
```

`--fresh`：开关。

### tyys session status

```text
zju tyys session status  本地体艺会话状态
```

无参数。

### tyys session logout

```text
zju tyys session logout  移除本地体艺会话
```

无参数。

## pta

PTA 独立登录、作业进度、小题保存与提交

### pta homework list

```text
zju pta homework list [--scope active|all] [--keyword VALUE] [--state all|todo|done] 本人作业及完成情况；默认只列还没截止的
```

`--scope`：active / all，默认 active；`--keyword`：文本/路径；`--state`：all / todo / done，默认 all。

### pta homework view

```text
zju pta homework view --set VALUE 一份作业的截止时间、进度、得分和每道小题的题号、题型、分值与对错
```

`--set`：文本/路径，必填。

### pta homework start

```text
zju pta homework start --set VALUE [--confirm] 开始答题，可能启动限时计时；查询不会自动开始
```

`--set`：文本/路径，必填；`--confirm`：开关。

### pta homework finish

```text
zju pta homework finish --set VALUE [--allow-incomplete] [--confirm] 结束整份作业（交卷），须教师允许提前结束；只交已经保存在平台上的答案
```

`--set`：文本/路径，必填；`--allow-incomplete`：开关；`--confirm`：开关。

### pta problem view

```text
zju pta problem view --set VALUE --problem VALUE 一道小题的完整题面、选项或样例、限制，本人最后一次作答与判题结果、代码草稿
```

`--set`：文本/路径，必填；`--problem`：文本/路径，必填。

### pta problem save

```text
zju pta problem save --set VALUE [--problem VALUE] [--answer VALUE] [--answer-file VALUE] [--code-file VALUE] [--compiler VALUE] [--answers-file VALUE] [--confirm] 保存答案但不判题：判断、选择、填空保存为答题记录，代码题保存为草稿
```

`--set`：文本/路径，必填；`--problem`：文本/路径；`--answer`：文本/路径；`--answer-file`：文本/路径；`--code-file`：文本/路径；`--compiler`：文本/路径；`--answers-file`：文本/路径；`--confirm`：开关。

### pta problem submit

```text
zju pta problem submit --set VALUE [--problem VALUE] [--answer VALUE] [--answer-file VALUE] [--code-file VALUE] [--compiler VALUE] [--answers-file VALUE] [--confirm] 提交答案：代码题会判题并等出结果，判断、选择、填空保存为答题记录；不会结束整份作业
```

`--set`：文本/路径，必填；`--problem`：文本/路径；`--answer`：文本/路径；`--answer-file`：文本/路径；`--code-file`：文本/路径；`--compiler`：文本/路径；`--answers-file`：文本/路径；`--confirm`：开关。

### pta submission list

```text
zju pta submission list --set VALUE [--problem VALUE] [--limit N] 本人在一份作业里的提交历史，最近的在前
```

`--set`：文本/路径，必填；`--problem`：文本/路径；`--limit`：整数，默认 30，最小 1，最大 100。

### pta submission view

```text
zju pta submission view --set VALUE --id VALUE 一次提交的作答内容和判题详情（代码、编译信息、各测试点）
```

`--set`：文本/路径，必填；`--id`：文本/路径，必填。

### pta reconcile

```text
zju pta reconcile --set VALUE 回查上一次没有确认结果的保存或提交；只读，确认成功才清除本地的未决记录
```

`--set`：文本/路径，必填。

### pta session login

```text
zju pta session login [--fresh] 建立或复用 PTA 独立会话，返回当前账号
```

`--fresh`：开关。

### pta session status

```text
zju pta session status  查看本地 PTA 会话，不联网
```

无参数。

### pta session logout

```text
zju pta session logout  清除当前 PTA 账号的本地会话
```

无参数。

### pta session import-cookie

```text
zju pta session import-cookie --file VALUE 验证并导入正常浏览器登录后的 Cookie
```

`--file`：文本/路径，必填。

## chaoxing

超星学习通的课程、课件与视频下载

### chaoxing course list

```text
zju chaoxing course list  本人在学习通上的课程：名称、教师、班级和课程页面的链接
```

无参数。

### chaoxing chapter list

```text
zju chaoxing chapter list --course VALUE [--fresh] 一门课各章节的课件和视频：每一节、「资料」栏的每个文件夹各有哪些文件，按课程里的顺序
```

`--course`：文本/路径，必填；`--fresh`：开关。

### chaoxing material list

```text
zju chaoxing material list --course VALUE [--chapter VALUE] 一门课的课件等文件（章节里的文档和「资料」栏）：文件名、大小和所在章节或文件夹
```

`--course`：文本/路径，必填；`--chapter`：文本/路径。

### chaoxing material download

```text
zju chaoxing material download --course VALUE [--name VALUE] [--chapter VALUE] [--all] [--out-dir VALUE] 下载课件，返回本地路径；下载过的直接复用。默认存到 data/output/chaoxing/课程名/，按章节分目录
```

`--course`：文本/路径，必填；`--name`：文本/路径；`--chapter`：文本/路径；`--all`：开关；`--out-dir`：文本/路径。

### chaoxing video list

```text
zju chaoxing video list --course VALUE [--chapter VALUE] 一门课的全部视频：文件名、大小和所在章节
```

`--course`：文本/路径，必填；`--chapter`：文本/路径。

### chaoxing video download

```text
zju chaoxing video download --course VALUE [--name VALUE] [--chapter VALUE] [--all] [--quality original|playback] [--out-dir VALUE] 下载视频，返回本地路径；下载过的直接复用。默认存到 data/output/chaoxing/课程名/，按章节分目录
```

`--course`：文本/路径，必填；`--name`：文本/路径；`--chapter`：文本/路径；`--all`：开关；`--quality`：original / playback，默认 original；`--out-dir`：文本/路径。

### chaoxing session login

```text
zju chaoxing session login [--fresh] 建立或复用超星会话，返回当前账号
```

`--fresh`：开关。

### chaoxing session status

```text
zju chaoxing session status  本地会话状态（不联网）
```

无参数。

### chaoxing session logout

```text
zju chaoxing session logout  清除本地超星会话
```

无参数。

## zhiyun

课堂资源查询、下载、实时字幕与本地转写

### zhiyun search courses

```text
zju zhiyun search courses [--scope mine|all] [--keyword VALUE] [--teacher VALUE] [--limit N] 搜索课程，自动查完必要分页；直接返回课程、教师和学期
```

`--scope`：mine / all；`--keyword`：文本/路径；`--teacher`：文本/路径；`--limit`：整数，默认 20，最小 1，最大 200。

### zhiyun search lessons

```text
zju zhiyun search lessons [--course VALUE] [--teacher VALUE] [--lesson VALUE] [--date VALUE] [--week-of VALUE] [--all] 一门课的课次：第几次、日期与时间、能否回放、有哪些资源；按开课时间编号，含还没上的
```

`--course`：文本/路径；`--teacher`：文本/路径；`--lesson`：文本/路径；`--date`：文本/路径；`--week-of`：文本/路径；`--all`：开关。

### zhiyun search resources

```text
zju zhiyun search resources [--course VALUE] [--teacher VALUE] [--lesson VALUE] [--date VALUE] [--week-of VALUE] [--all] [--kind VALUE] 某几次课有哪些资源：回放视频、音频、课件、课堂截图张数、字幕句数；只查看，不下载
```

`--course`：文本/路径；`--teacher`：文本/路径；`--lesson`：文本/路径；`--date`：文本/路径；`--week-of`：文本/路径；`--all`：开关；`--kind`：文本/路径，默认 all。

### zhiyun search subtitles

```text
zju zhiyun search subtitles [--course VALUE] [--teacher VALUE] [--lesson VALUE] [--date VALUE] [--week-of VALUE] [--all] --keyword VALUE 在课程录播字幕里搜关键词（如老师有没有说点名、考试范围）：返回命中的课次、时间点和前后文；省略课次时搜全部有录像的课次
```

`--course`：文本/路径；`--teacher`：文本/路径；`--lesson`：文本/路径；`--date`：文本/路径；`--week-of`：文本/路径；`--all`：开关；`--keyword`：文本/路径，必填。

### zhiyun download

```text
zju zhiyun download [--course VALUE] [--teacher VALUE] [--lesson VALUE] [--date VALUE] [--week-of VALUE] [--all] [--kind VALUE] [--audio-format m4a|wav|mp3] [--out-dir VALUE] [--dry-run] 下载课次的回放、音频、课件、课堂截图或字幕，返回本地路径；视频取 1080p，下载过的复用
```

`--course`：文本/路径；`--teacher`：文本/路径；`--lesson`：文本/路径；`--date`：文本/路径；`--week-of`：文本/路径；`--all`：开关；`--kind`：文本/路径，默认 ppt；`--audio-format`：m4a / wav / mp3，默认 m4a；`--out-dir`：文本/路径；`--dry-run`：开关。

### zhiyun live start

```text
zju zhiyun live start [--course VALUE] 后台采集今天本人剩余课堂的官方字幕，末节结束后自动退出；重复调用复用当前任务
```

`--course`：文本/路径。

### zhiyun live status

```text
zju zhiyun live status  查看后台采集状态、课程和最近字幕；连接成功不等于已有文字
```

无参数。

### zhiyun live stop

```text
zju zhiyun live stop  停止当前后台字幕采集，保留已保存文字
```

无参数。

### zhiyun live text

```text
zju zhiyun live text [--course VALUE] [--at VALUE] [--before N] [--after N] 返回已保存的课堂文字窗口；未来部分由内部等待，缺失时段明确说明
```

`--course`：文本/路径；`--at`：文本/路径；`--before`：整数，默认 300，最小 0，最大 3600；`--after`：整数，默认 0，最小 0，最大 3600。

### zhiyun setup

```text
zju zhiyun setup [--component all|media|asr|ppt] [--engine sensevoice|firered] [--cpu] 准备智云本地依赖；复用可用环境，按需安装，默认只选 SenseVoice
```

`--component`：all / media / asr / ppt，默认 all；`--engine`：sensevoice / firered，默认 sensevoice；`--cpu`：开关。

### zhiyun check

```text
zju zhiyun check [--component asr|media|ppt] [--engine sensevoice|firered] [--device auto|cuda:0|cpu] [--batch-seconds N] 检查本地组件
```

`--component`：asr / media / ppt，默认 asr；`--engine`：sensevoice / firered，默认 sensevoice；`--device`：auto / cuda:0 / cpu，默认 auto；`--batch-seconds`：整数，默认 60，最小 1，最大 600。

### zhiyun trans audio

```text
zju zhiyun trans audio --file VALUE [--out-dir VALUE] 本地音视频 → 带时间的 Markdown 粗稿、TXT 和原始 JSON
```

`--file`：文本/路径，必填；`--out-dir`：文本/路径。

### zhiyun trans ppt

```text
zju zhiyun trans ppt --file VALUE [--out-dir VALUE] 课件文字/原图提取与去重，近似图标记供 AI 核对；不做 OCR
```

`--file`：文本/路径，必填；`--out-dir`：文本/路径。

### zhiyun session login

```text
zju zhiyun session login [--fresh] 建立或复用学校认证
```

`--fresh`：开关。

### zhiyun session status

```text
zju zhiyun session status  查看本地会话
```

无参数。

### zhiyun session logout

```text
zju zhiyun session logout  清除本地智云会话
```

无参数。

## cc98

论坛查询、个人中心与互动发布

### cc98 hot

```text
zju cc98 hot [--period today|weekly|monthly|history] [--account VALUE] 十大，或本周、本月、历史热门
```

`--period`：today / weekly / monthly / history，默认 today；`--account`：文本/路径。

### cc98 search

```text
zju cc98 search --keyword VALUE [--board VALUE] [--sort relevance|recent|replies] [--within-days N] [--limit N] [--account VALUE] 搜帖子标题。服务端只做子串匹配，标题里可能出现的几种说法（全名、简称、别的叫法）一次给完
```

`--keyword`：文本/路径，必填；`--board`：文本/路径；`--sort`：relevance / recent / replies，默认 relevance；`--within-days`：整数，最小 1；`--limit`：整数，默认 30，最小 1，最大 100；`--account`：文本/路径。

### cc98 user

```text
zju cc98 user [--name VALUE] [--id N] [--topics] [--account VALUE] 用户资料
```

`--name`：文本/路径；`--id`：整数，最小 1；`--topics`：开关；`--account`：文本/路径。

### cc98 board list

```text
zju cc98 board list [--keyword VALUE] [--all] [--account VALUE] 我关注的版面；也可按名称找版面或列出全站版面
```

`--keyword`：文本/路径；`--all`：开关；`--account`：文本/路径。

### cc98 board topics

```text
zju cc98 board topics [--name VALUE] [--id N] [--top] [--from N] [--size N] [--account VALUE] 版面的主题列表
```

`--name`：文本/路径；`--id`：整数，最小 1；`--top`：开关；`--from`：整数，默认 0，最小 0；`--size`：整数，默认 10，最小 1，最大 20；`--account`：文本/路径。

### cc98 board tags

```text
zju cc98 board tags [--name VALUE] [--id N] [--account VALUE] 该版发主题用的标签
```

`--name`：文本/路径；`--id`：整数，最小 1；`--account`：文本/路径。

### cc98 board post

```text
zju cc98 board post --board VALUE --title VALUE [--content VALUE] [--image VALUE] [--markdown] [--anonymous] [--tag1 N] [--tag2 N] [--type N] [--confirm] [--account VALUE] 发主题，可带图片。发出后不能删只能编辑，正文先给用户过目；有的版面必须选标签，先用 board tags 查
```

`--board`：文本/路径，必填；`--title`：文本/路径，必填；`--content`：文本/路径；`--image`：文本/路径；`--markdown`：开关；`--anonymous`：开关；`--tag1`：整数，最小 1；`--tag2`：整数，最小 1；`--type`：整数，默认 0，最小 0，最大 2；`--confirm`：开关；`--account`：文本/路径。

### cc98 topic view

```text
zju cc98 topic view --id VALUE [--page VALUE] [--lz] [--trace N] [--find VALUE] [--account VALUE] 看帖：主楼、全部热门回复和一页楼层，正文都是全文；可一次看多个帖、连读多页、只看楼主或某一楼的作者、只留含某些词的楼层
```

`--id`：文本/路径，必填；`--page`：文本/路径；`--lz`：开关；`--trace`：整数，最小 1；`--find`：文本/路径；`--account`：文本/路径。

### cc98 topic reply

```text
zju cc98 topic reply --id VALUE [--content VALUE] [--quote N] [--image VALUE] [--markdown] [--anonymous] [--force] [--confirm] [--account VALUE] 回帖，可引用某一楼、可带图片。发出后不能删只能编辑，正文先给用户过目；内容必须是用户自己的话
```

`--id`：文本/路径，必填；`--content`：文本/路径；`--quote`：整数，最小 1；`--image`：文本/路径；`--markdown`：开关；`--anonymous`：开关；`--force`：开关；`--confirm`：开关；`--account`：文本/路径。

### cc98 topic favorite

```text
zju cc98 topic favorite --id VALUE [--cancel] [--confirm] [--account VALUE] 收藏主题，加 --cancel 是取消收藏
```

`--id`：文本/路径，必填；`--cancel`：开关；`--confirm`：开关；`--account`：文本/路径。

### cc98 topic download

```text
zju cc98 topic download [--id VALUE] [--floor N] [--url VALUE] [--account VALUE] 下载帖子某一楼的全部图片、视频、附件，或单个 file.cc98.org 链接；存到 data/output/cc98/，返回本地路径，下载过的直接复用
```

`--id`：文本/路径；`--floor`：整数，最小 1；`--url`：文本/路径；`--account`：文本/路径。

### cc98 floor like

```text
zju cc98 floor like --post N --state like|dislike|none [--confirm] [--account VALUE] 赞、踩楼层，或取消
```

`--post`：整数，必填，最小 1；`--state`：like / dislike / none，必填；`--confirm`：开关；`--account`：文本/路径。

### cc98 floor rate

```text
zju cc98 floor rate --post N [--type plus|minus] --reason N [--confirm] [--account VALUE] 给楼层评分（风评）；每天有次数限制，发帖数不足 500 不能评
```

`--post`：整数，必填，最小 1；`--type`：plus / minus，默认 plus；`--reason`：整数，必填，最小 1；`--confirm`：开关；`--account`：文本/路径。

### cc98 floor rating-reasons

```text
zju cc98 floor rating-reasons [--account VALUE] 评分可选的理由（加分、扣分各一组）
```

`--account`：文本/路径。

### cc98 floor original

```text
zju cc98 floor original --post N [--account VALUE] 自己某一楼的原文（UBB/Markdown 原样），编辑前用
```

`--post`：整数，必填，最小 1；`--account`：文本/路径。

### cc98 floor edit

```text
zju cc98 floor edit --post N --content VALUE [--title VALUE] [--markdown] [--confirm] [--account VALUE] 编辑自己的楼层；先用 floor original 取原文。标题和格式不给时沿用原帖
```

`--post`：整数，必填，最小 1；`--content`：文本/路径，必填；`--title`：文本/路径；`--markdown`：开关；`--confirm`：开关；`--account`：文本/路径。

### cc98 private-message list

```text
zju cc98 private-message list [--from N] [--size N] [--account VALUE] 最近的私信会话；有未读的会话直接带出对话
```

`--from`：整数，默认 0，最小 0；`--size`：整数，默认 10，最小 1，最大 20；`--account`：文本/路径。

### cc98 private-message view

```text
zju cc98 private-message view --user VALUE [--from N] [--size N] [--account VALUE] 与某人的私信对话，从早到晚
```

`--user`：文本/路径，必填；`--from`：整数，默认 0，最小 0；`--size`：整数，默认 10，最小 1，最大 20；`--account`：文本/路径。

### cc98 private-message send

```text
zju cc98 private-message send --user VALUE [--content VALUE] [--image VALUE] [--force] [--confirm] [--account VALUE] 发私信，可带图片。发出后不能撤回，内容用用户给的原话；5 分钟内给同一人的相同内容不重复发
```

`--user`：文本/路径，必填；`--content`：文本/路径；`--image`：文本/路径；`--force`：开关；`--confirm`：开关；`--account`：文本/路径。

### cc98 account overview

```text
zju cc98 account overview [--account VALUE] 个人中心总览：财富、风评、发帖数、签到状态、各类未读数、关注的版面
```

`--account`：文本/路径。

### cc98 account topics

```text
zju cc98 account topics [--from N] [--size N] [--account VALUE] 我发的主题
```

`--from`：整数，默认 0，最小 0；`--size`：整数，默认 10，最小 1，最大 20；`--account`：文本/路径。

### cc98 account posts

```text
zju cc98 account posts [--hot] [--from N] [--size N] [--account VALUE] 我的回复
```

`--hot`：开关；`--from`：整数，默认 0，最小 0；`--size`：整数，默认 10，最小 1，最大 20；`--account`：文本/路径。

### cc98 account history

```text
zju cc98 account history [--from N] [--size N] [--account VALUE] 浏览记录
```

`--from`：整数，默认 0，最小 0；`--size`：整数，默认 10，最小 1，最大 20；`--account`：文本/路径。

### cc98 account favorites

```text
zju cc98 account favorites [--group N] [--keyword VALUE] [--from N] [--size N] [--account VALUE] 收藏的主题，同时列出收藏分组
```

`--group`：整数，默认 0，最小 0；`--keyword`：文本/路径；`--from`：整数，默认 0，最小 0；`--size`：整数，默认 10，最小 1，最大 20；`--account`：文本/路径。

### cc98 account following

```text
zju cc98 account following [--fans] [--from N] [--size N] [--account VALUE] 我关注的用户，或我的粉丝
```

`--fans`：开关；`--from`：整数，默认 0，最小 0；`--size`：整数，默认 10，最小 1，最大 20；`--account`：文本/路径。

### cc98 account feed

```text
zju cc98 account feed [--kind boards|users] [--from N] [--size N] [--account VALUE] 关注的版面或关注的用户的新帖
```

`--kind`：boards / users，默认 boards；`--from`：整数，默认 0，最小 0；`--size`：整数，默认 10，最小 1，最大 20；`--account`：文本/路径。

### cc98 account notifications

```text
zju cc98 account notifications [--kind reply|at|system] [--from N] [--size N] [--account VALUE] 消息：回复我的、@ 我的、系统通知，带主题和正文；有未读私信时一并列出
```

`--kind`：reply / at / system；`--from`：整数，默认 0，最小 0；`--size`：整数，默认 10，最小 1，最大 20；`--account`：文本/路径。

### cc98 account signin

```text
zju cc98 account signin [--confirm] [--all] [--account VALUE] 论坛签到，今天已签则直接返回
```

`--confirm`：开关；`--all`：开关；`--account`：文本/路径。

### cc98 account signin-month

```text
zju cc98 account signin-month [--year N] [--month N] [--account VALUE] 某月签到记录与奖励
```

`--year`：整数，最小 2000；`--month`：整数，最小 1，最大 12；`--account`：文本/路径。

### cc98 session login

```text
zju cc98 session login [--account VALUE] [--fresh] 取 CC98 token 并缓存
```

`--account`：文本/路径；`--fresh`：开关。

### cc98 session status

```text
zju cc98 session status  本地 token 缓存状态（不联网）
```

无参数。

### cc98 session logout

```text
zju cc98 session logout [--account VALUE] [--all] 清除本地 token 缓存
```

`--account`：文本/路径；`--all`：开关。

## chalaoshi

教师评价与课程绩点

### chalaoshi search

```text
zju chalaoshi search --keyword VALUE [--college VALUE] [--sort relevance|rate|hot|name] [--limit N] 按姓名、拼音或首字母找教师，或按学院浏览：评分、热度和主页链接
```

`--keyword`：文本/路径，必填；`--college`：文本/路径；`--sort`：relevance / rate / hot / name，默认 relevance；`--limit`：整数，默认 20，最小 1，最大 200。

### chalaoshi teacher

```text
zju chalaoshi teacher --name VALUE [--college VALUE] [--limit N] [--sort rate|time] 一位教师的评分、评分人数、点名比例、所教课程的平均绩点，以及学生评论
```

`--name`：文本/路径，必填；`--college`：文本/路径；`--limit`：整数，默认 10，最小 0，最大 200；`--sort`：rate / time，默认 rate。

### chalaoshi course

```text
zju chalaoshi course --name VALUE 教一门课的所有老师的平均绩点、标准差和样本人数，并附各人的查老师评分
```

`--name`：文本/路径，必填。

## cnki

中国知网文献检索、筛选与全文 PDF 下载

### cnki search

```text
zju cnki search [--keyword VALUE] [--title VALUE] [--author VALUE] [--source VALUE] [--type 期刊|学位论文|博士|硕士|会议|报纸] [--year VALUE] [--core VALUE] [--sort relevance|date|cited|downloads] [--limit N] 在知网检索文献，可按类型、年份、核心期刊筛选：篇名、作者、来源、发表时间、被引和下载次数
```

`--keyword`：文本/路径；`--title`：文本/路径；`--author`：文本/路径；`--source`：文本/路径；`--type`：期刊 / 学位论文 / 博士 / 硕士 / 会议 / 报纸；`--year`：文本/路径；`--core`：文本/路径；`--sort`：relevance / date / cited / downloads，默认 relevance；`--limit`：整数，默认 20，最小 1，最大 50。

### cnki download

```text
zju cnki download --title VALUE [--author VALUE] [--source VALUE] [--out-dir VALUE] 按篇名下载文献全文 PDF；多篇一次传入，自动分批串行、复用已有文件并返回完整进度。默认存到 data/output/cnki/
```

`--title`：文本/路径，必填；`--author`：文本/路径；`--source`：文本/路径；`--out-dir`：文本/路径。

### cnki session login

```text
zju cnki session login [--fresh] 用学校 IP 登录知网并保存登录，返回识别到的机构；有效期内直接复用
```

`--fresh`：开关。

### cnki session status

```text
zju cnki session status  本地保存的知网登录（不联网）
```

无参数。

### cnki session logout

```text
zju cnki session logout  清除本地保存的知网登录
```

无参数。

## mail

浙大邮箱：邮件列表、正文、附件下载、发信和回复

### mail check

```text
zju mail check  检查邮箱账号：收信（IMAP）和发信（SMTP）服务器能不能登录；不读邮件、不发信
```

无参数。

### mail folders

```text
zju mail folders  邮件目录：收件箱、已发送、草稿、垃圾邮件和自己建的文件夹
```

无参数。

### mail message list

```text
zju mail message list [--folder VALUE] [--keyword VALUE] [--from VALUE] [--since VALUE] [--until VALUE] [--unread] [--limit N] 邮件列表，最新的在前：主题、发件人、时间、是否未读、几个附件；只读，不改未读状态
```

`--folder`：文本/路径；`--keyword`：文本/路径；`--from`：文本/路径；`--since`：文本/路径；`--until`：文本/路径；`--unread`：开关；`--limit`：整数，默认 20，最小 1，最大 100。

### mail message view

```text
zju mail message view --id VALUE [--folder VALUE] 一封邮件的完整正文、发件人、收件人、抄送和附件清单；只读，不会标成已读
```

`--id`：文本/路径，必填；`--folder`：文本/路径。

### mail message download

```text
zju mail message download --id VALUE [--folder VALUE] [--name VALUE] [--out-dir VALUE] 下载一封邮件的附件，默认全部，返回本地路径；默认存到 data/output/mail/，下载过的直接复用
```

`--id`：文本/路径，必填；`--folder`：文本/路径；`--name`：文本/路径；`--out-dir`：文本/路径。

### mail message send

```text
zju mail message send --to VALUE [--cc VALUE] --subject VALUE [--content VALUE] [--content-file VALUE] [--file VALUE] [--dry-run] [--force] [--confirm] 发一封新邮件：先 --dry-run 预览给用户看，用户同意后加 --confirm 发；发出后不能撤回
```

`--to`：文本/路径，必填；`--cc`：文本/路径；`--subject`：文本/路径，必填；`--content`：文本/路径；`--content-file`：文本/路径；`--file`：文本/路径；`--dry-run`：开关；`--force`：开关；`--confirm`：开关。

### mail message reply

```text
zju mail message reply --id VALUE [--folder VALUE] [--all] [--content VALUE] [--content-file VALUE] [--file VALUE] [--dry-run] [--force] [--confirm] 回复一封邮件：收件人取原信的回复地址或发件人，主题加 Re:，原文引用附在正文后面；加 --all 是回复全部。同样先 --dry-run
```

`--id`：文本/路径，必填；`--folder`：文本/路径；`--all`：开关；`--content`：文本/路径；`--content-file`：文本/路径；`--file`：文本/路径；`--dry-run`：开关；`--force`：开关；`--confirm`：开关。

## doc

PDF、Word、PPT、Excel 等文件或链接转文字；图片与 Word 转 PDF、合并、取页、找页、取图、渲染

### doc text

```text
zju doc text [--file VALUE] [--url VALUE] PDF、Word、PPT、Excel（含 doc/ppt/xls 老格式）、HTML、文本转文字；给本地文件或链接，校内与 CC98 链接自动经 WebVPN，教务网附件自动登录。全文另存 Markdown
```

`--file`：文本/路径；`--url`：文本/路径。

### doc pdf

```text
zju doc pdf --file VALUE [--size a4|original] [--out VALUE] 把图片（拍的作业、截图）、Word、PDF 按顺序合成一个 PDF；图片按拍摄方向转正
```

`--file`：文本/路径，必填；`--size`：a4 / original，默认 a4；`--out`：文本/路径。

### doc pages

```text
zju doc pages --file VALUE --pages VALUE [--out VALUE] 从 PDF 取出指定页另存为新 PDF，如只发课本里习题那几页
```

`--file`：文本/路径，必填；`--pages`：文本/路径，必填；`--out`：文本/路径。

### doc find

```text
zju doc find --file VALUE --keyword VALUE 找关键词在 PDF 的哪几页，返回页码和上下文；扫描件没有文字层时查不到
```

`--file`：文本/路径，必填；`--keyword`：文本/路径，必填。

### doc images

```text
zju doc images --file VALUE [--pages VALUE] 取出 PDF 里嵌入的原始图片（字帖、照片、扫描页），不经渲染、分辨率最高，按像素从大到小；一页常有底纹、水印等多张，发之前看一眼确认
```

`--file`：文本/路径，必填；`--pages`：文本/路径。

### doc render

```text
zju doc render --file VALUE --pages VALUE [--dpi N] 把 PDF 指定页渲染成 PNG（含文字和排版），用于看这页长什么样或发整页图；一次最多 30 页
```

`--file`：文本/路径，必填；`--pages`：文本/路径，必填；`--dpi`：整数，默认 150，最小 50，最大 300。

### doc check

```text
zju doc check  检查文档处理依赖（Python 包与 LibreOffice）
```

无参数。

### doc setup

```text
zju doc setup  把文档处理的 Python 依赖装到 data/tools/doc；LibreOffice 需按提示用系统包管理器安装
```

无参数。

## 边界与数据衔接

- 业务自动认证；session 仅作维护。网络和 URL 工具均在 webvpn。
- zdbk selection 通过课程、教师和上课时间自动定位，课程池与搜索条件由内部保留。普通志愿按用户指定的单次操作提交并回查。培养方案按专业名、学院名查。
- notice 的来源和栏目都写名称；list 与 view 的每条通知是同一种记录，new 只有标题、日期、来源和链接。
- 学在 rollcall 自动发现、执行和回查，确认成功立即结束；duration 为等待上限，默认 600 秒。体艺 rollcall 仅有 status、history 两个只读子命令。
- 学在的课程、作业、文件都按名称定位；下载结果总在 files 列表里。
- zhiyun 支持课程名称；--lesson/--lesson-id/--date/--week-of/--all 互斥。kind 支持 video,audio,ppt,slides,subtitles。视频优先 1080p；仅取音频优先独立音轨或 360p；无独立音轨的混合下载复用视频。
- zhiyun trans 只处理本地文件；音频默认 SenseVoice，ppt 提取已有文字与原图，未启用 OCR。输出交给 AI 按模板直接成稿。

## 智云本地依赖

```text
zju zhiyun setup [--component all|media|asr|ppt] [--engine sensevoice|firered] [--cpu]
```

安装、检查和转写均属于 zhiyun。setup 只在缺依赖时使用并复用现有环境；默认 SenseVoice，单独 ppt 只安装文档处理依赖。
