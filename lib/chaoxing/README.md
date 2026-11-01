# 超星学习通模块内部说明

CLI 用法见 [超星参考](../../references/chaoxing.md)。本文件记录实际请求、端点和协议上的坑。

端点最近核对：2026-10-04，用真实账号在《大学物理实验2026》（30 节、61 个课件、25 个视频、资料栏 19 个文件分三层文件夹）上跑通：登录、课程列表、章节目录、卡片、对象状态、章节文档与 195 MB 视频下载、资料栏列表与下载。下表与「协议上的坑」均按当天实测；没有遇到样本、仍只按参考实现写的部分：资料栏翻页（没有超过 30 行的层）、`isdown=0`、「教师课件」入口、未开放的节、对象状态里没有 `download` 时的退路、登录验证码与二次验证。

## 文件

| 文件 | 职责 |
|---|---|
| `client.ts` | 登录、会话缓存、请求排队、跳转跟随、失效后重登一次 |
| `parse.ts` | 页面解析：章节目录、卡片里的附件、资料栏的行；只处理文本 |
| `courses.ts` | 课程、章节、一门课的文件清单及其半小时缓存 |
| `download.ts` | 取下载地址并落盘；分块与续传复用 `zhiyun/download.ts` 的 `Transfer` / `downloadFile` |
| `cli.ts` | 参数、按名称选范围、结果视图 |

2026-10-10 在 Innovation 桌面端加、2026-10-31 同步过来的三处，都在 `cli.ts` 和 `courses.ts`。`course list` 的链接和 `chapter list` 当天用真实账号读过（1 门课、34 节、51 个课件、24 个视频）；`--chapter` 的两处收紧和 `--fresh` 只在本机用假数据核对过，没有用真实账号下过文件：

- `course list` 的每一行多了 `link`（`visit/stucoursemiddle?courseid&clazzid&cpi`，就是下表「进课程」的地址），原样交回 `--course` 指这门课：按名称找时，名字是另一门课的简称（「大学物理实验」对「大学物理实验2026」，`abbreviates` 判为真）会被判成不唯一，链接不会。`uniqueMatch` 给的候选也用同一个 `courseRow`，所以候选里也有。
- `chapter list`：整门课的清单（`inventory`，章节加资料栏，按 `objectid` 去重）按 `location` 分组，每组里分 `materials` 和 `videos`，顺序就是课程里的顺序。单独调 `material list` 和 `video list` 拿不到两类文件之间的章节先后，所以另给这一条。没有文件的节不列，没开放的仍在 `notOpen`。`--fresh` 不用半小时内的缓存、整门课重读。
- `--chapter` 的两处收紧（`scoped` 和下载命令里的 `choose`）。位置的第一段正好是「资料」时先当资料栏（`inData`），只读资料栏、不读各节；原来是章节优先，标题里带「资料」的章节会把它截走，有两个这样的章节时还会报不唯一。课程自己有一章就叫「资料」时仍按章节走。给了 `--name` 又给了 `--chapter` 时，先在位置和 `--chapter` 完全相同的文件里找，找不到再放宽到这个范围里的全部：大章自己挂着文件、下面小节里又有同名文件时不会报不唯一。

## 站点与会话

- 公网直连（`network=public`），独立账号（`auth=own`）：`chaoxing_username`（手机号）/ `chaoxing_password`，不回退到统一认证。
- 主机：`passport2.chaoxing.com`（登录）、`mooc1.chaoxing.com`、`mooc2-ans.chaoxing.com`、`mooc1-api.chaoxing.com`；文件在 `d0.ananas.chaoxing.com`、`s1.ananas.chaoxing.com`、`d0.cldisk.com` 等。
- 会话：`data/sessions/chaoxing.json`，只有 Cookie（`.chaoxing.com` 域的 `_uid`、`fid` 等），TTL 30 天。有 `_uid` 就直接用；被带去登录页或接口返回「请重新登录」时重登一次再做。
- 请求排队执行，间隔不小于 150 ms。超星对密集请求会跳到 `antispiderShowVerify` 验证码页，遇到即报 `RATE_LIMITED`，不自动处理验证码。

## 登录

`POST https://passport2.chaoxing.com/fanyalogin`，表单：

```
fid=-1&uname=<密文>&password=<密文>&refer=https%3A%2F%2Fi.chaoxing.com&t=true
&forbidotherlogin=0&validate=&doubleFactorLogin=0&independentId=0&independentNameId=0
```

- 密文：AES-128-CBC，密钥与 IV 都是登录页 `login.js` 里的 `transferKey`（`u2oh6Vu^HWe4_AES`），PKCS7，Base64。`t=true` 表示已加密。
- 成功 `{status:true,url}` 并种 Cookie；失败 `{status:false,msg2}`（旧分支用 `mes`）。`containTwoFactorLogin` 为真表示要二次验证。登录页的 `needVcode=1` 时网页会先弹点选验证码并把结果放进 `validate`，本模块不处理，按 `NEEDS_USER` 交给用户。
- 同一客户端登录失败后不再重试，避免反复提交错误密码。

## 端点

| 功能 | 方法与路径 | 说明 |
|---|---|---|
| 本人课程 | GET `mooc1-api…/mycourse/backclazzdata?view=json&rss=1` | JSON `channelList[]`：`content.id`=班级 clazzId，`content.cpi`，`content.name`=班级名，`content.course.data[0]`=`{id,name,teacherfactor}`。没有 `course` 的条目（文件夹等）跳过。未登录 `{"result":0,"msg":"请重新登录"}` |
| 章节目录 | GET `mooc2-ans…/mooc2-ans/mycourse/studentcourse?courseid&clazzid&cpi&ut=s` | HTML。`div.chapter_unit` 是大章；`id="cur<knowledgeId>"` 的块是可点开的节，嵌套的节外面多一层 `li`；标题在 `a.clicktitle`，序号在 `span.catalog_sbar`；`span.bntHoverTips` 含「解锁」表示未开放 |
| 章节卡片 | GET `mooc1…/mooc-ans/knowledge/cards?clazzid&courseid&knowledgeid&num=N&ut=s&cpi&v=…&mooc2=1` | HTML，脚本里 `mArg = {attachments:[…],defaults:{…}}`。`num` 从 0 起一张一页，越过最后一张时页面里是没渲染的模板 `mArg = $mArg`、没有对象；未开放时页面含「章节未开放」。附件的 `property` 带 `objectid`、`name`、`type`（扩展名）、`size`（字节，文档和视频都有） |
| 对象状态 | GET `mooc1…/ananas/status/<objectid>?k=<fid>&flag=normal` | Referer 须为 `…/ananas/modules/video/index.html`。JSON：`status:"success"`、`filename`、`length`、`download`（原文件，文档和视频都有，`http://d0.cldisk.com/download/<objectid>?at_&ak_&ad_`）；视频另有 `http`（转码的 sd.mp4），文档另有 `pdf`（预览）和 `http`（在线阅读页，不是文件）。`length` 与卡片里的 `size`、下载到的字节数一致 |
| 进课程 | GET `mooc1…/visit/stucoursemiddle?courseid&clazzid&cpi&ismooc2=1&v=2` | 跳到 `mooc2-ans/mycourse/stu?…&enc=…`，这个 `enc` 是资料栏根页面要的 `stuenc`，每次现取 |
| 资料栏 | GET `mooc2-ans…/mooc2-ans/coursedata/stu-datalist?courseid&clazzid&cpi&ut=s&stuenc` | HTML，每行一个 `ul.dataBody_td`：属性 `type`（扩展名，`afolder` 为文件夹，`tch-courseware` 为教师课件入口）、`id`（dataId）、`dataname`、`objectid`、`isdown`（0 为未开放下载）；大小在 `li.dataBody_size_stu`（约数）。一页 30 行，总页数在 `input#totalPages`，翻页加 `&pages=N` |
| 资料栏文件夹 | 同上，另加 `&dataName=<名>&dataId=<id>&type=1&parent=&flag=0&enc=<行内 enc>&microTopicId=0&isAjax=isAjax` | 行内 enc 是该行 `onclick="toOpen(…)"` 的第 10 个参数，与 stuenc 不是一个值 |
| 资料栏下载 | GET `mooc1…/coursedata/downloadData?dataId&classId&cpi&courseId&ut=s` | 302 到 `d0.cldisk.com/download/<objectId>?at_&ak_&ad_&fn`，不跟随，只取地址 |

## 协议上的坑

- **文件地址要带 `Referer: https://mooc1.chaoxing.com/`**，否则 403；不需要 Cookie。下载器只在访问 `*.chaoxing.com` 时带会话 Cookie。
- 平台给的跳转和文件地址常是 `http://`，统一换成 `https://`。
- `mArg` 用配对括号截取后 `JSON.parse`；不能像一些实现那样先删空格再正则，文件名里的空格会丢。
- 附件只收带 32 位十六进制 `objectid` 的（视频、音频、文档）；章节测验、直播、阅读等没有 objectid 的跳过。名字不带扩展名时用 `property.type` 补上。
- 卡片数量不事先知道（`studentstudyAjax` 能给出数量，但它是「进入学习页」的请求，这里不用），所以从 0 取到没有 `mArg` 的那一页，上限 12。中间一张没有附件的卡片不算结束。
- 章节附件走对象状态接口；资料栏文件走 `downloadData`（参考实现记录：资料栏对象的状态接口返回无权限）。两条路最后都落到 `d0.cldisk.com`：带 Referer 时 Range 请求返回 206，不带返回 403；195 MB 分块下载约 6 秒。
- **同一个文件常挂在几处**：实测 11 个文件名各出现两次且 `objectid` 相同（同一视频在两个节里，讲义在章节和资料栏各一份）。清单照实全列；清单和下载都在限定范围之后按 `objectid` 去重，留最先出现的（章节在资料栏之前），否则按名字下载会被判为不唯一、`--all` 会重复下载；`inventory()` 本身不去重，这样限定到某个文件夹或小节时那里面的文件仍然齐全。资料栏文件的大小优先用章节里同一对象的字节数，没有时把页面上的约数（`310KB`）换算成字节，输出统一经 `fileSize`。
- 章节目录里大章的标题在 `a.clicktitle > span[title]`，序号单独在 `div.catalog_num`（没有取）；节的 `a.clicktitle` 里先是 `span.catalog_sbar`（如 5.2）再是标题文字，没有 `title` 属性。
- 默认的 Chrome UA 即可访问 `mooc1-api`。150 ms 间隔下整门课首次读取（30 节的卡片 + 资料栏 5 层）约 10 秒，没有触发验证码。
- 资料栏的 `isdown=0` 尊重老师的设置，不取文件；「教师课件」入口（`mobilelearn…/page/ppt/studentCourseware/…`）未实现。
- 清单缓存：`data/cache/chaoxing/<courseId>-<clazzId>.json`，每个节和资料栏各自记读取时间，30 分钟内复用；按名字找不到文件时强制重读一次。
- **只给文件名时先就近找**（`cli.ts` 的 `nearby`）：读整门课要约 60 次请求、10 秒以上，比下载一个 195 MB 的视频还久。所以先把名字当章节标题找（「等厚干涉」→「5.2 等厚干涉G」），对不上再看以前的清单里哪几节有这个文件（旧清单只用来定位，内容重新读），最多读 3 节；在那里找不到或不唯一才读整门课。实测冷启动 `--name 等厚干涉`：11.5 秒降到 0.7 秒。
- **章节名的宽松匹配**（`cli.ts` 的 `chapterScope`）：先整句相等，再包含，都没有时找只差一两个字的：去掉序号和符号后，公共子序列至少 4 个字、占较长一方六成以上、占较短一方 85% 以上，且只有一个明显最像（领先第二名 0.1）才算。实验课表与学习通的叫法不完全一致（「金属材料杨氏模量的测定」对「…的测量」、「固定均匀弦振动的研究」对「固定均匀弦振动」、课表带「▲」），用实验课表里的 7 个名字对真实的 30 个章节标题核对过，都对到正确的那一节；「杨氏模量」「干涉」「电桥」仍然是不唯一，「光的干涉」「霍尔效应」对不上并给出候选。只给文件名而名字指的是某一节、那一节又只有一个这类文件时，直接取它。
- **单个文件的速度**：实测（2026-10-04，本机）195 MB 的视频用 1、4、6、8、16 个连接都是 4.7 秒、约 41 MB/s，同一条线路上清华镜像也是 41.6 MB/s，即已经跑满线路，加连接数没有用。平台的播放版（对象状态里的 `http`）是 1280×720 H.264、约 0.74 Mbps，体积约为原文件的十三分之一（195 MB 对 14.9 MB，0.8 秒下完）；原文件是 1920×1080 HEVC。东京服务器到同一文件服务器更慢而且起伏很大：78 MB 的文件用 4、8、16、32 个连接各测三轮，在 2.9 到 14.3 秒之间，看不出连接数的规律；只用 1 个连接时有一次要 131 秒。所以并行数保持 6，不再调。带签名的地址不绑定来源 IP。用户选定：默认下原文件，`--quality playback` 下播放版（整条命令 0.7 秒）。两种分开存，播放版的文件名在扩展名前加「（播放版）」；播放版事先不知道大小，本地有就复用。资料栏里的视频只有原文件。
- **并行**：一次同时下 3 个文件（`FILES_AT_ONCE`），每个文件内部按 4 MB 分块，全部连接数由同一个 `Transfer` 封顶为 6（`CONNECTIONS`）；取地址的请求（对象状态、`downloadData`）仍走客户端的排队，不并行。结果按给出的顺序返回，个别失败不影响其余。实测（2026-10-04，本机）：14 个课件共 116 MB，逐个下 6.0 秒，并行 3.4 秒；2 个视频共 257 MB，7.5 秒对 6.8 秒（大文件原本就分块并行，受带宽限制）。并行与逐个下载的文件逐一比对 MD5 一致。
- **中断后重跑**：下载被杀掉会留下 `<文件>.lock` 和 `<文件>.parts/`。锁里记着进程号，重跑时发现持有者已不在就接管并接着下（实测 234 MB 视频下到一半杀掉后重跑，结果与完整下载的 MD5 一致）。对象状态里的 `crc` 不是文件的 MD5，不能用来校验。
- 不调用任何学习进度、任务点、答题接口（`multimedia/log`、`ananas/job/*`、`work/*`）。

## 参考实现

参考端点与协议，模块代码独立实现：

- [Samueli924/chaoxing](https://github.com/Samueli924/chaoxing)：登录加密、章节目录选择器、`knowledge/cards` 的 `mArg`、对象状态接口及其 Referer。
- [DiYanYe/eitech-lms-helper](https://github.com/DiYanYe/eitech-lms-helper) 的接口实测文档（2026-09）：资料栏行结构、三个 enc、分页参数 `pages`、`downloadData` 跳转与 Referer。
- [superdaobo/mini-hbut](https://github.com/superdaobo/mini-hbut) 的协议笔记（2026-08）：`backclazzdata`、资料栏文件夹参数、对象状态接口返回字段。
- [Sophomoresty/mediago](https://github.com/Sophomoresty/mediago)：`toOpen` 参数位、对象状态里各地址字段的优先级。
