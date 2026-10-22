from .db_manager import suggest_names, get_characters_for_series

def _escape_brackets_text(s: str) -> str:
    if not s:
        return s
    return s.replace("(", r"\(").replace(")", r"\)")

class RFEntitySearchNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "category": (["characters", "series", "artists"], {"default": "characters"}),
                "search_query": ("STRING", {"default": "", "multiline": False}),
                "escape_brackets": ("BOOLEAN", {"default": True}),
                "result_text": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "process"
    CATEGORY = "RFNodes"

    def process(self, category, search_query, escape_brackets, result_text):
        out_text = result_text if result_text.strip() else search_query
        if escape_brackets:
            out_text = _escape_brackets_text(out_text)
        return (out_text,)

class RFSeriesCharacterListNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "series_name": ("STRING", {"default": "", "multiline": False}),
                "format_mode": (["dynamic_prompts", "comma_separated", "newline"], {"default": "dynamic_prompts"}),
                "gender_prefix": (["none", "1girl", "1boy"], {"default": "none"}),
                "escape_brackets": ("BOOLEAN", {"default": True}),
                "limit": ("INT", {"default": 30, "min": 1, "max": 200}),
                "characters_text": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("characters",)
    FUNCTION = "process"
    CATEGORY = "RFNodes"

    def process(self, series_name, format_mode, gender_prefix, escape_brackets, limit, characters_text):
        if characters_text.strip():
            out_text = characters_text
            if escape_brackets:
                out_text = _escape_brackets_text(out_text)
            return (out_text,)

        char_list = get_characters_for_series(series_name, limit)
        if not char_list:
            return ("",)

        formatted = []
        clean_s = series_name.strip().replace("_", " ")
        if escape_brackets and clean_s:
            clean_s = _escape_brackets_text(clean_s)

        for c in char_list:
            parts = []
            if gender_prefix != "none":
                parts.append(gender_prefix)
            clean_c = c.replace("_", " ")
            if escape_brackets:
                clean_c = _escape_brackets_text(clean_c)
            parts.append(clean_c)
            if clean_s:
                parts.append(clean_s)
            formatted.append(", ".join(parts))

        if format_mode == "dynamic_prompts":
            res = "{\n" + "\n".join([f"${formatted[0]}"] + [f"|{x}" for x in formatted[1:]]) + "\n}"
        elif format_mode == "newline":
            res = "\n".join(formatted)
        else:
            res = ", ".join(formatted)

        return (res,)