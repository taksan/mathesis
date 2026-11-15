"""Transcript -> study notes.

two-stage (default), developed and tested in eval/:
  extract     transcript -> faithful fact list, incl. a Decision guide when the lesson has one
  synthesize  fact list  -> notes organized by ideas (big idea, themes, How to choose, exam list)
  revise      if coverage.py finds facts/sections missing from the notes, ask for them (max_revisions rounds)
single: one call with the original prompt (single.txt).
"""
import re
from pathlib import Path

from . import coverage
from .config import Settings
from .notify import notify
from .obsidian import open_note, opener_name
from .llm import make_client, should_announce

PROMPT_DIR = Path(__file__).resolve().parent / "prompts"


def load_prompt(name: str) -> tuple[str, str]:
    """(system prompt, user-message template) for e.g. 'extract' -> extract.txt + extract.user.txt."""
    system = (PROMPT_DIR / f"{name}.txt").read_text(encoding="utf-8")
    user_file = PROMPT_DIR / f"{name}.user.txt"
    user = user_file.read_text(encoding="utf-8") if user_file.exists() else "Transcript:\n\n{content}"
    return system, user


def build_user_message(template: str, content: str, file: str | Path) -> str:
    """Context comes from the path: <learning path>/<course>/<NN-lesson>.md"""
    p = Path(file)
    return template.format(
        learning_path=p.parent.parent.name, course=p.parent.name,
        lesson=re.sub(r"^\d+-", "", p.stem), content=content)


def summarize(content: str, file: str | Path, client, settings: Settings, log=print) -> tuple[str, dict]:
    """Returns (notes_markdown, info). `client` is any backend from llm.py (chat(system, user) -> text)."""
    model = getattr(client, "label", settings.model)
    if settings.pipeline == "single":
        system, template = load_prompt("single")
        return (client.chat(system, build_user_message(template, content, file)),
                {"prompts": "single", "revisions": 0, "model": model})
    s1, u1 = load_prompt("extract")
    log(f"  stage 1 ({model}): extracting facts")
    dump = client.chat(s1, build_user_message(u1, content, file))
    s2, u2 = load_prompt("synthesize")
    log(f"  stage 2 ({model}): writing notes")
    notes = client.chat(s2, build_user_message(u2, dump, file))
    revise_system = (PROMPT_DIR / "revise.txt").read_text(encoding="utf-8")
    revisions = 0
    for _ in range(settings.max_revisions):
        missing, sections = coverage.missing_facts(dump, notes), coverage.required_sections_missing(notes)
        if not missing and not sections:
            break
        log(f"  revision {revisions + 1}: {len(missing)} omitted facts, missing sections: {sections or 'none'}")
        message = ("CURRENT NOTES:\n" + notes + "\n\nOMITTED FACTS:\n" + "\n".join("- " + m for m in missing)
                   + ("\n\nMISSING SECTIONS: " + ", ".join(sections) if sections else ""))
        notes = client.chat(revise_system, message)
        revisions += 1
    return notes, {"prompts": "extract+synthesize", "revisions": revisions, "model": model}


def clean_summary(text: str) -> str:
    """Drop an empty 'Technologies & services' section (prompts ask for 'None' when there is nothing)."""
    return re.sub(r"\n+#{2,}\s*Technologies[^\n]*\n+\s*(-\s*)?(\*\*)?None\.?(\*\*)?\s*$", "", text.strip(), flags=re.I) + "\n"


def summary_path(file: str | Path) -> Path:
    file = str(file)
    return Path(file[:-3] + "-summary.md" if file.endswith(".md") else file + "-summary.md")


def render(notes: str, info: dict, settings: Settings) -> str:
    """Final file text: cleaned notes plus a hidden comment saying which model/pipeline produced them."""
    footer = (f"\n<!-- summary: model={info.get('model', settings.model)} pipeline={settings.pipeline} "
              f"prompts={info['prompts']} revisions={info['revisions']} -->\n")
    return clean_summary(notes) + footer


def write_summary(content: str, file: str | Path, settings: Settings) -> str | None:
    """Generate and save <file>-summary.md; report the outcome with a desktop notification."""
    name = Path(file).stem
    try:
        client = make_client(settings, "summary")
        if client is None:
            return
        ok, problem = client.check()
        if not ok:  # fallback: the transcript is already saved; just no summary
            print(f"No summary for {file}: {problem}. The transcript is saved.")
            if should_announce("summary", problem):
                notify("Saved without summary", f"{name}: {problem}", enabled=settings.notify)
            return problem
        should_announce("summary", None)
        print(f"Requesting summary ({client.label}, pipeline {settings.pipeline}) for {file}")
        notes, info = summarize(content, file, client, settings)
        out = summary_path(file)
        out.write_text(render(notes, info, settings), encoding="utf-8")
        print(f"Summary written to {out}")
        on_click = (lambda: open_note(out, settings)) if settings.obsidian_open else None
        notify("Summary ready", name, enabled=settings.notify, on_click=on_click,
               action_label=f"Open in {opener_name(settings)}")
    except Exception as e:
        print(f"Error generating summary for {file}: {e}")
        notify("Summary failed", f"{name}: {e}", error=True, enabled=settings.notify)
        return str(e)