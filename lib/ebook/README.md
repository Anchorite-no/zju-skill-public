# 电子图书 请求与协议

CLI 用法见 [电子图书](../../references/ebook.md)。本文件记录两个来源的地址和结构，供开发和排障使用。

- 声明：`auth=none network=campus writes=false`，主机 `gk4pb6yy8y.search.serialssolutions.com` 和 `sslibrary.com`。两个站都按 IP 认证，经 WebVPN。
- 代码：`lib/ebook/{index,cli}.ts` · CLI：`zju ebook search` · 没有会话。
- 最近核对：2026-10-07（本机经 WebVPN，真实只读）。

## 一、电子书刊导航

- 入口：图书馆主页 `libweb.zju.edu.cn` 的「电子图书」，指向 `http://gk4pb6yy8y.search.serialssolutions.com/?L=GK4PB6YY8Y&tab=BOOKS`（页面标题「浙江大学图书馆电子书刊导航」，Serials Solutions 360）。它在 WebVPN 门户里叫「图书馆期刊导航」。
- 从校外地址访问会被转到 `login.serialssolutions.com/sso/login`（Serials Solutions Authentication Service）。
- 规模（「数据库浏览」页，`tab=OTHER`）：共列 580 个资源包，标了电子书的 144 个，分布在 69 个平台主机上；标了电子期刊的 258 个。用 10 个常见书名各取 50 本，共 500 本，出现过 48 个平台：中文书主要来自文泉学堂、科学文库、书递，外文书主要来自 Springer、O'Reilly、ProQuest Ebook Central、Elsevier、IEEE（IEL）。**超星电子书和 CADAL 不在它的书目里。**

### 请求

`GET /?V=1.0&N=<每页条数>&tab=BOOKS&L=GK4PB6YY8Y&S=<方式>&C=<词>`，翻页加 `&sortby=SB_T&B=<起始序号>`。少了 `V` 和 `N` 时返回的是没有结果的首页。

| `S` | 含义 | 实测 |
|---|---|---|
| `A_T_B` | 标题开头为 | 中英文都可用 |
| `A_T_M` | 标题等于 | 可用，没有用 |
| `T_W_A` | 标题包含所有词 | 英文可用；含汉字的词 35 秒没有响应（机器学习、深度学习、算法导论、「数据结构 C语言」都如此） |
| `I_M` | ISBN 等于 | 可用，带连字符的 13 位号码能查到 |

- 耗时跟每页条数走：`N=100` 约 10 到 13 秒，`N=20` 约 2.7 秒，`N=10` 约 1.7 秒。命令用 20，最多读 6 页。
- 结果按书名排序（`SB_T`）。所以先按开头匹配，以所给文字开头的书排在最前；英文书名不够数时再用「包含所有词」补。

### 页面

- 条目总数：`.SS_ResultsCount`（「120 记录」）。同一本书在几个平台各占一条。没有结果时也是 200，计数为「0 记录」。
- 每条是一个 `div.SS_Holding`：书名 `.SS_JournalTitle > strong`，`.SS_BookISBN` 形如 `(7-302-62729-0, 978-7-302-62729-6)`，`.SS_Edition`，`.SS_Authors`，`.SS_Publisher`，`.SS_Date`（只写年，或 `02/01/2019`）。
- 平台链接 `a.SS_JournalHyperLink`：文字是平台名，地址 `/log?L=…&D=<库代码>&J=<题名代码>&P=EJP&A=<书名>&H=…&U=<平台上的地址>`。命令取 `U` 作为直达地址，不经过这个记点击的跳转。
- 数据本身有瑕疵：个别 ISBN 缺位（不足 13 位的不输出），个别著者栏里填的是 ISBN。

### 同一个站的电子期刊（没有接）

`tab=JOURNALS` 是电子期刊：按刊名查学校能看哪种期刊、在哪个数据库、能看哪些年份。例如《计算机学报》(0254-4164) 给出「从 1998 至目前 在 万方数据_期刊；从 1978 至目前 在 中国知网(CNKI)_期刊；从 1983 至目前 在 维普_期刊」；刊名以 Nature 开头的有 152 条。请求和页面结构与电子图书相同，每条多一个覆盖年份。

## 二、超星电子书

- 地址 `https://www.sslibrary.com`（汇雅）。经 WebVPN 时页面写「欢迎来自 浙江大学 的用户」；从校外地址打开书的页面会被转到 `/user/login/showlogin`。首页是一段跳到 `/page/239443/show` 的脚本。
- 检索：`GET /book/search/do?sw=<词>&allsw=&bCon=&field=<方式>&searchtype=&page=1&pagesize=<n>`，带 `Referer: https://www.sslibrary.com/book/search`。`field`：`1` 书名、`2` 作者、`6` 目录、`all` 全文。书名是包含匹配（「机器学习」24 条里有《分布式机器学习与优化》）。没有单独的 ISBN 字段，但 `field=all` 能按 ISBN 找到，带不带连字符都行；`field=1` 不行。按 ISBN 查时命令只留 ISBN 确实相同的结果。
- 返回 JSON `{success, data: {result, total, maxpage}}`。每本：`bookName`、`author`、`publisher`（「北京：中信出版社」）、`date`（「2017.04」）、`isbn`、`ssid`、`dxid`、`cnFenlei`、`introduce`、`page`，一组来源标记，以及几个签好的值 `bookCardD`、`pdgD`、`jpathD`、`aiD`、`enc`、`time`。
- 书的页面：`/book/card?cnFenlei=<cnFenlei>&ssid=<ssid>&d=<bookCardD>&isFromBW=<isFromBW>&fromType=&websiteId=383503`。`websiteId` 是结果页上给浙大的站点编号，去掉它和 `fromType` 也能打开；只带 `ssid` 报 500。同一本书的 `bookCardD` 半小时后再查没有变，换一个会话也能打开。
- 阅读方式按结果页模板的判断：`isFromNewLib` 或 `isFromZX` 有 EPUB 阅读，`isFromBW` 有 PDF 阅读，`isFromBK` 有图像阅读，`isFromNewLib && isBlock` 另有 AI 阅读。页面上的「下载」链接指向 `/reader/pdg/…`，没有点过，不知道给的是什么格式。阅读器地址带 `enc` 和 `time`，命令不生成这些地址。

## 合并

- 两个来源的记录交替排列后合并：按 13 位 ISBN；没有 ISBN 的按书名、著者、出版社。超星的老书多是 10 位 ISBN 或统一书号，不参与按 ISBN 合并。
- 一个来源失败时返回另一个的结果，并在 `sourceErrors` 里写明；两个都失败才报错。

## 平台用法说明

导航结果里 `access` 的文字摘自图书馆数据库导航 `libdb.zju.edu.cn/s/lib/libtb/show/<编号>`（科学文库 1957、书递 1974），只收了导航页明确写了用法的平台。数据库导航的图书类一共 134 个库，列表在 `/s/lib/libtb/doctype/A`。

## 没做的

- 不下载、不代读全文。《浙江大学图书馆电子资源使用管理办法（试行）》第四条把「使用任何自动下载软件或智能机器人下载工具进行下载」列为违规。
- 电子期刊、按主题和字顺浏览。
- 超星按作者、目录、全文检索；CADAL、读秀。
