import os
import sys
import subprocess
import urllib.request
import shutil
import torch
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import folder_paths

DEFAULT_MODEL_URL = "https://huggingface.co/Bingsu/adetailer/resolve/main/hand_yolov8s.pt"
DEFAULT_MODEL_FILENAME = "hand_yolov8s.pt"

def _get_yolo_dir():
    yolo_dir = os.path.join(folder_paths.models_dir, "yolo")
    os.makedirs(yolo_dir, exist_ok=True)
    return yolo_dir

def _get_available_models():
    yolo_dir = _get_yolo_dir()
    files = [f for f in os.listdir(yolo_dir) if f.endswith(".pt")]
    if DEFAULT_MODEL_FILENAME not in files:
        files.insert(0, DEFAULT_MODEL_FILENAME)
    return sorted(files)

def _resolve_model_path(model_filename: str):
    yolo_dir = _get_yolo_dir()
    target_path = os.path.join(yolo_dir, model_filename)
    if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
        return target_path

    if model_filename == DEFAULT_MODEL_FILENAME:
        temp_path = target_path + ".tmp"
        try:
            req = urllib.request.Request(DEFAULT_MODEL_URL, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req) as resp, open(temp_path, "wb") as f:
                shutil.copyfileobj(resp, f)
            os.replace(temp_path, target_path)
            return target_path
        except Exception as e:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise RuntimeError(f"Failed to download default YOLO model {DEFAULT_MODEL_FILENAME}: {e}")

    raise FileNotFoundError(f"YOLO model file not found in models/yolo: {target_path}")

_CACHED_MODELS = {}

def _get_yolo_model(model_filename: str):
    global _CACHED_MODELS
    if model_filename in _CACHED_MODELS:
        return _CACHED_MODELS[model_filename]

    try:
        from ultralytics import YOLO
    except ImportError:
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", "ultralytics"], check=True)
            from ultralytics import YOLO
        except Exception as e:
            raise RuntimeError(f"Automatic installation of ultralytics failed: {e}")

    model_path = _resolve_model_path(model_filename)
    loaded = YOLO(model_path)
    _CACHED_MODELS[model_filename] = loaded
    return loaded

class RFHandDetectorNode:
    @classmethod
    def INPUT_TYPES(cls):
        models = _get_available_models()
        default_model = DEFAULT_MODEL_FILENAME if DEFAULT_MODEL_FILENAME in models else (models[0] if models else "")
        return {
            "required": {
                "image": ("IMAGE",),
                "model_name": (models, {"default": default_model}),
                "threshold": ("FLOAT", {"default": 0.35, "min": 0.05, "max": 1.0, "step": 0.05}),
                "padding": ("INT", {"default": 16, "min": 0, "max": 256, "step": 2}),
                "max_detections": ("INT", {"default": 4, "min": 1, "max": 50, "step": 1}),
                "mask_blur": ("INT", {"default": 8, "min": 0, "max": 64, "step": 2}),
            },
            "optional": {
                "manual_mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("mask", "preview_image")
    FUNCTION = "detect"
    CATEGORY = "RFNodes/Inpaint"

    def detect(self, image, model_name, threshold, padding, max_detections, mask_blur, manual_mask=None):
        model = _get_yolo_model(model_name)
        masks = []
        previews = []

        batch_count = len(image)
        for i in range(batch_count):
            np_img = (image[i].cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            pil_img = Image.fromarray(np_img)
            w, h = pil_img.size

            results = model.predict(source=pil_img, conf=threshold, verbose=False)
            boxes = []
            if results and len(results) > 0 and results[0].boxes is not None:
                for b in results[0].boxes:
                    conf = float(b.conf[0].item())
                    xyxy = b.xyxy[0].cpu().numpy().tolist()
                    cls_id = int(b.cls[0].item()) if b.cls is not None else 0
                    label_name = model.names.get(cls_id, "obj") if hasattr(model, "names") else "obj"
                    boxes.append((conf, xyxy, label_name))

            boxes.sort(key=lambda x: x[0], reverse=True)
            boxes = boxes[:max_detections]

            mask_img = Image.new("L", (w, h), 0)
            mask_draw = ImageDraw.Draw(mask_img)

            preview_img = pil_img.copy()
            preview_draw = ImageDraw.Draw(preview_img)

            for conf, (x1, y1, x2, y2), label_name in boxes:
                bx1 = max(0, int(x1) - padding)
                by1 = max(0, int(y1) - padding)
                bx2 = min(w, int(x2) + padding)
                by2 = min(h, int(y2) + padding)

                mask_draw.rectangle([bx1, by1, bx2, by2], fill=255)
                preview_draw.rectangle([bx1, by1, bx2, by2], outline="lime", width=3)
                label_text = f"{label_name} {conf:.2f}"
                preview_draw.text((bx1 + 2, max(0, by1 - 12)), label_text, fill="lime")

            if mask_blur > 0:
                mask_img = mask_img.filter(ImageFilter.GaussianBlur(mask_blur))

            m_arr = np.array(mask_img).astype(np.float32) / 255.0
            m_tensor = torch.from_numpy(m_arr)

            if manual_mask is not None:
                m_manual = manual_mask[i] if (manual_mask.dim() == 3 and i < len(manual_mask)) else (manual_mask[0] if manual_mask.dim() == 3 else manual_mask)
                if m_manual.shape != m_tensor.shape:
                    import torch.nn.functional as F
                    m_manual_resized = F.interpolate(
                        m_manual.unsqueeze(0).unsqueeze(0),
                        size=(h, w),
                        mode="bilinear",
                        align_corners=False
                    ).squeeze(0).squeeze(0)
                    m_tensor = torch.maximum(m_tensor, m_manual_resized)
                else:
                    m_tensor = torch.maximum(m_tensor, m_manual)

            masks.append(m_tensor)

            p_arr = np.array(preview_img).astype(np.float32) / 255.0
            previews.append(torch.from_numpy(p_arr))

        out_mask = torch.stack(masks, dim=0)
        out_preview = torch.stack(previews, dim=0)
        return (out_mask, out_preview)