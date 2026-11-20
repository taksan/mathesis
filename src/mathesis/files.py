"""The files that belong to one page of a course, and the background jobs (summary, lab guide) still writing some of them.

`GET /files` answers from here: the userscript sends the page's main path and gets every document of that page, so it never
has to guess names ("NN-incorrect (attempt 2).md", the JSON, the summary, the lab guide).
"""
import re
import threading
from pathlib import Path

from .labguide import guide_path
from .pipeline import summary_path

QUIZ_NAME = re.compile(r"^(?P<num>\d+)-(?P<kind>incorrect|all questions)(?: \(attempt (?P<attempt>\d+)\))?\.(?P<ext>md|json)$")


class Jobs:
    """Summaries and lab guides being written by this server process, and the ones that failed.

    In memory only: a job lives and dies with the process, so a restart has nothing pending and nothing to remember.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._state: dict[tuple[str, str], dict] = {}

    def start(self, target: Path, kind: str) -> None:
        with self._lock:
            self._state[(str(target), kind)] = {"state": "pending"}

    def finish(self, target: Path, kind: str, output: Path, problem: str | None = None) -> None:
        """Called when the job ends, however it ended: the file is there, or the job failed (`problem` says why)."""
        with self._lock:
            if output.is_file() and not problem:   # a failed *re*generation leaves the old file: still a failure
                self._state.pop((str(target), kind), None)
            else:
                self._state[(str(target), kind)] = {"state": "failed", "error": problem or "not written: see the server log"}

    def get(self, target: Path, kind: str) -> dict | None:
        with self._lock:
            return self._state.get((str(target), kind))

    def run(self, target: Path, kind: str, output: Path, fn, *args) -> None:
        """Run a summary / lab guide writer, tracking it. Registered by `start` before the task is queued."""
        problem = "stopped unexpectedly: see the server log"
        try:
            problem = fn(*args)   # the writers return why they wrote nothing (provider down, no key, a bad answer), or None
        finally:
            self.finish(target, kind, output, problem)


def page_files(target: Path, root: Path, jobs: Jobs, obsidian: bool) -> list[dict]:
    """Every document of the page whose main file is `target` (files that exist, plus summary / guide still being written)."""
    def entry(kind: str, label: str, path: Path | None, state: str = "ready", **extra) -> dict:
        md = path is not None and path.suffix == ".md"
        return {"kind": kind, "label": label, "state": state,
                "path": str(path.relative_to(root)) if path else None,
                "opener": "obsidian" if md and obsidian else "editor", **extra}

    quiz = QUIZ_NAME.match(target.name)
    out: list[dict] = []
    if quiz:
        folder, num = target.parent, quiz["num"]
        attempts = []
        for f in folder.glob(f"{num}-incorrect*.md"):
            m = QUIZ_NAME.match(f.name)
            if m and m["kind"] == "incorrect" and m["num"] == num:
                attempts.append((int(m["attempt"] or 1), f))
        for n, f in sorted(attempts, reverse=True):
            out.append(entry("incorrect", f"Attempt {n}", f, attempt=n))
        for kind, label, name in [("all", "All questions", f"{num}-all questions.md"),
                                  ("json", "All questions (JSON)", f"{num}-all questions.json")]:
            if (folder / name).is_file():
                out.append(entry(kind, label, folder / name))
        job = jobs.get(folder / f"{num}-all questions.json", "domains")   # the exam domains being added to the JSON (or failed)
        if job:
            out.append(entry("domains", "Exam domains", folder / f"{num}-all questions.json", job["state"],
                             **({"error": job["error"]} if "error" in job else {}), regenerating=True))
        return out

    for kind, label, path in [("lab-guide", "Lab guide", guide_path(target)), ("summary", "Summary", summary_path(target))]:
        job = jobs.get(target, kind)
        if job:   # pending / failed; when the file exists this is a regeneration, and the old file stays readable
            out.append(entry(kind, label, path if path.is_file() else None, job["state"],
                             **({"error": job["error"]} if "error" in job else {}), regenerating=path.is_file()))
        elif path.is_file():
            out.append(entry(kind, label, path))
    if target.suffix == ".md" and target.is_file():
        out.append(entry("transcript", "Transcript", target))
    return out
