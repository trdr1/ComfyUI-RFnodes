import copy
import json
import os
import re

from PIL import Image
import folder_paths

# 画像ファイルのメタデータから「元プロンプト」を取り出す共通処理。
# web/inpaint_canvas.js の loadMeta と同じ優先順位で探索する。

CARRIER_TYPE = "RFPromptCarrierNode"
_CHAR_RE = re.compile(r"1girl\s*,")


def _non_empty(v):
    return isinstance(v, str) and v.strip() != ""


def _loads(s):
    if not _non_empty(s):
        return None
    try:
        return json.loads(s)
    except Exception:
        return None


def resolve_image_path(value):
    """フォルダ読み込みノードの image_path(文字列 or その配列)を実在するファイルパスにする。無ければ空文字。"""
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    if not isinstance(value, str):
        return ""
    p = value.strip().strip('"')
    if not p:
        return ""
    candidates = [p]
    if not os.path.isabs(p):
        for base in (
            getattr(folder_paths, "base_path", None),
            folder_paths.get_output_directory(),
            folder_paths.get_input_directory(),
        ):
            if base:
                candidates.append(os.path.join(base, p))
    for c in candidates:
        if os.path.isfile(c):
            return c
    return ""


def read_text_info(path):
    try:
        with Image.open(path) as im:
            return {k: v for k, v in dict(im.info).items() if isinstance(v, str)}
    except Exception as e:
        print(f"[RFNodes] メタデータの読み取りに失敗しました: {path}: {e}")
        return {}


def _find_original_in_prompt(prompt_obj):
    if not isinstance(prompt_obj, dict):
        return ""
    nodes = [
        n for n in prompt_obj.values()
        if isinstance(n, dict) and isinstance(n.get("inputs"), dict) and n.get("class_type") != CARRIER_TYPE
    ]
    for n in nodes:
        if n.get("class_type") == "ImpactWildcardProcessor" and _non_empty(n["inputs"].get("populated_text")):
            return n["inputs"]["populated_text"]
    for n in nodes:
        for k, v in n["inputs"].items():
            if k == "wildcard_text":
                continue
            if isinstance(v, str) and _CHAR_RE.search(v):
                return v
    return ""


def _find_original_in_workflow(wf):
    if not isinstance(wf, dict) or not isinstance(wf.get("nodes"), list):
        return ""
    nodes = [n for n in wf["nodes"] if isinstance(n, dict) and n.get("type") != CARRIER_TYPE]
    for n in nodes:
        wv = n.get("widgets_values")
        if n.get("type") == "ImpactWildcardProcessor" and isinstance(wv, list) and len(wv) > 1 and _non_empty(wv[1]):
            return wv[1]
    for n in nodes:
        wv = n.get("widgets_values")
        if isinstance(wv, list):
            for v in wv:
                if isinstance(v, str) and not v.startswith("data:image") and _CHAR_RE.search(v):
                    return v
    return ""


def _extract_a1111(param_str):
    if not _non_empty(param_str):
        return ""
    idx = param_str.find("Negative prompt:")
    positive = param_str[:idx] if idx != -1 else param_str
    return positive.strip()


def _find_carrier_in_prompt(prompt_obj):
    if not isinstance(prompt_obj, dict):
        return ""
    for n in prompt_obj.values():
        if isinstance(n, dict) and n.get("class_type") == CARRIER_TYPE and isinstance(n.get("inputs"), dict):
            if _non_empty(n["inputs"].get("prompt_text")):
                return n["inputs"]["prompt_text"]
    return ""


def _find_carrier_in_workflow(wf):
    if not isinstance(wf, dict) or not isinstance(wf.get("nodes"), list):
        return ""
    for n in wf["nodes"]:
        if isinstance(n, dict) and n.get("type") == CARRIER_TYPE and isinstance(n.get("widgets_values"), list):
            for v in n["widgets_values"]:
                if _non_empty(v):
                    return v
    return ""


def extract_original_prompt(path):
    """画像ファイルのメタデータから元プロンプトを返す。見つからなければ空文字。"""
    info = read_text_info(path)
    if not info:
        return ""

    text = ""
    obj = _loads(info.get("prompt"))
    if obj is not None:
        text = _find_original_in_prompt(obj)
    if not text:
        obj = _loads(info.get("workflow"))
        if obj is not None:
            text = _find_original_in_workflow(obj)
    if not text and info.get("parameters"):
        text = _extract_a1111(info["parameters"])
    if not text:
        for key in ("comfy_inpaint_prompt", "prompt", "comfy_workflow", "workflow"):
            obj = _loads(info.get(key))
            if obj is None:
                continue
            text = _find_carrier_in_prompt(obj) or _find_carrier_in_workflow(obj)
            if text:
                break
    return text or ""


def inject_carrier_text(prompt, extra_pnginfo, text):
    """保存メタデータ(prompt / workflow)内の元プロンプトノードの値を text に差し替えたコピーを返す。"""
    text = text or ""

    new_prompt = copy.deepcopy(prompt) if prompt is not None else None
    if isinstance(new_prompt, dict):
        for n in new_prompt.values():
            if isinstance(n, dict) and n.get("class_type") == CARRIER_TYPE and isinstance(n.get("inputs"), dict):
                n["inputs"]["prompt_text"] = text

    new_extra = copy.deepcopy(extra_pnginfo) if extra_pnginfo is not None else None
    wf = new_extra.get("workflow") if isinstance(new_extra, dict) else None
    if isinstance(wf, dict) and isinstance(wf.get("nodes"), list):
        for n in wf["nodes"]:
            if isinstance(n, dict) and n.get("type") == CARRIER_TYPE:
                n["widgets_values"] = [text]
                if isinstance(n.get("widgets_values_named"), dict):
                    n["widgets_values_named"]["prompt_text"] = text

    return new_prompt, new_extra