"""通用文档转文字，输出一行 JSON：{status, format, pages: [{page, title?, text}], reason}。

PDF 用 pypdf；DOCX/PPTX 直接读 OOXML；XLSX 用 openpyxl；XLS 用 xlrd；PPT 用 olefile 读二进制文字记录；
ODP 直接读 ODF；DOC、RTF、ODT、WPS、ODS 用 LibreOffice 无头转换为 OOXML 再提取（Ubuntu 22.04 的 Impress
无头模式会崩溃，演示文稿一律不经 LibreOffice）；HTML 与纯文本直接读取。不做 OCR：扫描件和图片返回 no_text。
"""
import argparse
import html.parser
import importlib.util
import json
import os
import posixpath
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

MAX_TEXT = 16 * 1024 * 1024
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
TEXT = {'.txt', '.md', '.csv', '.tsv', '.json', '.xml'}
HTML = {'.html', '.htm'}
IMAGES = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'}
# 需要 LibreOffice 转换的格式 → 转成的 OOXML 格式（只用 Writer 与 Calc）
CONVERT = {'.doc': 'docx', '.rtf': 'docx', '.odt': 'docx', '.wps': 'docx', '.wpt': 'docx',
           '.ods': 'xlsx', '.et': 'xlsx'}
PPT = {'.ppt', '.pps', '.dps'}


def soffice():
    """LibreOffice 可执行文件；ZJU_SOFFICE 可覆盖"""
    configured = os.environ.get('ZJU_SOFFICE')
    if configured:
        return configured if Path(configured).exists() else None
    for name in ('soffice', 'libreoffice'):
        found = shutil.which(name)
        if found:
            return found
    for candidate in (r'C:\Program Files\LibreOffice\program\soffice.exe', r'C:\Program Files (x86)\LibreOffice\program\soffice.exe',
                      '/Applications/LibreOffice.app/Contents/MacOS/soffice'):
        if Path(candidate).exists():
            return candidate
    return None


def result(status, fmt, pages=(), reason=None):
    return {'status': status, 'format': fmt, 'pages': list(pages), 'reason': reason}


def guard(pages):
    if sum(len(p['text'].encode('utf-8')) for p in pages) > MAX_TEXT:
        raise ValueError('提取文字超过 16 MiB')
    return pages


def pdf_text(page):
    """pypdf 取字：拆开的代理对接回原字符；残缺的代理换成 U+FFFD（Word 导出的数学斜体常只映射半个字符，原字已不可恢复）"""
    return (page.extract_text() or '').encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'replace')


def read_text(file):
    data = file.read_bytes()
    if len(data) > MAX_TEXT:
        raise ValueError('文本文件超过 16 MiB')
    for encoding in ('utf-8-sig', 'gb18030'):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode('utf-8', errors='replace')


class _Html(html.parser.HTMLParser):
    BLOCK = {'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'table'}

    def __init__(self):
        super().__init__()
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style') and self.skip:
            self.skip -= 1
        elif tag in ('td', 'th'):
            self.parts.append(' | ')

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_text(file):
    parser = _Html()
    parser.feed(read_text(file))
    lines = [re.sub(r'[ \t\u3000]+', ' ', line).strip(' |') for line in ''.join(parser.parts).split('\n')]
    return '\n'.join(line for line in lines if line)


def paragraph(node, ns):
    return ''.join(t.text or '' for t in node.iter(ns + 't')).strip()


def docx_text(file):
    with zipfile.ZipFile(file) as archive:
        if archive.getinfo('word/document.xml').file_size > MAX_TEXT:
            raise ValueError('解压文本超过 16 MiB')
        body = ET.fromstring(archive.read('word/document.xml')).find(W + 'body')
    lines = []
    for child in body if body is not None else []:
        if child.tag == W + 'p':
            text = paragraph(child, W)
            if text:
                lines.append(text)
        elif child.tag == W + 'tbl':
            for row in child.iter(W + 'tr'):
                cells = [' '.join(filter(None, (paragraph(p, W) for p in cell.iter(W + 'p')))) for cell in row.iter(W + 'tc')]
                if any(cells):
                    lines.append(' | '.join(cells))
    return '\n'.join(lines)


def slide_names(archive):
    names = [n for n in archive.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)]
    if 'ppt/presentation.xml' in archive.namelist() and 'ppt/_rels/presentation.xml.rels' in archive.namelist():
        rels = ET.fromstring(archive.read('ppt/_rels/presentation.xml.rels'))
        targets = {r.attrib['Id']: posixpath.normpath(posixpath.join('ppt', r.attrib['Target'])) for r in rels if r.attrib.get('TargetMode') != 'External'}
        ordered = [targets.get(s.attrib.get(R + 'id')) for s in ET.fromstring(archive.read('ppt/presentation.xml')).iter(P + 'sldId')]
        ordered = [n for n in ordered if n and re.fullmatch(r'ppt/slides/slide\d+\.xml', n)]
        if ordered:
            return ordered
    return sorted(names, key=lambda n: int(re.search(r'slide(\d+)\.xml', n).group(1)))


def pptx_pages(file):
    pages = []
    with zipfile.ZipFile(file) as archive:
        for index, name in enumerate(slide_names(archive), 1):
            root = ET.fromstring(archive.read(name))
            text = '\n'.join(filter(None, (paragraph(p, A) for p in root.iter(A + 'p'))))
            if text:
                pages.append({'page': index, 'text': text})
    return pages


def ppt_pages(file):
    """PowerPoint 97-2003：读 'PowerPoint Document' 流里的文字记录。
    SlideListWithText(0x0FF0, instance 0) 里按 SlidePersistAtom(0x03F3) 分页的是占位符文字；
    各 Slide 容器(0x03EE) 按出现顺序对应各页，其中是文本框文字。TextCharsAtom(0x0FA0) 为 UTF-16LE，TextBytesAtom(0x0FA8) 为单字节。"""
    import olefile
    with olefile.OleFileIO(str(file)) as ole:
        if not ole.exists('PowerPoint Document'):
            raise ValueError('不是 PowerPoint 97-2003 文件')
        data = ole.openstream('PowerPoint Document').read()
    listed, drawn = [], []

    def text_of(rtype, body):
        raw = data[body[0]:body[1]]
        text = raw.decode('utf-16-le', errors='ignore') if rtype == 0x0FA0 else raw.decode('cp1252', errors='ignore')
        return text.replace('\r', '\n').replace('\x0b', '\n').strip()

    def walk(start, end, where):
        pos = start
        while pos + 8 <= end:
            head, rtype, length = struct.unpack_from('<HHI', data, pos)
            body = (pos + 8, min(pos + 8 + length, end))
            if head & 0xF == 0xF:
                if rtype == 0x0FF0:
                    walk(body[0], body[1], 'list' if head >> 4 == 0 else 'skip')
                elif rtype == 0x03EE:
                    drawn.append([])
                    walk(body[0], body[1], 'slide')
                elif rtype in (0x03F0, 0x03F8):  # 备注、母版
                    pass
                else:
                    walk(body[0], body[1], where)
            elif rtype == 0x03F3 and where == 'list':
                listed.append([])
            elif rtype in (0x0FA0, 0x0FA8) and where in ('list', 'slide'):
                text = text_of(rtype, body)
                target = listed if where == 'list' else drawn
                if text and target:
                    target[-1].append(text)
            pos = body[1] if length else pos + 8

    walk(0, len(data), 'root')
    prompt = re.compile(r'^(Click to (edit|add) |单击此处(编辑|添加)|点击此处(编辑|添加))')
    listed = [[t for t in page if not prompt.match(t)] for page in listed]
    drawn = [[t for t in page if not prompt.match(t)] for page in drawn]
    pages = []
    for i in range(max(len(listed), len(drawn))):
        lines = []
        for text in (listed[i] if i < len(listed) else []) + (drawn[i] if i < len(drawn) else []):
            if text not in lines:
                lines.append(text)
        if lines:
            pages.append({'page': i + 1, 'text': '\n'.join(lines)})
    return pages


def odp_pages(file):
    ns_draw = '{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}'
    ns_text = '{urn:oasis:names:tc:opendocument:xmlns:text:1.0}'
    with zipfile.ZipFile(file) as archive:
        root = ET.fromstring(archive.read('content.xml'))
    pages = []
    for index, page in enumerate(root.iter(ns_draw + 'page'), 1):
        lines = [''.join(p.itertext()).strip() for p in page.iter() if p.tag in (ns_text + 'p', ns_text + 'h')]
        text = '\n'.join(line for line in lines if line)
        if text:
            pages.append({'page': index, 'text': text})
    return pages


def cell(value):
    if value is None:
        return ''
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def rows_text(rows):
    lines = []
    for row in rows:
        values = [cell(v) for v in row]
        while values and not values[-1]:
            values.pop()
        if any(values):
            lines.append(' | '.join(values))
    return '\n'.join(lines)


def xlsx_pages(file):
    from openpyxl import load_workbook
    book = load_workbook(file, read_only=True, data_only=True)
    try:
        return [{'page': i, 'title': sheet.title, 'text': rows_text(sheet.iter_rows(values_only=True))}
                for i, sheet in enumerate(book.worksheets, 1)]
    finally:
        book.close()


def xls_pages(file):
    import xlrd
    book = xlrd.open_workbook(str(file))
    return [{'page': i, 'title': sheet.name, 'text': rows_text(sheet.row_values(r) for r in range(sheet.nrows))}
            for i, sheet in enumerate(book.sheets(), 1)]


def convert(file, target):
    """LibreOffice 无头转换；每次使用独立的用户配置目录，避免并发冲突"""
    office = soffice()
    if not office:
        return None
    work = Path(tempfile.mkdtemp(prefix='zju-doc-'))
    try:
        profile = (work / 'profile').resolve().as_uri()
        subprocess.run([office, f'-env:UserInstallation={profile}', '--headless', '--norestore', '--convert-to', target,
                        '--outdir', str(work), str(file)], capture_output=True, timeout=180, check=False)
        produced = work / (file.stem + '.' + target)
        if not produced.exists():
            raise ValueError(f'LibreOffice 未能把 {file.suffix} 转为 {target}')
        kept = Path(tempfile.mkdtemp(prefix='zju-doc-out-')) / produced.name
        shutil.move(str(produced), kept)
        return kept
    finally:
        shutil.rmtree(work, ignore_errors=True)


OLE_FAMILY = {'.docx': '.doc', '.xlsx': '.xls', '.xlsm': '.xls', '.pptx': '.ppt'}


def sniff(file, suffix):
    """按文件头判断真实格式：学校服务器常给错扩展名（如老 Word 文件叫 .docx）"""
    with open(file, 'rb') as f:
        head = f.read(512)
    if head.startswith(b'%PDF'):
        return '.pdf'
    if head.startswith(b'PK\x03\x04'):
        if suffix in ('.docx', '.pptx', '.xlsx', '.xlsm'):
            return suffix
        with zipfile.ZipFile(file) as archive:
            names = archive.namelist()
        if 'word/document.xml' in names:
            return '.docx'
        if any(n.startswith('ppt/') for n in names):
            return '.pptx'
        if any(n.startswith('xl/') for n in names):
            return '.xlsx'
        return suffix
    if head.startswith(b'\xd0\xcf\x11\xe0'):
        if suffix in ('.doc', '.xls', '.ppt', '.pps', '.wps', '.et', '.dps'):
            return suffix
        return OLE_FAMILY.get(suffix, '.doc')
    text = head.lstrip(b'\xef\xbb\xbf \t\r\n').lower()
    if suffix not in TEXT | HTML and (text.startswith(b'<!doctype html') or text.startswith(b'<html')):
        return '.html'
    return suffix


def extract(file):
    file = Path(file)
    suffix = file.suffix.lower()
    fmt = suffix.lstrip('.') or 'unknown'
    if not file.is_file():
        return result('error', fmt, reason='文件不存在')
    if file.stat().st_size == 0:
        return result('error', fmt, reason='文件为空（0 字节），源文件可能已不存在')
    actual = sniff(file, suffix)
    if actual != suffix:
        work = Path(tempfile.mkdtemp(prefix='zju-doc-fix-'))
        try:
            fixed = work / (file.stem + actual)
            shutil.copyfile(file, fixed)
            inner = extract(fixed)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        inner['declaredFormat'] = fmt
        return inner
    if suffix in TEXT:
        text = read_text(file)
        return result('text' if text.strip() else 'no_text', fmt, [{'page': 1, 'text': text}] if text.strip() else [], None if text.strip() else '文件为空')
    if suffix in HTML:
        text = html_text(file)
        return result('text' if text else 'no_text', fmt, [{'page': 1, 'text': text}] if text else [], None if text else '网页没有正文文字')
    if suffix == '.pdf':
        if importlib.util.find_spec('pypdf') is None:
            return result('unsupported', fmt, reason='缺少 pypdf，运行 zju doc setup')
        from pypdf import PdfReader
        pages = [{'page': i, 'text': pdf_text(page).strip()} for i, page in enumerate(PdfReader(file).pages, 1)]
        pages = guard([p for p in pages if p['text']])
        return result('text' if pages else 'no_text', fmt, pages, None if pages else '没有可提取的文字，可能是扫描件；未做 OCR')
    if suffix == '.docx':
        text = docx_text(file)
        return result('text' if text else 'no_text', fmt, guard([{'page': 1, 'text': text}]) if text else [], None if text else '文档没有可提取文字，可能只有图片')
    if suffix == '.pptx':
        pages = guard(pptx_pages(file))
        return result('text' if pages else 'no_text', fmt, pages, None if pages else '演示文稿没有可提取文字，可能由截图组成；未做 OCR')
    if suffix in ('.xlsx', '.xlsm'):
        if importlib.util.find_spec('openpyxl') is None:
            return result('unsupported', fmt, reason='缺少 openpyxl，运行 zju doc setup')
        pages = guard(xlsx_pages(file))
        return result('text' if any(p['text'] for p in pages) else 'no_text', fmt, pages, None)
    if suffix == '.xls':
        if importlib.util.find_spec('xlrd') is not None:
            pages = guard(xls_pages(file))
            return result('text' if any(p['text'] for p in pages) else 'no_text', fmt, pages, None)
        CONVERT['.xls'] = 'xlsx'
    if suffix in PPT:
        if importlib.util.find_spec('olefile') is None:
            return result('unsupported', fmt, reason='缺少 olefile，运行 zju doc setup')
        pages = guard(ppt_pages(file))
        return result('text' if pages else 'no_text', fmt, pages, None if pages else '演示文稿没有可提取文字，可能由图片组成；未做 OCR')
    if suffix == '.odp':
        pages = guard(odp_pages(file))
        return result('text' if pages else 'no_text', fmt, pages, None if pages else '演示文稿没有可提取文字')
    if suffix in CONVERT:
        converted = convert(file, CONVERT[suffix])
        if converted is None:
            return result('unsupported', fmt, reason=f'{suffix} 需要 LibreOffice 转换，本机未安装')
        try:
            inner = extract(converted)
        finally:
            shutil.rmtree(converted.parent, ignore_errors=True)
        inner['format'] = fmt
        inner['convertedVia'] = 'libreoffice'
        return inner
    if suffix in IMAGES:
        return result('no_text', fmt, reason='图片，需要看图；未做 OCR')
    return result('unsupported', fmt, reason=f'暂不支持 {suffix or "无扩展名"} 文件')


def check():
    office = soffice()
    return {'python': sys.version.split()[0], 'pdf': importlib.util.find_spec('pypdf') is not None,
            'xlsx': importlib.util.find_spec('openpyxl') is not None, 'xls': importlib.util.find_spec('xlrd') is not None,
            'ppt': importlib.util.find_spec('olefile') is not None, 'images': importlib.util.find_spec('PIL') is not None, 'render': importlib.util.find_spec('pymupdf') is not None,
            'docx': True, 'pptx': True, 'libreoffice': office, 'legacyOffice': office is not None, 'ocr': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('file', nargs='?')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        if args.check:
            print(json.dumps(check(), ensure_ascii=False))
        elif not args.file:
            parser.error('需要文件路径')
        else:
            print(json.dumps(extract(args.file), ensure_ascii=False))
    except Exception as error:
        print(json.dumps(result('error', Path(args.file or '').suffix.lstrip('.') or 'unknown', reason=str(error)), ensure_ascii=False))
