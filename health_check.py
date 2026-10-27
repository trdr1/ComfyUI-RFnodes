import os
import sys
import ast
import traceback
import importlib

def check_syntax(file_path):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            source = f.read()
        ast.parse(source, filename=file_path)
        return True, None
    except Exception as e:
        return False, traceback.format_exc()

def run_health_check():
    root_dir = os.path.dirname(os.path.abspath(__file__))
    print(f"[RFNodes Health Check] Checking directory: {root_dir}")
    errors = []

    py_files = []
    for dirpath, _, filenames in os.walk(root_dir):
        for fn in filenames:
            if fn.endswith(".py"):
                py_files.append(os.path.join(dirpath, fn))

    print(f"[RFNodes Health Check] Validating syntax for {len(py_files)} Python files...")
    for pf in py_files:
        ok, err = check_syntax(pf)
        if not ok:
            errors.append(f"Syntax/AST Error in {pf}:\n{err}")

    if errors:
        print("\n" + "=" * 60)
        print("[RFNodes Health Check FAILED - Syntax Errors Detected]")
        for e in errors:
            print(e)
        print("=" * 60)
        sys.exit(1)

    print("[RFNodes Health Check] Validating module imports and mappings...")
    if root_dir not in sys.path:
        sys.path.insert(0, root_dir)

    try:
        init_mod = importlib.import_module("__init__")
        node_mappings = getattr(init_mod, "NODE_CLASS_MAPPINGS", None)
        if not isinstance(node_mappings, dict):
            errors.append("NODE_CLASS_MAPPINGS is missing or not a dict in __init__.py")
        else:
            for node_name, cls_obj in node_mappings.items():
                if not hasattr(cls_obj, "INPUT_TYPES"):
                    errors.append(f"Node class '{node_name}' is missing INPUT_TYPES")
                if not hasattr(cls_obj, "RETURN_TYPES"):
                    errors.append(f"Node class '{node_name}' is missing RETURN_TYPES")
                if not hasattr(cls_obj, "FUNCTION"):
                    errors.append(f"Node class '{node_name}' is missing FUNCTION")
    except Exception as e:
        errors.append(f"Import/Runtime Error during package validation:\n{traceback.format_exc()}")

    if errors:
        print("\n" + "=" * 60)
        print("[RFNodes Health Check FAILED - Runtime/Validation Errors Detected]")
        for e in errors:
            print(e)
        print("=" * 60)
        sys.exit(1)

    print("\n[RFNodes Health Check PASSED - All modules, syntax, and node definitions are valid]")
    sys.exit(0)

if __name__ == "__main__":
    run_health_check()