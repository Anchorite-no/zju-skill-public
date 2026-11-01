# 学在模块内部职责

CLI 用法和签到行为见 [学在参考](../../references/xuezai.md)。本文件说明源码依赖、实际请求与端点；不定义额外的运行流程或安装入口。

## 组件边界

| 组件 | 唯一职责 |
|---|---|
| `profile` | 读取账号配置 |
| `core/http` | HTTP、Cookie 和连接池 |
| `webvpn/transport.openContext` | 根据声明组装传输和现有认证组件 |
| `zjuam` | CAS 密码认证、TGT 复用和 service 票据交换 |
| `xuezai/client.ts` | 学在专属 identity 回跳、站点 Cookie、XSRF、用户 ID、分页、取文件下载地址和签名上传 |
| `xuezai/rollcall.ts` | 原 autosign 签到流程：轮询点名、参考点应答、距离拟合、每轮重试与停止；接收已有客户端 |
| `xuezai/cli.ts` / `rollcall-cli.ts` | 参数适配，创建和关闭一次任务所用的客户端 |

`openXuezai()` 是模块工厂：调用公共 `openContext`，把同一上下文注入 `Xuezai`，随后由业务请求按需准备站点会话。模块不重新读取 CAS 账号密码，也不实现密码加密或 CAS 表单提交。站点缓存有效时不会先请求 CAS；确需身份委托时，由注入的 `ctx.zjuam.service()` 完成。

`ensureSession()` 是客户端内部方法，只管理学在自己的会话。保留的 `xuezai session login` 用于诊断或显式刷新，复用同一客户端流程；业务操作不依赖先执行它。

签到函数接收已经组装的 `RollcallClient`，不创建认证器或另开连接。CLI 和直接导入 `index.ts` 的调用使用同一份业务实现。`index.ts` 只导出已有组件，没有第二套执行器。

## 其他内部文件

| 文件 | 职责 |
|---|---|
| `courses.ts` | 学期、课程、章节、活动及内容树 |
| `materials.ts` | 附件查询和下载；分块、重试与续传复用 `zhiyun/download.ts` 的 `Transfer` / `downloadFile` |
| `homework.ts` | 作业、提交记录、下载老师给的附件和本人交过的文件、个人提交及撤回 |
| `todos.ts` | 原生待办和作业补查 |
| `types.ts` | 数据和日志类型 |
| `cli-common.ts` | 命令共用的客户端生命周期、写闸与日志适配 |

2026-10-11 在 Innovation 桌面端加、2026-10-31 同步过来的几处，都在 `courses.ts`、`materials.ts`、`homework.ts`、`todos.ts` 和 `cli.ts`。Innovation 当天用真实账号读过、下过一个文件（《计算机组成》9 个课件分在 6 章，按链接读清单、`--chapter 第四章` 筛出 3 个、按章下了一个 1.6 MB 的 PDF）：

- `course list` 的每一行多了 `link`（`/course/<课程号>/content`，课程页面的地址），`--course` 认它（`findCourse` 开头）：名字会重、会互相包含，链接不会。做法和超星模块一样。
- `material list` 的文件改成照课程里的先后排（`courseMaterials`：章、节、活动各按平台的顺序走一遍，没有归到章里的排在最后），每个文件带上在哪一章、哪一节（`placeOf`，取的是名称；挂在几个活动上的按第一个算），视频带 `video`。原来是平台返回活动的顺序，和章节无关。
- `material list`、`material download` 多了 `--chapter`（`cli.ts` 的 `inChapter`）：只留那一章或那一节里的文件，先找名字完全相同的，没有再找包含它的，对到几个不同名字的章节时给候选；几章同名时一起算。下载时只给 `--chapter`、不给 `--name` 就是这一章的全部（不含视频，加 `--video` 才带）。
- `homework attachments`（`downloadAttachments`）：老师随作业给的附件，默认存到 `data/output/xuezai/<课程名>/作业附件/<作业名>/`，下载过且大小一致的复用。
- 作业补查保留完整列表，按活动类型、课程和活动编号合并，课程作业的 `submitted` 覆盖原生待办的旧状态；合并后才过滤已交作业。`todos --done` 保留已交项并标 `done: true`，不多发请求。原生待办会残留已交作业，不能提前过滤补查结果。

`courses.ts`、`materials.ts`、`homework.ts` 中的 `*Row` / `*View` 只做 CLI 输出投影（北京时间、名称、状态、正文转纯文本）；库函数、名称匹配和提交回查仍使用平台原字段。

具体参数和返回类型以各函数声明为准；使用约定、限制和验证状态只维护在学在参考文档中。

## 站点与会话

- 站点：`https://courses.zju.edu.cn`（TronClass），公网直连，统一身份认证。
- 模块：`lib/xuezai/`；CLI：`node scripts/zju.ts xuezai …`。源码分工见 [内部职责](README.md)。
- 会话：`data/sessions/xuezai.json`，按 profile 用户校验身份，TTL 12 小时。`session status` / `session logout` 只访问本地。

## 登录

业务请求由公共传输组件注入 `zjuam`，仅在学在站点会话不可用时委托 CAS。账号来自同一个认证上下文，密码认证和 RSA 始终由 `zjuam` 实现；模块内部只适配 identity 回跳、Cookie/XSRF 和用户 ID。有效的站点缓存不再触发额外 CAS 预检。`session login` 是维护动作，日常业务无需先执行。

`/user/index` → `identity.zju.edu.cn` → `zjuam.zju.edu.cn/cas/login?service=…` → CAS 委托 → identity 回跳 → `/user/index`。兼容 302/303 和 HTML meta refresh。

当前用户数字 ID 来自本人页面注入的 `ng-init="userId=…;"`，缓存在会话文件；不依赖可能为空的 `activity-reads-for-user`。`/api/user` 在当前平台返回 403，不能用来判断登录失败。

JSON 读取遇 401 或登录跳转时合并重登一次；写请求不自动重放。登录和下载错误不会输出带 ticket/token 的完整跳转 URL。

## 端点

| 功能 | 方法与路径 | 主要参数 / 响应 |
|---|---|---|
| 学期 | GET `/api/my-semesters` | `fields=id,name,sort,is_active,code` → `semesters[]` |
| 本人课程 | GET `/api/my-courses` | `conditions` JSON、`page/page_size` → `courses[], pages, total` |
| 课程详情 | GET `/api/courses/{course}` | 课程原字段，含教师、学期、章节 |
| 章节 | GET `/api/courses/{course}/modules` | `modules[].syllabuses[]` |
| 活动 | GET `/api/courses/{course}/activities` | `activities[]`，含 `module_id/syllabus_id/type/uploads/data` |
| 活动详情 | GET `/api/activities/{activity}` | 正文在 `data.description`，附件在 `uploads[]`；作业详情用 |
| 文件下载地址 | GET `/api/uploads/{upload}/url` | `{url}`：`tcmedia.zju.edu.cn/download/file/<key>?timestamp&token&name`，不带 Cookie 直接取 |
| 课程作业 | GET `/api/courses/{course}/homework-activities` | 分页 `homework_activities[]`，包含已提交/未提交/已结束 |
| 本人提交记录 | GET `/api/activities/{activity}/students/{user}/submission_list` | `list[]`，包含草稿状态、附件、正文、提交时间和批改字段 |
| 小组提交记录 | GET `/api/activities/{activity}/groups/{group}/submission_list` | 当前前端可确认的接口；本次无小组样本实测 |
| 原生待办 | GET `/api/todos?no-intercept=true` | `todo_list[]`，作业、考试、测验等 |
| 申请上传（写） | POST `/api/uploads` | JSON `{name,size,parent_type:"submission_upload",parent_id:0,is_scorm:false,embed_material_type:""}` → `{id,upload_url}` |
| 上传字节（写） | PUT 返回的 `upload_url` | multipart `file`，签名 URL 自带授权，不带 Cookie |
| 提交作业（写） | POST `/api/course/activities/{activity}/submissions` | JSON `{uploads:[附件ID],comment,slides:[],is_draft:false}` |
| 撤回（写） | PUT `/api/submissions/{submission}/retract` | JSON `{}`，需平台允许撤回 |
| 当前点名 | GET `/api/radar/rollcalls` | `rollcalls[]`，含 `rollcall_id/is_radar/is_number/status` |
| 本人历史点名 | GET `/api/course/{course}/student/{user}/rollcalls` | `rollcalls[]`：`rollcall_time`（UTC）、`source`（radar/number/qr）、`status`（on_call_fine/absent）、`student_status`（on_call/absent）、`rollcall_status`（finished）；无点名为空数组。同课程的 `/api/course/{course}/rollcalls`、`students_rollcalls` 是教师接口，学生 403；`rollcall-score` 只给次数汇总，不使用。2026-09-28 核对 |
| 雷达签到（写） | PUT `/api/rollcall/{id}/answer?api_version=1.1.2` | `{deviceId,longitude,latitude,accuracy,speed:null,altitude:null,altitudeAccuracy:null,heading:null}` |
| 数字签到（写） | PUT `/api/rollcall/{id}/answer_number_rollcall` | `{deviceId,numberCode:"0007"}` |

课程条件使用 `semester_id: [ID, …]`、`keyword`、`status: ["ongoing","notStarted","ended"]`。查询自动翻页。章节和活动分开返回，内容树函数按 ID 关联，空章节和未分章活动也保留。

- **当前学期不能只看 `is_active`。** 平台只把长学期标成当前（2026-10 实测只有 `2026-2027秋冬`），同学年的 `2026-2027秋` 不带标记，但秋学期的课正在上。`currentSemesters()` 取带标记的学期，加上同一学年里名称互相包含的学期（秋、冬 ⊂ 秋冬）；待办补查、课程列表默认范围和同名课程的优先级都用它。只按 `is_active` 会漏掉短学期课程的作业。
- **课程 `status` 不能用来判断在不在上。** 2026-10 实测 36 门课里 34 门是 `ongoing`（含去年的课），`end_date` 大多为空。
- 活动列表已带 `data.description`（作业要求、页面正文）和 `data.link`（链接类活动的地址），课程详情不必逐个请求活动详情。
- **`uploads[].allow_download` 不限制下载接口。** 老师关掉下载后它为 `false`，网页只是不显示下载按钮；下载地址照常给出原文件，长度与清单 `size` 一致（2026-10-10 实测 pdf、pptx、docx、mp4、wmv、m4v、wav、mp3）。所以下载不看这个字段，清单也不输出它。
- **取地址用 `/url`，不用 `/blob`。** 两者指向同一个 tcmedia 文件，但 `/blob` 302 给的地址多一个 `nonce`，只能请求一次，第二次起 403，分不了块；`/url`（网页预览用的 `/preview` 同）给的地址可以重复、并发请求。tcmedia（Tengine）支持 Range，带强 ETag，没有 Last-Modified。签名里的 `timestamp` 取整到小时，同一个文件在同一个小时里每次取到的地址都相同；过了整点旧地址仍可用：23:00 签的地址到 00:05 还能取，一次跨 00:00 的下载全程用旧地址、没有请求被拒（2026-10-11）；多久失效没有测到。
- 下载按 4 MB 分块，一次 3 个文件、共 6 个连接；没下完的留下 `<文件名>.parts`，下次接着下。签名每小时换一次，续传按地址去掉查询串后的部分（含文件 key）认同一个文件；下载中途被存储拒绝（403）时重新取地址接着下，最多两次（真实的过期没有遇到，只用注入的 403 验证过）。tcmedia 的新连接不时在建立时被断开（约 5 秒后 `ECONNRESET`），同一块连着断两次也遇到过，所以每个请求最多重试 4 次。
- 文件清单里的 `size` 与下载到的字节数一致（2026-10 实测），用来判断本地文件能否复用。默认保存到 `data/output/xuezai/<课程名>/<文件名>`；同一门课里重名的文件在名字后带平台编号。
- 撤回只针对最近一次提交（网页上的「撤回」按钮同此），所以命令不接收提交记录编号。
- 本人交过的文件与课件走同一个下载接口，`homework download` 取最近一次提交（与撤回同一条记录），存到 `data/output/xuezai/<课程名>/我的提交/<作业名>/`，老师传回的文件在其下的 `老师批改/`。重交时同名文件内容会变，所以每次重新下载，不按大小复用。
- `submission_correct.uploads` 里名为 `markattatchment.txt` 的不是老师传回的文件，而是平台保存网页批注笔迹的数据（URL 编码的 JSON，内容是各页的 SVG 路径；2026-10 实测，老师在网页上批注一次产生一到两个）。它只用来说明「老师在网页上批注过」（`annotation`），不列入文件、不下载；把笔迹画回 PDF 未做。
- 没有文件的提交记录有两种：老师代为登记的（`submit_by_instructor: true`，如线下交的作业、考试成绩）和纯文字提交，`homework download` 在 `note` 里分别说明。

## 校园参考点

仅作为已有雷达策略的起点，默认 ZJGD1。参考点与定位策略由脚本内部选择，常规调用不接受坐标。参考点沿用原 autosign，不添加本次网上查询的坐标，不代表设备当前实际位置。

| 代码 | 经度 | 纬度 |
|---|---:|---:|
| ZJGD1 | 120.089136 | 30.302331 |
| ZJGX1 | 120.085042 | 30.30173 |
| ZJGB1 | 120.077135 | 30.305142 |
| YQ4 | 120.122176 | 30.261555 |
| YQ1 | 120.123853 | 30.262544 |
| YQ7 | 120.120344 | 30.263907 |
| ZJ1 | 120.126008 | 30.192908 |
| HJC1 | 120.195939 | 30.272068 |
| HJC2 | 120.198193 | 30.270419 |
| ZJ2 | 120.124267 | 30.19139 |
| YQSS | 120.124001 | 30.265735 |
| ZJG4 | 120.073427 | 30.299757 |

## 参考实现

参考端点与协议，模块代码独立实现：

- 本地 `ZJU-Course-Autosign` 的 `809a0e0^`：课程分页、活动附件、待办补查。
- [login-zju](https://github.com/5dbwat4/login-zju/blob/main/src/courses.ts)：CAS/identity 与 meta refresh 登录链。
- [vibe-learning-in-zju](https://github.com/EviterLesRoses2/vibe-learning-in-zju/blob/main/zju-mcp.mjs)：两段式上传、提交和撤回接口。
- 当前学在浙大前端与真实只读响应：章节、文件、作业和个人/小组提交记录路径。

## 分开的签到任务（2026-09-30）

`rollcall.ts` 仅处理 GPS/雷达；`rollcall-number.ts` 管理数字点名的字幕输入、候选、提交与回查；`rollcall-all.ts` 只组合前两者，共享取消信号，成功回调先于清理触发，避免等待数字清理时 GPS 仍继续写入。CLI 三入口（`rollcall`、`rollcall number`、`rollcall all`）复用 rollcall-cli.ts 的写闸、时限和输出。

数字提交仍为表中 PUT 接口。只有 `error_code` 含 wrong 才将该候选判为明确错码并换下一候选；其他响应或网络错误先回查，未签上则下一轮重试同一码，不设未决锁。同课窗口从首次发现前 300 秒到此刻（最多后 300 秒），内部每 20 秒取新文字；候选来源只含定稿，单次点名最多提交 200 次。

`zhiyun/live-input.ts` 是签到的内部只读输入接口，`remote.ts` 用与公开智云命令相同的配置和 SSH 传输调用内部入口；没有单条公开命令绕过转发。采集用请求 UUID 确认所有权，只停止本次创建的任务；启动响应丢失时由任务 until 限制最晚结束；复用用户原有采集时不停止该任务。服务器原 zju-autosign 枚举服务已于 2026-09-30 移除；真实数字写仍待正常业务验收。
