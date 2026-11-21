"""Attempts for the quiz platform (QuickQuiz): the file `NN-attempt N.json`, in the import format of schema/quickquiz-attempts.schema.json.

The userscript writes the attempt from the Udemy results page (your answers, the questions you marked, when it was taken). It can only
name the quiz by title; the server adds `quiz.hash`, the content hash the platform identifies a quiz by, computed from the quiz JSON
saved next to it (`NN-all questions.json`, the very file you import there), so the attempt finds its quiz even when two quizzes share
a title. Without that file the attempt keeps the title only, and the platform matches it by title.
"""
import hashlib
import json
import re
from pathlib import Path

DROP_TOP = ("attempt", "author", "syllabus")      # not part of a quiz's identity
DROP_QUESTION = ("domain", "domainGuessed")


def quiz_hash(quiz: dict) -> str:
    """The content hash of a quiz file as the platform computes it (see `x-hashExample` in the schema)."""
    content = {k: v for k, v in quiz.items() if k not in DROP_TOP}
    if isinstance(content.get("questions"), list):
        content["questions"] = [{k: v for k, v in q.items() if k not in DROP_QUESTION} if isinstance(q, dict) else q
                                for q in content["questions"]]
    text = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def quiz_file_for(attempt_path: Path) -> Path:
    """`NN-attempt N.json` belongs to `NN-all questions.json` in the same folder."""
    m = re.match(r"(\d+)-attempt \d+\.json$", attempt_path.name)
    return attempt_path.with_name(f"{m[1]}-all questions.json" if m else "all questions.json")


def add_hash(content: bytes, quiz_file: Path) -> tuple[bytes, str]:
    """`content` (an attempts file from the userscript) with the hash of the saved quiz put on each attempt whose title it has.
    Returns the new content and a note: "hash" (added), "no quiz" (no saved quiz JSON) or "other quiz" (its title differs)."""
    data = json.loads(content.decode("utf-8"))
    if not quiz_file.is_file():
        return content, "no quiz"
    try:
        quiz = json.loads(quiz_file.read_text(encoding="utf-8"))
        title = str(quiz["title"]).strip().lower()
        digest = quiz_hash(quiz)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return content, "no quiz"
    note = "other quiz"
    for attempt in data.get("attempts", []):
        q = attempt.get("quiz") or {}
        if str(q.get("title", "")).strip().lower() == title:
            attempt["quiz"] = {"hash": digest, "title": q["title"]}
            note = "hash"
    return (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8"), note
