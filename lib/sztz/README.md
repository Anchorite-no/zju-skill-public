# 素质拓展数智平台 请求与协议

CLI 用法见 [二三四课堂](../../references/sztz.md)。本文件记录登录、端点和字段，供开发和排障使用。

- 地址：`https://sztz.zju.edu.cn/dekt/`（`sztz.zju.edu.cn/` 用脚本跳到这里；团委首页的「二三四课堂」入口）。页面标题「浙江大学大学生素质拓展数智平台」，Vite 单页应用，业务页面按需加载。
- 旧名字和旧地址（2026-10-12 经 WebVPN 核对）：学校文件里叫它「素拓网」，平台自己的通知里把现在这个叫「新素拓平台」，给的地址是 `http://sztz.zju.edu.cn/`。它以前有过两个地址，都已经停用：一个是团委旧网站下面的子目录，现在返回 404，没有留跳转；一个是更早的独立域名，现在是个空页面，团委首页「二三四课堂」那一格的图上还印着它，那一格链的是 `http://sztz.zju.edu.cn/`。这两个旧地址只写在 `lib/core/moved.json` 里，说明里不再出现（用户 2026-10-12 要的：都改成新的地址，不保留旧的，同学会照着旧文件去点）：命令结果里出现时换成现在的地址，请求它们时改去请求现在的地址（`lib/core/moved.ts`，接在 `output.ts` 的 `envelope` 和 `webvpn/transport.ts` 上）。实测拿老素拓网的地址跑 `doc text --url`，原来是 404，现在读到平台的页面。以后再有搬了家又没留跳转的网站，往那张表里加一行。
- 声明：`auth=cas network=campus writes=true`。主机只解析到校内地址 `10.203.15.167`，经 WebVPN。
- 代码：`lib/sztz/{index,cli}.ts` · CLI：`zju sztz credits | activity list · new · mine · signup · favorite | projects | notices` · 没有本地会话文件；`activity new` 的已读记录在 `data/sztz/seen.json`。
- 端点最近核对：只读 2026-10-06；报名、取消报名、收藏 2026-10-07；`activity new` 和活动页的地址 2026-10-12（本机经 WebVPN，真实请求）。

## 登录

- 首页「师生登录」：`GET login/getLoginUrl?returnUrl=<BASE>/&_auth_provider_=` 返回 `{data: "https://zjuam.zju.edu.cn/cas/login?service=https%3A%2F%2Fsztz.zju.edu.cn%2Fdekt%2F"}`。取出 service 交给 `zjuam.loginService`，回跳 `<BASE>/?ticket=…` 后会话生效（实测 0.5 秒）。
- 经 WebVPN 时站点 cookie 由网关代持，跟着 WebVPN 会话走，所以不另存本地会话；WebVPN 重登后第一次调用会重新委托一次。
- 未登录的表现：个人接口返回 200 和 `{code:-1, msg:"没有数据【cn.xht100.skylake.modules….entity.…】访问权限!"}`，据此登录后重试一次。活动列表 `getXmList`、`getHdList` 匿名可读，但 `fzr`、`lxdh`、`dzyx` 是 `****`，`sfbm` 为空；读到 `****` 时登录后重取。
- 「管理员登录」是账号密码加图形验证码（`login/doLogin`），不涉及。

## 通用

- 请求都在 `<BASE>/` 下，路径不带前导斜杠。GET 带查询串；POST 是 `application/x-www-form-urlencoded`（前端用 qs 序列化）。
- 响应 `{code, msg, extend, data, success}`，分页的另有 `pageIndex, pageSize, totalPages, count`。`code=0` 成功；参数不对时是 `{code:-1, msg:"操作失败！服务器处理异常！"}`。
- 时间是 UTC 的 ISO 串（`2026-10-17T11:00:00.000+00:00`），输出换成北京时间。
- 平台是多租户产品（包名 `cn.xht100.skylake`），前端里有大量管理端页面（学校、院系、组织管理员），学生端只用 `student/` 下的接口。

## 端点（学生端）

| 用途 | 方法 | 路径 | 参数与说明 |
|---|---|---|---|
| 活动中心 / 项目库 | GET | `student/home/getXmList` | `keyword, page, limit, finished=false, lx`。`lx=2` 是活动（可加 `date=YYYY-MM-DD` 只看那天有的活动），`lx=1` 是项目（可加 `xmfl, xmlb, xmlx, nj`）。不带 `lx` 返回空。活动按开始时间由新到旧，2026-10-06 共 5137 条；项目 100 条 |
| 首页活动 | GET | `student/home/getHdList` | `page, limit, date?`，首页展示用，没有封装 |
| 我的信息 | GET | `student/home/getMyInfo` | `extend.myInfo`：`dektJf/dsktJf/dsiktJf` 二、三、四课堂记点，`…Xf` 学分，`…Dj` 等级，`…Tg` 是否达标，`myTg` 美育、`lyTg` 劳育，`departmentName`（低年级是学园名） |
| 成绩单记录 | POST | `student/home/getZdySqjl` | `pageIndex, pageSize`。每条：`jd` 记点、`xm` 项目（同活动记录）、`cyrshzt.label` 审核状态、`czsj`、`qksm` 情况说明、`sfyc` 是否在成绩单上隐藏 |
| 我的活动 | POST | `student/home/getWdhdList` | `action`（0 报名、1 收藏、2 认定）`, page, limit, keyword?`。不带 `action` 报服务器异常 |
| 通知 | GET | `student/tzgg/ajaxList` | `pageIndex, pageSize, mc`。每条 `mc, fbsj, nr`（HTML 正文）`, fjmc, fjid`（附件名和编号，逗号分隔）；附件 `common/file/download?id=<编号>` |
| 项目基础数据 | GET | `student/home/getXmBaseData` | `extend`：`xmflList`（第二课堂、第三课堂）、`xmlbList`（16 个类别）、`xmlxList`（美育、劳育、其他）、`xmnjList`、`nj`（本人年级） |
| 我的申请 | POST | `student/home/wdsq` | `active`（页签序号：已完成、审核中、不通过、草稿箱、待补交）`, page, limit`；没有封装 |
| 成绩单下载 | — | `student/ekcjd/export` | 没有试 |
| 是否收藏 | GET | `student/home/sfsc` | `id`，`data` 是布尔值。页面选中一个活动时逐个查；没有用，收藏状态取自本人收藏列表 |

## 写接口

| 用途 | 方法 | 路径 | 说明 |
|---|---|---|---|
| 报名 | GET | `student/home/hdbm` | `id`。成功 `code=0` |
| 取消报名 | GET | `student/home/hdqxbm` | `id`。页面只在已报名且报名截止时间未到时显示这个按钮 |
| 收藏开关 | GET | `student/home/hdsc` | `id`。调一次翻转一次，没有单独的取消接口 |

- 三个都只带活动编号，没有表单。页面在提交前只弹一次确认框。
- 命令上报名和取消报名是同一个 `activity signup`（取消加 `--cancel`），收藏和取消收藏是同一个 `activity favorite`，2026-10-07 用户要求：成对的操作合成一个命令，命令按对象分组。
- 列表记录里的 `sfsc`、`scjg` 都不反映收藏状态（实测收藏前后都是 `false`、`null`），所以 `favorite` 标记来自本人收藏列表（`getWdhdList action=1`）；`signedUp` 取 `sfbm` 与本人报名列表（`action=0`）的并集。
- 写的流程（`commit`）：写闸与 `--confirm` 在建立会话前检查 → 找到活动并做提交前检查 → 写前日志（`data/journal/sztz-*.jsonl`，`submit`）→ 写请求只发一次 → 用本人列表回查（`reconcile`）。平台答复失败记 `rejected` 并转述 `msg`。
- 写请求不重发：没有回应时不知道平台是否已处理，以回查为准。收藏是开关，重发会把状态翻回去。回查也读不到时报告"没有确认"。
- 提交前检查与页面一致：不在本平台报名的不提交（给出 `jtbmfs` 和联系人）；不在报名时间内不提交；已报名或已收藏不重复提交；取消报名只在报名截止前提交。名额、可申请年级（`ksqnj`）、素能测评等不在本地判断，交给平台，平台拒绝时转述原因。
- 真实验证（2026-10-07）：收藏、重复收藏、取消收藏、无收藏时取消；报名、重复报名、取消报名、无报名时取消。每次结束时本人列表与开始时相同。平台拒绝（名额满、年级不符）和请求无回应两种情况没有遇到真实样本，只按逻辑写。

没有做的写接口（没有调用过）：`saveXmsq`（提交项目申请）、`saveFj`、`saveXsZdyxm`（成绩单显示或隐藏某条）、`student/dyjh/*`（答疑留言）、`student/snzp/*`（素能测评）。

## 活动记录字段

`mc` 名称；`zxfs`、`zdfs` 最小、最大记点；`hdkssj`、`hdjssj` 活动起止；`bmkssj`、`bmjssj` 报名起止；`hddd` 地点；`zmrs` 招募人数；`bmrs` 已报人数；`lxdw.mc` 立项单位（没有时用 `flowStartUser`）；`xmfl.mc` 课堂；`xmlb.mc` 类别；`xmlx.mc` 美育、劳育、其他；`lxsx` 简介；`hdzysx` 注意事项；`bmfs.label` 报名方式（`启用报名人满即止`、`启用报名超过人数仍可报名`、`不在本平台报名`）；`jtbmfs` 具体报名方式；`ksqnj` 可申请年级；`fzr`、`lxdh`、`dzyx` 负责人、电话、邮箱；`sfbm` 本人是否已报名（页面用它判断，没有单独核对过这个字段，所以另外对照本人报名列表）；`lx.label` 活动项目或基础项目。`sfsc`、`scjg` 不反映收藏状态，见写接口一节。

- 状态由时间算，和前端一致，只是把「报名结束到活动开始之间」单列为报名已截止（前端显示进行中）。以活动结束时间判断是否结束：平台上有开始时间年份填错、晚于结束时间的活动。
- 找还没结束的活动时逐页读（每页 50），读到这一页最后一条的开始时间早于 90 天前为止：长期活动开始得早但还没结束。2026-10-06 没结束的有 24 个，读了 2 页。

## 新出现的活动（`activity new`）

2026-10-12 在 Innovation 桌面端里加的，2026-10-31 同步过来。做法照 `notice new`。

- 读还没结束的活动（和 `activity list` 同一个读法），只留「报名中」「未开始报名」的，去掉已读记录里有的。报名已截止和进行中的不算新的，也不记。
- 只读活动列表，不读本人的报名和收藏列表：输出里不用负责人和报名状态，匿名读到的就够，少几次请求。
- 已读记录在 `data/sztz/seen.json`：上次查看的时间，和见过的活动（编号 → 报名截止时间）；报名截止超过 7 天的清掉。
- 第一次调用给出现在能报或还没开始报名的全部（2026-10-12 实测 19 个），之后只给新出现的。报名截止早的在前。
- 输出不带平台的活动编号，后续办事仍用活动名。
- 一个活动见过以后，举办单位再改报名时间，`new` 不会再报它。

活动页的地址：前端是 hash 路由（`createWebHashHistory`，地址是 `<BASE>/#/…`），15 个路由里没有单个活动的页面，活动中心是 `/index/hdzx`。它读地址里的 `xmId` 和 `xmmc`：平台首页点一个活动，就是 `router.push({ path: '/index/hdzx', query: { xmmc: 名称, xmId: 编号 } })`。所以一个活动的地址写成 `<BASE>/#/index/hdzx?xmmc=<名称>&xmId=<编号>`。这是从前端代码里读出来的，带着编号打开以后页面的样子没有在浏览器里看过。

活动记录里的 `czsj` 是这条记录最后一次操作的时间，`zhshsj` 是最后审核时间（实测是 null），都不是发布时间，所以「新」是按第一次读到算的。

## 没做的

- 提交项目认定申请（要填活动时间、联系电话、情况说明并上传证明材料）。
- 我的申请、成绩单文件下载、素能测评、答疑解惑。
- 平台通知只有十几条，放在 `sztz notices`，没有并进 `notice` 模块的来源。
