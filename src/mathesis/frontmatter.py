"""YAML frontmatter at the top of the Markdown files the server saves: file type, course, lesson, url and a hash of the body.

The hash is of the text after the frontmatter, so editing only the metadata never changes it, and a note typed into the body
does. Anything in the frontmatter that Mathesis does not own (keys the person added) is kept as it is.
"""
import hashlib
import json
import re

OWNED = ("type", "course", "lesson", "url", "hash")


def split(text: str) -> tuple[list[str] | None, str]:
    """(frontmatter lines without the --- fences, body). Frontmatter is None when the text does not start with a closed block."""
    if not text.startswith("---\n") and not text.startswith("---\r\n"):
        return None, text
    lines = text.split("\n")
    for i in range(1, len(lines)):
        if lines[i].rstrip("\r") in ("---", "..."):
            return [l.rstrip("\r") for l in lines[1:i]], "\n".join(lines[i + 1:])
    return None, text  # opened but never closed: not frontmatter


def strip(text: str) -> str:
    """The text without its frontmatter (what readers of the lesson, such as the summary, should see)."""
    return split(text)[1]


def body_hash(body: str) -> str:
    return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()


def _line(key: str, value: str) -> str:
    return f"{key}: {json.dumps(value, ensure_ascii=False)}"  # a JSON string is a valid YAML double-quoted string


def apply(existing: str | None, content: str, meta: dict[str, str]) -> tuple[str, bool]:
    """The file text to write, and whether the existing body was kept.

    - no file yet: frontmatter + content
    - a file with frontmatter: our keys are updated, other keys stay, the body becomes `content`
    - a file without frontmatter (e.g. saved before this existed, with notes in it): only the frontmatter is added; the
      existing text is not changed at all
    """
    if existing is None:
        front, body, kept = [], content, False
    else:
        front, _ = split(existing)
        if front is None:
            front, body, kept = [], existing, True
        else:
            body, kept = content, False
    values = {k: v for k, v in meta.items() if k in OWNED and k != "hash" and v}
    values["hash"] = None  # filled in below, once the body is known
    out = list(front)
    for key in OWNED:
        if key not in values:
            continue
        text = _line(key, values[key]) if values[key] is not None else None
        idx = next((i for i, l in enumerate(out) if re.match(rf"{key}\s*:", l)), None)
        if key == "hash":
            text = _line("hash", body_hash(body))
        if idx is None:
            out.append(text)
        else:
            out[idx] = text
    return "---\n" + "\n".join(out) + "\n---\n" + body, kept
