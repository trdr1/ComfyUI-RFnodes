import os
import json
import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import folder_paths

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
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "RFNodes/Inpaint"

    def save_images(self, images, original_image_name, filename_prefix="inpaint/result", prompt=None, extra_pnginfo=None):
        orig_path = folder_paths.get_annotated_filepath(original_image_name)
        if not os.path.exists(orig_path):
            raise FileNotFoundError(f"Original image file not found: {orig_path}")

        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            filename_prefix, self.output_dir, images[0].shape[1], images[0].shape[0]
        )

        with Image.open(orig_path) as orig_img:
            orig_info = dict(orig_img.info)
            orig_exif = orig_img.getexif()

        results = []
        for batch_number, image in enumerate(images):
            i = 255.0 * image.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

            metadata = PngInfo()
            for k, v in orig_info.items():
                if isinstance(v, (str, bytes)):
                    metadata.add_text(k, str(v))

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