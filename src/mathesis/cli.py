"""The `mathesis` command."""
import argparse
import dataclasses
import os
import shutil
import socket
import sys
from pathlib import Path

from . import __version__
from .config import DEFAULT_CONFIG, EXAMPLE_CONFIG, ConfigError, Settings
from .lessons import DERIVED
from .obsidian import find_command, open_in_obsidian
from .llm import make_client
from .pipeline import PROMPT_DIR, render, summarize, summary_path


def _settings(args) -> Settings:
    """Environment first, then command-line flags on top."""
    s = Settings.from_env(getattr(args, "config", None))
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
    if getattr(args, "no_lab_guide", False):
        overrides["lab_guide"] = False
    if getattr(args, "no_open", False):
        overrides["obsidian_open"] = False
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
        "MATHESIS_LAB_GUIDE": "1" if s.lab_guide else "0", "MATHESIS_NOTIFY_ON_SAVE": "1" if s.notify_on_save else "0", "MATHESIS_PIPELINE": s.pipeline,
        "MATHESIS_MAX_REVISIONS": str(s.max_revisions), "MATHESIS_OBSIDIAN_OPEN": "1" if s.obsidian_open else "0",
        **({"MATHESIS_OBSIDIAN": s.obsidian_command} if s.obsidian_command else {}),
        **({"MATHESIS_CONFIG": str(s.config_path)} if s.config_path else {}),
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
            found += sorted(f for f in p.rglob("*.md") if not f.name.endswith(DERIVED))
        elif p.is_file():
            found.append(p)
        else:
            print(f"not found: {p}", file=sys.stderr)
    return [f for f in found if not f.name.endswith(DERIVED)]


def cmd_summarize(args) -> int:
    s = _settings(args)
    client = make_client(s, "summary")
    if client is None:
        print("error: no summary provider (summary.provider is \"none\")", file=sys.stderr)
        return 1
    ok, message = client.check()
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

    for name in s.unused_providers():
        report(None, f"[providers.{name}] is configured but not used: set provider = \"{name}\" in [summary] and/or [lab_guide]")
    report(None if s.config_path is None else True,
           f"config file: {s.config_path or 'none (defaults; mathesis config --init writes an example)'}")
    for what, enabled, role in [("summaries", s.summary_enabled, "summary"), ("lab guides", s.lab_guide_enabled, "lab_guide")]:
        client = make_client(s, role) if enabled else None
        if client is None:
            report(None, f"{what}: off")
            continue
        ok, message = client.check()
        # the lab guide backend being down only means no guides (the lab is still saved), so it is a warning
        report(ok if role == "summary" else (True if ok else None), f"{what} ({client.label}): {message}")
    report(s.root.is_dir() and os.access(s.root, os.W_OK), f"notes folder {s.root} exists and is writable")
    missing = [n for n in ["extract.txt", "extract.user.txt", "synthesize.txt", "synthesize.user.txt",
                           "revise.txt", "single.txt"] if not (PROMPT_DIR / n).is_file()]
    report(not missing, f"prompts in {PROMPT_DIR}" + (f" (missing: {', '.join(missing)})" if missing else ""))
    report(True if shutil.which("notify-send") else None,
           "notify-send " + ("found" if shutil.which("notify-send") else "not found: no desktop notifications"))
    missing_lab = (PROMPT_DIR / "lab_guide.txt").is_file()
    report(missing_lab, "lab guide prompt " + ("found" if missing_lab else "missing"))
    opener = find_command(s.obsidian_command)
    report(True if opener else None, "Obsidian opener: " + (" ".join(opener) if opener else
           "not found (notification click will not open Obsidian; set MATHESIS_OBSIDIAN)"))
    with socket.socket() as sock:
        sock.settimeout(0.5)
        busy = sock.connect_ex((s.host, s.port)) == 0
    report(None if busy else True, f"port {s.port} " + ("is already in use (another server running?)" if busy else "is free"))
    print(f"\nsummary={s.summary_provider} lab_guide={s.lab_provider} pipeline={s.pipeline} "
          f"max_revisions={s.max_revisions} ollama={s.model} num_ctx={s.num_ctx}")
    if args.click_test:
        bad += _click_test(s)
    return 1 if bad else 0


def _click_test(s: Settings, wait: int = 120) -> int:
    """Fire a real notification whose click opens an existing summary in Obsidian, and wait for the click."""
    import time
    from .notify import notify
    target = next(iter(sorted(s.root.rglob("*-summary.md"))), None)
    if target is None:
        print("click test: no *-summary.md found under the notes folder")
        return 1
    clicked = []

    def on_click():
        clicked.append(True)
        print(f"clicked: opening {target.name} in Obsidian ->", "ok" if open_in_obsidian(target, s.obsidian_command) else "FAILED")

    print(f"click test: a notification appeared; click it (or its button) within {wait}s to open {target.name} in Obsidian ...")
    thread = notify("Mathesis test: click me", f"Opens {target.name} in Obsidian", on_click=on_click, enabled=s.notify)
    if thread:
        thread.join(wait)
    if not clicked:
        print("click test: no click received")
    return 0 if clicked else 1


# ---------------------------------------------------------------- config
def cmd_config(args) -> int:
    if args.init:
        target = Path(args.config).expanduser() if args.config else DEFAULT_CONFIG
        if target.exists():
            print(f"error: {target} already exists (not overwriting)", file=sys.stderr)
            return 1
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(EXAMPLE_CONFIG.read_text(encoding="utf-8"), encoding="utf-8")
        target.chmod(0o600)
        print(f"wrote {target}: edit it, then restart `mathesis serve` (`mathesis doctor` checks it)")
        return 0
    s = _settings(args)
    print(f"config file: {s.config_path or 'none'} (default location: {DEFAULT_CONFIG})")
    for name in s.unused_providers():
        print(f"warning: [providers.{name}] is configured but not used: set provider = \"{name}\" in [summary] and/or [lab_guide]")
    for what, provider, model in [("summaries", s.summary_provider, s.summary_model), ("lab guides", s.lab_provider, s.lab_model)]:
        if provider == "none":
            print(f"{what}: off")
            continue
        spec = s.provider_spec(provider, model)
        shown = {k: v for k, v in spec.items() if k not in ("api_key", "name") and v is not None}
        key = " (api_key set in file)" if spec.get("api_key") else ""
        print(f"{what}: {provider} {shown}{key}")
    return 0


# ---------------------------------------------------------------- parser
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="mathesis", description="Save course transcripts and turn them into study notes with an LLM (Ollama by default).")
    p.add_argument("--version", action="version", version=f"mathesis {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp):
        sp.add_argument("--model", help="Ollama model (default: MATHESIS_MODEL or gemma4:12b)")
        sp.add_argument("--ollama-url", dest="ollama_url", help="Ollama server URL")
        sp.add_argument("--root", help="folder where notes may be written (default: MATHESIS_ROOT)")
        sp.add_argument("--config", help="config file (default: MATHESIS_CONFIG or config.toml in the application directory)")

    sv = sub.add_parser("serve", help="run the server the userscript talks to (hot reload on code changes)")
    common(sv)
    sv.add_argument("--host"), sv.add_argument("--port", type=int)
    sv.add_argument("--no-reload", action="store_true", help="disable hot reload")
    sv.add_argument("--no-summary", action="store_true", help="only save transcripts, no summaries")
    sv.add_argument("--no-lab-guide", dest="no_lab_guide", action="store_true", help="labs: no gcloud/terraform guide")
    sv.add_argument("--no-notify", action="store_true", help="no desktop notifications")
    sv.add_argument("--no-open", dest="no_open", action="store_true", help="notification click does not open Obsidian")
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
    dr.add_argument("--click-test", action="store_true",
                    help="also fire a notification and check that clicking it opens a summary in Obsidian")
    dr.set_defaults(func=cmd_doctor)

    cf = sub.add_parser("config", help="show which config file and LLM providers are in use; --init writes an example")
    cf.add_argument("--config", help="config file to show / to create")
    cf.add_argument("--init", action="store_true", help=f"write a commented example config ({DEFAULT_CONFIG} unless --config)")
    cf.set_defaults(func=cmd_config)
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as e:
        print(f"config error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
