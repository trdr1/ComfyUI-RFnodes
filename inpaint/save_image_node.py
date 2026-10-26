import os
import json
import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo
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


def _safe_stem(path):
    """入力画像のファイル名(拡張子なし)を、ファイル名に使える形にする"""
    stem = os.path.splitext(os.path.basename(str(path)))[0]
    for ch in '<>:"/\\|?*':
        stem = stem.replace(ch, "_")
    return stem.strip(" .") or "image"


def _mask_to_image(mask):
    """MASK テンソル(B,H,W または H,W)の先頭1枚を 8bit グレースケール画像にする"""
    m = mask
    if hasattr(m, "dim") and m.dim() == 3:
        m = m[0]
    arr = np.clip(255.0 * m.cpu().numpy(), 0, 255).astype(np.uint8)
    return Image.fromarray(arr)


class RFSaveImagePreserveMeta:
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"
        self.prefix_append = ""

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
        return {
            "required": {
                "images": ("IMAGE",),
                "original_image_name": (sorted(files),),
                "filename_prefix": ("STRING", {"default": "inpaint/result"}),
            },
            "optional": {
                # フォルダ連続処理用: 読み込み中の画像パス。接続すると original_image_name より優先し、
                # そのファイルのメタデータを引き継いで保存する
                "original_image_path": ("STRING", {"default": "", "forceInput": True}),
                # 修正対象のマスク(手の検出マスクなど)。接続すると結果と同じ場所にマスク画像とinfo.jsonを保存する
                "mask": ("MASK",),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "RFNodes/Inpaint"

    def save_images(self, images, original_image_name, filename_prefix="inpaint/result", prompt=None, extra_pnginfo=None, original_image_path=None, mask=None):
        if original_image_path is not None:
            # フォルダ連続処理: 読み込み中の画像を元画像として扱う
            pm = _prompt_meta()
            orig_path = pm.resolve_image_path(original_image_path)
            if not orig_path:
                raise FileNotFoundError(f"Original image file not found: {original_image_path}")
            # 保存メタデータ内の元プロンプトノードを、この画像から読み取ったプロンプトに揃える
            prompt, extra_pnginfo = pm.inject_carrier_text(
                prompt, extra_pnginfo, pm.extract_original_prompt(orig_path)
            )
        else:
            orig_path = folder_paths.get_annotated_filepath(original_image_name)
        if not os.path.exists(orig_path):
            raise FileNotFoundError(f"Original image file not found: {orig_path}")

        # 入力画像名をファイル名に含める: <prefix>_<入力画像名>_00001_.png
        src_stem = _safe_stem(orig_path)
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            f"{filename_prefix}_{src_stem}", self.output_dir, images[0].shape[1], images[0].shape[0]
        )

        with Image.open(orig_path) as orig_img:
            orig_info = dict(orig_img.info)
            orig_exif = orig_img.getexif()

        # この実行で保存する結果ファイル名(同じ実行の結果は同じマスクを共有する)
        first_counter = counter
        result_files = [f"{filename}_{first_counter + i:05}_.png" for i in range(len(images))]

        mask_file = ""
        if mask is not None:
            mask_file = f"{filename}_{first_counter:05}_mask.png"
            mask_img = _mask_to_image(mask)
            mask_meta = PngInfo()
            mask_meta.add_text("rf_source_image", orig_path)
            mask_meta.add_text("rf_source_name", os.path.basename(orig_path))
            mask_meta.add_text("rf_source_stem", src_stem)
            mask_meta.add_text("rf_result_files", json.dumps(result_files, ensure_ascii=False))
            mask_img.save(os.path.join(full_output_folder, mask_file), pnginfo=mask_meta)

        # マスクと結果と元画像の対応表(後から解析するスクリプト用)
        info_file = f"{filename}_{first_counter:05}_info.json"
        info = {
            "source_image": orig_path,
            "source_name": os.path.basename(orig_path),
            "source_stem": src_stem,
            "image_size": [int(images[0].shape[1]), int(images[0].shape[0])],
            "mask_file": mask_file,
            "result_files": result_files,
            "subfolder": subfolder,
        }
        with open(os.path.join(full_output_folder, info_file), "w", encoding="utf-8") as f:
            json.dump(info, f, ensure_ascii=False, indent=2)

        results = []
        for batch_number, image in enumerate(images):
            i = 255.0 * image.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

            metadata = PngInfo()
            for k, v in orig_info.items():
                # rf_ で始まるキーはこのノードが毎回書き直すので、元画像のものは引き継がない
                if isinstance(v, (str, bytes)) and not str(k).startswith("rf_"):
                    metadata.add_text(k, str(v))

            # 結果画像からも元画像・マスクを辿れるようにする
            metadata.add_text("rf_source_image", orig_path)
            metadata.add_text("rf_source_name", os.path.basename(orig_path))
            metadata.add_text("rf_source_stem", src_stem)
            metadata.add_text("rf_mask_file", mask_file)
            metadata.add_text("rf_info_file", info_file)
            metadata.add_text("rf_batch_index", str(batch_number))

            if prompt is not None:
                metadata.add_text("comfy_inpaint_prompt", json.dumps(prompt))
            if extra_pnginfo is not None:
                for x in extra_pnginfo:
                    metadata.add_text(f"comfy_{x}", json.dumps(extra_pnginfo[x]))

            file = f"{filename}_{counter:05}_.png"
            save_path = os.path.join(full_output_folder, file)

            save_kwargs = {"pnginfo": metadata}
            if orig_exif:
                save_kwargs["exif"] = orig_exif

            img.save(save_path, compress_level=4, **save_kwargs)
            results.append({
                "filename": file,
                "subfolder": subfolder,
                "type": self.type
            })
            counter += 1

        return {"ui": {"images": results}}