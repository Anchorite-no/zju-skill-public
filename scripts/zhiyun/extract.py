"""Extract existing text only; never claim OCR for scanned/image-only materials."""
import argparse
import importlib.util
import hashlib
import io
import json
import math
from pathlib import Path
import re
import posixpath
import xml.etree.ElementTree as ET
import zipfile

MAX_TEXT_BYTES = 16 * 1024 * 1024
NEAR_DISTANCE = 4
NEAR_RMSE = 3

def image_fingerprint(data):
    """Exact decoded-pixel identity plus a small perceptual hash for review candidates."""
    try:
        from PIL import Image, ImageOps
        with Image.open(io.BytesIO(data)) as image:
            if getattr(image, 'n_frames', 1) != 1:
                return None  # Do not collapse animations based on only the first frame.
            rgba = ImageOps.exif_transpose(image).convert('RGBA')
            exact = hashlib.sha256()
            exact.update(str(rgba.size).encode())
            exact.update(image.info.get('icc_profile', b''))
            exact.update(str(image.info.get('gamma')).encode())
            exact.update(rgba.tobytes())
            white = Image.new('RGBA', rgba.size, 'white')
            white.alpha_composite(rgba)
            small = white.convert('L').resize((32, 32), Image.Resampling.LANCZOS)
            pixels = list(small.tobytes())
            cosines = [[math.cos(math.pi * (2 * x + 1) * k / 64) for x in range(32)] for k in range(8)]
            horizontal = [[sum(pixels[y * 32 + x] * cosines[k][x] for x in range(32)) for k in range(8)] for y in range(32)]
            coeff = [sum(horizontal[y][u] * cosines[v][y] for y in range(32)) for v in range(8) for u in range(8)]
            median = sorted(coeff[1:])[31]
            phash = sum(1 << i for i, c in enumerate(coeff) if i and c > median)
            return {'pixelHash': exact.hexdigest(), 'phash': phash, 'pixels': pixels, 'size': rgba.size}
    except ImportError:
        return None
    except (OSError, ValueError):
        return None  # Byte identity still works; keep the original asset for inspection.

class ImageIndex:
    def __init__(self, destination):
        self.destination = destination
        self.by_bytes, self.by_pixels, self.unique = {}, {}, []

    def add(self, data, page, extension):
        digest = hashlib.sha256(data).hexdigest()
        first, fingerprint = self.by_bytes.get(digest), None
        if first is None:
            fingerprint = image_fingerprint(data)
            if fingerprint:
                first = self.by_pixels.get(fingerprint['pixelHash'])
        if first is not None:
            self.by_bytes[digest] = first
            return {'page': page, 'path': first['path'], 'sourceSha256': digest, 'duplicateOf': first['page']}
        row = {'page': page, 'sourceSha256': digest}
        if fingerprint:
            candidates = []
            for previous, other in self.unique:
                if not other or fingerprint['size'] != other['size']:
                    continue
                distance = (fingerprint['phash'] ^ other['phash']).bit_count()
                if distance > NEAR_DISTANCE:
                    continue
                rmse = math.sqrt(sum((a - b) ** 2 for a, b in zip(fingerprint['pixels'], other['pixels'])) / 1024)
                if rmse <= NEAR_RMSE:
                    candidates.append((distance, rmse, previous))
            if candidates:
                distance, rmse, match = min(candidates, key=lambda item: (item[0], item[1]))
                row['similarTo'] = {'page': match['page'], 'path': match['path'], 'distance': distance, 'thumbnailRmse': round(rmse, 3)}
        # Similar assets are always retained. A changed minus sign or animation is content.
        self.destination.mkdir(parents=True, exist_ok=True)
        out = self.destination / f'page-{page:03d}-{len(self.unique) + 1:03d}{extension}'
        with out.open('xb') as stream:
            stream.write(data)
        row['path'] = str(out)
        self.by_bytes[digest] = row
        if fingerprint:
            self.by_pixels[fingerprint['pixelHash']] = row
        self.unique.append((row, fingerprint))
        return row

def slide_names(archive):
    names = [n for n in archive.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)]
    if 'ppt/presentation.xml' in archive.namelist() and 'ppt/_rels/presentation.xml.rels' in archive.namelist():
        if any(archive.getinfo(n).file_size > MAX_TEXT_BYTES for n in ['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']):
            raise ValueError('PPT 索引超过 16 MiB')
        rels = ET.fromstring(archive.read('ppt/_rels/presentation.xml.rels'))
        targets = {r.attrib['Id']: posixpath.normpath(posixpath.join('ppt', r.attrib['Target'])) for r in rels if r.attrib.get('TargetMode') != 'External'}
        presentation = ET.fromstring(archive.read('ppt/presentation.xml'))
        names = [targets[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']] for s in presentation.iter('{http://schemas.openxmlformats.org/presentationml/2006/main}sldId')]
        if any(not re.fullmatch(r'ppt/slides/slide\d+\.xml', n) for n in names):
            raise ValueError('PPT 页面索引指向非幻灯片内容')
    else:
        names.sort(key=lambda n: int(re.search(r'slide(\d+)\.xml', n).group(1)))
    return names

def extract_images(file, destination):
    """Preserve original raster assets by displayed page; this is not slide rendering/OCR."""
    file, destination = Path(file), Path(destination).resolve()
    raster = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'}
    if file.suffix.lower() in raster:
        return [{'page': 1, 'path': str(file.resolve())}]
    if file.suffix.lower() != '.pptx':
        return []
    images, total, index = [], 0, ImageIndex(destination)
    with zipfile.ZipFile(file) as archive:
        for page, name in enumerate(slide_names(archive), 1):
            if archive.getinfo(name).file_size > MAX_TEXT_BYTES:
                raise ValueError('单页 PPT XML 过大')
            rel_path = posixpath.join(posixpath.dirname(name), '_rels', posixpath.basename(name) + '.rels')
            if rel_path not in archive.namelist():
                continue
            if archive.getinfo(rel_path).file_size > MAX_TEXT_BYTES:
                raise ValueError('单页 PPT 资源索引过大')
            rels = ET.fromstring(archive.read(rel_path))
            targets = {r.attrib['Id']: posixpath.normpath(posixpath.join(posixpath.dirname(name), r.attrib['Target'])) for r in rels if r.attrib.get('TargetMode') != 'External' and r.attrib.get('Type', '').endswith('/image')}
            root, seen = ET.fromstring(archive.read(name)), set()
            for blip in root.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}blip'):
                target = targets.get(blip.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed'))
                if not target or target in seen:
                    continue
                if not target.startswith('ppt/media/'):
                    raise ValueError('PPT 图片引用越出 media 目录')
                seen.add(target)
                ext = Path(target).suffix.lower()
                if ext not in raster:
                    continue
                size = archive.getinfo(target).file_size
                total += size
                if size > 64 * 1024 * 1024 or total > 256 * 1024 * 1024:
                    raise ValueError('PPT 图片解压大小超过限制')
                images.append(index.add(archive.read(target), page, ext))
    return images

def extract(file):
    file = Path(file)
    suffix = file.suffix.lower()
    if suffix in {'.txt', '.md', '.csv', '.tsv'}:
        if file.stat().st_size > MAX_TEXT_BYTES:
            return {'status': 'unsupported', 'reason': '文本文件超过 16 MiB'}
        return {'status': 'text', 'pages': [{'page': 1, 'text': file.read_text(encoding='utf-8-sig')}]}
    if suffix in {'.pptx', '.docx'}:
        with zipfile.ZipFile(file) as archive:
            names = slide_names(archive) if suffix == '.pptx' else ['word/document.xml']
            if sum(archive.getinfo(n).file_size for n in names) > MAX_TEXT_BYTES:
                return {'status': 'unsupported', 'reason': '解压文本超过 16 MiB'}
            pages = []
            namespace = '{http://schemas.openxmlformats.org/drawingml/2006/main}' if suffix == '.pptx' else '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
            for index, name in enumerate(names, 1):
                root = ET.fromstring(archive.read(name))
                paragraphs = [''.join(t.text or '' for t in p.iter(namespace + 't')).strip() for p in root.iter(namespace + 'p')]
                text = '\n'.join(p for p in paragraphs if p)
                if text:
                    pages.append({'page': index, 'text': text})
            return {'status': 'text' if pages else 'no_text', 'pages': pages, 'reason': None if pages else '课件没有可提取文字，可能由截图组成；未做 OCR'}
    if suffix == '.pdf':
        try:
            from pypdf import PdfReader
        except ImportError:
            return {'status': 'unsupported', 'reason': '缺少可选 pypdf，原始 PDF 已保留'}
        pages, size = [], 0
        for index, page in enumerate(PdfReader(file).pages, 1):
            # 残缺的代理字符（Word 导出的数学斜体常只映射半个）换成 U+FFFD，否则 encode 与输出 JSON 会失败
            text = (page.extract_text() or '').encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'replace')
            size += len(text.encode('utf-8'))
            if size > MAX_TEXT_BYTES:
                return {'status': 'unsupported', 'reason': 'PDF 文本超过 16 MiB'}
            if text.strip():
                pages.append({'page': index, 'text': text.strip()})
        return {'status': 'text' if pages else 'no_text', 'pages': pages, 'reason': None if pages else '未提取到 PDF 文字，可能是扫描件；未做 OCR'}
    if suffix in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'}:
        return {'status': 'no_text', 'pages': [], 'reason': '图片课件，提供原图供 AI 阅读；未做 OCR'}
    return {'status': 'unsupported', 'reason': f'暂不提取 {suffix} 的文字，原文件已保留'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('file', nargs='?')
    parser.add_argument('--images-dir', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        if args.check:
            print(json.dumps({'available': True, 'pdfTextAvailable': importlib.util.find_spec('pypdf') is not None, 'visualDedupAvailable': importlib.util.find_spec('PIL') is not None, 'ocr': False}))
        else:
            if not args.file:
                parser.error('需要课件文件')
            result = extract(args.file)
            if args.images_dir:
                result['images'] = extract_images(args.file, args.images_dir)
                result['dedup'] = {'visualAvailable': importlib.util.find_spec('PIL') is not None, 'exact': 'bytes-or-decoded-pixels', 'near': 'review-only', 'nearDistance': NEAR_DISTANCE, 'nearRmse': NEAR_RMSE}
            print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status': 'error', 'reason': str(error)}, ensure_ascii=False))
