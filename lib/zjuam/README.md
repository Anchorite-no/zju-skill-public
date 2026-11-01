# 统一身份认证 请求与协议

日常业务自动认证；会话维护命令见 [命令总表](../../references/commands.md#zjuam)。本文件记录 CAS 的实际请求与协议，供开发和排障使用。

- 域名：zjuam.zju.edu.cn · 状态：**只读可用**（2026-09-17 直连与经 WebVPN 两种路径均真实验证）· auth=none network=public
- 代码：`lib/zjuam/{login,rsa,session}.ts` · CLI：`zju zjuam session login|status|logout`

## 鉴权

1. GET `/cas/login`（可带 `?service=`）→ HTML，取 `<input name="execution">`
2. GET `/cas/v2/getPubKey` → `{modulus, exponent}`（hex）
3. `password = hex(pow(int(ascii(pwd)), e, n))` 左补零到模长；**无 padding**（jsbn RSAKey.encrypt 行为）
4. POST 同一 URL，表单 `username, password, execution, _eventId=submit, authcode=""`，带 `Origin`/`Referer`
5. 30x = 成功，`Set-Cookie: iPlanetDirectoryPro`（domain `zju.edu.cn`）；200 = 失败，错误文本在 `<span id="msg">`

## 端点

| 短名 | 方法 | 路径 | 关键参数 | 响应 | 失效表现 | 级别 | 最近验证 |
|---|---|---|---|---|---|---|---|
| login-page | GET | `/cas/login` | `service?` | HTML 含 execution | — | A | 2026-09-17 |
| pubkey | GET | `/cas/v2/getPubKey` | — | `{modulus, exponent}` | — | A | 2026-09-17 |
| login | POST | `/cas/login` | 表单见上 | 302 + TGT cookie | 200 + `id="msg"` | A | 2026-09-17 |
| service | GET | `/cas/login?service=<url>` | — | 302 `<url>?ticket=ST-…` | 200 登录表单 = TGT 失效 | A | 2026-09-17 |
| oauth-authorize | GET | `/cas/oauth2.0/authorize` | client_id, redirect_uri | 302 链 | — | B | — |

## 会话复用

- TGT 有效性探测：GET `/cas/login?service=https://zjuam.zju.edu.cn/cas/`，302 且 Location 带 `ticket=` 即有效。**不要**用无 service 的 GET 判断，它对有效 TGT 也返回 302 而 body 为空，无法区分。
- 缓存 `data/sessions/zjuam.json`，TTL 12h；失效自动清 `zju.edu.cn` 域 cookie 重登。只存取 `zjuam.zju.edu.cn` 与 `zju.edu.cn` 域的 cookie：jar 是整个上下文共用的，连 WebVPN ticket 一起存会在下次加载时盖掉新 ticket，见 [WebVPN README](../webvpn/README.md) 的坑。

## 委托给其他系统

`Zjuam.service(url)` 返回带 ticket 的回跳 URL；`loginService(url)` 再跟随回跳直到目标域给出非 30x。目标域的会话 cookie 落在同一个 `HttpClient.jar` 里，由调用模块自行 `SessionStore.save`。

## 坑

- 密码含非 ASCII 字符会在 `Buffer.from(pwd, "ascii")` 处失真；zjuam 前端同样只按 ASCII 处理，此类密码本身登不上。
- 验证码：正常路径不出现；出现时 POST 返回 200 + 提示，代码抛 `NEEDS_USER`，请在浏览器登一次。
- 多个 path 的 cookie：zjuam 自身只有 `/cas` 下的，但委托后目标站（zdbk）会发三个不同 path 的 JSESSIONID，CookieJar 已按 path 区分。
