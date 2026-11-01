"""PDF 处理，输出一行 JSON。改自机主的交互式工具 D:/Code/Projects/pdf_tool/pdf_tool.py（D:/Code c5b0793）。

保留原工具的图片处理（按 EXIF 转正、转 RGB、可居中放到 A4 白纸）、PDF 合并与「1,3-5」取页规则；
去掉菜单、配色和工作文件夹，改为参数调用。Word 转 PDF 由 Word COM 改为 LibreOffice 无头转换
（技能跑在 Linux 服务器上）；PDF 转 Word 依赖 Microsoft Word，没有迁移。

  pdf_tool.py combine <输出.pdf> <a4|original> <输入>...   图片、PDF、Word 按顺序合成一个 PDF
  pdf_tool.py pages <pdf> <页码规则> <输出.pdf>             取出指定页另存
  pdf_tool.py find <pdf> <关键词>...                        列出含关键词的页
  pdf_tool.py images <pdf> <页码规则或空串> <输出目录>      取出嵌入的原始图片（PyMuPDF）
  pdf_tool.py render <pdf> <页码规则> <dpi> <输出目录>      把指定页渲染成 PNG（PyMuPDF）

images / render 来自助手在服务器上自写的 document-asset-delivery 技能的 pdf_assets.py（2026-09-29 迁入后删除该技能）。
"""
import io
import json
import shutil
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter

from extract import convert, pdf_text, sniff

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff", ".tif", ".gif"}
WORD_EXTS = {".doc", ".docx", ".odt", ".rtf", ".wps"}
# A4 at 150 dpi. The original saved this canvas at 100 dpi, which made each page 1.5 times A4.
A4_PIXELS, A4_DPI, ORIGINAL_DPI = (1240, 1754), 150.0, 100.0

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
    IMAGE_EXTS.add(".heic")
except ImportError:
    pass


def fit_image_to_a4(img):
    """将图片等比例缩放并居中粘贴到 A4 白纸上"""
    from PIL import Image

    a4_w, a4_h = A4_PIXELS
    a4_canvas = Image.new("RGB", (a4_w, a4_h), (255, 255, 255))
    if img.width / img.height > a4_w / a4_h:
        new_w, new_h = a4_w, int(a4_w / (img.width / img.height))
    else:
        new_w, new_h = int(a4_h * (img.width / img.height)), a4_h
    img_resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    a4_canvas.paste(img_resized, ((a4_w - new_w) // 2, (a4_h - new_h) // 2))
    return a4_canvas


def image_page(path, a4):
    """一张图片转成单页 PDF（内存中）"""
    from PIL import Image, ImageOps

    img = ImageOps.exif_transpose(Image.open(str(path)))
    if img.mode != "RGB":
        img = img.convert("RGB")
    if a4:
        img = fit_image_to_a4(img)
    page = io.BytesIO()
    img.save(page, "PDF", resolution=A4_DPI if a4 else ORIGINAL_DPI)
    page.seek(0)
    return page


def kind_of(file):
    """按文件头判断：pdf / word / image；其他返回 None"""
    kind = sniff(file, file.suffix.lower())
    if kind == ".pdf":
        return "pdf"
    if kind in WORD_EXTS:
        return "word"
    try:
        from PIL import Image
    except ImportError:
        if kind in IMAGE_EXTS:
            raise ValueError("图片转 PDF 需要 Pillow，运行 zju doc setup")
        return None
    try:
        with Image.open(file) as img:
            img.verify()
        return "image"
    except Exception:
        return None


def combine(out, size, inputs):
    if size not in ("a4", "original"):
        raise ValueError("size 只能是 a4 或 original")
    writer, parts, temps = PdfWriter(), [], []
    try:
        for name in inputs:
            file = Path(name)
            if not file.is_file():
                raise ValueError(f"文件不存在：{file}")
            kind = kind_of(file)
            if kind == "pdf":
                source = str(file)
            elif kind == "image":
                source = image_page(file, size == "a4")
            elif kind == "word":
                converted = convert(file, "pdf")
                if converted is None:
                    raise ValueError("Word 转 PDF 需要 LibreOffice，本机未安装")
                temps.append(converted.parent)
                source = str(converted)
            else:
                raise ValueError(f"不支持 {file.name}：只接受图片、PDF 和 Word 文件")
            before = len(writer.pages)
            writer.append(source)
            parts.append({"file": str(file), "kind": kind, "pages": len(writer.pages) - before})
        with open(out, "wb") as f:
            writer.write(f)
    finally:
        for temp in temps:
            shutil.rmtree(temp, ignore_errors=True)
    return {"out": str(out), "pages": sum(p["pages"] for p in parts), "bytes": Path(out).stat().st_size, "inputs": parts}


def parse_page_rule(rule, total_pages):
    """原工具的「1,3-5」规则，按页序去重排序。原工具静默丢掉越界和无效片段，这里直接报错，避免取错页"""
    target_pages = set()
    for part in rule.replace(" ", "").replace("，", ",").split(","):
        if not part:
            continue
        start, dash, end = part.partition("-")
        if not start.isdigit() or (dash and not end.isdigit()):
            raise ValueError(f"页码规则无效：{part}（格式如 1,3-5）")
        first, last = int(start), int(end) if dash else int(start)
        if first > last:
            raise ValueError(f"页码范围 {part} 须从小到大")
        if not 1 <= first <= last <= total_pages:
            raise ValueError(f"页码 {part} 超出范围 1-{total_pages}")
        target_pages.update(range(first - 1, last))
    if not target_pages:
        raise ValueError("没有给出页码")
    return sorted(target_pages)


def pdf_path(file):
    file = Path(file)
    if not file.is_file():
        raise ValueError(f"文件不存在：{file}")
    if sniff(file, file.suffix.lower()) != ".pdf":
        raise ValueError(f"{file.name} 不是 PDF 文件")
    return file


def pdf_reader(file):
    return PdfReader(str(pdf_path(file)))


def open_pymupdf(file):
    try:
        import pymupdf
    except ImportError:
        raise ValueError("取图和渲染需要 PyMuPDF，运行 zju doc setup")
    return pymupdf.open(str(pdf_path(file)))


# Embedded images smaller than this are icons, bullets and logos.
MIN_IMAGE_PIXELS = 20000
MAX_RENDER_PAGES = 30


def images(pdf, rule, out_dir):
    """取出嵌入的原始图片（不经渲染，分辨率最高），同一图片只取一次，按像素从大到小"""
    doc = open_pymupdf(pdf)
    indexes = parse_page_rule(rule, doc.page_count) if rule else range(doc.page_count)
    out_dir = Path(out_dir)
    seen, found, small = set(), [], 0
    for i in indexes:
        for entry in doc[i].get_images(full=True):
            xref = entry[0]
            if xref in seen:
                continue
            seen.add(xref)
            info = doc.extract_image(xref)
            width, height = info["width"], info["height"]
            if width * height < MIN_IMAGE_PIXELS:
                small += 1
                continue
            target = out_dir / f"p{i + 1:03d}_x{xref}_{width}x{height}.{info['ext']}"
            target.write_bytes(info["image"])
            found.append({"page": i + 1, "file": str(target), "width": width, "height": height, "format": info["ext"], "bytes": len(info["image"])})
    found.sort(key=lambda item: -item["width"] * item["height"])
    return {"outDir": str(out_dir), "totalPages": doc.page_count, "images": found, "skippedSmall": small}


def render(pdf, rule, dpi, out_dir):
    """把指定页渲染成 PNG，含页面上的文字和排版"""
    doc = open_pymupdf(pdf)
    indexes = parse_page_rule(rule, doc.page_count)
    if len(indexes) > MAX_RENDER_PAGES:
        raise ValueError(f"一次最多渲染 {MAX_RENDER_PAGES} 页，给了 {len(indexes)} 页")
    dpi = int(dpi)
    out_dir = Path(out_dir)
    rendered = []
    for i in indexes:
        target = out_dir / f"page-{i + 1:03d}-{dpi}dpi.png"
        doc[i].get_pixmap(dpi=dpi).save(str(target))
        rendered.append({"page": i + 1, "file": str(target), "bytes": target.stat().st_size})
    return {"outDir": str(out_dir), "totalPages": doc.page_count, "dpi": dpi, "pages": rendered}


def extract_pages(pdf, rule, out):
    try:
        import pymupdf
    except ImportError:
        pymupdf = None
    if pymupdf is None:
        # pypdf 会连同整本书共享的字体、图片一起复制；仅在未装 PyMuPDF 时退回。
        reader = pdf_reader(pdf)
        indexes = parse_page_rule(rule, len(reader.pages))
        writer = PdfWriter()
        for i in indexes:
            writer.add_page(reader.pages[i])
        with open(out, "wb") as f:
            writer.write(f)
        total = len(reader.pages)
    else:
        # 课本几页从整本书取出：只保留这些页实际引用的对象，高亮等批注照留。
        doc = pymupdf.open(str(pdf_path(pdf)))
        indexes = parse_page_rule(rule, doc.page_count)
        part = pymupdf.open()
        for i in indexes:
            part.insert_pdf(doc, from_page=i, to_page=i)
        part.save(str(out), garbage=4, deflate=True)
        total = doc.page_count
    return {"out": str(out), "pages": [i + 1 for i in indexes], "totalPages": total, "bytes": Path(out).stat().st_size}


def find(pdf, keywords):
    texts = [pdf_text(page) for page in pdf_reader(pdf).pages]
    matches = {}
    for keyword in keywords:
        hits = []
        for i, text in enumerate(texts):
            at = text.find(keyword)
            if at >= 0:
                hits.append({"page": i + 1, "snippet": " ".join(text[max(0, at - 30): at + len(keyword) + 60].split())})
        matches[keyword] = hits
    return {"totalPages": len(texts), "textPages": sum(1 for t in texts if t.strip()), "matches": matches}


def main(args):
    if len(args) >= 4 and args[0] == "combine":
        return combine(args[1], args[2], args[3:])
    if len(args) == 4 and args[0] == "pages":
        return extract_pages(args[1], args[2], args[3])
    if len(args) == 4 and args[0] == "images":
        return images(args[1], args[2], args[3])
    if len(args) == 5 and args[0] == "render":
        return render(args[1], args[2], args[3], args[4])
    if len(args) >= 3 and args[0] == "find":
        return find(args[1], args[2:])
    raise ValueError("用法见 pdf_tool.py 开头说明")


if __name__ == "__main__":
    try:
        print(json.dumps(main(sys.argv[1:]), ensure_ascii=False))
    except ValueError as error:
        print(json.dumps({"error": str(error), "input": True}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}, ensure_ascii=False))
