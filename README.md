# ZJU Skill

面向 AI 助手的浙江大学校园系统工具，也可直接通过命令行使用。本项目是独立社区项目，与学校官方应用无隶属关系。

AI 入口为 [SKILL.md](SKILL.md)，全部命令见 [命令总表](references/commands.md)。命令内部处理认证、匹配、分页、下载与必要回查，业务对象优先按名称指定。

## 能力

| 系统 | 能力 |
|---|---|
| 教务与实验课 | 课表、考试、成绩绩点、学籍、培养方案、实验报告成绩、教学班与余量、单次选退课和志愿排序 |
| 学在浙大 | 待办、课程章节、课件与作业附件、作业记录与提交、学在签到和历史 |
| 体艺 | 只读考勤状态与历史；场馆空场、须知、普通预约、验证码、同伴、付款、订单与取消 |
| 通知、素质拓展、电子书 | 校级和学院通知、二三四课堂记点与活动、报名收藏、电子书平台入口 |
| PTA、超星、智云 | PTA 作业与作答；超星课件和视频；智云资源、字幕、课堂实时文字、本地转写 |
| CC98、查老师、知网 | 论坛查询与用户授权互动、教师评价、中文文献检索和下载 |
| 浙大邮箱 | 邮件列表、正文和附件下载，查信读信不改未读状态；预览后确认的发信与回复 |
| 文档 | PDF/Office 转文字、图片和 Word 转 PDF、合并、取页、找页、取图与渲染 |

## 安装

需要 Node.js 24 LTS（最低 22.13）、Git 与 npm。

```sh
git clone https://github.com/Anchorite-no/zju-skill-public.git
cd zju-skill-public
npm ci
node scripts/zju.ts profile init
```

编辑生成的 profile.env，仅填需要使用的账号。统一认证、WebVPN、CC98、PTA、超星、浙大邮箱和实验平台的凭据各自独立；模板见 [profile.env.example](profile.env.example)。不要提交账号、会话或下载材料。

```sh
node scripts/zju.ts --help
node scripts/zju.ts zdbk timetable
node scripts/zju.ts lab grades
node scripts/zju.ts xuezai todos
node scripts/zju.ts tyys venue list
```

把仓库作为 zju 放入助手的技能目录，或建立指向仓库的符号链接。助手按 SKILL.md 调用 node <SKILL>/scripts/zju.ts。Python、FFmpeg、文档处理或验证码识别依赖由相应模块的 setup/check 管理，普通查询无需安装全部组件。

## 普通场馆预约

明确目标后直接调用 tyys venue book。命令检查一次当前空场；有空场时完成预下单、同伴校验、验证码、提交、付款或零元确认及回查。未放号、无空场或场地被占用时返回结果，不等待或反复抢占。完整用法见 [体艺](references/tyys.md)。

## 写操作与数据

写操作须有当前任务授权，通常还需环境变量 ZJU_ALLOW_WRITE=1 和 --confirm；CC98 日签只需 --confirm。选课、作业、开考、交卷和付款分别表达各自授权。失败应读取完整错误；结果不明时按回查状态处理，不能把请求发出等同于完成。

配置在 profile.env，运行数据默认 data/；可用 ZJU_PROFILE 和 ZJU_DATA_DIR 更改位置。智云可按 [说明](references/zhiyun.md) 配置用户自己的远程执行机。模型处理的课程资料、论坛内容和个人信息遵守对应平台与权利人的规则。

## 开发与许可

运行 npm run typecheck，更新命令后用 node scripts/command-docs.ts 生成命令表。开发约定见 [AGENTS.md](AGENTS.md)，职责见 [架构](dev/architecture.md)，验证范围见 [状态](dev/PLAN.md)。

项目自有代码采用 [GNU GPL v3（仅限第 3 版）](LICENSE)，SPDX 标识为 `GPL-3.0-only`。使用、修改与再分发须遵循该许可证；分发修改版时按 GPL 提供对应源码并保留许可。第三方代码、依赖和模型保留各自的许可，来源及声明见 [第三方声明](THIRD_PARTY_NOTICES.md)。
