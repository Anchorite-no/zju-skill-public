# PTA 组件

`client.ts` 使用 `openContext` 的 own/public 组合，账号来自 Profile；复用 HttpClient/CookieJar 与 SessionStore。`query.ts` 只读当前用户作业，`answers.ts` 校验并转换答案，`write.ts` 负责写闸、日志、作业锁和未决回查，`cli.ts` 注册同一套 API。导入模块不会联网。

平台时间全部是 UTC（`…Z`）；`cli.ts` 的 withClient 在输出前用 core `beijingTimes` 统一换成北京时间，库函数和写流程内部仍按原 UTC 比较截止。PTA ID 保持字符串。平台题目集生命周期、是否作答、判题结果和是否主动结束是独立状态，不用列表里的 PENDING 代替作答进度。命令、答案输入格式和结果含义见 [PTA 参考](../../references/pta.md)；实际请求与端点见下。

登录走 `passport.pintia.cn/api/users/sessions`，身份探测走 `/api/u/current`；使用官方协议的 JSON、Origin/Referer 和客户端指纹头。请求按客户端串行，至少间隔 350ms。

## 名称定位与输出（2026-10-03）

- `view.ts` 负责把作业名、题号换成平台编号，并生成 CLI 的输出视图；题目集、小题、答题实例、提交四种编号不出现在公开参数里（提交详情的 `--id` 除外，它取自 `submission list`）。
- 小题状态列表里判断题的 `label` 为空（小题详情的 `examLabel` 才有 `1-1`）。题号规则与网页一致：「题型序号-组内序号」，题型序号是 `PROBLEM_TYPES` 里的位置加一（判断 1、单选 2、…、编程 7）；平台给了 label 的（`7-1`、`H-1`）直接用。
- 作业名先在未截止的题目集里匹配，再查全部；有整段匹配（前后不接字母数字）时只取整段匹配，避免 `HW1` 命中 `HW10`–`HW15`。
- 判断、选择、填空的提交是整组一条记录（`problemSetProblemId` 为 `0`），`submissionDetails` 与 `judgeResponseContents` 按小题一一对应；看单题时取这一题自己的对错与得分。
- 代码题提交后 `status` 先是等待中，CLI 每 2 秒读一次提交详情，最多 10 次。
- 客户端限速约 3 次/秒；每份作业的进度要两次请求，83 份历史作业全量扫描约 58 秒。

## 接口与验证范围

| 功能 | 当前官方端点 |
|---|---|
| 本人题目集 | GET `/api/problem-sets`，page/limit/filter/order_by/asc |
| 答题信息、显式开始 | GET / POST `/api/problem-sets/{set}/exams` |
| 小题详情 | GET `/api/problem-sets/{set}/exam-problems/{problem}` |
| 本人进度 | GET `/api/exams/{exam}/problem-sets/{set}/problem-status` |
| 最后答案、历史 | GET `/api/exams/{exam}/problem-sets/{set}/last-submissions`、`submissions` |
| 提交明细 | GET `/api/exams/{exam}/submissions/{submission}` |
| 小题/题型保存提交 | POST `/api/exams/{exam}/exam-submissions`，`problemType/details` |
| 代码草稿 | GET / POST `/api/problem-sets/problems/{problem}/exam-draft`，`answer.detail/saveAt` |
| 整份结束 | PUT `/api/exams/{exam}/end` |
