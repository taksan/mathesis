"""The running version: the package version plus the git build of this checkout ("<commit count>.<short sha>", the same
scheme as the userscripts' @version), with "+dirty" when files have uncommitted changes."""
import subprocess
from pathlib import Path

from . import __version__


def _git(*args: str) -> str:
    out = subprocess.run(["git", *args], cwd=Path(__file__).resolve().parent, capture_output=True, text=True, timeout=5)
    if out.returncode:
        raise OSError(out.stderr.strip())
    return out.stdout.strip()


def build() -> str:
    """"<count>.<sha>[+dirty]" of the checkout, or "" when this is not a git checkout (an installed package)."""
    try:
        sha = _git("rev-parse", "--short", "HEAD")
        count = _git("rev-list", "--count", "HEAD")
        dirty = bool(_git("status", "--porcelain", "--untracked-files=no", "--", "."))
    except (OSError, subprocess.SubprocessError):
        return ""
    return f"{count}.{sha}{'+dirty' if dirty else ''}"


def describe() -> str:
    b = build()
    return f"Mathesis {__version__}" + (f" (build {b})" if b else "")
