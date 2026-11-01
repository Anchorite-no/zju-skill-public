import argparse
import hashlib
import json
from pathlib import Path
from modelscope.hub.snapshot_download import snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument('--engine', choices=['sensevoice', 'firered'], default='sensevoice')
parser.add_argument('--models', type=Path, required=True)
args = parser.parse_args()
models = [('iic/SenseVoiceSmall', 'SenseVoiceSmall'), ('iic/speech_fsmn_vad_zh-cn-16k-common-pytorch', 'fsmn-vad')] if args.engine == 'sensevoice' else [('xukaituo/FireRedASR2-AED', 'FireRedASR2-AED'), ('xukaituo/FireRedVAD', 'FireRedVAD'), ('xukaituo/FireRedPunc', 'FireRedPunc')]
records = []
for model_id, name in models:
    folder = args.models.resolve() / name
    snapshot_download(model_id, local_dir=str(folder))
    files = []
    for file in sorted(folder.rglob('*')):
        if file.is_file():
            with file.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            files.append({'path': str(file.relative_to(folder)), 'sha256': digest, 'bytes': file.stat().st_size})
    records.append({'model': model_id, 'directory': str(folder), 'files': files})
(args.models / f'{args.engine}-installed.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
