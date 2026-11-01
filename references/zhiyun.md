# 智云课堂

查询用 `zhiyun search`，下载用 `zhiyun download`，音频转写和课件提取用 `zhiyun trans audio/ppt`。业务命令自动处理认证，`zhiyun session` 仅用于会话排障。完整参数见各命令的 `--help` 或 [命令总表](commands.md#zhiyun)。

## 查询与下载

```text
zhiyun
├─ search    courses · lessons · resources · subtitles   找课、看课次与资源、搜字幕
├─ download                                              下载回放、音频、课件、截图、字幕
├─ live      start · status · stop · text                上课时的实时字幕
├─ trans     audio · ppt                                 本地录音转写、课件提取
├─ setup · check                                         本地依赖
└─ session                                               排障用
```

课程写名称，可用简称（计组）；课次写第几次（`--lesson 1`、`--lesson 1,3-5`）或日期（`--date 2026-09-28`），也可 `--week-of 日期` 取那一周、`--all` 取全部，四种只给一种。智云录播对全校开放：课程名先在我的课程里找，没有再搜全站，没选的课也能查。

- 同名课程有多位教师时加 `--teacher 教师名`。同一门课开过多个学期时默认取当前学期的；当前学期没开就取最近一次开的，不取还没开始的学期。结果开头写明取的是哪位教师、哪个学期，默认取过时带 note。要别的学期：`search courses --keyword 课程名` 找到那一门，把它的 courseId 写到 `--course`。
- `search courses --keyword 课程名` 返回课程、教师、学期（如 2026-2027秋冬）。scope 为 all 表示这些课不是用户选的。
- `search lessons --course 课程名` 列出每次课：lesson（第几次）、date、time、能否回放 playable、有哪些资源 kinds。编号按开课时间，含还没上的。
- `search resources --course 课程名 --lesson 1` 看某次课有什么：回放视频（带地址与清晰度）、音频、课件、课堂截图张数、字幕句数。只是查看；要文件用 download，不是下载的前置步骤。
- `search subtitles --course 课程名 --keyword "点名、签到、考勤"` 在录播字幕里搜老师说过的话（点名、考试范围、作业要求等），几个说法用顿号或竖线分隔；省略课次时搜全部有录像的课次。每处命中给出第几次课、日期、时间点和前后各一句；字幕里的「点名」可能是叫人回答问题，按前后文判断。当天的课课后才有字幕，列在 lessonsWithoutCaptions。不用先下载字幕再自己搜。
- `download --course 课程名 --lesson 1 --kind ppt` 下载并返回 `files`：每个文件的课次、日期、种类、本地路径和大小；没有该类资源的课次列在 `skipped`。kind 支持 video,audio,ppt,slides,subtitles，默认 ppt，可逗号分隔多种。视频取 1080p；只要音频时用独立音轨或 360p 视频提取。`--dry-run` 只列出将下载什么。可指定 `--audio-format`、`--out-dir`；并发、超时、重试和续传由内部处理，下载过的文件校验后复用。

## 课堂实时文字

`zhiyun live start` 后台采集今天本人剩余课堂的官方字幕，自动等待开课、按课次切换，最后一节结束后退出；只听一门课可加 `--course 课程名`。用普通前台终端调用，命令自行启动后台并立即返回状态，随后直接回答；命令返回后采集继续，重复启动同范围复用任务。执行机需要保持在线，启动成功不等于已收到字幕。

`zhiyun live text` 返回刚才五分钟的已保存文字。指定课程加 `--course`；指定时刻用 `--at "2026-09-30 13:40"` 或 `--at 13:40`，可用 `--before 300 --after 300` 调整前后秒数。未来部分由命令内部等待；多个课次有歧义时返回候选。晚启动或断线造成的缺失会直接说明；preview 是尚未定稿的文字，不能当作多次独立发言。

查看采集用 `zhiyun live status`，停止用 `zhiyun live stop`。停止保留已保存字幕；查询文字不会自动启动监听或补回此前内容。live start 只采集文字，不提交签到。当前没有自动音频转写兜底。

这些命令与其他智云命令一样统一远程执行。文字内嵌在结果中，file/directory 是执行机上的持续采集文件，status/text 不把整个增长目录复制回调用端。

## 转写与课件提取

```powershell
node scripts/zju.ts zhiyun trans audio --file 录音.m4a --out-dir data/output/audio-text
node scripts/zju.ts zhiyun trans ppt --file 课件.pptx --out-dir data/output/ppt-text
```

**音频**：接受 FFmpeg 可读取的本地音视频，转换为 16 kHz 单声道 WAV 后转写。日常转写固定使用默认 SenseVoice、自动设备和内部批量设置；out-dir 可省略，由脚本生成。返回的 `markdown` 指向带时间的 `transcript.md`，`text/segments/raw/metadata` 保留文字与原始结果。输入、模型环境、批量参数和缓存均匹配时复用；补充 Markdown 不重跑 ASR。

**课件**：接受 PPTX、PDF、DOCX、UTF-8 文本和常见图片，提取已有文字与原图，返回 `markdown/json/status/pageCount/imageCount`。`no_text` 表示需要看图或原件；`unsupported` 表示格式或依赖限制。当前没有 OCR。PPTX 按实际页序导出内嵌位图，位图可能只是页面局部，不能当作完整幻灯片渲染。

完全重复图片只存一份，保留每页引用；近似图以 `similarTo` 标记并保留双方原图，不自动合并页面。`imageCount` 是图片引用数，`uniqueImageCount` 是实际文件数。缺少 Pillow 时仅按字节去重，`visualDedup=false`；扫描 PDF 保留原件链接。源文件、提取脚本和输出均未变时复用缓存，人工修改的 Markdown 不覆盖。

整理课堂笔记时，读取转写、课件和原图，按 [笔记模板](zhiyun-notes-template.md) 直接成稿。核对作业、日期、公式和老师更正，保留原始粗稿；用户已有改稿时另存版本。已有转写和提取结果直接读取，无需重复处理。

## 依赖检查

日常转写的运行策略由执行机配置：ZJU_ASR_ENGINE（默认 sensevoice）、ZJU_ASR_DEVICE（默认 auto）、ZJU_ASR_BATCH_SECONDS（默认 60）。这些不是要求模型选择的任务参数。out-dir 省略时仍生成本地输出位置；远程执行会自动映射并取回产物。

缺少组件或排障时使用 `zhiyun check --component asr|media|ppt`，按结果调用 `zhiyun setup` 安装所需组件。默认检查 asr；media 检查 FFmpeg，ppt 检查文档提取依赖。只处理课件时用 `setup --component ppt`，无需 ASR 权重。检查、转写和课件提取不需要校园登录。

## 可选远程执行

运行环境中的 `ZJU_ZHIYUN_REMOTE=<SSH别名或user@host>` 与 `ZJU_ZHIYUN_REMOTE_ROOT=<仓库绝对路径>` 可将智云命令交给另一台执行机；未配置时本地执行。当前执行端为 Windows PowerShell，调用端支持 Linux 和 Windows。可选 `ZJU_ZHIYUN_REMOTE_NODE`、`ZJU_ZHIYUN_REMOTE_KEY`、`ZJU_ZHIYUN_REMOTE_PORT` 指定 Node、私钥和端口；默认 Node 命令为 `node`，端口 22。执行机须在线，并已配置免密 SSH、可信主机密钥及自己的 Profile 和依赖。

- 原有命令与参数保持不变；CLI 自动传输文件和回传产物，每次业务命令只远程执行一次（输入副本失效时在命令开始前就退回重传，不算执行）。文件传输用 SFTP，连接中断时自动从已传部分续传（最多 4 次）。
- `--file` 使用调用端文件并自动上传；明确的 Windows 绝对输入路径也可引用执行机文件。上传的副本放在执行机的 `data/cache/remote-input/`，同一文件通过两端哈希校验后复用；两周没用过的副本自动清理，被清理或改动过的在下次使用时自动重新上传。
- `--out/--out-dir` 指调用端输出位置；默认下载回到 `data/output/zhiyun/remote/<目标哈希>/`。原图、目录结构和 Markdown 链接一起回传，返回的业务文件路径可在调用端直接读取。
- 检查、安装和会话命令只回传结果，不复制模型、可执行文件或凭据。调用端已修改的文件拒绝覆盖；传输失败保留错误信封和非零退出码。
- 网络中断或取消不自动重发业务命令。重试前先确认原任务已结束；执行机副本与结果保留用于缓存，调用端映射保存在 `data/cache/zhiyun-remote/`。
