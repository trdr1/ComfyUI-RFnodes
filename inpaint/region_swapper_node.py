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
                "target_folder": ("STRING", {"default": "inpaint_results", "multiline": False}),
                "active": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "RFNodes/Inpaint"

    def run(self, target_folder="inpaint_results", active=True):
        return {"ui": {"status": [f"Monitoring: {target_folder}"]}}

def _get_view_params(full_path):
    output_dir = os.path.abspath(folder_paths.get_output_directory())
    input_dir = os.path.abspath(folder_paths.get_input_directory())
    abs_path = os.path.abspath(full_path)

    try:
        rel_out = os.path.relpath(abs_path, output_dir)
        if not rel_out.startswith(".."):
            sub = os.path.dirname(rel_out).replace("\\", "/")
            return {"filename": os.path.basename(abs_path), "subfolder": sub, "type": "output"}
    except Exception:
        pass

    try:
        rel_in = os.path.relpath(abs_path, input_dir)
        if not rel_in.startswith(".."):
            sub = os.path.dirname(rel_in).replace("\\", "/")
            return {"filename": os.path.basename(abs_path), "subfolder": sub, "type": "input"}
    except Exception:
        pass

    raise FileNotFoundError(f"File is outside ComfyUI input/output directories: {full_path}")

def get_latest_sessions(folder="inpaint_results", limit=25):
    output_dir = folder_paths.get_output_directory()
    clean_folder = (folder or "inpaint_results").strip().strip("/\\")
    search_dir = os.path.join(output_dir, clean_folder)
    if not os.path.isdir(search_dir):
        return []

    pattern = os.path.join(search_dir, "*_mask.png")
    mask_files = glob.glob(pattern)
    if not mask_files:
        return []
    mask_files.sort(key=os.path.getmtime, reverse=True)

    sessions = []
    for m_path in mask_files[:limit]:
        if not os.path.exists(m_path) or os.path.getsize(m_path) == 0:
            continue

        try:
            with Image.open(m_path) as m_img:
                info_meta = dict(m_img.info)
        except Exception as e:
            raise RuntimeError(f"Failed to read mask image metadata: {m_path}: {e}")

        session_dir = os.path.dirname(m_path)
        orig_file = info_meta.get("rf_orig_file", os.path.basename(m_path).replace("_mask.png", "_orig.png"))
        orig_full = os.path.join(session_dir, orig_file)

        if os.path.exists(orig_full):
            orig_path = orig_full
            orig_view = {"filename": orig_file, "subfolder": clean_folder, "type": "output"}
        else:
            orig_path = info_meta.get("rf_source_image", "")
            if not orig_path or not os.path.exists(orig_path):
                continue
            orig_view = _get_view_params(orig_path)

        raw_results = info_meta.get("rf_result_files")
        if raw_results:
            try:
                result_filenames = json.loads(raw_results)
            except Exception:
                result_filenames = []
        else:
            base_prefix = os.path.basename(m_path).replace("_mask.png", "")
            matched = glob.glob(os.path.join(session_dir, f"{base_prefix}_*.png"))
            result_filenames = [os.path.basename(x) for x in matched if not x.endswith("_mask.png") and not x.endswith("_orig.png")]

        valid_result_paths = []
        for rf in result_filenames:
            full_r = os.path.join(session_dir, rf)
            if os.path.exists(full_r) and not full_r.endswith("_orig.png"):
                valid_result_paths.append(full_r)

        if not valid_result_paths:
            continue

        mask_view = {"filename": os.path.basename(m_path), "subfolder": clean_folder, "type": "output"}
        result_views = [{"filename": os.path.basename(rp), "subfolder": clean_folder, "type": "output"} for rp in valid_result_paths]

        label = f"{orig_view['filename']} [{os.path.basename(m_path).replace('.png', '')}] ({len(result_views)}枚)"
        sessions.append({
            "mask_path": m_path,
            "source_image": orig_path,
            "orig_view": orig_view,
            "mask_view": mask_view,
            "result_views": result_views,
            "label": label,
        })
    return sessions

def compose_and_save(mask_path, assignments):
    if not os.path.exists(mask_path):
        raise FileNotFoundError(f"Mask file not found: {mask_path}")

    with Image.open(mask_path) as m_img:
        info_meta = dict(m_img.info)
        full_mask = m_img.convert("L")

    orig_path = info_meta.get("rf_source_image", "")
    if not orig_path or not os.path.exists(orig_path):
        raise FileNotFoundError(f"Original source image not found: {orig_path}")

    session_dir = os.path.dirname(mask_path)
    raw_results = info_meta.get("rf_result_files")
    if raw_results:
        result_filenames = json.loads(raw_results)
    else:
        base_prefix = os.path.basename(mask_path).replace("_mask.png", "")
        matched = glob.glob(os.path.join(session_dir, f"{base_prefix}_*.png"))
        result_filenames = [os.path.basename(x) for x in matched if not x.endswith("_mask.png")]

    result_paths = [os.path.join(session_dir, rf) for rf in result_filenames]
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