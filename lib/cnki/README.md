# 知网模块内部说明

CLI 用法见 [知网参考](../../references/cnki.md)。本文件记录实际请求、端点和协议上的坑。

端点最近核对：2026-10-05，IP 登录、检索、筛选、下载和拼图验证协议。

## 文件

| 文件 | 职责 |
|---|---|
| `index.ts` | 模块声明、检索式与 `QueryJson`、结果表格解析、IP 登录与登录复用、按篇名定位、取下载地址并落盘 |
| `slider.ts` | 验证地址识别、PNG 拼块匹配、AES 坐标加密、有限次取题校验和返回页放行 |
| `cli.ts` | 参数（年份、来源类别的写法）、一次下载的篇数上限、结果视图、`session` 维护命令 |

## 站点与登录

- 没有账号。知网按出口 IP 认机构，所以声明 `auth=none`、`network=campus`：默认经 WebVPN 出去（出口是学校的 IP），`transport=direct` 时直连，本机要在校园网内。知网本身公网可达，声明成 campus 是为了拿到学校的出口，不是因为连不上。
- 主机：`login.cnki.net`（IP 登录）、`kns.cnki.net`（检索与详情页）、`bar.cnki.net` 和 `docdown.cnki.net`（下载）。都在 `cnki.net` 下，传输层按这个后缀重写。
- IP 登录：`GET https://login.cnki.net/TopLogin/api/loginapi/IpLoginFlush?callback=cb&_=<毫秒>`，Referer 为 `https://www.cnki.net/`，返回 JSONP。成功 `{"IsSuccess":true,"ShowName":"浙江大学图书馆","UserName":"sh0283","Expire":"…"}`（`Expire` 约 20 分钟后）；不在机构 IP 内 `{"IsSuccess":false,"ErrorCode":5024,"ErrorMsg":"IP自动登录失败!"}`。这是知网首页自己的脚本（loginhead.js）在页面加载时调的接口。
- 经 WebVPN 时知网的 Cookie 由 WebVPN 服务端代持，跟着 WebVPN 的 ticket 走；ticket 换新后知网那边就是一个没登录过的新会话。

## 登录复用

登录存在 `data/sessions/cnki.json`（`SessionStore`，`username` 字段记出口 `webvpn` / `direct`）：

- `extra.institution`、`extra.expiresAt`（接口返回的 `Expire`，按北京时间换成时间戳）、`extra.via`（经 WebVPN 时是 ticket 的 SHA-256 前 16 位，直连时是 `direct`）。经 WebVPN 时本地没有知网的 Cookie，文件里只有这个标记；直连时 `cnki.net` 的 Cookie 一并存下，进程结束时再存一次。
- 复用条件：出口没变（`via` 相同）且离 `expiresAt` 还有一分钟以上。满足时不调登录接口，检索一次只发一个请求。
- 同一个知网会话里再调登录接口，返回的 `Expire` 不变（实测 17:28 登录、17:29 强制重登，都是 17:48）；到期之后会怎样没有等到，按到期重新登录处理。
- **保存的登录在知网那边已经没了**（例如 WebVPN 那边丢了 Cookie）：检索接口返回 403 和 `{"code":-403,"message":"https://kns.cnki.net/verify/home?captchaType=blockPuzzle&…"}`，页面请求则是 302 到同一个验证页。这时登录是复用的，就重新 IP 登录、原请求再发一次；下载被带到 `login.cnki.net` 时同样重登后重取一次下载地址。实测：伪造一份与新 ticket 对应的登录标记，检索依次为 403 → IP 登录 → 200。
- **刚登录过仍被带去验证**时处理拼图：同一出口和 Cookie 会话取题、匹配、校验，访问返回页建立放行状态，然后重发原来的检索或详情请求。是否已经重登以本进程的 `loggedInVia` 判断；业务请求仍要求验证时立即停止。

## 请求顺序

没有可用的登录时：IP 登录 → `POST /kns8s/brief/grid`（检索）。有登录时直接检索。下载再加：`GET` 详情页 → 下载地址的三次跳转。

**没有登录过的会话直接打 `kns.cnki.net` 会被带去滑块验证**（`/verify/home?captchaType=blockPuzzle&…`）。2026-10-05 实测：全新 WebVPN 会话里第一个请求是检索结果页、高级检索页（302）或检索接口（403）时都如此；先调 IP 登录再打就正常，登录之后不必先开检索页，直接发检索请求即可。

## 拼图验证

- 验证页 `/verify/home` 参数为 `captchaType=blockPuzzle`、`ident`、`captchaId`、`returnUrl`。前端脚本直接拆 query；给校验接口的 `returnUrl` 保留原始百分号编码，不能用解码后的 `URLSearchParams.get()` 值。
- `POST https://kns.cnki.net/verify-api/get`，JSON：`captchaType, clientUid, ident, captchaId, ts`。头为 `Content-Type: application/json;charset=utf-8`、`uniplatform: NZKPT`，Referer 用验证页。成功 `code="0"`，`data` 有 `originalImageBase64`、`jigsawImageBase64`、`token`、`secretKey`。
- 图片是 PNG。背景 310×155，拼块保留 155 的全高与透明边距；按 alpha 避开边缘白线，在相同纵坐标上做灰度归一化相关匹配，处理缺口变暗。只提交匹配明确的位置；图像尺寸变化、损坏或协议缺字段报错。
- `POST /verify-api/web/check`，JSON：`captchaType, pointJson, token, ident, returnUrl`。`pointJson` 是 `{"x":位移,"y":5}`，有 `secretKey` 时按 UTF-8 密钥做 AES-ECB-PKCS7，输出 Base64；没有密钥时使用明文 JSON。
- 校验成功 `code="0"`，取 `data.returnUrl` 加 `captchaId` 后访问。现网返回 HTTP URL，提升为 HTTPS；只允许知网站内地址，WebVPN 链接先还原再走原 Context。检索 POST 的返回地址是高级检索页，访问放行页后还要重发原 POST，不能把页面 HTML 当成检索结果。
- 每次验证最多 3 次取题机会，后续题间隔 1 秒；匹配不确定、题目过期 `6110` 或校验错误 `6111` 才换新题。前一篇成功的验证不消耗后一篇的机会。`6201` / HTTP 429 立即停；其他校验拒绝不循环。同一业务请求通过后再次遇到验证也停。批量下载遇到 `RATE_LIMITED` 时报告已完成文件和剩余未执行篇名。
- 图像解析只依赖 npm 的 `pngjs`，不依赖 Python、浏览器或远程识别服务；常规任务无新增参数、无独立验证码命令。

## 检索

`POST https://kns.cnki.net/kns8s/brief/grid`，表单（`X-Requested-With: XMLHttpRequest`，Referer 写高级检索页的地址 `/kns8s/AdvSearch?classid=<库>`）：

```
boolSearch=true&QueryJson=<JSON>&pageNum=1&pageSize=20|50&sortField=FFD|PT|CF|DFR&sortType=desc
&dstyle=listmode&productStr=&aside=&searchFrom=资源范围：总库;&CurPage=1
```

`QueryJson`（与网页高级检索生成的相同，结构来自页面脚本 `common.min.js` 的 `QueryState` 和 `advsearch.min.js`）：

```json
{"Platform":"","Resource":"JOURNAL","Classid":"YSTT4HG0","Products":"",
 "QNode":{"QGroup":[
  {"Key":"Subject","Title":"","Logic":0,"Items":[],"ChildItems":[
    {"Key":"input[data-tipid=gradetxt-1]","Title":"主题","Logic":0,"ChildItems":[],
     "Items":[{"Key":"input[data-tipid=gradetxt-1]","Title":"主题","Logic":0,"Field":"SU","Operator":"TOPRANK","Value":"图神经网络 * 推荐系统","Value2":""}]}]},
  {"Key":"ControlGroup","Title":"","Logic":0,"Items":[],"ChildItems":[
    {"Key":".tit-date-box","Title":"","Logic":0,"ChildItems":[],
     "Items":[{"Key":".tit-date-box","Title":"发表时间","Logic":0,"Field":"PT","Operator":"BETWEEN","Value":"2022-01-01","Value2":"2024-12-31"}]},
    {"Key":".extend-tit-checklist","Title":"","Logic":0,"ChildItems":[],
     "Items":[{"Key":0,"Title":"北大核心","Logic":1,"Field":"HX","Operator":"DEFAULT","Value":"Y","Value2":""}]}]}]},
 "ExScope":"1","SearchType":1,"Rlang":"CHINESE","KuaKuCode":"","Expands":{},"SearchFrom":1}
```

- 库：总库 `CROSSDB` / `WD0FTY92`（此时 `KuaKuCode` 填默认勾选的十个子库）；期刊 `JOURNAL` / `YSTT4HG0`；学位论文 `DISSERTATION` / `LSTPFY1C`，博士 `RMJLXHZ3`，硕士 `JQIRZIYA`；会议 `CONFERENCE` / `JUP3MUPD`；报纸 `NEWSPAPER` / `MPMFIG1A`。单库检索时 `KuaKuCode` 为空。
- 检索字段：`SU` 主题（`TOPRANK`）、`TI` 篇名、`AU` 作者、`LY` 文献来源（期刊名、学位授予单位、会议名都是它），后三个用 `DEFAULT`（精确）。每个条件是 `Subject` 组下的一个子组，`Logic` 0 为并且。
- 发表时间 `PT` 的 `BETWEEN` 在总库和各单库都有效。期刊高级检索页自己用的是出版年度 `YE`，它与结果列的发表时间（含网络首发）会差一年；统一用 `PT`，筛出来的日期与显示的一致。
- 来源类别只在期刊库：`SI`（SCI）、`EI`、`HX`（北大核心）、`CSI`（CSSCI）、`CSD`（CSCD），值 `Y`，各项 `Logic` 1（或）。
- 排序：`FFD` 相关度、`PT` 发表时间、`CF` 被引、`DFR` 下载。`sortField` 留空时知网按发表时间排。
- 检索词里空格和 `* + - ( ) / % =` 是运算符（`*` 与、`+` 或、`-` 非），词本身带这些字符时要用英文单引号括起来（`'Bi-LSTM' * 情感分析`）。检索框上限 120 字。
- 一页最多 50 条（网页可选 10、20、50）。只取第一页。

响应是 HTML 片段。总数在 `共找到</span><em>24,713</em>`；每行一个 `<tr>`，按 `td` 的 class 取：`name`（篇名链接到详情页 `kcms2/article/abstract?v=…`，里面有「网络首发」「免费」标记和检索词高亮的 `font`）、`author`（每位作者一个 `a`）、来源列在期刊和总库是 `source`、学位论文是 `unit`、会议是 `hy-name`，`date`（期刊带时分，学位论文库里只有年度）、`data`（总库、学位论文、会议才有的数据库列：期刊、博士、硕士、中国会议…）、`quote`、`download`。没有结果时没有 `<tbody>`。

## 下载

1. 详情页 `GET https://kns.cnki.net/kcms2/article/abstract?v=…`：`<li class="btn-dlpdf">` 里的链接是 PDF，`<li class="btn-dlcaj">` 是 CAJ。期刊里两个链接的 id 是 `pdfDown` / `cajDown`，学位论文里两个都叫 `cajDown`，所以按 `li` 的 class 区分。经 WebVPN 时页面里的链接已被改写成 WebVPN 地址，用 `unwrapUrl` 还原。
2. `GET https://bar.cnki.net/bar/download/order?id=…` → 302 `bar.cnki.net/docgateway/api/distribute/route?q=…` → 302 `docdown.cnki.net/docdown/fulltext/download?q=…` → 200 `application/pdf`，`Content-Disposition` 的文件名是「篇名_第一作者.pdf」。

- 下载地址是一次下载订单：每一跳只请求一次，不做 Range 探测、不分块、不重试（所以没有复用 `zhiyun/download.ts` 的 `downloadFile`，它会先发一次探测请求）。文件边收边写到 `.part`，核对长度和 `%PDF-` 文件头后改名。
- 列表行里也有一个「下载」链接，但不区分格式；一律从详情页取。
- 本地文件名自己拼成「篇名_第一作者」，与网页下载的一致；本地已有时不再请求详情页和下载地址。
- 跳到 `login.cnki.net` 表示要个人账号（学校没有订购）；跳到 `/verify/` 或返回带验证地址的 403 JSON 时自动处理拼图，然后从带 `captchaId` 的返回地址继续文件流，不重新走已经消耗的订单跳转。返回普通网页时把页面文字放进报错。下载时的真实滑块样本仍待验收。
- 实测耗时（本机，经 WebVPN）：检索在复用登录时 0.6–0.7 秒，要登录时 0.9–1.0 秒；下载一篇 1.8–2.3 秒（1–2 MB 的期刊论文、6.3 MB 的硕士论文都是）。
- 同一篇两次下载的字节数不同（1.7 MB 与 1.9 MB），文件是知网按次生成的，不能用大小判断是否同一文件。

## 协议上的坑

- `cli.ts` 接收任意数量的篇名并去重，顺序执行 `find → save`；两篇之间停 1 秒，每处理 5 篇后改为停 10 秒，不并发、不要求模型拆调用。分批只是本地节奏安排，不是知网接口的五篇限制，也不能保证不触发机构出口的限流。
- `PaperSelectionRequired` 只表示单篇的篇名或候选问题，连同无全文/未订购的 `RemoteRejected` 可记录后继续；认证、验证码、协议、网络等共同故障停止整批。检索和文件服务器的 HTTP 429 均映射成 `RATE_LIMITED`，不会当作普通单篇失败继续请求。
- 下载结果始终包含 `requestedCount, count, files, failed, pending, status, message`。多篇没有文件成功时抛出的错误在 `detail` 保留同样的汇总，候选保留到对应失败项；单篇错误保持原来的提示和候选结构。重复执行时复用 `save` 已有的本地文件检查，不重复下载完整文件。
- 篇名定位：把篇名按标点拆成几段、每段都要出现在篇名里（`TI`），再在本地去掉标点和空格后比对整个篇名。这样用户写的冒号、破折号全半角与知网不一致时也能找到（实测「SS-GCN：…」对上了知网的「SS-GCN:…」）。同名文献确实存在（两篇《图神经网络综述》），用作者或来源区分。
- 学位论文在学位论文库里的 `date` 是授予年度，在总库里是具体日期；按篇名下载走总库。
- `ExScope`、`aside`、`searchFrom`、`productStr` 照网页的默认值填，没有发现对结果有影响。`Rlang=CHINESE` 只查中文文献库；外文文献在知网只有题录，没有全文。

## 没有做的

- 翻页、分组浏览（按学科、机构等左侧分面）、摘要与关键词（详情页里有，`#abstract_text`、`.param-keyrowd`）、引文导出、专业检索表达式、外文文献、专利标准年鉴等其他库。
- 拼图以外的验证码。
