# 文档转文字 内部实现

模型的基本能力：任何模块下载到的 PDF、Word、PPT、Excel 都用 `zju doc text` 转成文字，参数见 [命令总表](../../references/commands.md#doc)。模型不再自行安装解析库或编写下载脚本。

| 文件 | 职责 |
|---|---|
| `index.ts` | 受管 Python 环境、调用提取脚本、链接下载与文件命名、Markdown 落盘 |
| `cli.ts` | `doc text / check / setup` |
| `../../scripts/doc/extract.py` | 各格式提取，输出一行 JSON |

## 依赖

- Python 包 `pypdf`、`openpyxl`、`xlrd`、`olefile` 装在 `data/tools/doc/.venv`（`zju doc setup`；`ZJU_DOC_PYTHON` 可指定解释器）。
- DOC、RTF、ODT、WPS、ODS 用 LibreOffice 无头转换为 DOCX/XLSX 再提取；每次转换使用独立的用户配置目录，避免并发冲突。`ZJU_SOFFICE` 可指定路径。服务器已装 `libreoffice-{writer,calc}-nogui` 与 `python3-venv`。
- 演示文稿不经 LibreOffice：Ubuntu 22.04 的 LibreOffice 7.3 Impress 在无头模式下转换 PPTX/PPT 会在 libsdlo 内崩溃（Signal 6），装 Draw、换全新配置目录都无效；catdoc 的 catppt 对常见样例报 Bad BBD entry。PPT/PPS/DPS 改用 olefile 读「PowerPoint Document」流的 TextCharsAtom/TextBytesAtom，按 SlideListWithText 的 SlidePersistAtom 与各 Slide 容器分页；ODP 直接读 content.xml。
- 在本机执行，不经智云的远程执行机；智云 `zhiyun trans ppt` 仍负责课件的文字与原图提取。

## 提取

- 先按文件头判断真实格式（PDF、ZIP 内的 word/ppt/xl、OLE 复合文档、HTML），扩展名与内容不符时按真实格式处理并返回 declaredFormat。
- PDF 逐页取文字层；DOCX 按正文顺序取段落与表格（单元格以 ` | ` 分隔）；PPTX 按演示顺序逐页；PPT 按页取文字记录；XLSX/XLS 每个工作表一页，行内单元格以 ` | ` 分隔；HTML 去掉脚本样式后按块换行；文本按 UTF-8 → GB18030 解码。
- 不做 OCR：扫描版 PDF、纯图片课件返回 `no_text`。提取文字上限 16 MiB。

## 链接下载

- `zdbk.zju.edu.cn` 用教务网会话（`openZdbk`），因为通知附件需要登录；其余 `*.zju.edu.cn` 与 `cc98.org` 经 WebVPN；其他主机直连。单个文件受 HttpClient 16 MiB 缓冲上限约束。
- 文件名取 `Content-Disposition`（`filename*` 优先，按 UTF-8 或 GB18030 还原字节），否则取 URL 末段；缺扩展名时按 Content-Type 补。
- 下载文件与全文 Markdown 存在 `data/output/doc/<链接或路径哈希>/`，结果内联前 2 万字，更长时标 `truncated`。

## PDF 处理（pdf / pages / find）

`scripts/doc/pdf_tool.py` 改自机主的交互式工具 `D:/Code/Projects/pdf_tool/pdf_tool.py`（D:/Code 提交 c5b0793，原件未改）。原样复制的版本见本仓库提交「copy pdf_tool.py unchanged」，改造差异可直接 diff。

- 保留：图片按 EXIF 转正、转 RGB、A4 模式等比缩放居中贴到白页（1240×1754）；合并用 pypdf `PdfWriter.append`；取页用原来的「1,3-5」规则，按页序去重排序。
- 改动：去掉 questionary 菜单、配色和“工作文件夹”，改为参数调用、输出一行 JSON；三种输入（图片、PDF、Word）合成一个命令 `doc pdf`，按给出的顺序排页。A4 画布改按 150 dpi 保存，页面是真实 A4（原来 100 dpi，页面是 A4 的 1.5 倍）；原图模式仍按 100 dpi。取页规则遇到越界、倒序或无法解析的片段直接报错（原来静默丢掉），避免取错页。
- Word 转 PDF 由 Word COM 改为 LibreOffice 无头转换（复用 extract.py 的 `convert`，每次独立配置目录）；输入格式按文件头判断，图片以 Pillow 能否打开为准。PDF 转 Word 依赖 Microsoft Word，没有迁移。
- 新增 `find`：pypdf 逐页取文字，列出含关键词的页和前后约 90 字；扫描件没有文字层时 textPages 为 0。437 页的 OCR 课本约 12 秒。
- 取页改用 PyMuPDF `insert_pdf` 并 `garbage=4` 回收，只带走这些页实际引用的字体和图片，高亮等批注保留；pypdf `add_page` 会连带整本书共享的资源（1049 页课本取 5 页为 34.7 MB，改后 158 KB）。未装 PyMuPDF 时退回 pypdf。
- 输出默认 `data/output/doc/<输入哈希>/`：合成为「首个文件名.pdf」或「首个文件名等N个文件.pdf」，取页为「原名_第…页.pdf」；`--out` 指定时不覆盖已有文件。
- 依赖：Pillow、PyMuPDF 与 pypdf 同装在 `data/tools/doc/.venv`；pillow-heif 装了才支持 HEIC，默认不装。

## 取图与渲染（images / render）

来自助手在服务器上自写的 document-asset-delivery 技能里的 `pdf_assets.py`（2026-09-29 迁入本模块，原技能删除）。用 PyMuPDF：

- `images`：`page.get_images(full=True)` + `doc.extract_image(xref)` 取嵌入的原图，不经渲染，同一 xref 只取一次，小于 2 万像素的（图标、项目符号、logo）跳过并计数，结果按像素从大到小。一页常有纸纹底图、页眉色块、水印，底纹往往像素最大，真正的素材反而更小，所以交付前要看一眼。页面是矢量绘制时没有嵌入图，改用 render。
- `render`：`page.get_pixmap(dpi)` 渲染整页 PNG，dpi 50–300，默认 150，一次最多 30 页；扫描书 150 dpi 一页约 300 KB。
- 输出按「输入 + 页码 + dpi」哈希存到 `data/output/doc/<哈希>/images|render/`，文件名带页码、xref 和尺寸，便于回查。
