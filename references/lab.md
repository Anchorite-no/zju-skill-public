# 实验课选课平台（浙江大学实验选课系统）

## 命令

```text
lab
├─ timetable                 我的实验课表：哪天做什么实验、在哪个实验室
├─ grades                    每次实验报告的分数与出分状态
├─ courses                   我的实验课和选课开放时间
├─ labs --course             一门课的全部实验与还能选的周次
├─ selected                  我已选的实验
├─ select                    单次选课（--cancel 是退）
├─ notices                   平台公告
└─ session                   排障用
```

| 用户目标 | 命令 | 结果 |
|---|---|---|
| 实验课哪天做什么、在哪 | `timetable` | 按日期列出实验名、实验室、开始时间、教师，附 currentTime |
| 每次实验报告多少分、哪些没出分 | `grades`，往期加 `--term 学期名` | reports 按课程和实验序号排列，含 course、experiment、teacher、sequence、score、status；gradedCount / pendingCount 分别为已评分、未出分项数 |
| 实验什么时候开选、能选几个 | `courses` | 每门实验课的星期、上午或下午、可选个数上限 limit、已选个数、selectionOpens / selectionCloses |
| 还有哪些实验能选 | `labs --course 大学物理实验` | 每个实验的教师、实验室、容量、已选人数；availableWeeks 已排除本人已选、周次冲突和满员，选不了的在 unavailableReason 写原因；message 是总体结论 |
| 我选了哪些实验 | `selected` | 实验名、教师、实验室、实验序号 week、上课日期 dates |
| 选一个实验 | `select --course 课程名 --lab 实验名 --week 序号 --confirm` | 先查容量，满员不提交；选后回查 |
| 退一个实验 | 同一个命令加 `--cancel`：`select --course 课程名 --lab 实验名 --cancel --confirm` | 按名称定位本人已选的那一项，退后回查 |

课程、实验都写名称，不需要任何编号；查往期加 `--term 2025-2026春夏`。时间都是北京时间。

- 账号：平台本地账号，默认同学号（`lab_username` 不填回退 `zju_username`）；密码在 `profile.env` 的 `lab_password`。
- **week 是实验序号，不是校历周**：平台把绪论课之后的每次实验依次编号，两周的实验写成 `5,6`。选课时取 `labs` 结果里 availableWeeks 的 week 原样填写；实际日期看 `timetable` 或 `selected` 的 dates。
- limit 是这门课一共要选的实验个数（如 14）；`required: true` 的是必做实验。
- `grades` 查每次实验的报告分（0–100），不是整门课程总评。`score: null` / `status: 未出分` 不代表没交报告，零分仍是已评分；学期没有记录会明确说明。

单次选实验使用 `lab select --course 课程名 --lab 实验名 --week 序号 --confirm`，退选加 `--cancel`。查询、选择与回查由命令内部完成；不设置计划、等待开放或重复抢课。

学期、课程、班次、课表、通知和人数数据缺失或格式异常时返回 BAD_RESPONSE，不当作空结果；默认学期要求唯一 currentTerm 标记。select（含 --cancel）在创建连接前检查写闸。
