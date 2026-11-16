"""`mathesis config --init`: the few questions needed for a valid, working config.toml."""
import json
from pathlib import Path

from .config import ConfigError, Settings, api_key_env

DEFAULT_NOTES = "~/mathesis-notes"
NO_AI = ("none", "No AI: lessons are only saved, no summaries and no lab guides (you can add a provider later)")
PROVIDERS = [
    ("ollama", "Ollama: local models, no key (needs `ollama pull gemma4:12b`)"),
    ("gemini", "Gemini: Google API, key in GEMINI_API_KEY"),
    ("openai", "OpenAI: API, key in OPENAI_API_KEY"),
    ("claude-code", "Claude Code: the `claude` CLI and your Claude Code login"),
]
NEEDS_KEY = {"gemini", "openai"}


def ask_text(ask, prompt: str, default: str) -> str:
    try:
        answer = ask(f"{prompt} [{default}]: ").strip()
    except EOFError:
        answer = ""
    return answer or default


def choose(ask, title: str, options: list[tuple[str, str]], out=print) -> str:
    """Numbered menu; Enter (or end of input) picks the first item. A number or the item's name is accepted."""
    out(f"\n{title}")
    for i, (_, label) in enumerate(options, 1):
        out(f"  {i}) {label}")
    names = [n for n, _ in options]
    while True:
        try:
            answer = ask(f"Choose 1-{len(options)} [1]: ").strip().lower()
        except EOFError:
            answer = ""
        if not answer:
            return names[0]
        if answer.isdigit() and 1 <= int(answer) <= len(options):
            return names[int(answer) - 1]
        if answer in names:
            return answer
        out("  not a choice, try again")


def render(root: str, default: str, summary: str | None, lab: str | None, models: dict[str, str]) -> str:
    """The config text. `summary` / `lab` are None when they follow the default provider; default "none" = no AI."""
    q = json.dumps
    if default == "none":
        return "\n".join(["# Mathesis configuration, written by `mathesis config --init`.",
                          "# Every option, commented: src/mathesis/config.example.toml. Restart `mathesis serve` after editing.", "",
                          "# no AI: files are only saved. To get summaries, set llm = true and a provider (see the example file)",
                          "llm = false", "", "[server]", f"root = {q(root)}      # the only folder the server may write into", ""])
    lines = ["# Mathesis configuration, written by `mathesis config --init`.",
             "# Every option, commented: src/mathesis/config.example.toml. Restart `mathesis serve` after editing.", "",
             "# the one provider for everything; [summary] / [lab_guide] below only override it",
             f"provider = {q(default)}", ""]
    for section, value in (("summary", summary), ("lab_guide", lab)):
        if value:
            lines += [f"[{section}]", f"provider = {q(value)}", ""]
    lines += ["[server]", f"root = {q(root)}      # the only folder the server may write into", ""]
    for name, model in models.items():
        lines += [f"[providers.{name}]", f"model = {q(model)}", ""]
    return "\n".join(lines)


def run_init(target: Path, force: bool = False, ask=None, out=print, starting: bool = False) -> int:
    """`starting`: the command that follows (serve, doctor...) carries on right after, so the last hint is not "now run it"."""
    ask = ask or input
    if target.exists() and not force:
        out(f"error: {target} already exists (use --force to replace it, or edit it)")
        return 1
    out("Mathesis setup: a few questions. Enter accepts the default (no AI provider needed).\n")
    root = ask_text(ask, "1) Folder where lessons and notes are saved", DEFAULT_NOTES)
    root_dir = Path(root).expanduser()
    if root_dir.exists() and not root_dir.is_dir():
        out(f"error: {root_dir} exists and is not a folder")
        return 1
    default = choose(ask, "2) Which model provider to use by default?", [NO_AI, *PROVIDERS], out)
    others = [(n, label) for n, label in PROVIDERS if n != default]
    jobs = {"summary": None, "lab": None}
    for number, key, what, off in ((3, "summary", "summaries", "off: no summaries (lessons are only saved)"),
                                   (4, "lab", "lab guides", "off: no lab guides")):
        if default == "none":
            break
        picked = choose(ask, f"{number}) Which provider for {what}?",
                        [(default, f"default ({default})")] + others + [("none", off)], out)
        jobs[key] = None if picked == default else picked
    used = set() if default == "none" else {default, *(v for v in jobs.values() if v and v != "none")}
    models = {}
    if "openai" in used:  # the only built-in provider without a default model
        models["openai"] = ask_text(ask, "OpenAI model name", "gpt-4.1-mini")

    root_dir.mkdir(parents=True, exist_ok=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render(root, default, jobs["summary"], jobs["lab"], models), encoding="utf-8")
    target.chmod(0o600)
    try:
        Settings.from_env(target)  # the file we just wrote must load
    except ConfigError as e:
        out(f"error: the written file is not valid: {e}")
        return 1

    out(f"\nWrote {target} (notes folder: {root_dir})")
    keys = sorted(api_key_env(n) for n in used if n in NEEDS_KEY)
    env_file = target.parent / ".env"
    out("\nBefore you start:")
    step = 1
    if default == "none":
        out("  No AI is configured: lessons are saved as they are. Run `mathesis config --init --force` or edit the file to add a provider.")
    for key in keys:
        out(f"  {step}) Set {key}: either `export {key}=...` in the shell that starts the server,")
        out(f"     or write the line {key}=... to {env_file} (gitignored)")
        step += 1
    if "ollama" in used:
        out(f"  {step}) Make sure Ollama is running and has its model: `ollama pull gemma4:12b`")
        step += 1
    if "claude-code" in used:
        out(f"  {step}) Make sure the `claude` CLI is installed and logged in")
        step += 1
    if starting:
        out(f"  {step}) `mathesis doctor` checks everything at any time; change answers with `mathesis config --init --force`\n")
    else:
        out(f"  {step}) `mathesis doctor` checks everything, then `mathesis serve` starts the server")
    return 0
