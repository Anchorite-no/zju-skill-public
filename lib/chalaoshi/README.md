# 查老师 请求与协议

CLI 用法见 [查老师](../../references/chalaoshi.md)。本文件记录实际请求、端点和内部实现，供开发和排障使用。

- 声明：`auth=none network=public writes=false`。无需登录。

- 域名变动看 https://github.com/zjuchalaoshi/chalaoshi （README「当前域名」）。

## 查表 vs 直连：站点没有搜索接口

首页搜索框是纯前端：把 `/static/json/search.json` 整个下载后在浏览器里过滤。**服务端不存在搜索 API**（`/search`、`/api/search` 都 404）。所以本模块也是查表：

| | 首次 | 之后 |
|---|---|---|
| 下载索引 `GET /static/json/search.json` | 1.7–3.0 s，1.07 MB，10295 位教师 + 50 个学院 | 缓存 7 天；过期后条件 GET（`ETag`/`Last-Modified`，服务端 `Cache-Control: max-age=31536000`，内容 2026-09-13 更新） |
| 本地过滤 | — | **< 1 ms** |
| 教师详情页 `GET /teacher/{id}/` | 0.5–1.8 s | 每次实取（有评分人数、点名率、各课绩点、评论数） |

搜索是**线性扫描**：10295 条约 0.15 ms，读+解析 1 MB 缓存约 6 ms，整条命令离线约 0.1 s，不需要建索引。排序是打分制：

| 匹配方式 | 分 |
|---|---|
| 姓名完全相等 / 全拼完全相等 | 100 / 90 |
| 姓名前缀 / 首字母完全相等 | 80 / 70 |
| 姓名子串（含外教英文名） | 60 |
| 全拼前缀（≥4 字母 55，否则 45）/ 首字母前缀 | 55–45 / 40 |
| 姓名跳字（"王辉" ⊂ "王伟辉"，≥2 汉字）/ 全拼子串 | 30 / 25 |

再加小额加成：有评分 +3，评分高 +0–2，人气 +0–3（同档时把好老师排前）。

## 端点（2026-09-17 实测）

| 短名 | 路径 | 返回 |
|---|---|---|
| index | `GET https://chalaoshi.de/static/json/search.json` | `{colleges:[{id,name}], teachers:[…]}` |
| teacher | `GET https://chalaoshi.de/teacher/{id}/`（`/t/{id}/` 同） | HTML：`<title>X老师 9.39分 422人打分</title>`，`<div class="teacher">` 里姓名/学校/学院/`NN%的人认为该老师会点名`，`<h2>评分</h2><p>N人参与评分</p>`，`<p class="course_name">课程</p>…<p>绩点/人数</p>`，`N个评论` |
| name | `GET /tn?name=王伟` | HTML 同名列表（学院 + 评分），点击跳 `/t/{id}/`。脚本用本地索引代替 |
| comments | `GET https://api.chalaoshi.de/comments/{id}?sort=rate\|time` | HTML，**全部评论一次返回**（毕惟红 354 条 220 KB），每条 `<div class="hidden" id="comment-page">` 含正文、`like_{cid}`、点赞数、`发布于 YYYY.MM.DD`。`sort=rate` 人气（站点默认）、`time` 最新；`hot` 是 400 |
| gpa | `GET https://api.chalaoshi.de/gpa?course=课程名` | HTML 表：教该课的所有老师 `姓名 / 绩点±标准差 / 人数`（课否数据）。课程名要和页面写法一致（全角括号、罗马数字） |
| kefou | `GET /kefou?name=姓名&sort=length` | 课否公众号评论页，未接 |
| rate / captcha | `POST /teacher/{id}/rate`、`api /captcha/*`、`/comment/*` | 写操作，需极验验证码，**不实现** |
