"""YAML frontmatter at the top of the Markdown files the server saves: file type, course, author, lesson, url and a hash of the body.

The hash is of the text after the frontmatter, so editing only the metadata never changes it, and a note typed into the body
does. Anything in the frontmatter that Mathesis does not own (keys the person added) is kept as it is.
"""
import difflib
import hashlib
import json
import re

OWNED = ("type", "course", "author", "lesson", "url", "hash")


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
    """Hash of the body. Line endings and trailing whitespace are ignored, so an editor that adds or drops the final newline does
    not look like an edit."""
    return "sha256:" + hashlib.sha256(body.replace("\r\n", "\n").rstrip().encode("utf-8")).hexdigest()


def diff(on_disk: str, new: str, max_lines: int = 300, max_width: int = 240) -> str:
    """What saving would change in a file the person edited: a unified diff of the bodies (frontmatter left out), from the file as it is
    to the text about to replace it. A line starting with "-" is in the file now and would be gone (their notes, when they only typed
    into it); "+" would be new. Long diffs and long lines are cut. Empty when the bodies are the same."""
    def clip(line: str) -> str:
        return line if len(line) <= max_width else line[:max_width - 1] + "…"
    a = [clip(l) for l in strip(on_disk).replace("\r\n", "\n").rstrip().split("\n")]
    b = [clip(l) for l in strip(new).replace("\r\n", "\n").rstrip().split("\n")]
    lines = list(difflib.unified_diff(a, b, "in your notes now", "this save", n=2, lineterm=""))
    if len(lines) > max_lines:
        lines = lines[:max_lines] + [f"… {len(lines) - max_lines} more lines of the diff"]
    return "\n".join(lines)


def is_modified(text: str) -> bool:
    """True when the body no longer matches the hash stored in the frontmatter: the person edited the file since the server wrote
    it (their notes). Frontmatter without a hash counts as modified, since there is nothing to compare with. A file with no
    frontmatter is not "modified": it is never overwritten (see `apply`)."""
    front, body = split(text)
    if front is None:
        return False
    for line in front:
        m = re.match(r'hash\s*:\s*"?([^"\s]*)"?\s*$', line)
        if m:
            return m.group(1) != body_hash(body)
    return True


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


def refresh(existing: str, meta: dict[str, str]) -> str:
    """Update our keys in the frontmatter of `existing` and leave everything else alone, including the stored hash (so a file with
    notes in it still counts as changed afterwards). A file without frontmatter gets it added, as in `apply`."""
    front, body = split(existing)
    if front is None:
        return apply(existing, "", meta)[0]
    out = list(front)
    for key in OWNED:
        value = meta.get(key)
        if key == "hash" or not value:
            continue
        text = _line(key, value)
        idx = next((i for i, l in enumerate(out) if re.match(rf"{key}\s*:", l)), None)
        if idx is None:
            out.insert(len(out) - 1 if out and out[-1].startswith("hash") else len(out), text)  # before the hash line
        else:
            out[idx] = text
    return "---\n" + "\n".join(out) + "\n---\n" + body
