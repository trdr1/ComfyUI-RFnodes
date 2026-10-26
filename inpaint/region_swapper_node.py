import os
import json
import glob
import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import folder_paths
from .save_image_node import _prompt_meta, _safe_stem

class RFRegionSwapperNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "active": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "RFNodes/Inpaint"

    def run(self, active=True):
        return {"ui": {"status": ["Active" if active else "Inactive"]}}

def get_latest_sessions(limit=20):
    output_dir = folder_paths.get_output_directory()
    pattern = os.path.join(output_dir, "**", "*_info.json")
    files = glob.glob(pattern, recursive=True)
    if not files:
        return []
    files.sort(key=os.path.getmtime, reverse=True)
    sessions = []
    for fp in files[:limit]:
        try:
            with open(fp, "r", encoding="utf-8") as f:
                data = json.load(f)
            data["info_path"] = fp
            sessions.append(data)
        except Exception as e:
            raise RuntimeError(f"Failed to read session file {fp}: {e}")
    return sessions

def compose_and_save(session_path, assignments):
    if not os.path.exists(session_path):
        raise FileNotFoundError(f"Session info file not found: {session_path}")

    with open(session_path, "r", encoding="utf-8") as f:
        info = json.load(f)

    orig_path = info["source_image"]
    if not os.path.exists(orig_path):
        raise FileNotFoundError(f"Original source image not found: {orig_path}")

    session_dir = os.path.dirname(session_path)
    mask_file = info.get("mask_file")
    mask_path = os.path.join(session_dir, mask_file) if mask_file else ""
    if not os.path.exists(mask_path):
        raise FileNotFoundError(f"Mask file not found: {mask_path}")

    result_files = info.get("result_files", [])
    result_paths = [os.path.join(session_dir, rf) for rf in result_files]
    for rp in result_paths:
        if not os.path.exists(rp):
            raise FileNotFoundError(f"Candidate result image not found: {rp}")

    with Image.open(orig_path) as orig_img:
        orig_img_rgb = orig_img.convert("RGB")
        orig_info = dict(orig_img.info)
        orig_exif = orig_img.getexif()

    width, height = orig_img_rgb.size
    final_img = orig_img_rgb.copy()

    with Image.open(mask_path) as m_img:
        full_mask = m_img.convert("L")
        if full_mask.size != (width, height):
            full_mask = full_mask.resize((width, height), Image.Resampling.BILINEAR)

    loaded_results = {}
    for assign in assignments:
        candidate_idx = assign.get("candidate_idx", 0)
        if candidate_idx == 0:
            continue
        result_idx = candidate_idx - 1
        if result_idx < 0 or result_idx >= len(result_paths):
            raise IndexError(f"Candidate index out of range: {candidate_idx}")

        if result_idx not in loaded_results:
            with Image.open(result_paths[result_idx]) as c_img:
                c_rgb = c_img.convert("RGB")
                if c_rgb.size != (width, height):
                    c_rgb = c_rgb.resize((width, height), Image.Resampling.BILINEAR)
                loaded_results[result_idx] = c_rgb
        patch_source = loaded_results[result_idx]

        bbox = assign.get("bbox")
        if not bbox or len(bbox) != 4:
            raise ValueError(f"Invalid bbox in assignment: {bbox}")

        bx1, by1, bx2, by2 = bbox
        bx1 = max(0, min(width - 1, int(bx1)))
        by1 = max(0, min(height - 1, int(by1)))
        bx2 = max(bx1 + 1, min(width, int(bx2)))
        by2 = max(by1 + 1, min(height, int(by2)))

        region_crop_mask = full_mask.crop((bx1, by1, bx2, by2))
        patch_crop = patch_source.crop((bx1, by1, bx2, by2))
        final_img.paste(patch_crop, (bx1, by1), region_crop_mask)

    src_stem = _safe_stem(orig_path)
    output_dir = folder_paths.get_output_directory()
    full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        f"swapped_{src_stem}", output_dir, width, height
    )

    metadata = PngInfo()
    for k, v in orig_info.items():
        if isinstance(v, (str, bytes)) and not str(k).startswith("rf_"):
            metadata.add_text(k, str(v))

    metadata.add_text("rf_source_image", orig_path)
    metadata.add_text("rf_composed_from_session", session_path)
    metadata.add_text("rf_assignments", json.dumps(assignments, ensure_ascii=False))

    save_filename = f"{filename}_{counter:05}_.png"
    save_path = os.path.join(full_output_folder, save_filename)

    save_kwargs = {"pnginfo": metadata}
    if orig_exif:
        save_kwargs["exif"] = orig_exif

    final_img.save(save_path, compress_level=4, **save_kwargs)
    return {
        "filename": save_filename,
        "subfolder": subfolder,
        "full_path": save_path
    }