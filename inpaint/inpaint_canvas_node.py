import os
import base64
import io
import torch
import numpy as np
from PIL import Image, ImageOps
import folder_paths

_PM = None


def _prompt_meta():
    """同フォルダの prompt_meta.py を読み込む(パッケージ読み込みでも直接読み込みでも動くようにする)"""
    global _PM
    if _PM is not None:
        return _PM
    try:
        from . import prompt_meta as _m
    except Exception:
        import importlib.util
        _p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompt_meta.py")
        _spec = importlib.util.spec_from_file_location("rf_inpaint_prompt_meta", _p)
        _m = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_m)
    _PM = _m
    return _PM


class RFInpaintCanvasNode:
    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
        return {
            "required": {
                "image": (sorted(files), {"image_upload": True}),
                "mask_data": ("STRING", {"default": "", "multiline": False}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "image_path")
    FUNCTION = "process"
    CATEGORY = "RFNodes/Inpaint"

    def process(self, image, mask_data):
        image_path = folder_paths.get_annotated_filepath(image)
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"Image not found: {image_path}")

        img_raw = Image.open(image_path)
        img_raw = ImageOps.exif_transpose(img_raw)
        img = img_raw.convert("RGB")
        img_np = np.array(img).astype(np.float32) / 255.0
        img_tensor = torch.from_numpy(img_np)[None, ...]

        w, h = img.size

        if mask_data and mask_data.startswith("data:image"):
            b64_content = mask_data.split(",", 1)[1]
            mask_bytes = base64.b64decode(b64_content)
            m_img = Image.open(io.BytesIO(mask_bytes)).convert("L")
            if m_img.size != (w, h):
                m_img = m_img.resize((w, h), Image.Resampling.BILINEAR)
            mask_np = np.array(m_img).astype(np.float32) / 255.0
        else:
            mask_np = np.zeros((h, w), dtype=np.float32)

        mask_tensor = torch.from_numpy(mask_np)[None, ...]
        return (img_tensor, mask_tensor, image_path)


class RFPromptCarrierNode:
    """元画像のプロンプト(キャラ・作品名を含む文字列)を、画面で確認できる形で持つノード。
    テキストはウィジェット値なので、ComfyUIが保存する prompt/workflow メタデータにそのまま残る。
    OUTPUT_NODE なので、配線しなくても毎回プロンプトに含まれる。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_text": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                # フォルダ連続処理用: 読み込み中の画像パス(LoadImagesFromFolderKJ の image_path を接続)。
                # 接続すると、その画像のメタデータから元プロンプトを読み取って prompt_text に書き出す。
                "image_path": ("STRING", {"default": "", "forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt_text",)
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "RFNodes/Inpaint"

    def run(self, prompt_text, image_path=None):
        text = prompt_text
        if image_path is not None:
            # image_path が接続されているときは、画像のメタデータを正とする
            # (前の画像のプロンプトが残らないよう、見つからなければ空にする)
            pm = _prompt_meta()
            src = pm.resolve_image_path(image_path)
            text = pm.extract_original_prompt(src) if src else ""
        return {"ui": {"text": [text]}, "result": (text,)}


# __init__.py を編集しなくても使えるよう、ここでComfyUIへ直接登録する
try:
    import nodes as _comfy_nodes

    _comfy_nodes.NODE_CLASS_MAPPINGS.setdefault("RFPromptCarrierNode", RFPromptCarrierNode)
    _comfy_nodes.NODE_DISPLAY_NAME_MAPPINGS.setdefault("RFPromptCarrierNode", "元プロンプト（引き継ぎ）")
except Exception as _e:
    print(f"[RFNodes] RFPromptCarrierNode の登録に失敗しました: {_e}")
