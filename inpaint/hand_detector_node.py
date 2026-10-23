import os
import urllib.request
import shutil
import torch
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import folder_paths

MODEL_URL = "https://huggingface.co/Bingsu/adetailer/resolve/main/hand_yolov8s.pt"
MODEL_FILENAME = "hand_yolov8s.pt"

def _get_model_path():
    yolo_dir = os.path.join(folder_paths.models_dir, "yolo")
    os.makedirs(yolo_dir, exist_ok=True)
    target_path = os.path.join(yolo_dir, MODEL_FILENAME)
    if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
        return target_path

    temp_path = target_path + ".tmp"
    try:
        req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req) as resp, open(temp_path, "wb") as f:
            shutil.copyfileobj(resp, f)
        os.replace(temp_path, target_path)
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise RuntimeError(f"Failed to download hand_yolov8s.pt: {e}")
    return target_path

_LOADED_MODEL = None

def _get_yolo_model():
    global _LOADED_MODEL
    if _LOADED_MODEL is not None:
        return _LOADED_MODEL
    try:
        from ultralytics import YOLO
    except ImportError:
        raise ImportError("ultralytics is required for hand detection. Please run: pip install ultralytics")
    model_path = _get_model_path()
    _LOADED_MODEL = YOLO(model_path)
    return _LOADED_MODEL

class RFHandDetectorNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "threshold": ("FLOAT", {"default": 0.35, "min": 0.05, "max": 1.0, "step": 0.05}),
                "padding": ("INT", {"default": 16, "min": 0, "max": 256, "step": 2}),
                "max_hands": ("INT", {"default": 4, "min": 1, "max": 20, "step": 1}),
                "mask_blur": ("INT", {"default": 8, "min": 0, "max": 64, "step": 2}),
            }
        }

    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("mask", "preview_image")
    FUNCTION = "detect"
    CATEGORY = "RFNodes/Inpaint"

    def detect(self, image, threshold, padding, max_hands, mask_blur):
        model = _get_yolo_model()
        masks = []
        previews = []

        for i in range(len(image)):
            np_img = (image[i].cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            pil_img = Image.fromarray(np_img)
            w, h = pil_img.size

            results = model.predict(source=pil_img, conf=threshold, verbose=False)
            boxes = []
            if results and len(results) > 0 and results[0].boxes is not None:
                for b in results[0].boxes:
                    conf = float(b.conf[0].item())
                    xyxy = b.xyxy[0].cpu().numpy().tolist()
                    boxes.append((conf, xyxy))

            boxes.sort(key=lambda x: x[0], reverse=True)
            boxes = boxes[:max_hands]

            mask_img = Image.new("L", (w, h), 0)
            mask_draw = ImageDraw.Draw(mask_img)

            preview_img = pil_img.copy()
            preview_draw = ImageDraw.Draw(preview_img)

            for conf, (x1, y1, x2, y2) in boxes:
                bx1 = max(0, int(x1) - padding)
                by1 = max(0, int(y1) - padding)
                bx2 = min(w, int(x2) + padding)
                by2 = min(h, int(y2) + padding)

                mask_draw.rectangle([bx1, by1, bx2, by2], fill=255)
                preview_draw.rectangle([bx1, by1, bx2, by2], outline="lime", width=3)
                label = f"hand {conf:.2f}"
                preview_draw.text((bx1 + 2, max(0, by1 - 12)), label, fill="lime")

            if mask_blur > 0:
                mask_img = mask_img.filter(ImageFilter.GaussianBlur(mask_blur))

            m_arr = np.array(mask_img).astype(np.float32) / 255.0
            masks.append(torch.from_numpy(m_arr))

            p_arr = np.array(preview_img).astype(np.float32) / 255.0
            previews.append(torch.from_numpy(p_arr))

        out_mask = torch.stack(masks, dim=0)
        out_preview = torch.stack(previews, dim=0)
        return (out_mask, out_preview)