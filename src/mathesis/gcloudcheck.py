"""Check the `gcloud` commands of a lab guide against the installed gcloud's own help pages.

A model guesses flags; `gcloud <group> <command> --help` knows them. This module finds the commands in a guide's
bash blocks and reports the ones with an unknown command, an unknown flag, or (design-center) a missing required flag.
Only `--help` is ever run, with an empty CLOUDSDK_CONFIG (no account, no project), so nothing reaches a real project.
"""
import os
import re
import shlex
import shutil
import subprocess
import tempfile
from functools import lru_cache

GLOBAL_FLAGS = {"--project", "--quiet", "--format", "--filter", "--limit", "--flatten", "--help", "--verbosity", "--sort-by",
                "--page-size", "--uri"}
IMPLIED = {"--location", "--space", "--application-template", "--application", "--project"}   # often set by a gcloud property


def available() -> bool:
    return shutil.which("gcloud") is not None


@lru_cache(maxsize=None)
def help_text(path: tuple[str, ...]) -> str | None:
    """`gcloud <path> --help` as plain text, or None when that command or group does not exist."""
    config = tempfile.mkdtemp(prefix="mathesis-gcloud-")
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": config, "CLOUDSDK_CONFIG": config, "TERM": "dumb",
           "CLOUDSDK_CORE_DISABLE_COLOR": "true", "CLOUDSDK_CORE_DISABLE_PROMPTS": "1"}
    try:
        r = subprocess.run(["gcloud", *path, "--help"], capture_output=True, text=True, env=env, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    finally:
        shutil.rmtree(config, ignore_errors=True)
    return None if r.returncode else re.sub(r"\x1b\[[0-9;]*m|.\x08", "", r.stdout)


def commands(guide: str):
    """The `gcloud ...` command lines of the guide's bash blocks (continuations joined)."""
    for block in re.findall(r"```(?:bash|sh|shell)\n(.*?)```", guide, re.S):
        for line in re.sub(r"\\\n\s*", " ", block).splitlines():
            line = line.strip()
            m = re.search(r"(?:^|[=(]\"?\$\(|\|\s*|;\s*|do\s+)(gcloud\s.*)", line)
            if m and not line.startswith("#"):
                yield m.group(1)


def command_path(words: list[str]) -> list[str]:
    """The longest prefix of `words` that is a real gcloud group / command."""
    path: list[str] = []
    for w in words:
        if not re.fullmatch(r"[a-z][a-z0-9-]*", w) or help_text(tuple(path + [w])) is None:
            break
        path.append(w)
    return path


def check(cmd: str) -> str:
    """'ok', 'skip' (could not parse it), or what is wrong with the command."""
    try:
        toks = shlex.split(cmd.split(" | ")[0].split(")\"")[0].rstrip(")"), posix=True)
    except ValueError:
        return "skip"
    words = [t for t in toks[1:] if not t.startswith("-")]
    flags = [t.split("=")[0] for t in toks[1:] if t.startswith("--")]
    path = command_path(words)
    h = help_text(tuple(path)) if path else None
    if not path or h is None:
        return "unknown command: " + " ".join(words[:5])
    if "\nGROUPS" in h and not re.search(r"\nSYNOPSIS\n\s+gcloud [^\n]*\[", h) and "--" not in h.split("GCLOUD WIDE FLAGS")[0]:
        return "stops at a group: " + " ".join(path)
    bad = [f for f in flags if f not in GLOBAL_FLAGS and not re.search(r"(?<![\w-])" + re.escape(f) + r"(?![\w-])", h)]
    required = []
    i = h.find("REQUIRED FLAGS")
    if i >= 0 and path[0] == "design-center":   # elsewhere "required" can mean one-of groups: not judged
        rest = h[i + 14:]
        m = re.search(r"\n[A-Z][A-Z ]+\n", rest)
        required = re.findall(r"^\s{1,8}(--[a-z][a-z-]*)", rest[:m.start()] if m else rest, re.M)
    missing = [r for r in dict.fromkeys(required) if r not in flags and r not in IMPLIED]
    msg = ([f"unknown flags {bad}"] if bad else []) + ([f"missing required {missing}"] if missing else [])
    return f"{'; '.join(msg)} in `gcloud {' '.join(path)}`" if msg else "ok"


def problems(guide: str) -> list[tuple[str, str]]:
    """(command, what is wrong) for every checked command that is wrong."""
    return [(c, r) for c in dict.fromkeys(commands(guide)) if (r := check(c)) not in ("ok", "skip")]


def help_for(bad: list[tuple[str, str]], limit: int = 7000) -> str:
    """The help pages (flags part) of the commands in `bad`, one per distinct command."""
    seen: dict[tuple[str, ...], str] = {}
    for cmd, _ in bad:
        path = tuple(command_path([w for w in cmd.split()[1:] if not w.startswith("-")]))
        if path and path not in seen:
            seen[path] = f"=== gcloud {' '.join(path)} --help ===\n" + help_text(path).split("GCLOUD WIDE FLAGS")[0][:limit]
    return "\n\n".join(seen.values())
