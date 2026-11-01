# 实验课模块

CLI 用法：[references/lab.md](../../references/lab.md)。`index.ts` 负责会话、课表、报告成绩与单次选退课，`cli.ts` 负责参数和输出。

单次选课由 `LabCourse.select` 核对实验、周次与容量，写前记录 journal，提交后按班次、周次、课程和学期回查。退选只移除本人指定记录并核对其他记录保留。底层 `submitSelection` 只发一次写请求，调用前必须校验目标。

## 站点与会话

- 站点：http://10.203.16.55:86/lab-course/selectCourse（86 = Vue SPA 静态页；**API 在 http://10.203.16.55:8098/lab-course/api/***）
- 声明：`auth=own network=campus writes=true`。校内 IP，直连或经 WebVPN（重写为 `http-8098/<enc(ip)>`，WebVPN 实测可用）。

- 代码：`lib/lab/index.ts` · CLI：`zju lab …` · token：`data/sessions/lab-course.json`（JWT 48h，失效自动重登）。
- 2026-09-18 从 SPA app.js（`/lab-course/static/js/app.8c92160a63da249c5050.js`）逆向 + 本人账号实测。

## 协议（每个请求都要签名）

```
POST /api/login  {username, password}                    # 唯一不带 Authorization 的请求
→ {code:200, data:{token:{access_token:JWT, token_type:"bearer"}, name, role, roles[]}}
```

- 之后每个请求带 `Authorization: bearer <access_token>`。
- 每个请求（GET/POST）都混入三个公共参数：`app_key`、`timestamp`（毫秒）、`sign`。
  GET 时全部进 query，POST 时全部进表单体（`application/x-www-form-urlencoded`），空值不传。
- **sign = md5(secret + path + 按参数名排序的 k+v（跳过空值和对象值） + timestamp + " " + secret)**，hex 小写。
  `path` 是 `/api/...`（不含域名）；`secret`、`app_key` 是前端混淆常量（base64→hex）解码所得，写死在 `lib/lab/index.ts`：
  - `APP_KEY  = eb8c68399de7483abb2d8abaea0d039f`（源串 `["==wn","D0g6","6qYL7","qDSn3","ZOox4","6"]` 反转后 base64 解码）
  - `APP_SECRET = 7cd476ab866b49d7a9788ad9f4789495`（源串 `["fNR","2q4Z","rSde","peIr","Z9H","iUlQ","=","="]` 拼接 base64 解码）
- 响应信封 `{code, message, data}`：`200` 成功；`401` 无权限；`408` token 失效（前端跳登录，模块自动重登一次）；其它按业务拒绝报 message。
- JWT payload：`{role:"1", userid, exp, nbf}`，有效期 48 小时。
- 多角色：登录返回 `roles[]` 长度 >1 时前端让用户选角色再调 `POST /api/change_role {roles:roleId, username}` 换发 token。学生角色 `id=1`，模块默认自动切学生。

⚠️ 签名时间戳必须与发送的 `timestamp` **同一个值**（毫秒）。`Date.parse(new Date())` 是秒级截断，会得到 401——探测时踩过。

## 端点（原有端点 2026-09-18 核对；报告成绩 2026-11-01 核对）

| 短名 | 方法+路径 | 参数 | 返回 data |
|---|---|---|---|
| login | POST `/api/login` | username, password | token/name/role/roles |
| change_role | POST `/api/change_role` | roles( roleId ), username | 同 login（新 token） |
| terms | GET `/api/terms` | — | `{content:[{id,name,currentTerm,stadate,enddate}]}`，currentTerm=1 是当前 |
| my-courses | GET `/api/courses/uid` | page=-1, size=-1, termId, uid | 课程数组 `{id, courseName:"大学物理实验周四上午", count:14, week:4, time:1, startDate, endDate}` |
| labs | GET `/api/courseId/{courseId}/course/labs` | — | 班次数组 `{id=courseLabId, labName, contain 容量, counts 已选, openWeek, teacherName, address, times, week, time, isMust}` |
| week-status | GET `/api/course/labs/status` | termId, studentUid | `{"班次id_周次段": 人数}`，只含有人的（1785 键里没有 5671 = 该班次还没人选） |
| my-selections | GET `/api/course/lab/students` | termId, uid | `{content:[{id=记录id, courseLabId, selectWeek, ...}]}` |
| report-grades | GET `/api/teacher/evaluates/studentfull` | termId, uid | 学生端“查看成绩”的数组：`course_name, lab_name, teacher_name, select_week, score`；score 为数字字符串或 null；`myGrades` 只保留展示字段，转数值并按课程/序号排序 |
| **select（写）** | POST `/api/course/lab/students` | courseId, courseLabId, uid, termId, selectWeek | 选课成功（前端 alert"选课完成"） |
| **cancel（写）** | POST `/api/course/lab/students/del/{记录id}` | — | 退选成功 |
| open-status | GET `/api/course/open_status` | — | `{openstatus:[{termId, courseName, count 每课上限, startDate, endDate(毫秒), week, time, isTest, isPenTest}]}`（150 条，含历史学期） |
| notices | GET `/api/notices/student` | uid | `[{id, title, content(HTML), gmtCreate}]` |
| msg | GET `/api/msg`；POST `/api/msg/read` | uid | 站内消息（未接） |
| my-info | GET `/api/uid/{uid}/students` | — | 个人资料；**含 password 字段（哈希），模块已剥掉** |
| timetable | GET `/api/course/lab/students/full` | termId, uid, courseId, page=-1, size=-1 | 网页“我的课表”：`{content:[{id=courseLabId, lab_name, address, times, teacher_name, select_week, dates, course_name, …}]}`；行内含电话等个人字段，CLI 只输出日期/时间/实验/实验室/教师/序号 |
| lab-dates | GET `/api/courseLabTimes/date` | courseId | `{"班次id_周次段": "YYYY-MM-DD\n…"}`；timetable 行缺 dates 时补用 |

`/api/courses/student_full` 不是“我的课表”（2026-09-24 本人账号返回 []），不要用它判断排课。

报告分不能读 `/api/course/lab/students` 或未加 evaluate 的 `/full` 里的 `total_score/final_score`，它们不关联报告评分。成绩接口的 `score=null` 只表示未出分，不据此判断报告是否提交；零分必须保留，异常响应或非法分数报 BAD_RESPONSE。`/api/course/students/score` 是整门课总评，不属于本次报告成绩查询。

## 已知坑

- API 是 **HTTP 明文**（校内网），WebVPN 重写时端口进路径（`http-8098`）。
- 86 端口的 SPA 只是壳，**直接打 8098 的 API**，没有验证码/Referer 检查，签名对了就放行。
- `weekStatus` 只返回已有人选的班次周次；`taken=0` 不代表键存在。
- 前端把用户/角色等存 localStorage 并用自有 AES 加密（key `c1h2i5n6g2o2k4a7`，iv `C2H3I4N5G2O3K1E4`），与本模块无关（我们不走 localStorage）。
