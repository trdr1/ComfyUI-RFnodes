import os
import re
import random
import threading
import folder_paths
import numpy as np
try:
    import yaml
except ImportError:
    yaml = None

_wildcard_lock = threading.Lock()
_wildcard_cache = {}
_stateful_wildcards = {}
_state_lock = threading.Lock()

RE_WildCardQuantifier = re.compile(r"(?P<quantifier>\d+)#__(?P<keyword>[\w.\-+/*\\]+?)__", re.IGNORECASE)

def _get_wildcards_dirs():
    dirs = []
    seen = set()

    def add_dir(p):
        if not p:
            return
        ap = os.path.abspath(p)
        if ap not in seen and os.path.isdir(ap):
            seen.add(ap)
            dirs.append(ap)

    current_dir = os.path.dirname(os.path.abspath(__file__))
    add_dir(os.path.join(current_dir, "wildcards"))
    add_dir(os.path.join(current_dir, "..", "wildcards"))

    try:
        import impact
        impact_dir = os.path.dirname(os.path.abspath(impact.__file__))
        impact_root = os.path.abspath(os.path.join(impact_dir, "..", ".."))
        add_dir(os.path.join(impact_root, "wildcards"))
        add_dir(os.path.join(impact_root, "custom_wildcards"))
    except Exception:
        pass

    add_dir(os.path.join(folder_paths.base_path, "custom_nodes", "ComfyUI-Impact-Pack", "wildcards"))
    add_dir(os.path.join(folder_paths.base_path, "custom_nodes", "ComfyUI-Impact-Pack", "custom_wildcards"))
    add_dir(os.path.join(folder_paths.base_path, "wildcards"))
    add_dir(os.path.join(folder_paths.base_path, "input", "wildcards"))

    return dirs

def _normalize(k):
    return k.replace("\\", "/").replace(" ", "-").lower()

def _load_file_lines(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return [x.strip() for x in f.read().splitlines() if x.strip() and not x.strip().startswith("#")]
    except UnicodeDecodeError:
        with open(path, "r", encoding="iso-8859-1", errors="ignore") as f:
            return [x.strip() for x in f.read().splitlines() if x.strip() and not x.strip().startswith("#")]

def _load_wildcard_dict():
    global _wildcard_cache
    with _wildcard_lock:
        if _wildcard_cache:
            return _wildcard_cache
        res = {}
        for d in _get_wildcards_dirs():
            for root, _, files in os.walk(d, followlinks=True):
                for file in files:
                    rel = os.path.relpath(os.path.join(root, file), d)
                    full_key = _normalize(os.path.splitext(rel)[0])
                    base_key = _normalize(os.path.splitext(file)[0])
                    fpath = os.path.join(root, file)
                    lines = None
                    if file.endswith(".txt"):
                        lines = _load_file_lines(fpath)
                        res[full_key] = lines
                        if base_key not in res:
                            res[base_key] = lines
                    elif (file.endswith(".yaml") or file.endswith(".yml")) and yaml:
                        try:
                            with open(fpath, "r", encoding="utf-8") as f:
                                ydata = yaml.load(f, Loader=yaml.FullLoader)
                            if isinstance(ydata, dict):
                                for yk, yv in ydata.items():
                                    subk = _normalize(f"{full_key}/{yk}") if full_key else _normalize(yk)
                                    base_subk = _normalize(yk)
                                    val_list = [str(item) for item in yv] if isinstance(yv, list) else [str(yv)]
                                    res[subk] = val_list
                                    if base_subk not in res:
                                        res[base_subk] = val_list
                        except Exception:
                            pass
        _wildcard_cache = res
        return _wildcard_cache

def _find_wildcard_options(w_dict, kw):
    norm_kw = _normalize(kw)
    if norm_kw in w_dict:
        return w_dict[norm_kw]
    if "/" not in norm_kw:
        target_suffix = f"/{norm_kw}"
        for k, v in w_dict.items():
            if k.endswith(target_suffix):
                return v
    return None

def _is_numeric(s):
    return re.match(r"^-?(\d*\.?\d+|\d+\.?\d*)$", str(s).strip()) is not None

def _get_next_stateful(key, options, mode, seed=None):
    global _stateful_wildcards
    if not options:
        return ""
    sig = (len(options), options[0])
    with _state_lock:
        if key not in _stateful_wildcards:
            _stateful_wildcards[key] = {"index": 0, "bag": [], "sig": sig}
        st = _stateful_wildcards[key]
        if st["sig"] != sig:
            st["index"] = 0
            st["bag"] = []
            st["sig"] = sig
        if mode == "seq":
            idx = st["index"] % len(options)
            val = options[idx]
            st["index"] = (st["index"] + 1) % len(options)
            return val
        elif mode == "bag":
            if not st["bag"]:
                flat = [re.sub(r"^\s*[0-9.]+::", "", str(x), count=1) for x in options]
                rng = random.Random(seed) if seed is not None else random.Random()
                rng.shuffle(flat)
                st["bag"] = flat
            return st["bag"].pop(0)
    return ""

def _process_comment_out(text):
    lines = text.split("\n")
    out = []
    flag = False
    for line in lines:
        if line.lstrip().startswith("#"):
            flag = True
            continue
        if not out:
            out.append(line)
        elif flag:
            out[-1] += " " + line
            flag = False
        else:
            out.append(line)
    return "\n".join(out)

def process_wildcards(text, seed=None, mode="random"):
    text = _process_comment_out(text)
    rng = np.random.default_rng(seed)
    w_dict = _load_wildcard_dict()

    def replace_options(s):
        found = False
        def rep(match):
            nonlocal found
            content = match.group(1)
            options = content.split("|")
            mode = "rnd"
            first = options[0].strip()
            key_p = ""
            if first.startswith("$"):
                mode = "seq"
                options[0] = options[0].lstrip("$")
                key_p = f"OPT_SEQ_{hash(content)}"
            elif first.startswith("@"):
                mode = "bag"
                options[0] = options[0].lstrip("@")
                key_p = f"OPT_BAG_{hash(content)}"

            mparts = options[0].split("$$")
            sel_range = None
            sel_sep = " "
            if len(mparts) > 1:
                r1 = re.match(r"(\d+)(-(\d+))?", options[0])
                r2 = re.match(r"-(\d+)", options[0])
                if r1:
                    a = r1.group(1).strip()
                    b = r1.group(3).strip() if r1.group(3) else a
                    sel_range = (int(a), int(b))
                elif r2:
                    sel_range = (1, int(r2.group(1).strip()))
                if len(mparts) == 2:
                    options[0] = mparts[1]
                elif len(mparts) == 3:
                    sel_sep = mparts[1]
                    options[0] = mparts[2]

            if mode in ["seq", "bag"]:
                cnt = 1
                if sel_range:
                    cnt = int(rng.integers(low=sel_range[0], high=sel_range[1] + 1))
                items = [_get_next_stateful(key_p, options, mode, seed) for _ in range(cnt)]
                items = [re.sub(r"^\s*[0-9.]+::", "", str(x), count=1) for x in items]
                found = True
                return sel_sep.join(items)

            probs = []
            tot = 0.0
            for opt in options:
                parts = opt.split("::", 1) if isinstance(opt, str) else [opt]
                val = float(parts[0].strip()) if len(parts) == 2 and _is_numeric(parts[0]) else 1.0
                probs.append(val)
                tot += val
            norm = [p / tot for p in probs]

            cnt = 1
            if sel_range:
                low = min(sel_range[0], sel_range[1])
                high = max(sel_range[0], sel_range[1])
                max_cnt = min(len(options), high)
                cnt = int(rng.integers(low=min(low, max_cnt), high=max_cnt + 1)) if max_cnt >= low else 1

            if cnt >= len(options) or tot <= 1:
                picked = list(options)
                rng.shuffle(picked)
                chosen = picked[:cnt]
            else:
                chosen = rng.choice(options, p=norm, size=cnt, replace=False)
            chosen = [re.sub(r"^\s*[0-9.]+::", "", str(x), count=1) for x in chosen]
            found = True
            return sel_sep.join(chosen)

        pat = r"(?<!\\)\{((?:[^{}]|(?<=\\)[{}])*?)(?<!\\)\}"
        res = re.sub(pat, rep, s)
        return res, found

    def replace_wildcards_kw(s):
        pat = r"__([$@]?[\w.\-+/*\\]+?)__"
        matches = re.findall(pat, s)
        found = False
        for raw in matches:
            sub_mode = "rnd"
            kw = raw
            if kw.startswith("$"):
                sub_mode = "seq"
                kw = kw[1:]
            elif kw.startswith("@"):
                sub_mode = "bag"
                kw = kw[1:]
            norm_kw = _normalize(kw)
            opts = _find_wildcard_options(w_dict, kw)
            if opts:
                if mode == "all_lines_newline":
                    clean_opts = [re.sub(r"^\s*[0-9.]+::", "", str(x), count=1) for x in opts]
                    chosen = "\n".join(clean_opts)
                elif mode == "all_lines_comma":
                    clean_opts = [re.sub(r"^\s*[0-9.]+::", "", str(x), count=1) for x in opts]
                    chosen = ", ".join(clean_opts)
                elif sub_mode in ["seq", "bag"]:
                    chosen = _get_next_stateful(norm_kw, opts, sub_mode, seed)
                    chosen = re.sub(r"^\s*[0-9.]+::", "", str(chosen), count=1)
                else:
                    probs = []
                    tot = 0.0
                    for opt in opts:
                        parts = opt.split("::", 1) if isinstance(opt, str) else [opt]
                        val = float(parts[0].strip()) if len(parts) == 2 and _is_numeric(parts[0]) else 1.0
                        probs.append(val)
                        tot += val
                    norm = [p / tot for p in probs]
                    chosen = rng.choice(opts, p=norm)
                    chosen = re.sub(r"^\s*[0-9.]+::", "", str(chosen), count=1)
                s = s.replace(f"__{raw}__", chosen, 1)
                found = True
        return s, found

    depth = 50
    while depth > 0:
        depth -= 1
        qmatches = [m.groupdict() for m in RE_WildCardQuantifier.finditer(text)]
        for qm in qmatches:
            k = qm["keyword"]
            cnt = int(qm["quantifier"]) if qm["quantifier"] else 1
            text = text.replace(f"{cnt}#__{k}__", " ".join([f"__{k}__"] * cnt), 1)

        text, r1 = replace_options(text)
        text, r2 = replace_wildcards_kw(text)
        if not r1 and not r2:
            break
    return text

def _get_wildcard_keys_list():
    d = _load_wildcard_dict()
    keys = sorted(list(d.keys()))
    return ["Select Wildcard..."] + [f"__{k}__" for k in keys]

def refresh_wildcards():
    global _wildcard_cache
    with _wildcard_lock:
        _wildcard_cache.clear()
    return _get_wildcard_keys_list()

class RFWildcardProcessorNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
                "select_wildcard": (_get_wildcard_keys_list(), {"default": "Select Wildcard..."}),
                "replace_single_wildcard": ("BOOLEAN", {"default": True}),
                "wildcard_mode": (["random", "all_lines_newline", "all_lines_comma"], {"default": "random"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    OUTPUT_NODE = True
    FUNCTION = "process"
    CATEGORY = "RFNodes/Wildcard"

    @classmethod
    def IS_CHANGED(cls, text, select_wildcard, replace_single_wildcard, wildcard_mode, seed):
        return float("nan")

    def process(self, text, select_wildcard, replace_single_wildcard, wildcard_mode, seed):
        out = process_wildcards(text, seed=seed, mode=wildcard_mode)
        return {"ui": {"text": [out]}, "result": (out,)}