import os
import glob
import torch
import numpy as np
from PIL import Image, ImageOps

class RFDirectoryImageLoaderNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "directory_path": ("STRING", {"default": ""}),
                "index": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1}),
            },
            "optional": {
                "pattern": ("STRING", {"default": "*.png, *.jpg, *.jpeg, *.webp"}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("image", "file_path", "file_name")
    FUNCTION = "load"
    CATEGORY = "RFNodes/Batch"

    def load(self, directory_path, index, pattern="*.png, *.jpg, *.jpeg, *.webp"):
        if not directory_path or not os.path.isdir(directory_path):
            raise FileNotFoundError(f"Directory not found: {directory_path}")

        extensions = [p.strip() for p in pattern.split(",") if p.strip()]
        files = []
        for ext in extensions:
            files.extend(glob.glob(os.path.join(directory_path, ext)))
            files.extend(glob.glob(os.path.join(directory_path, ext.upper())))

        files = sorted(list(set(files)))
        if not files:
            raise RuntimeError(f"No valid image files found in directory: {directory_path}")

        target_file = files[index % len(files)]
        img_raw = Image.open(target_file)
        img_raw = ImageOps.exif_transpose(img_raw)
        img = img_raw.convert("RGB")
        img_np = np.array(img).astype(np.float32) / 255.0
        img_tensor = torch.from_numpy(img_np)[None, ...]

        return (img_tensor, target_file, os.path.basename(target_file))