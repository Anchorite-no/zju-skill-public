"""Local ASR worker. stdout is one JSON result; models and logs stay local."""
import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
import uuid
import wave

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get('ZJU_DATA_DIR', str(ROOT / 'data'))).resolve()

def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')

def jsonable(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items() if k != 'spk_embedding'}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if hasattr(value, 'tolist'):
        return jsonable(value.tolist())
    return str(value)

def check(args):
    import torch
    packages = ['torch', 'soundfile', 'funasr'] if args.engine == 'sensevoice' else ['torch', 'soundfile', 'transformers', 'kaldi-native-fbank']
    versions = {key: importlib.metadata.version(key) for key in packages}
    if args.engine == 'sensevoice':
        files = [args.models / 'SenseVoiceSmall' / 'model.pt', args.models / 'SenseVoiceSmall' / 'config.yaml', args.models / 'fsmn-vad' / 'model.pt']
    else:
        files = [args.models / 'FireRedASR2-AED' / 'model.pth.tar', args.models / 'FireRedVAD' / 'VAD' / 'model.pth.tar', args.models / 'FireRedPunc' / 'model.pth.tar']
        if not (args.firered_source / 'fireredasr2s' / '__init__.py').is_file():
            raise FileNotFoundError('缺少 FireRed 官方源码，运行安装器 --engine firered')
    for file in files:
        if not file.is_file():
            raise FileNotFoundError(f'缺少模型文件：{file}')
    device = 'cuda:0' if args.device == 'auto' and torch.cuda.is_available() else ('cpu' if args.device == 'auto' else args.device)
    if device.startswith('cuda') and not torch.cuda.is_available():
        raise RuntimeError('请求 CUDA，但当前环境不能使用 GPU')
    weights = [{'file': str(p), 'sha256': digest(p)} for p in files]
    signature = hashlib.sha256(json.dumps({'engine': args.engine, 'versions': versions, 'weights': weights, 'worker': digest(__file__), 'device': device}, sort_keys=True).encode()).hexdigest()
    return {'engine': args.engine, 'device': device, 'versions': versions, 'signature': signature}

def validate_segments(rows, duration):
    result = []
    for row in rows:
        text = row['text'].strip()
        if not re.search(r'[A-Za-z0-9\u3400-\u9fff]', text):
            continue
        start, end = row.get('start'), row.get('end')
        if (start is None) != (end is None):
            raise ValueError('句段时间戳只有一端，不能伪造另一端')
        if start is not None and (not all(isinstance(n, (int, float)) and math.isfinite(n) for n in [start, end]) or start < 0 or end < start or end > duration + 1):
            raise ValueError('ASR 返回了无效时间戳')
        result.append({'start': start, 'end': end, 'text': text})
    if not result:
        raise ValueError('没有识别到有效文本')
    return result

def transcribe(args, info):
    import torch
    import soundfile as sf
    audio, target = args.audio.resolve(), args.out.resolve()
    if target.exists():
        raise FileExistsError(f'输出已存在，不覆盖：{target}')
    with wave.open(str(audio), 'rb') as wav:
        if wav.getframerate() != 16000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError('ASR 输入必须为 16 kHz 单声道 16-bit PCM WAV')
        duration = wav.getnframes() / 16000
    if duration <= 0:
        raise ValueError('音频为空')
    target.parent.mkdir(parents=True, exist_ok=True)
    stage = target.parent / f'.{target.name}.stage-{uuid.uuid4().hex}'
    stage.mkdir()
    torch.set_num_threads(8)
    torch.set_float32_matmul_precision('high')
    gpu = info['device'].startswith('cuda')
    sync = lambda: torch.cuda.synchronize() if gpu else None
    began = time.perf_counter()
    try:
        if args.engine == 'sensevoice':
            from funasr import AutoModel
            from funasr.utils.postprocess_utils import rich_transcription_postprocess as clean
            model = AutoModel(model=str(args.models / 'SenseVoiceSmall'), vad_model=str(args.models / 'fsmn-vad'),
                vad_kwargs={'max_single_segment_time': 30000}, device=info['device'], ncpu=8,
                trust_remote_code=False, disable_update=True, disable_pbar=True)
            sync(); loaded = time.perf_counter()
            waveform, rate = sf.read(str(audio), dtype='float32')
            with torch.inference_mode():
                raw = model.generate(input=waveform, fs=rate, cache={}, language='zh', use_itn=True,
                    batch_size_s=args.batch_seconds, merge_vad=True, merge_length_s=15,
                    sentence_timestamp=True, return_raw_text=True, disable_pbar=True)
            sync()
            if not raw or not isinstance(raw[0], dict):
                raise ValueError('SenseVoice 没有返回转写')
            entries = raw[0].get('sentence_info') or []
            rows = [{'start': s['start'] / 1000 if s.get('start') is not None else None,
                     'end': s['end'] / 1000 if s.get('end') is not None else None,
                     'text': clean(s.get('text') or s.get('sentence') or '')} for s in entries]
            if not rows:
                rows = [{'start': None, 'end': None, 'text': clean(raw[0].get('text', ''))}]
            discarded = []
        else:
            sys.path.insert(0, str(args.firered_source))
            from fireredasr2s import FireRedAsr2System, FireRedAsr2SystemConfig
            from fireredasr2s.fireredasr2 import FireRedAsr2Config
            from fireredasr2s.fireredvad import FireRedVadConfig
            from fireredasr2s.fireredpunc import FireRedPuncConfig
            config = FireRedAsr2SystemConfig(
                vad_model_dir=str(args.models / 'FireRedVAD' / 'VAD'), asr_model_dir=str(args.models / 'FireRedASR2-AED'),
                punc_model_dir=str(args.models / 'FireRedPunc'), enable_lid=False, enable_punc=True,
                asr_batch_size=8, punc_batch_size=16,
                vad_config=FireRedVadConfig(use_gpu=gpu, merge_silence_frame=60, extend_speech_frame=10),
                asr_config=FireRedAsr2Config(use_gpu=gpu, use_half=gpu, beam_size=3, return_timestamp=False),
                punc_config=FireRedPuncConfig(use_gpu=gpu))
            model = FireRedAsr2System(config)
            discarded = []
            original_vad, original_asr = model.vad.detect, model.asr.transcribe
            def safe_vad(*a, **kw):
                result = original_vad(*a, **kw)
                discarded.extend([s, e] for s, e in result[0]['timestamps'] if e - s < 0.025)
                result[0]['timestamps'] = [(s, e) for s, e in result[0]['timestamps'] if e - s >= 0.025]
                return result
            def complete_asr(ids, waves):
                result = original_asr(ids, waves)
                if {r.get('uttid') for r in result} != set(ids):
                    raise RuntimeError('FireRed 未返回全部片段，停止而非输出残缺成品')
                return result
            model.vad.detect, model.asr.transcribe = safe_vad, complete_asr
            sync(); loaded = time.perf_counter()
            with torch.inference_mode():
                raw = model.process(str(audio))
            sync()
            rows = [{'start': s['start_ms'] / 1000, 'end': s['end_ms'] / 1000, 'text': s['text']} for s in raw['sentences']]
        inference_seconds = time.perf_counter() - loaded
        segments = validate_segments(rows, duration)
        metadata = {**info, 'audioSha256': digest(audio), 'durationSeconds': duration,
            'loadSeconds': loaded - began, 'inferenceSeconds': inference_seconds,
            'batchSeconds': args.batch_seconds, 'timestampKind': 'vad_or_sentence',
            'discardedSubFrameSegments': discarded, 'cleanup': 'punctuation-only segments removed; no summarization, correction or extra numeric rewriting'}
        write_json(stage / 'raw.json', jsonable(raw))
        write_json(stage / 'segments.json', segments)
        write_json(stage / 'metadata.json', metadata)
        (stage / 'transcript.txt').write_text('\n'.join(s['text'] for s in segments) + '\n', encoding='utf-8')
        stage.rename(target)
        return {**metadata, 'directory': str(target), 'segmentCount': len(segments)}
    except BaseException:
        if stage.resolve().parent == target.parent.resolve() and stage.name.startswith(f'.{target.name}.stage-'):
            shutil.rmtree(stage)
        raise

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['check', 'transcribe'])
    parser.add_argument('--engine', choices=['sensevoice', 'firered'], default='sensevoice')
    parser.add_argument('--models', type=Path, default=DATA / 'models' / 'zhiyun-asr')
    parser.add_argument('--firered-source', type=Path, default=DATA / 'tools' / 'zhiyun-firered' / 'FireRedASR2S')
    parser.add_argument('--device', choices=['auto', 'cuda:0', 'cpu'], default='auto')
    parser.add_argument('--batch-seconds', type=int, default=60)
    parser.add_argument('--audio', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    if not 1 <= args.batch_seconds <= 600:
        parser.error('batch-seconds must be 1..600')
    if args.action == 'transcribe' and (args.audio is None or args.out is None):
        parser.error('transcribe needs --audio and --out')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    try:
        with contextlib.redirect_stdout(sys.stderr):
            info = check(args)
            result = info if args.action == 'check' else transcribe(args, info)
        print(json.dumps({'ok': True, 'data': result}, ensure_ascii=False))
    except Exception as error:
        code = 'PLUGIN_NOT_INSTALLED' if isinstance(error, (ImportError, importlib.metadata.PackageNotFoundError, FileNotFoundError)) else 'BAD_RESPONSE'
        print(json.dumps({'ok': False, 'error': {'code': code, 'message': str(error)}}, ensure_ascii=False))
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
