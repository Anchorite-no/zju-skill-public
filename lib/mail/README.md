# 浙大邮箱 请求与协议

日常用法见 [邮箱](../../references/mail.md)，参数见 [命令总表](../../references/commands.md#mail)。本文件记录收发信的实际协议、配置依据和坑，供开发和排障使用。

- 服务器：IMAP `imap.zju.edu.cn:993`、SMTP `smtp.zju.edu.cn:994`，都是 TLS 直连（TLS 1.2 起，校验证书）· auth=own network=public · 状态：**离线验证**（2026-11-01，假的 IMAP/SMTP 客户端跑过查信、读信、附件、发信、回复和防重；没有用真实账号收发）
- 代码：`lib/mail/{index,cli}.ts`；IMAP 用 `imapflow`，解析用 `mailparser`，SMTP 用 `nodemailer`

## 配置依据

- 官方使用指南：<https://its.zju.edu.cn/2026/0528/c91768a3167649/page.htm>。同时列出非 SSL 端口 143 / 25 / 110 和 POP3 995，这里只用加密的 993 / 994。
- 客户端专用密码：<https://mail.zju.edu.cn/coremail/help/2fa_zh_CN.html>。开了二次验证以后，客户端必须用它，收信和发信服务器都用同一个。网页版「设置 → 安全设置 → 客户端专用密码 → 生成专用密码」，随机 16 位、区分大小写、只显示一次；密码名称不是密码。
- 登录用户名是完整邮箱地址：<https://mail.zju.edu.cn/coremail/help/clientoption_zh_CN.jsp>。
- 凭据在加密账号配置的 `mail_username` / `mail_password`；不是 `@zju.edu.cn` 的地址在连接之前拒绝。

## 收信

- 每条命令新开一个 IMAP 连接，做完 LOGOUT，不保存会话。目录一律 `EXAMINE`（`mailboxOpen(..., { readOnly: true })`），取正文用 `BODY.PEEK[]`，查信、读信、下附件都不改 `\Seen`。
- 邮件 id 是 `UIDVALIDITY-UID`。服务器重建目录时 UIDVALIDITY 变，旧 UID 可能指向别的信，所以 view、download、reply 先比对 UIDVALIDITY，不一致就要求重新 list。
- 目录按名字定位：先按 RFC 6154 特殊用途（`\Sent`、`\Drafts`、`\Junk`、`\Trash`、`\Archive`）对常用中文说法，再按目录 path / name 唯一匹配；`\Noselect` 的目录不列出。真实服务器上各目录的名字和特殊用途标记还没核对。
- 列表：`SEARCH` 按 UID 倒序取前 limit 封，再 `FETCH ENVELOPE FLAGS RFC822.SIZE BODYSTRUCTURE`。附件数按 BODYSTRUCTURE 数：disposition 是 attachment 的，或带文件名、不是 inline、不是 text/multipart 的。`--keyword` 几种说法拼成 `OR SUBJECT`；中文主题搜索要服务器支持 `CHARSET UTF-8`，还没在真实服务器上试过。
- `SINCE` / `BEFORE` 只比日期，不带时区。日期用 UTC 零点构造，imapflow 按 UTC 取日，才不会差一天；`--until` 含当天，所以 `BEFORE` 是它的下一天。
- 读信先 `FETCH RFC822.SIZE`，超过 25 MB 不取，请用户去网页版。正文给 `mailparser` 的 `text`（只有 HTML 的信它会转成文字），最多 60000 字，超过标 `truncated`。`related` 的附件是正文里引用的内嵌图片，不算附件。

## 发信

- `send` 和 `reply` 共用一条路：写闸（`ZJU_ALLOW_WRITE=1` 加 `--confirm`）在读账号、连服务器之前检查；`--dry-run` 只返回将要发出的内容，不需要写闸、不连 SMTP（reply 的预览要连 IMAP 读原信）。
- 附件在发之前读进内存，最多 10 个、合计 10 MB；nodemailer 开 `disableFileAccess` / `disableUrlAccess`，正文和附件都不能再去读别的文件或网址。
- 写前日志 `data/journal/mail-<时间>-<uuid>.jsonl`：先记 `begin`（收件人、主题、附件名和大小、内容摘要 digest，不记正文），落盘失败不发；之后记 `done`（messageId、accepted、rejected）、`rejected` 或 `unknown`。
- 防重：10 分钟内的 mail 日志里有同一个 digest 的 `begin`、又没有 `rejected`，就不发，要 `--force`。digest 取收件人、抄送、主题、正文和附件名与大小。结果不明的那封也会拦下来，先请用户核实。
- 结果怎么分：nodemailer 的错误带 `command`；`CONN`、`EHLO`、`STARTTLS`、`AUTH`、`MAIL FROM`、`RCPT TO` 阶段失败，以及 `EAUTH`、`EENVELOPE`、`EDNS`，都是确定没发；`DATA` 之后或没有 command 的，按结果不明处理，不重发。
- 部分收件人被拒时返回 `partial` 和 `rejected` 列表，不整封重发。
- 不往「已发送」里 APPEND。服务器会不会自动把 SMTP 发出的信存进已发送，还没核对。

## 回复

- 收件人取原信 `Reply-To`，没有就取 `From`；回复自己发出的信时取原信的 `To`。`--all` 把原信的 `To` 和 `Cc` 放进抄送，去掉自己和已在收件人里的地址。
- 主题已有 `Re:`、`回复:`、`答复:` 的不再加；带 `In-Reply-To` 和 `References`，网页版能串成会话。
- 原文按「在 时间，发件人 写道：」加 `> ` 引用，最多 200 行。
