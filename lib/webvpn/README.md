# WebVPN 请求与协议

日常业务按模块声明自动经 WebVPN；诊断与会话维护命令见 [命令总表](../../references/commands.md#webvpn)。本文件记录 WebVPN 与可达性的实际请求和协议，供开发和排障使用。

- 域名：webvpn.zju.edu.cn · 状态：**只读可用**（2026-09-17 真实验证：登录、复用、NEED_CONFIRM、CAS 经 WebVPN、zdbk 委托）· auth=own network=public
- 代码：`lib/webvpn/{client,transport,doctor}.ts` · CLI：webvpn check/session/url/probe，参数见 [命令总表](../../references/commands.md#webvpn)。

## 鉴权

1. GET `/login` → HTML，取 `name="_csrf"`、`name="captcha_id"`、以及内联脚本里 `encrypt(data[i].value, "<key>", "<iv>")` 的 key/iv（2026-09-17 线上值为 `wrdvpnisawesome!`，每次以页面为准）
2. `password = hex(iv) + hex(AES-128-CFB(pwd, key, iv))`（页面用 aes-js 的 CFB，段长 128）
3. POST `/do-login`，表单 `_csrf, auth_type=local, username, sms_code="", password, captcha="", needCaptcha=false, captcha_id`
4. 响应 JSON：`{error: "NEED_CONFIRM"}` → 再 POST `/do-confirm-login` 同表单；其他 `error` 为失败；无 error 即成功
5. 有效标志：cookie `wengine_vpn_ticketwebvpn_zju_edu_cn`；`route` cookie 由服务端下发（Go 版写死的 `8768cab8…` 不再依赖）

**账号体系**：WebVPN 用校园网账号密码，与统一认证不同，代码不做回退。错误有次数限制（提示"还剩 N 次机会"），代码不自动重试。凭据填在 `profile.env` 的 `webvpn_username` / `webvpn_password`。

**默认传输**：`network=campus` 的模块统一经 WebVPN 访问（`transport=webvpn`），校内校外一致；只有 `transport=direct` 时直连。WebVPN 与 CAS 相互独立：zjuam 永远直连，只有校内站点的 URL（含 CAS 回跳）被重写。例外是模块在 `publicHosts` 里点名的主机（目前只有通知模块，取自 `lib/notice/hosts.json` 的校外实测）：经 WebVPN 时它们仍直连；直连不通，或者落到网站群的「无权访问」页 `/nopermit_zjusub.jsp`，这一次运行里这个主机改走 WebVPN。

## 端点

| 短名 | 方法 | 路径 | 关键参数 | 响应 | 失效表现 | 级别 | 最近验证 |
|---|---|---|---|---|---|---|---|
| login-page | GET | `/login` | — | HTML | — | A | 2026-09-17 |
| do-login | POST | `/do-login` | 见上 | JSON `{error?}` | `error` 非空 | A | 2026-09-17 |
| confirm | POST | `/do-confirm-login` | 同上 | JSON | — | A | 2026-09-17 |
| probe | GET | `/` | — | 200 非登录页 = ticket 有效 | 302 到 /login | A | 2026-09-17 |

## URL 重写

`https://<host>[:port]/<path>?<q>` → `https://webvpn.zju.edu.cn/<scheme>[-<port>]/<enc(host)>/<path>?<q>&vpn-12-o2-<host>`

`enc(host) = hex("wrdvpnisthebest!") + hex(AES-128-CFB(host, key=iv="wrdvpnisthebest!"))`

已用 cc98-autosign-fast 里写死的两条常量反解验证：
- `…7421ffe744922e3426537d51d1e2974724` ↔ `openid.cc98.org`
- `…7421f1e748d22433310830079bab` ↔ `api.cc98.org`

`Referer` 头也要重写；`Location` 响应头是 WebVPN URL，用 `unwrapUrl` 还原。

## 坑

- 主机名编码 key 是 `wrdvpnisthebest!`，登录密码 key 是页面给的（当前 `wrdvpnisawesome!`），两者不同。
- 会话 TTL 未知，暂按 6h；`probe()` 每次用前探一次。
- 验证码：连续失败后出现，代码抛 `NEEDS_USER`；逃生口 `import-cookie --ticket`（从浏览器复制 `wengine_vpn_ticketwebvpn_zju_edu_cn`）。
- `NEED_CONFIRM` 在服务端已有该账号会话时出现（例如 `--fresh` 重登），再 POST `/do-confirm-login` 同表单即可，已验证。
- 经 WebVPN 访问时，目标站的会话 cookie 由 WebVPN 服务端代持，本地 jar 只有 `wengine_vpn_ticket…`、`route`；`;jsessionid=` 会出现在重写后的 URL 路径里。zdbk 声明为 `network=public` 直连，所以它的三 JSESSIONID 问题仍然成立，由 CookieJar 按 path 处理（2026-09-17 直连验证：`JSESSIONID/jwglxt`、`JSESSIONTOKEN/`、`JSESSIONPREJSDM/jwglxt/xtgl` 三个并存）。
- `Zjuam` 重登时只能清 `zjuam.zju.edu.cn` 与 `zju.edu.cn` 域的 cookie，不能按后缀清子域，否则会把 `webvpn.zju.edu.cn` 的 ticket 一起删掉（2026-09-17 踩过）。
- 会话文件只存取本组件自己的 cookie：`webvpn.json` 只有 `webvpn.zju.edu.cn` 域的，`zjuam.json` 只有 `zjuam.zju.edu.cn` 与 `zju.edu.cn` 域的。一个上下文里 WebVPN、统一认证和站点共用一个 jar；2026-10-06 之前两者都把整个 jar 存下来、加载时全部放回，`zjuam.json` 里就带着一份登录统一认证那一刻的 WebVPN ticket。`openContext` 先建 Webvpn 再建 Zjuam，后者把这份旧 ticket 盖在刚载入的新 ticket 上，第一个请求被网关拒绝，于是 `auth=cas network=campus` 的上下文每次运行都重登 WebVPN。触发条件是在这种上下文里做过一次统一认证表单登录（那一刻 jar 里有 ticket），之后 `zjuam.json` 的 12 小时有效期内一直如此；最早是通知模块的信息技术中心栏目和当天的探测脚本带出来的。旧文件里混入的 cookie 在加载时被过滤，不需要手动清。
- 同一账号可以同时有多个会话：2026-10-06 服务器登录之后，本机 4 分钟前拿到的 ticket 仍然有效，连续两次运行都没有重登。
- 网关对不带有效 ticket 的请求回 302 `/login`，同时 `Set-Cookie` 下发一个新的匿名 ticket 和 `route`（2026-10-06 实测：无 cookie、伪造 ticket 都如此；带有效 ticket 的请求不下发）。所以 ticket 失效时的在途请求会改写 jar 里的 ticket：传输层在重登期间不发新请求，登录前先等在途请求回来（最多 1 秒），重登后的重发只做一次。曾有一次运行在十来个并发请求下登录了两回、其中一个请求拿到登录页；之后同样条件新旧实现各跑 5 次都只登录一回，没能再复现，这个处理是按上面的机制做的预防。
- http 站点（如 ETA 的 `http://eta.zju.edu.cn`）经 WebVPN 时会先 302 升级到 `/https/` 前缀，单次 `fetch` 拿到 302 属正常，用 `fetchFollow` 或直接写 https。

## 当前诊断边界

webvpn check 默认诊断网络和会话，指定 --host 时检查给定主机；--fresh 强制重查（未指定主机时检查 WebVPN、统一认证和查老师三站），不再提供 --clear-cache。模块 auth/network 声明直接看 module.json 或架构文档。直连校园网探针使用实际校内 CC98 主机，教务网 zdbk 是公网站点，不能用其可达性证明已接入校园网。

## 站点可达性与传输声明

判断一个站点是 `public`（公网直连）还是 `campus`（只在校网，需 WebVPN），**不能在本机测**：
本机可能有 TUN 级代理（FlClash / Clash / ZJU Connect / Tailscale）在 IP 层劫持全部流量，
即使用公共 DNS 解析出真实 IP、直连该 IP，包仍会走隧道进校园网，得到假的"可达"。

**唯一可靠办法**：从一台没有校园网拓扑的干净外部主机（国内云服务器）测。
命令：`zju webvpn probe --host <h> --via <ssh目标>`（见下），或手动 `ssh <host> 'curl -sS -o /dev/null -m8 -w "%{http_code}" https://<h>/'`。

### 实测结果（2026-09-17，腾讯云国内节点，无校园网拓扑）

| 站点 | 公共 DNS 解析 | 校外 HTTPS | 声明 | 说明 |
|---|---|---|---|---|
| zjuam.zju.edu.cn | 210.32.15.40 | 200 | public | 统一认证，公网可达 |
| zdbk.zju.edu.cn | 210.32.15.59 | 200 | public | 教务网，公网可达 |
| eta.zju.edu.cn | 210.32.132.16 | 200 | public | 三全育人；后端接口 `getPublicKey.zf`/`getCurrentUser.zf` 从校外返回真实 JSON，非仅首页外壳 |
| courses.zju.edu.cn | 210.32.157.21 | 302 | public | 学在浙大 |
| classroom.zju.edu.cn | 210.32.157.28 | 200 | public | 智云课堂门户；`*.cmc.zju.edu.cn` 另测 |
| webvpn.zju.edu.cn | 210.32.3.80 | 302 | public | WebVPN 入口本身 |
| **api.cc98.org** | **10.10.98.98** | **连接失败** | **campus** | CC98，私网地址，仅校网 |
| www.cc98.org / openid.cc98.org | 10.10.98.98 | 连接失败 | campus | 同上 |
| bksy.zju.edu.cn / kyjs.zju.edu.cn | 无公网解析 | 无法解析 | campus | 本科生院官网与竞赛管理系统，2026-09-24 服务器实测；notice 模块经 WebVPN 读取 |

`cnki.net`（知网）不在这张表的判断范围内：它公网可达，声明成 `campus` 是因为全文权限按出口 IP 认机构，经 WebVPN 出去才是学校的 IP（2026-10-05 本机经 WebVPN 实测，IP 登录返回「浙江大学图书馆」；直连公网 IP 返回登录失败）。

### 结论

- 210.32.x 段的浙大站点在**国内**公网可达 → `public`。海外可能被墙（另有 `courses/*.cmc` 只对国内 IP 开放的说法），海外场景如需可改回 `campus`。
- cc98.org 全家（10.10.98.98）只在校网 → `campus`，必须 WebVPN。
- `*.cmc.zju.edu.cn`（智云视频/转录）待从外部主机单独实测，先按国内可达性归类，若失败再标 campus。

### 更新规则

站点改版或 IP 变化时，从干净外部主机重测，改这张表，同时改对应模块 `requirements.network`。
不要用本机 `curl` 或本机 probe 的 `direct.reachable` 作为依据（TUN 会骗你）。
