# ZJU Skill

面向 AI 助手的浙江大学校园系统工具，也可直接通过命令行使用。本项目是独立社区项目，与学校官方应用无隶属关系。

AI 入口为 [SKILL.md](SKILL.md)，全部命令见 [命令总表](references/commands.md)。命令内部处理认证、匹配、分页、下载与必要回查，业务对象优先按名称指定。

## 能力

| 系统 | 能力 |
|---|---|
| 教务与实验课 | 课表、考试、成绩绩点、学籍、培养方案、实验报告成绩、教学班与余量、单次选退课和志愿排序 |
| 学在浙大 | 待办、课程章节、课件与作业附件、作业记录与提交、点名记录（只读） |
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
node scripts/zju.ts profile init --system zju
node scripts/zju.ts profile init --system webvpn
```

在交互终端按提示输入账号和密码，密码不回显。其他系统用 `profile init --system cc98|pta|chaoxing|mail|lab|tyys|buddy` 选择其一；CC98 多账号加 `--index 2`。各系统凭据独立，`profile show` 只显示密码是否已配置。自动化程序可以通过 `profile init --stdin` 传入配置 JSON，不要把密码放在命令参数或聊天里。

账号以 AES-256-GCM 密文保存，加密密钥保存在 Windows 凭据管理器、macOS 钥匙串或 Linux Secret Service。旧 `profile.env` 首次读取时原子迁移，文件名保持不变，不生成明文备份；迁移后不要手工编辑它。系统凭据库不可用时直接报错。详见 [凭据与发布安全](SECURITY.md)。

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

加密配置在 `profile.env`，运行数据默认 `data/`；可用 `ZJU_PROFILE` 和 `ZJU_DATA_DIR` 更改位置。进程环境变量仍可临时覆盖账号，`.env` 只用于非秘密运行设置。学院与访问方式等用 `profile init --college 学院全称 --transport webvpn` 修改。智云可按 [说明](references/zhiyun.md) 配置用户自己的远程执行机。模型处理的课程资料、论坛内容和个人信息遵守对应平台与权利人的规则。

## 开发与许可

运行 `npm run typecheck` 与 `npm run security`；更新命令后用 `node scripts/command-docs.ts` 生成命令表。使用 `npm pack` 打包时会检查实际文件清单，拒绝开发资料、账号与会话数据。

项目自有代码采用 [GNU GPL v3（仅限第 3 版）](LICENSE)，SPDX 标识为 `GPL-3.0-only`。使用、修改与再分发须遵循该许可证；分发修改版时按 GPL 提供对应源码并保留许可。第三方代码、依赖和模型保留各自的许可，来源及声明见 [第三方声明](THIRD_PARTY_NOTICES.md)。
