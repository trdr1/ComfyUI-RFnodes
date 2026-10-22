import os
import base64
import io
import torch
import numpy as np
from PIL import Image, ImageOps
import folder_paths

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

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
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
        return (img_tensor, mask_tensor)