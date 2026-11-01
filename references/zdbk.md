# 本科教学管理信息服务平台（zdbk.zju.edu.cn，正方 jwglxt）

## 命令

```text
zdbk
├─ timetable                        课表
├─ exams                            考试安排
├─ grades                           成绩与绩点
├─ student                          本人学籍
├─ plan       view · list           培养方案
├─ selection  context · courses · search · sections · selected · credits · select · reorder · drop
└─ session    login · status · logout   排障用
```

| 用户目标 | 命令 | 结果 |
|---|---|---|
| 课表、下节课、教室 | `timetable`，其他学期加 `--year 2026-2027 --term 秋`（秋、冬、春、夏、短、暑） | 每门课的教师、星期、节次、起止时间、周次、教室，附当前北京时间 |
| 考试时间、考场、座位 | `exams`，可加 `--course 课程名` | 每门课的 midterm、final：`status` 为 未公布 或 已公布；已公布时有 date、startTime、endTime，考场和座位号公布后才有 location、seat |
| 成绩、绩点、学分 | `grades` | 全部课程成绩，总体、各学期、主修绩点，已获学分 |
| 我的学号、学院、专业、班级 | `student` | 学号、姓名、学院、专业、行政班；研究生不在本科教务网，查不到 |
| 我的培养方案 | `plan view`；别的专业加 `--major 专业名`，别的年级加 `--year 2024` | 学分、学位、核心课，完整 PDF 存到 `file`，再用 `doc text --file` 读各学期课程 |
| 某学院有哪些专业的培养方案 | `plan list --college 学院名`，可加 `--major`、`--year` | 专业、学院、学分、学位、学制 |

选课命令见 [选课](zdbk-selection.md)。教务通知见 [通知](notice.md)，不在本模块。

## 已知坑

- 课表按账号、查询学年学期缓存，6 小时内且北京时间未跨日时直接读本地，不创建认证客户端或联网。过期自动重新获取，返回 cache.fetchedAt/expiresAt；刷新失败（登录、网络或页面异常）而 7 天内有缓存时返回旧缓存，标 `cache.stale=true`、`refreshError` 和可直接转述的 message，不再报错；本工具发起选退课写请求前使缓存失效。网页或其他客户端改课最多等到下一次自动刷新。
- 首次查询从课表页面读取默认学年学期，取表格课表，并读取同页面 `js/comp/jwglxt/xkgl/kbcx/xskbcx.js` 的 `arrKbjcsj` 起止时间；不额外预检 CAS 或课表开放状态。默认值跟随网页，指定其他学年学期用 year/term。
- CLI 返回数组名为 `data.courses`，不是上游原始 `kbList`；一次读取完整结果即可。上游缺少 kbList 或节次时间解析失败时返回 BAD_RESPONSE，不当成空课表，不猜时间。

- 常规选课已接入 `Xsxk`：查询、单教学班志愿提交、完整分组排序、直接退选与回查。使用方法和限制见 [选课](zdbk-selection.md)。写请求不自动重放。
- 普通选退课写请求不自动重放，提交后回查。补退选 `xsbtx` / `N253540` 尚未实现。

课表 CLI 输出 courses[].name/teacher/exam/meetings，每项上课安排含 weekday（1=周一）、periods、startTime/endTime（北京时间）、location、weeks、weekPattern；同时提供完整 periodTimes、实时 currentTime/currentWeekday 和来源链接。相同课程、地点和周次规则的连续节次合并。模型据此回答课表和下节课问题，无独立 next-class 命令。协议原字段与 table/list 仅供内部 API 使用。

## 个人考试安排

返回 courses[].name/term/credits，以及 midterm、final 两场考试。未公布的只有 `status: 未公布`，不能据此推断免考；已公布的有 date、startTime、endTime，考场 location 和座位号 seat 公布后才出现，没有就是还没出，不补猜。时间写法无法识别时原文放在 time。按期末日期排序；课程备注在 remarks。

## 成绩与绩点

- 评教闸：页面先 POST `xtgl/index_cxMyCosJxpj.html`，`result="1"` 表示本学期评教已完成；否则教务网不显示本学期成绩，CLI 返回 `evaluationPending`。
- 教务网不给平均绩点，CLI 按浙大发本〔2022〕24号自行计算 Σ(学分×绩点)/Σ学分：同一课程每次修读都计入；弃修（本科生院弃修通知：不计入绩点）、缓考、二级制合格不计入；缺考、无效、不及格用教务网给出的 0 绩点计入。GPA 保留三位小数。
- 输出 `summary`（gpa/gpaCredits/earnedCredits/courseCount）、`major`（主修数据已修课程的同规则绩点与课程名）、`terms[]`（year/term/gpa/gpaCredits/courses），课程含 grade/credits/gradePoint/inGpa，不计入时带 note。earnedCredits 按课程代码去重，只计及格的课。出国成绩单用的 4.3 分制（2022 级起）未实现。
