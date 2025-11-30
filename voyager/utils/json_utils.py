import json
import re
from typing import Any, Dict, Union
from .file_utils import f_join


def json_load(*file_path, **kwargs):
    file_path = f_join(file_path)
    with open(file_path, "r") as fp:
        return json.load(fp, **kwargs)


def json_loads(string, **kwargs):
    return json.loads(string, **kwargs)


def json_dump(data, *file_path, **kwargs):
    file_path = f_join(file_path)
    with open(file_path, "w") as fp:
        json.dump(data, fp, **kwargs)


def json_dumps(data, **kwargs):
    """
    Returns: string
    """
    return json.dumps(data, **kwargs)


# ---------------- Aliases -----------------
load_json = json_load
loads_json = json_loads
dump_json = json_dump
dumps_json = json_dumps


# ----------------------------------------------------------------------
# ⭐⭐ NEW: Remove Markdown fences (```json ... ```) ⭐⭐
# ----------------------------------------------------------------------
def strip_markdown_fences(s: str) -> str:
    """
    Remove leading/trailing ```json blocks from LLM output.
    Works for: ```json ... ``` or ``` ... ```
    """
    s = s.strip()
    if s.startswith("```"):
        lines = s.splitlines()
        # Remove first ```xxx
        if lines and lines[0].lstrip().startswith("```"):
            lines = lines[1:]
        # Remove last ```
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        s = "\n".join(lines).strip()
    return s


def extract_char_position(error_message: str) -> int:
    char_pattern = re.compile(r"\(char (\d+)\)")
    if match := char_pattern.search(error_message):
        return int(match[1])
    else:
        raise ValueError("Character position not found in the error message.")


def add_quotes_to_property_names(json_string: str) -> str:
    def replace_func(match):
        return f'"{match.group(1)}":'

    property_name_pattern = re.compile(r"(\w+):")
    corrected_json_string = property_name_pattern.sub(replace_func, json_string)

    try:
        json.loads(corrected_json_string)
        return corrected_json_string
    except json.JSONDecodeError as e:
        raise e


def balance_braces(json_string: str) -> str:
    open_braces_count = json_string.count("{")
    close_braces_count = json_string.count("}")

    while open_braces_count > close_braces_count:
        json_string += "}"
        close_braces_count += 1

    while close_braces_count > open_braces_count:
        json_string = json_string.rstrip("}")
        close_braces_count -= 1

    try:
        json.loads(json_string)
        return json_string
    except json.JSONDecodeError as e:
        raise e


def fix_invalid_escape(json_str: str, error_message: str) -> str:
    while error_message.startswith("Invalid \\escape"):
        bad_escape_location = extract_char_position(error_message)
        json_str = json_str[:bad_escape_location] + json_str[bad_escape_location + 1 :]
        try:
            json.loads(json_str)
            return json_str
        except json.JSONDecodeError as e:
            error_message = str(e)
    return json_str


def correct_json(json_str: str) -> str:
    try:
        json.loads(json_str)
        return json_str
    except json.JSONDecodeError as e:
        error_message = str(e)
        if error_message.startswith("Invalid \\escape"):
            json_str = fix_invalid_escape(json_str, error_message)
        if error_message.startswith("Expecting property name enclosed in double quotes"):
            json_str = add_quotes_to_property_names(json_str)
            try:
                json.loads(json_str)
                return json_str
            except json.JSONDecodeError as e:
                error_message = str(e)
        if balanced_str := balance_braces(json_str):
            return balanced_str
    return json_str


# ----------------------------------------------------------------------
# ⭐⭐ MODIFIED: Use strip_markdown_fences before parsing ⭐⭐
# ----------------------------------------------------------------------
def fix_and_parse_json(json_str: str, try_to_fix_with_gpt: bool = True) -> Union[str, Dict[Any, Any]]:
    """Fix and parse JSON string"""

    # ---- NEW ---- remove ```json ... ``` wrappers first
    json_str = strip_markdown_fences(json_str)

    try:
        json_str = json_str.replace("\t", "")
        return json.loads(json_str)
    except json.JSONDecodeError:
        json_str = correct_json(json_str)
        try:
            return json.loads(json_str)
        except json.JSONDecodeError:
            pass

    # Find first brace block
    try:
        brace_index = json_str.index("{")
        json_str = json_str[brace_index:]
        last_brace_index = json_str.rindex("}")
        json_str = json_str[: last_brace_index + 1]
        return json.loads(json_str)
    except Exception:
        raise
