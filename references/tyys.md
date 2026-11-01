# 浙大体艺考勤查询与场馆预约

## 本人考勤

`tyys rollcall status` 查询当前课程目标、GPS 查询结果及已有到勤方式；`tyys rollcall history [--course 课程名]` 查询各学期记录。两者只读，不取签到凭据、不提交。已有扫码记录不能当作 GPS 成功；unknown 只表示无法确认，按 message 回答。

历史结果的 planned 是应上次数，held 是已有记录数；未上课次不计入缺勤。message 已汇总到勤和未到课次。

## 场馆预约

场馆命令在 `tyys venue` 下，与考勤查询独立。无须先登录或读源码。

明确要求预约时直接 book，不先用 list、notice 或 check 预检；未放号、缺同伴、时段不匹配等由 book 返回。needs-time 或 needs-input 附 alternatives 时，这些已是同一次查询得到的相邻时段，不再重复查询；让用户明确选择，不能把 19:00 自动改成 19:30。

| 目标 | 命令 |
|---|---|
| 查空场 | `tyys venue list --sport 羽毛球 --campus 紫金港 --venue 体育馆 --date 今天 --time 19:00` |
| 看场馆目录 | `tyys venue list`；多个场馆符合筛选时也返回候选，不扫全站余量 |
| 查放号时间与使用规则 | `tyys venue notice` |
| 预约明确场馆 | `tyys venue book --venue 紫金港体育馆 --sport 羽毛球 --date 明天 --time 19:00 --confirm` |
| 查看本人预约 | `tyys venue order list`；可用 date、venue 筛选 |
| 取消一个明确预约 | `tyys venue order cancel --venue 场馆 --date 日期 --time 19:00-20:00 --confirm` |

book 和 order cancel 需要 `ZJU_ALLOW_WRITE=1` 与有效任务授权。现有授权不重复询问。场馆重名时只按候选问清目标，不自行选择。

日期接受今天、明天、后天、0至3天后、YYYY-MM-DD；查询和预约范围为当天到三天后。三天后始终按北京时间日历加三天，不解释成含当天第三天。未开放时返回 not-released，能确认放号时间时附 releaseAt；不等待放号，也不改约前一天。

time 用 HH:mm 表示从该时刻开始的一格，也可传完整区间 HH:mm-HH:mm。最多同一块场地两格连续时段，实际仍受场馆规则限制；当前须知限制羽毛球、网球每账号每日一小时，不能自动缩短用户明确要求的区间。当天已经开始的时段不预约。

book 只查询一次空场；无空场返回 unavailable，被别人先订走返回 rejected，不轮询、不换场重试。普通预约仍完整处理验证码、同伴、一次提交、付款和回查。请直接转述结果，不用循环或定时任务重新实现抢场馆。

同伴默认使用 profile 中已获本人授权的同伴配置，自动登录取码并校验；指定同伴时传 `--buddy 姓名`，多人用竖线分隔。缺少配置按错误说明补齐，不让模型拼同伴编号或传递同伴码。校园卡查询密码配置项为 `tyys_card_password`；同伴账号是 `tyys_buddy_username / tyys_buddy_password`，多人使用 `_2` 等后缀，密码不通过命令参数传入。

用户有费用上限时加 `--max-fee 金额`。实际价格在建单后返回；超预算或缺查询密码会保留未支付订单并返回 pending-payment，附金额与可取得的有效期。免费订单也要完成零元确认。booked、already-booked 才能说约上；pending-payment、unknown 都不能说预约完成，也不要重启命令盲目重复下单。

order cancel 不自动取消收费预约；cancelled、already-cancelled 才算确认取消。recovered-previous-operation 表示只回查了上次操作，本次未创建订单或再次付款，直接转述已有订单状态。unknown 表示写入可能已执行但无法确认，提示到 App 核对。遇到 rate-limited 本次停止，不连续重新调用。

首次环境准备使用 `tyys venue setup`，检查用 `tyys venue check`；两者只处理本地 Python 和识别模型。普通查询不依赖识别环境，正常预约不临时下载模型。
