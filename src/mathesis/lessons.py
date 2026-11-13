"""Find which saved lesson a piece of text (e.g. a quiz question) comes from: embeddings over transcript passages."""
import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path

# files made from a lesson (summary, lab guide, Udemy quiz review and its lessons-to-learn companion), never lessons themselves
DERIVED = ("-summary.md", "-lab-guide.md", " - incorrect.md", " - all questions.md", " - lessons to learn.md")
CACHE = Path("~/.cache/mathesis/embeddings.json").expanduser()


@dataclass
class Match:
    lesson: Path      # transcript file
    title: str        # e.g. "13-SLOs and error budgets"
    score: float      # cosine similarity of the best passage
    passage: str      # that passage


def lesson_files(course_dir: Path) -> list[Path]:
    """Transcript files of a course: every .md that is not a summary and not a quiz copy."""
    def is_quiz(f: Path) -> bool:
        head = f.read_text(encoding="utf-8")[:400]
        return bool(re.search(r"\*\d+ questions · multiple choice", head))
    return [f for f in sorted(course_dir.glob("*.md")) if not f.name.endswith(DERIVED) and not is_quiz(f)]


def passages(text: str, max_chars: int = 900) -> list[str]:
    """Paragraphs of a transcript (the userscript writes ~450-char paragraphs); tiny ones are merged."""
    out, current = [], ""
    for para in (p.strip() for p in re.split(r"\n\s*\n", text)):
        if not para or para.startswith("# "):
            continue
        current = f"{current}\n\n{para}".strip() if current and len(current) < 200 else para
        if len(current) >= 200:
            out.append(current)
            current = ""
    if current:
        out.append(current)
    return [p[:max_chars * 2] for p in out]


def _cosine(a, b) -> float:
    return sum(x * y for x, y in zip(a, b)) / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)) or 1)


class LessonIndex:
    def __init__(self, client, cache_path: Path = CACHE):
        self.client, self.cache_path = client, cache_path
        self.items: list[tuple[Path, str, list[float]]] = []   # (lesson file, passage, vector)
        self._cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}

    def _vectors(self, texts: list[str]) -> list[list[float]]:
        key = lambda t: f"{self.client.embed_model}:{hashlib.sha1(t.encode()).hexdigest()}"
        todo = [t for t in dict.fromkeys(texts) if key(t) not in self._cache]
        for i in range(0, len(todo), 32):
            batch = todo[i:i + 32]
            for t, v in zip(batch, self.client.embed(batch)):
                self._cache[key(t)] = v
        if todo:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(json.dumps(self._cache))
        return [self._cache[key(t)] for t in texts]

    def build(self, course_dir: Path) -> "LessonIndex":
        pairs = [(f, p) for f in lesson_files(course_dir) for p in passages(f.read_text(encoding="utf-8"))]
        self.items = [(f, p, v) for (f, p), v in zip(pairs, self._vectors([p for _, p in pairs]))]
        return self

    def search(self, text: str, k: int = 3) -> list[Match]:
        """Best lessons for `text`, one entry per lesson (its best passage), most similar first."""
        query = self._vectors([text])[0]
        best: dict[Path, tuple[float, str]] = {}
        for f, p, v in self.items:
            score = _cosine(query, v)
            if f not in best or score > best[f][0]:
                best[f] = (score, p)
        ranked = sorted(best.items(), key=lambda kv: -kv[1][0])[:k]
        return [Match(f, f.stem, score, passage) for f, (score, passage) in ranked]
