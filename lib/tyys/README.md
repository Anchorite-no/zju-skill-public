# 体艺考勤与场馆协议

课程考勤客户端只提供 GET 查询；场馆预约使用独立的网页客户端，保留完整写流程。

## 考勤认证与只读端点

CAS App 会话由 `client.ts` 管理，按账号缓存并核对令牌身份与有效期；过期自动重新认证一次。PTM 请求带 App 签名；`sign.ts` 负责签名，`rollcall.ts` 只组织当前状态与历史。

| 路径 | 用途 |
|---|---|
| GET `/api/l/v6/termlist` | 学期 |
| GET `/api/l/v6/student/courselist` | 本人课程 |
| GET `/api/l/v6/course_times` | 课次日期 |
| GET `/api/l/v6/student/attendancelist` | 本人到勤记录 |
| GET `/api/l/v6/attendance/potion` | 当前 GPS 查询结果 |

GPS 查询返回 422 只能说明未取得位置，不能证明教师未开启。只读输出独立保留已有到勤方式与 GPS 结果；状态 1/6 为到勤或迟到，未知响应不猜测。当前状态按课程和当天课次关联，历史缺勤数按已有 detail 计算，不能把尚未上课的课次算作缺勤。

## 场馆预约

2026-09-25/26 按网页前端逐项核对，并在本机直连只读实测到预下单为止；验证码只取题未校验，未提交、未支付。2026-10-03 补核预约须知接口、前端日期计算与单场馆当日查询，均为只读；正常查询已返回 200。

当前实现：`venue.ts` 负责网页客户端、签名、须知和时段；`booking.ts` 负责一次调用的预约、同伴、支付、订单和取消；`captcha.ts` 管理本地识别环境与常驻子进程，`scripts/tyys/captcha.py` 复用旧项目的纯本地识别算法。CLI 注册仍在 `cli.ts`。现场验证范围、真实写待办分别记录在 PLAN，不把只读成功视为预约成功。

网页会话按账号隔离缓存四小时，目录和须知缓存一天。业务码 408 立即停止；不会启用批量扫描、全局请求预算或自行设置数日封禁。预约只读取一次目标日期空场；未开放、无空场直接返回。提交遇场地已占用不再换场或重试。预下单后保留平台要求的最短处理间隔、验证码最多两次尝试、同伴校验、付款与结果回查；这些属于一次预约交易。

写前 JSONL 按账号保存到 `data/journal/tyys-venue-<hash>.jsonl`。begin 必须落盘才提交；确认或明确拒绝后记 resolved。相同日期与时段再次调用时，先回查该目标的未决操作；响应丢失不重放提交或付款。对已有未支付订单可以在当前授权内完成付款，但一次调用返回 recovered-previous-operation 时只恢复上次记录，不接着做新操作。

识别环境在 `data/tools/tyys/.venv`；setup 优先用 uv 的 Python 3.10，服务器没有 uv 时使用 python3 venv。固定 ddddocr 1.6.1、PaddleOCR 3.4.0、PaddlePaddle 3.3.1。Paddle 官方模型缓存为 `~/.paddlex/official_models/PP-OCRv5_mobile_rec`；只有 setup 下载，普通 check/book 要求本地文件存在。Python 不请求场馆接口；stdout 为 JSON Lines，第三方模型日志不混入业务结果。

后端 `http://www.tyys.zju.edu.cn/venue-server`，与课程考勤 `/ptm` 是两套系统。App 内的场馆预约只是 WebView 打开同一网页；考勤查询使用的 App JWT 直接作 `cgAuthorization/cgappauthorization` 发来返回 401，所以用网页登录：

1. CAS service `http://tyys.zju.edu.cn/venue-server/sso/manageLogin`，回跳到 `/venue/login?oauth_token=…`。
2. POST `/api/login`，头 `oauth-token`，空表单；返回 `roles` 与 `token.access_token`。
3. POST `/roleLogin`，表单 `roleid=3`（学生，账号只有这一个角色），头 `cgAuthorization` 为上一步令牌；返回新令牌、`ruleList`。令牌有效期 4 小时，之后请求都带 `cgAuthorization`。

请求约定（前端 `emitAjax` 与 `$http`）：表单编码；GET 参数进查询串并自动加 `nocache=timestamp`；值为 null/undefined 的字段不发送。签名 `md5(salt + path + Σ(key+value) + timestamp + " " + salt)`，key 按字典序，跳过空串、null 和对象值，path 为 `/api/...`（不含 `/venue-server`）；头 `app-key/timestamp/sign`。salt 与 app-key 同旧项目 zju-room-booker `signer.py`。不需要 Referer/Origin。业务码：200 成功，401「请登录后访问」，250「最多只能查看3天后的预约」，408「访问频繁，限制访问中...」。408 是按账号的频率限制：2026-09-26 约 20 分钟内发出约 300 个请求（其中一次 15 秒内约 100 个）后触发，之后所有 day/info 都返回 408，间隔 0.7 秒也不放行；登录接口仍可用。用户以前被封过 72 小时。开发探测只查单个场地、少量请求，不做批量扫描。

| 用途 | 方法与路径 | 学生实际发送的参数 | 说明 |
|---|---|---|---|
| 预约须知与放号时间 | GET `/api/front/website/protocols/code/RESERVATION_PROTOCOL`（未登录）；GET `/api/protocols/code/RESERVATION_PROTOCOL`（登录后） | 无 | 预约页弹窗实际使用的接口，返回 `title, content, protocolCode, autoPopup, staySec` 等；`content` 为 HTML。公开入口无需账号登录，仍按前端附请求签名。含校区和场馆放号时间、同伴码及预约规则 |
| 网站通知列表与正文 | GET `/api/front/website/articles`；GET `/api/front/website/articles/{id}` | 列表 `page=0, size=20`，可选 `catalogTitle` | 这是普通通知栏目，与预约须知分开；本次公开列表为空。不能据此判断没有预约须知 |
| 场地目录 | GET `/api/reservation/campus/venue/info` | 无 | `venueSiteInfo` 按场馆分组；历史 54 个场地中 29 个 `isArt=1`（琴房、艺术教室，已迁出，过滤）；`sportName` 部分为 null。`reservationNumMax=2` 是一次最多选的格数；`advanceReservationDays` 是含当天的当前可选天数，前端最大日期为 `today + advanceReservationDays - 1`，不能直接作为“几天后”偏移量；当日时段响应可覆盖目录值 |
| 某日时段 | GET `/api/reservation/day/info` | `venueSiteId, searchDate` | 可查范围按场地而定：多数场地为今天到后天，足球场（47、48、59、62）可到 4 天后；新的一天在该场地放号前返回 250，放号后才出现（紫金港羽毛球、网球 9/26 14:00 前已放出后天，华家池 41、64 此时仍为 250）。`reservationDateSpaceInfo[date]` 每个场地（`id, spaceName`）以 timeId 为键给出时段：`reservationStatus` 1 空闲、2 不开放、3 未支付占位、4 已预约，`startDate/endDate`，`orderType=5` 为管理员批量订场。放号前该日场地没有时段键。`token` 供预下单和提交使用，`reservationDateList[0]` 即 weekStartDate |
| 预下单 | POST `/api/reservation/order/info` | `venueSiteId, reservationDate, weekStartDate, reservationOrderJson, schoolType=1, token` | `reservationOrderJson=[{"spaceId","timeId","venueSpaceGroupId":null}]`。返回 `venueInfoBean`（`buddyNumMin/Max, isFee, reserveTip`）、`phone`、`buddyList`（`id,name,userId,userRoleId…`）、`isCaptchaCheck`、`orderDetailList`（无价格）。实测不占场、不生成订单 |
| 验证码取题 | GET `/api/captcha/get` | `captchaType=clickWord, clientUid, ts` | `repData`：`token, secretKey, wordList`（3 个汉字）、`originalImageBase64`（310×155 PNG） |
| 验证码校验 | POST `/api/captcha/check` | `captchaType, pointJson, token` | 按顺序点 3 字，坐标取图片像素；有 secretKey 时 `pointJson=AES-ECB-PKCS7(JSON(points))`，`captchaVerification=AES(token+"---"+JSON(points))`，均 Base64；`repCode=0000` 为通过 |
| 提交 | POST `/api/reservation/order/submit` | 预下单字段 + `phone, buddyIds, buddyNo, captchaVerification, isOfflineTicket=1`，`token` 仍为 day/info 的 | `reservationOrderJson` 最多 2 格；连续两小时即同一场地相邻两个 timeId。`buddyIds` 为同伴记录 id 逗号串（`GET /api/buddies` 的 `id`）；账号带 `VipCheckBuddyNo` 规则时 `buddyNo` 为对应同伴的 5 位同伴码。返回 `orderInfo`（`id, tradeNo, amountFee, expireTime`） |
| 同伴码 | POST `/api/vip/view/buddy_no` | 无 | 只能看登录账号本人的码：5 位数字字符串，连续查看两次不变。用户说明每次被使用后刷新，所以要在提交前以同伴账号登录读取。`POST /api/vip/check/buddy_no`（`buddyUserId, buddyRoleId, buddyNo`）返回 `checkResult` 可预先校验 |
| 支付确认 | POST `/api/venue/finances/order/pay` | `venueTradeNo, isApp=0`；收费单另加 `payType=1, paySecret` | 零元单不发 `payType`；不确认约 3 分钟后订单取消。`payType=1` 为校园卡，`paySecret` = AES-CBC-PKCS7(校园卡查询密码, key `c1h2i5n6g2o2k4a7`, iv `C2H3I4N5G2O3K1E4`) 的十六进制密文（前端 `keySetPassword`） |
| 我的订单 | GET `/api/orders/mine` | `page, size` | 分页 `content[]`：`tradeNo, venueSiteId, reservationDateDetail, reservationStartDate, orderStatus`（1 正常、2 已取消、3 占用）、`payStatus`（1 未支付、2 已支付、3–5 退款）、`amountFee, promiseStatus` |
| 取消 | POST `/api/venue/finances/order/cancel` | `venueTradeNo` | 公告：付费场地一经预约不予取消；逾期未入场且未取消影响后续资格 |

旧项目的琴房经验：提交距预下单过快会被拒（「预约步骤流程耗时异常」），当时稳定值为 1.5 秒。

### 预约须知与日期口径

2026-10-03 从当前前端 `chingo.2fa40da1.js` 及其懒加载块定位：预约页块 `chunk-3cc3ae64` 按是否登录选择上述 protocol 接口；日期选择块 `chunk-7fcac090` 的 `disabledDate` 和下一天按钮都使用 `advanceReservationDays - 1`。业务码 250 的文案不能取代这个日期计算。

预约须知正文列明每日释放预约名额的时刻：紫金港网球 08:00、紫金港羽毛球 09:00、玉泉羽毛球 12:00、华家池羽毛球与膜顶网球 18:00。该段落署期 2024-10-17，目前仍由官方接口返回；不是场馆每天开门营业的时刻。正文还明确同伴码预约成功后失效；稀缺场地按一小时/场次、每账号每日最多一场次，最终可选格数仍要结合场馆实际规则校验。

2026-10-03 北京时间 02:43，目录及紫金港体育馆羽毛球当天的 day/info 均返回 `advanceReservationDays=2`，当天查询成功；查询 10-06（真实三天后）返回 250。已有 09-26 13:57 原始记录显示该场馆 09-28 已开放、09-29 仍为 250。结合前端计数与 09:00 放号规则，现有证据支持“放号前含当天两天、放号后含当天三天”的解释，尚未对本次放号边界做前后实测。

因此 CLI 必须分开处理用户的日历偏移与平台当前开放窗口。用户说三天后就是日历加三天，不能改成加两天；以该场馆现有规则推算，目标日历加三天的预约要等次日 09:00 才进入窗口。若规则或服务端结果变化，应保留目标日期重新判断，不回退到其他日期。公开输入按用户要求限定为今天至三天后，历史足球场更长窗口不扩大该范围。
