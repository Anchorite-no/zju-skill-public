"""Local click-word recognition migrated from zju-room-booker; no venue requests.
Detection, variants, probability rescue and assignment retain the old algorithm.
"""
from __future__ import annotations
import base64
import binascii
import contextlib
import io
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Iterable
from PIL import Image, ImageFilter, ImageOps

class CaptchaError(Exception):
    def __init__(self, message, **details):
        super().__init__(message)

@dataclass
class ClickPoint:
    x: int
    y: int

@dataclass
class CaptchaChallenge:
    original_image_base64: str
    word_list: list[str]
    captcha_type: str = "clickWord"

@dataclass
class ClickWordRecognition:
    box: list[int]
    crop_box: list[int] = field(default_factory=list)
    recognized_texts: list[str] = field(default_factory=list)

@dataclass
class ClickWordSolveResult:
    challenge: CaptchaChallenge
    points: list[ClickPoint]
    recognitions: list[ClickWordRecognition]


def _bundled_paddle_model_dir():
    candidate = Path.home() / ".paddlex" / "official_models" / PADDLE_RECOGNITION_MODEL
    if candidate.is_dir() and (candidate / "inference.pdiparams").is_file():
        return candidate
    if "--setup" in sys.argv:
        return None
    raise CaptchaError("Paddle 模型缺失，请运行 tyys venue setup；预约中不下载模型")


DEFAULT_CLICK_WORD_KEY = "XwKsGlMcdPMEhR1B"

DEFAULT_CLICK_WORD_TYPE = "clickWord"

DEFAULT_BLOCK_PUZZLE_TYPE = "blockPuzzle"

FAST_VARIANT_INDEXES = (0, 1)

EXTRA_VARIANT_INDEXES = (2, 3)

PADDLE_VARIANT_INDEXES = (1,)

CLICK_WORD_BOX_PADDING = 4

CLICK_WORD_MIN_BOX_EDGE = 10

CLICK_WORD_IOU_THRESHOLD = 0.65

CLICK_WORD_PROBABILITY_TOP_K = 3

CLICK_WORD_MAX_BOX_PADDING = 10

PADDLE_RECOGNITION_MODEL = "PP-OCRv5_mobile_rec"

COMMON_CONFUSION_MAP = {
    "伟": {"为"},
    "为": {"伟"},
    "之": {"z"},
    "了": {"7"},
}

_DDDD_DETECTOR = None

_DDDD_CLASSIFIER = None

_PADDLE_RECOGNIZER = None

def _load_ddddocr():
    try:
        import ddddocr
    except ImportError as exc:
        raise CaptchaError(
            "ddddocr is required for auto-solving click-word captcha. Install project dependencies first."
        ) from exc
    return ddddocr

def _load_paddle_text_recognition():
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    try:
        from paddleocr._models.text_recognition import TextRecognition
    except ImportError as exc:
        raise CaptchaError(
            "paddleocr is required for Paddle-based click-word recognition. Install project dependencies first."
        ) from exc
    return TextRecognition

def _get_ddddocr_engines():
    global _DDDD_DETECTOR, _DDDD_CLASSIFIER
    if _DDDD_DETECTOR is None or _DDDD_CLASSIFIER is None:
        ddddocr = _load_ddddocr()
        if _DDDD_DETECTOR is None:
            _DDDD_DETECTOR = ddddocr.DdddOcr(det=True, show_ad=False)
        if _DDDD_CLASSIFIER is None:
            _DDDD_CLASSIFIER = ddddocr.DdddOcr(beta=True, show_ad=False)
    return _DDDD_DETECTOR, _DDDD_CLASSIFIER

def _get_paddle_recognizer():
    global _PADDLE_RECOGNIZER
    if _PADDLE_RECOGNIZER is None:
        TextRecognition = _load_paddle_text_recognition()
        model_dir = _bundled_paddle_model_dir()
        if model_dir is not None:
            _PADDLE_RECOGNIZER = TextRecognition(
                model_name=PADDLE_RECOGNITION_MODEL,
                model_dir=str(model_dir),
            )
        else:
            _PADDLE_RECOGNIZER = TextRecognition(model_name=PADDLE_RECOGNITION_MODEL)
    return _PADDLE_RECOGNIZER

def prewarm_click_word_solver() -> float:
    start = perf_counter()
    detector, classifier = _get_ddddocr_engines()
    image = Image.new("RGB", (64, 64), "white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    image_bytes = buffer.getvalue()
    try:
        detector.detection(image_bytes)
        classifier.classification(image_bytes)
        recognizer = _get_paddle_recognizer()
        import numpy as np

        list(recognizer.predict(input=[np.array(image)]))
    except Exception as exc:
        raise CaptchaError(f"Failed to prewarm captcha engines: {exc}") from exc
    return perf_counter() - start

def decode_image_base64(image_base64: str) -> bytes:
    if not image_base64:
        return b""
    try:
        return base64.b64decode(image_base64, validate=True)
    except binascii.Error as exc:
        raise CaptchaError("Captcha image is not valid base64 data.") from exc

def _classification_variants(crop: Image.Image) -> list[Image.Image]:
    grayscale = crop.convert("L")
    contrasted = ImageOps.autocontrast(grayscale)
    sharpened = contrasted.filter(ImageFilter.SHARPEN)
    variants = [
        sharpened,
        sharpened.resize((sharpened.width * 4, sharpened.height * 4)),
        sharpened.resize((sharpened.width * 6, sharpened.height * 6)),
        sharpened.resize((sharpened.width * 4, sharpened.height * 4)).point(
            lambda pixel: 255 if pixel > 180 else 0
        ),
        sharpened.resize((sharpened.width * 4, sharpened.height * 4)).point(
            lambda pixel: 255 if pixel > 150 else 0
        ),
    ]
    return variants

def _detection_variants(image: Image.Image) -> list[Image.Image]:
    grayscale = image.convert("L")
    contrasted = ImageOps.autocontrast(grayscale)
    sharpened = contrasted.filter(ImageFilter.SHARPEN)
    return [
        image.convert("RGB"),
        sharpened.resize((sharpened.width * 2, sharpened.height * 2)).convert("RGB"),
        sharpened.resize((sharpened.width * 3, sharpened.height * 3))
        .point(lambda pixel: 255 if pixel > 150 else 0)
        .convert("RGB"),
    ]

def _clamp_box(box: Iterable[int], width: int, height: int) -> tuple[int, int, int, int] | None:
    values = [int(value) for value in box]
    if len(values) != 4:
        return None
    x1, y1, x2, y2 = values
    x1 = max(0, min(x1, width))
    x2 = max(0, min(x2, width))
    y1 = max(0, min(y1, height))
    y2 = max(0, min(y2, height))
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2

def _box_iou(left: tuple[int, int, int, int], right: tuple[int, int, int, int]) -> float:
    inter_x1 = max(left[0], right[0])
    inter_y1 = max(left[1], right[1])
    inter_x2 = min(left[2], right[2])
    inter_y2 = min(left[3], right[3])
    if inter_x2 <= inter_x1 or inter_y2 <= inter_y1:
        return 0.0
    intersection = (inter_x2 - inter_x1) * (inter_y2 - inter_y1)
    left_area = (left[2] - left[0]) * (left[3] - left[1])
    right_area = (right[2] - right[0]) * (right[3] - right[1])
    union = left_area + right_area - intersection
    if union <= 0:
        return 0.0
    return intersection / union

def _prepare_detection_boxes(
    boxes: Iterable[Iterable[int]],
    width: int,
    height: int,
) -> list[tuple[int, int, int, int]]:
    normalized: list[tuple[int, int, int, int]] = []
    for box in boxes:
        clamped = _clamp_box(box, width, height)
        if clamped is None:
            continue
        x1, y1, x2, y2 = clamped
        if (x2 - x1) < CLICK_WORD_MIN_BOX_EDGE or (y2 - y1) < CLICK_WORD_MIN_BOX_EDGE:
            continue
        normalized.append(clamped)
    normalized.sort(key=lambda item: (item[1], item[0], item[2] - item[0], item[3] - item[1]))
    filtered: list[tuple[int, int, int, int]] = []
    for box in normalized:
        if any(_box_iou(box, existing) >= CLICK_WORD_IOU_THRESHOLD for existing in filtered):
            continue
        filtered.append(box)
    return filtered

def _expand_box(
    box: tuple[int, int, int, int],
    width: int,
    height: int,
    padding: int | None = None,
) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = box
    if padding is None:
        edge = min(x2 - x1, y2 - y1)
        padding = max(
            CLICK_WORD_BOX_PADDING,
            min(CLICK_WORD_MAX_BOX_PADDING, int(round(edge * 0.18))),
        )
    return (
        max(0, x1 - padding),
        max(0, y1 - padding),
        min(width, x2 + padding),
        min(height, y2 + padding),
    )

def _append_unique(target: list[str], values: Iterable[str]) -> None:
    for value in values:
        text = str(value).strip()
        if text and text not in target:
            target.append(text)

def _classify_crops_with_paddle(
    crops: list[Image.Image],
    *,
    variant_indexes: tuple[int, ...] = PADDLE_VARIANT_INDEXES,
) -> list[list[str]]:
    if not crops:
        return []
    recognizer = _get_paddle_recognizer()
    import numpy as np

    model_inputs: list[object] = []
    mapping: list[int] = []
    for crop_index, crop in enumerate(crops):
        variants = _classification_variants(crop)
        for index in variant_indexes:
            if index >= len(variants):
                continue
            model_inputs.append(np.array(variants[index].convert("RGB")))
            mapping.append(crop_index)
    if not model_inputs:
        return [[] for _ in crops]
    outputs = list(recognizer.predict(input=model_inputs))
    recognized_by_crop: list[list[str]] = [[] for _ in crops]
    for crop_index, result in zip(mapping, outputs):
        text = ""
        if hasattr(result, "get"):
            text = str(result.get("rec_text") or "").strip()
        if text and text not in recognized_by_crop[crop_index]:
            recognized_by_crop[crop_index].append(text)
    return recognized_by_crop

def _classify_crop(
    crop: Image.Image,
    *,
    charset_range: list[str] | None = None,
    variant_indexes: tuple[int, ...] | None = None,
) -> list[str]:
    _, classifier = _get_ddddocr_engines()
    texts: list[str] = []
    seen: set[str] = set()
    full_charset: list[str] | None = None
    variants = _classification_variants(crop)
    if variant_indexes is None:
        selected_variants = variants
    else:
        selected_variants = [variants[index] for index in variant_indexes]
    if charset_range:
        full_charset = classifier.get_charset()
        classifier.set_ranges(charset_range)
    try:
        for variant in selected_variants:
            buffer = io.BytesIO()
            variant.save(buffer, format="PNG")
            text = classifier.classification(buffer.getvalue()).strip()
            if text not in seen:
                texts.append(text)
                seen.add(text)
    finally:
        if full_charset is not None:
            classifier.set_ranges(full_charset)
    return texts

def _classify_crop_probabilities(
    crop: Image.Image,
    *,
    charset_range: list[str] | None = None,
    variant_indexes: tuple[int, ...] | None = None,
    top_k: int = CLICK_WORD_PROBABILITY_TOP_K,
) -> list[str]:
    _, classifier = _get_ddddocr_engines()
    texts: list[str] = []
    full_charset: list[str] | None = None
    variants = _classification_variants(crop)
    if variant_indexes is None:
        selected_variants = variants
    else:
        selected_variants = [variants[index] for index in variant_indexes if index < len(variants)]
    if charset_range:
        full_charset = classifier.get_charset()
        classifier.set_ranges(charset_range)
    try:
        for variant in selected_variants:
            buffer = io.BytesIO()
            variant.save(buffer, format="PNG")
            try:
                result = classifier.classification(buffer.getvalue(), probability=True)
            except TypeError:
                break
            if not isinstance(result, dict):
                continue
            charsets = result.get("charsets")
            probabilities = result.get("probability")
            if not isinstance(charsets, list) or not isinstance(probabilities, list) or not probabilities:
                continue
            first_step = probabilities[0]
            if not isinstance(first_step, list):
                continue
            ranked_indexes = sorted(
                range(len(first_step)),
                key=lambda index: first_step[index],
                reverse=True,
            )
            top_values: list[str] = []
            for index in ranked_indexes:
                if index >= len(charsets):
                    continue
                value = str(charsets[index]).strip()
                if not value or value in top_values:
                    continue
                top_values.append(value)
                if len(top_values) >= top_k:
                    break
            _append_unique(texts, top_values)
    finally:
        if full_charset is not None:
            classifier.set_ranges(full_charset)
    return texts

def _candidate_indexes_for_target(
    target: str,
    recognitions: list[ClickWordRecognition],
) -> list[int]:
    exact = [
        index
        for index, recognition in enumerate(recognitions)
        if target in recognition.recognized_texts
    ]
    if exact:
        return exact
    confusion_values = COMMON_CONFUSION_MAP.get(target) or set()
    if not confusion_values:
        return []
    return [
        index
        for index, recognition in enumerate(recognitions)
        if any(value in recognition.recognized_texts for value in confusion_values)
    ]

def _resolve_target_assignments(
    targets: list[str],
    recognitions: list[ClickWordRecognition],
) -> dict[str, int] | None:
    candidates = {
        target: _candidate_indexes_for_target(target, recognitions)
        for target in targets
    }
    ordered_targets = sorted(targets, key=lambda item: (len(candidates[item]), item))
    assignments: dict[str, int] = {}
    used_indexes: set[int] = set()

    def backtrack(position: int) -> bool:
        if position >= len(ordered_targets):
            return True
        target = ordered_targets[position]
        for index in candidates[target]:
            if index in used_indexes:
                continue
            assignments[target] = index
            used_indexes.add(index)
            if backtrack(position + 1):
                return True
            used_indexes.remove(index)
            assignments.pop(target, None)
        return False

    if not backtrack(0):
        return None
    return assignments

def _missing_targets(
    targets: list[str],
    recognitions: list[ClickWordRecognition],
) -> list[str]:
    return [
        target
        for target in targets
        if not any(target in recognition.recognized_texts for recognition in recognitions)
    ]

def _build_rescue_charset(targets: list[str]) -> list[str]:
    charset: list[str] = []
    _append_unique(charset, targets)
    for target in targets:
        _append_unique(charset, sorted(COMMON_CONFUSION_MAP.get(target) or set()))
    return charset

def _apply_dddd_rescue(
    crops: list[Image.Image],
    recognitions: list[ClickWordRecognition],
    targets: list[str],
) -> None:
    unresolved_targets = _missing_targets(targets, recognitions)
    if not unresolved_targets:
        return
    rescue_charset = _build_rescue_charset(unresolved_targets)
    if not rescue_charset:
        return
    probability_variants = FAST_VARIANT_INDEXES + EXTRA_VARIANT_INDEXES
    for crop, recognition in zip(crops, recognitions):
        rescue_texts = _classify_crop(
            crop,
            charset_range=rescue_charset,
            variant_indexes=probability_variants,
        )
        _append_unique(recognition.recognized_texts, rescue_texts)
        probability_texts = _classify_crop_probabilities(
            crop,
            charset_range=rescue_charset,
            variant_indexes=probability_variants,
        )
        _append_unique(recognition.recognized_texts, probability_texts)

def _detect_click_word_boxes(
    image: Image.Image,
    *,
    expected_word_count: int,
) -> list[tuple[int, int, int, int]]:
    detector, _ = _get_ddddocr_engines()
    merged_boxes: list[tuple[int, int, int, int]] = []
    detection_variants = _detection_variants(image)
    minimum_boxes = max(expected_word_count, 1)
    for index, variant in enumerate(detection_variants):
        buffer = io.BytesIO()
        variant.save(buffer, format="PNG")
        raw_boxes = detector.detection(buffer.getvalue()) or []
        candidate_boxes = _prepare_detection_boxes(raw_boxes, variant.width, variant.height)
        scale_x = image.width / variant.width
        scale_y = image.height / variant.height
        for box in candidate_boxes:
            scaled_box = (
                int(round(box[0] * scale_x)),
                int(round(box[1] * scale_y)),
                int(round(box[2] * scale_x)),
                int(round(box[3] * scale_y)),
            )
            merged_boxes.append(scaled_box)
        merged_boxes = _prepare_detection_boxes(merged_boxes, image.width, image.height)
        if index == 0 and len(merged_boxes) >= minimum_boxes:
            return merged_boxes
    return merged_boxes

def solve_click_word_challenge(
    challenge: CaptchaChallenge,
) -> ClickWordSolveResult:
    if challenge.captcha_type != DEFAULT_CLICK_WORD_TYPE:
        raise CaptchaError(
            f"Auto solver currently supports only '{DEFAULT_CLICK_WORD_TYPE}', got '{challenge.captcha_type}'."
        )
    image_bytes = decode_image_base64(challenge.original_image_base64)
    if not image_bytes:
        raise CaptchaError("Captcha challenge does not contain image data.")
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    boxes = _detect_click_word_boxes(
        image,
        expected_word_count=len(challenge.word_list),
    )
    if not boxes:
        raise CaptchaError(
            "Detector did not return any usable click-word boxes.",
            challenge=challenge,
            failure_type="no_boxes",
        )
    crops: list[Image.Image] = []
    recognitions: list[ClickWordRecognition] = []
    for box in boxes:
        crop_box = _expand_box(box, image.width, image.height)
        crop = image.crop(crop_box)
        crops.append(crop)
        recognitions.append(
            ClickWordRecognition(
                box=[int(box[0]), int(box[1]), int(box[2]), int(box[3])],
                crop_box=[int(crop_box[0]), int(crop_box[1]), int(crop_box[2]), int(crop_box[3])],
                recognized_texts=[],
            )
        )
    for crop, recognition in zip(crops, recognitions):
        fast_texts = _classify_crop(crop, variant_indexes=FAST_VARIANT_INDEXES)
        _append_unique(recognition.recognized_texts, fast_texts)
    _apply_dddd_rescue(crops, recognitions, challenge.word_list)
    if _missing_targets(challenge.word_list, recognitions):
        paddle_texts = _classify_crops_with_paddle(crops)
        for recognition, texts in zip(recognitions, paddle_texts):
            _append_unique(recognition.recognized_texts, texts)
    assignments = _resolve_target_assignments(challenge.word_list, recognitions)
    if assignments is None:
        missing_targets = _missing_targets(challenge.word_list, recognitions)
        unresolved_target = next(
            (
                target
                for target in challenge.word_list
                if not _candidate_indexes_for_target(target, recognitions)
            ),
            challenge.word_list[0] if challenge.word_list else "",
        )
        details = [
            {
                "box": item.box,
                "crop_box": item.crop_box,
                "recognized_texts": item.recognized_texts,
            }
            for item in recognitions
        ]
        raise CaptchaError(
            f"Failed to resolve click-word target '{unresolved_target}'. Recognition details: {details}",
            challenge=challenge,
            recognitions=recognitions,
            failure_type="recognition_miss" if missing_targets else "matching_conflict",
        )
    points: list[ClickPoint] = []
    for target in challenge.word_list:
        match_index = assignments.get(target, -1)
        if match_index < 0:
            details = [
                {
                    "box": item.box,
                    "crop_box": item.crop_box,
                    "recognized_texts": item.recognized_texts,
                }
                for item in recognitions
            ]
            raise CaptchaError(
                f"Failed to resolve click-word target '{target}'. Recognition details: {details}",
                challenge=challenge,
                recognitions=recognitions,
                failure_type="matching_conflict",
            )
        x1, y1, x2, y2 = recognitions[match_index].box
        points.append(ClickPoint(x=(x1 + x2) // 2, y=(y1 + y2) // 2))
    return ClickWordSolveResult(
        challenge=challenge,
        points=points,
        recognitions=recognitions,
    )


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()

if __name__ == "__main__":
    try:
        with contextlib.redirect_stdout(sys.stderr):
            seconds = prewarm_click_word_solver()
        emit({"ready": True, "warmupSeconds": round(seconds, 3)})
        if "--check" not in sys.argv and "--setup" not in sys.argv:
            for line in sys.stdin:
                try:
                    request = json.loads(line)
                    with contextlib.redirect_stdout(sys.stderr):
                        result = solve_click_word_challenge(CaptchaChallenge(request["image"], request["words"]))
                    emit({"points": [{"x": p.x, "y": p.y} for p in result.points]})
                except Exception as exc:
                    emit({"error": str(exc)[:400]})
    except Exception as exc:
        emit({"error": str(exc)[:400]})
        sys.exit(1)
