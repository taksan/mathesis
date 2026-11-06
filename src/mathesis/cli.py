"""The `mathesis` command."""
import argparse
import dataclasses
import os
import shutil
import socket
import sys
from pathlib import Path

from . import __version__
from .config import Settings
from .ollama import OllamaClient
from .pipeline import PROMPT_DIR, render, summarize, summary_path


def _settings(args) -> Settings:
    """Environment first, then command-line flags on top."""
    s = Settings.from_env()
    overrides = {}
    for flag, field in [("model", "model"), ("ollama_url", "ollama_url"), ("host", "host"), ("port", "port")]:
        if getattr(args, flag, None) is not None:
            overrides[field] = getattr(args, flag)
    if getattr(args, "root", None):
        overrides["root"] = Path(args.root).expanduser().resolve()
    if getattr(args, "single", False):
        overrides["pipeline"] = "single"
    if getattr(args, "no_revise", False):
        overrides["max_revisions"] = 0
    if getattr(args, "no_summary", False):
        overrides["summarize"] = False
    if getattr(args, "no_notify", False):
        overrides["notify"] = False
    return dataclasses.replace(s, **overrides)


# ---------------------------------------------------------------- serve
def cmd_serve(args) -> int:
    import uvicorn
    s = _settings(args)
    # flags travel to the (reloaded) server process through the environment
    os.environ.update({
        "MATHESIS_HOST": s.host, "MATHESIS_PORT": str(s.port), "MATHESIS_ROOT": str(s.root),
        "MATHESIS_MODEL": s.model, "MATHESIS_OLLAMA_URL": s.ollama_url, "MATHESIS_NUM_CTX": str(s.num_ctx),
        "MATHESIS_SUMMARIZE": "1" if s.summarize else "0", "MATHESIS_NOTIFY": "1" if s.notify else "0",
        "MATHESIS_NOTIFY_ON_SAVE": "1" if s.notify_on_save else "0", "MATHESIS_PIPELINE": s.pipeline,
        "MATHESIS_MAX_REVISIONS": str(s.max_revisions),
    })
    package_dir = str(Path(__file__).resolve().parent)
    uvicorn.run("mathesis.server:app", host=s.host, port=s.port, reload=not args.no_reload,
                reload_dirs=[package_dir])
    return 0


# ---------------------------------------------------------------- summarize
def _transcripts(paths) -> list[Path]:
    found = []
    for p in map(Path, paths):
        if p.is_dir():
            found += sorted(f for f in p.rglob("*.md") if not f.name.endswith("-summary.md"))
        elif p.is_file():
            found.append(p)
        else:
            print(f"not found: {p}", file=sys.stderr)
    return [f for f in found if not f.name.endswith("-summary.md")]


def cmd_summarize(args) -> int:
    s = _settings(args)
    client = OllamaClient(s)
    ok, message = client.check_model()
    if not ok:
        print(f"error: {message}", file=sys.stderr)
        return 1
    files = _transcripts(args.paths)
    if not files:
        print("no transcript files to summarize", file=sys.stderr)
        return 1
    failures = 0
    for i, f in enumerate(files, 1):
        out = summary_path(f)
        if out.exists() and not args.force and not args.stdout:
            print(f"[{i}/{len(files)}] skip (summary exists, use --force): {f.name}")
            continue
        print(f"[{i}/{len(files)}] {f.name}")
        try:
            notes, info = summarize(f.read_text(encoding="utf-8"), f, client, s)
        except Exception as e:
            failures += 1
            print(f"  failed: {e}", file=sys.stderr)
            continue
        text = render(notes, info, s)
        if args.stdout:
            print(text)
        else:
            out.write_text(text, encoding="utf-8")
            print(f"  -> {out}")
    return 1 if failures else 0


# ---------------------------------------------------------------- doctor
def cmd_doctor(args) -> int:
    s = _settings(args)
    bad = 0

    def report(ok: bool | None, text: str):
        nonlocal bad
        mark = {True: "ok  ", False: "FAIL", None: "warn"}[ok]
        bad += ok is False
        print(f"[{mark}] {text}")

    ok, message = OllamaClient(s).check_model()
    report(ok, f"Ollama {s.ollama_url}: {message}")
    report(s.root.is_dir() and os.access(s.root, os.W_OK), f"notes folder {s.root} exists and is writable")
    missing = [n for n in ["extract.txt", "extract.user.txt", "synthesize.txt", "synthesize.user.txt",
                           "revise.txt", "single.txt"] if not (PROMPT_DIR / n).is_file()]
    report(not missing, f"prompts in {PROMPT_DIR}" + (f" (missing: {', '.join(missing)})" if missing else ""))
    report(True if shutil.which("notify-send") else None,
           "notify-send " + ("found" if shutil.which("notify-send") else "not found: no desktop notifications"))
    with socket.socket() as sock:
        sock.settimeout(0.5)
        busy = sock.connect_ex((s.host, s.port)) == 0
    report(None if busy else True, f"port {s.port} " + ("is already in use (another server running?)" if busy else "is free"))
    print(f"\nmodel={s.model} pipeline={s.pipeline} max_revisions={s.max_revisions} num_ctx={s.num_ctx}")
    return 1 if bad else 0


# ---------------------------------------------------------------- parser
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="mathesis", description="Save course transcripts and turn them into study notes with Ollama.")
    p.add_argument("--version", action="version", version=f"mathesis {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp):
        sp.add_argument("--model", help="Ollama model (default: MATHESIS_MODEL or gemma4:12b)")
        sp.add_argument("--ollama-url", dest="ollama_url", help="Ollama server URL")
        sp.add_argument("--root", help="folder where notes may be written (default: MATHESIS_ROOT)")

    sv = sub.add_parser("serve", help="run the server the userscript talks to (hot reload on code changes)")
    common(sv)
    sv.add_argument("--host"), sv.add_argument("--port", type=int)
    sv.add_argument("--no-reload", action="store_true", help="disable hot reload")
    sv.add_argument("--no-summary", action="store_true", help="only save transcripts, no Ollama summaries")
    sv.add_argument("--no-notify", action="store_true", help="no desktop notifications")
    sv.add_argument("--single", action="store_true", help="one-call pipeline with the original prompt")
    sv.set_defaults(func=cmd_serve)

    su = sub.add_parser("summarize", help="write <file>-summary.md for transcript files (or every .md in a folder)")
    common(su)
    su.add_argument("paths", nargs="+", help="transcript .md files or folders")
    su.add_argument("--force", action="store_true", help="overwrite existing summaries")
    su.add_argument("--stdout", action="store_true", help="print the notes instead of writing a file")
    su.add_argument("--single", action="store_true", help="one-call pipeline with the original prompt")
    su.add_argument("--no-revise", action="store_true", help="skip the completeness revision rounds")
    su.set_defaults(func=cmd_summarize)

    dr = sub.add_parser("doctor", help="check Ollama, the model, folders, prompts and notifications")
    common(dr)
    dr.add_argument("--host"), dr.add_argument("--port", type=int)
    dr.set_defaults(func=cmd_doctor)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
