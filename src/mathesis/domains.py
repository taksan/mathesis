"""Exam domains for the questions of a saved quiz (`NN-all questions.json`) that Udemy gave none.

Some course authors tag their questions with an exam domain and many do not. When a provider is set (`[domains]`, else the default
provider), the server fills in the missing ones after the JSON is saved, and only from the certification's OFFICIAL syllabus:

  1. the model says which certification the course prepares for (from the course name, the test title and the first questions);
  2. the syllabus is found: official URLs the model is sure of, then a web search for the exam guide (webtext.py); every page is read
     as text (HTML or PDF) and the model extracts the top-level domains from it. A domain only counts if its name appears in the
     page text, and the page has to be published by the certifying body itself (the model's call, shown in the file);
  3. the questions are classified in batches against those domains; an answer that is not one of the domains is dropped.

The syllabus is built once and kept (~/.cache/mathesis/syllabi/<certification>.json, never expired; delete the file to build it again),
and each course folder is remembered with its certification (courses.json there), so every later test of that course, and of any
course for the same exam, reuses it: no identification, no search, no page read. Questions that already have a domain are never touched. Each question the model tagged gets `"domainGuessed": true`, and the file records
where the syllabus came from in `"syllabus"`: the official names are Udemy's own labels' alternative, not a replacement,
except that a domain the quiz already names (its other questions carry Udemy's label for it, often reworded or cut off) is written with
that label, so one quiz does not call the same area by two names (`align`; `"syllabus"` keeps the official names).
"""
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from . import webtext
from .config import Settings
from .llm import make_client, should_announce
from .notify import notify
from .obsidian import open_note, opener_name
from .pipeline import PROMPT_DIR

CACHE_DIR = Path("~/.cache/mathesis/syllabi").expanduser()
MAX_PAGES = 5        # pages read while looking for the syllabus
MAX_TEXT = 60_000    # characters of a page the model reads
MIN_DOMAINS = 2      # fewer than this is not a syllabus
BATCH = 10           # questions per classification call
SAMPLE = 8           # questions shown when identifying the certification


class DomainError(Exception):
    """Nothing could be added; the message says why (it becomes the job's failure reason)."""


def prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


def parse_json(text: str, want: type):
    """The first JSON value of type `want` (dict or list) in a model's answer, tolerating a code fence or a sentence around it."""
    for m in re.finditer(r"[\[{]", text):
        try:
            value, _ = json.JSONDecoder().raw_decode(text[m.start():])
        except ValueError:
            continue
        if isinstance(value, want):
            return value
    raise ValueError("no JSON in the answer: " + text.strip()[:120])


def norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:100] or "unknown"


def one_line(text, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def missing(data: dict) -> list[int]:
    """Positions of the questions that have no domain."""
    return [i for i, q in enumerate(data.get("questions", [])) if not str(q.get("domain") or "").strip()]


def needs_domains(content: bytes | str) -> bool:
    """True when `content` is a quiz JSON with at least one question that has no domain."""
    try:
        data = json.loads(content)
    except ValueError:
        return False
    return isinstance(data, dict) and isinstance(data.get("questions"), list) and bool(missing(data))


def question_text(q: dict) -> str:
    options = "; ".join(one_line(o.get("text"), 140) for o in q.get("options", []))
    return f"{one_line(q.get('question'), 700)}\nOptions: {options}"


# ---- 1. which certification ----

def identify(client, data: dict, course: str) -> dict:
    sample = "\n\n".join(f"Q{i + 1}: {question_text(q)}" for i, q in enumerate(data["questions"][:SAMPLE]))
    answer = client.chat(prompt("domains_identify.txt"),
                         f"Course: {course}\nPractice test: {data.get('title', '')}\n\nFirst questions:\n\n{sample}", 0.0)
    info = parse_json(answer, dict)
    name = str(info.get("certification") or "").strip()
    if not name or name.lower() == "null":
        raise DomainError("could not tell which certification this course prepares for")
    urls = [u for u in (info.get("urls") or []) if isinstance(u, str) and u.startswith("https://")][:3]
    return {"certification": name, "query": str(info.get("search_query") or f"{name} official exam guide").strip(), "urls": urls}


# ---- 2. the official syllabus ----

def read_syllabus(client, certification: str, url: str, text: str) -> dict | None:
    """The syllabus a page holds, or None when it is not an official one or no domain name checks out against the text."""
    answer = client.chat(prompt("domains_syllabus.txt"),
                         f"Certification: {certification}\nPage: {url}\n\nText:\n\n{text[:MAX_TEXT]}", 0.0)
    info = parse_json(answer, dict)
    if info.get("official") is not True:
        return None
    haystack = norm(text)
    domains, seen = [], set()
    for d in info.get("domains") or []:
        name = one_line(d.get("name") if isinstance(d, dict) else d, 200)
        if len(norm(name)) < 3 or norm(name) not in haystack or norm(name) in seen:   # copied from the page, or not trusted
            continue
        seen.add(norm(name))
        topics = [one_line(t, 120) for t in (d.get("topics") or []) if isinstance(t, str)][:8] if isinstance(d, dict) else []
        domains.append({"name": name, "topics": topics})
    if len(domains) < MIN_DOMAINS:
        return None
    return {"certification": certification, "url": url, "versionNote": one_line(info.get("version_note"), 200), "domains": domains}


def choose(client, found: list[dict], course: str, title: str) -> dict:
    listing = "\n".join(f"{i + 1}. {s['url']}\n   {s['versionNote'] or 'no version note'}\n   domains: "
                        + "; ".join(d["name"] for d in s["domains"]) for i, s in enumerate(found))
    try:
        n = int(parse_json(client.chat(prompt("domains_choose.txt"), f"Course: {course}\nPractice test: {title}\n\n{listing}", 0.0), dict)["choice"])
        return found[n - 1] if 1 <= n <= len(found) else found[0]
    except Exception:
        return found[0]


def load_cache(certification: str, cache_dir: Path) -> dict | None:
    """The syllabus built earlier for this certification (it stays valid until its file is deleted)."""
    try:
        cached = json.loads((cache_dir / (slug(certification) + ".json")).read_text(encoding="utf-8"))
        return cached if len(cached.get("domains", [])) >= MIN_DOMAINS else None
    except (OSError, ValueError, AttributeError):
        return None


def known_syllabus(course: str, cache_dir: Path) -> dict | None:
    """The syllabus of a course folder seen before: no need to ask which certification it is."""
    try:
        certification = json.loads((cache_dir / "courses.json").read_text(encoding="utf-8")).get(course)
    except (OSError, ValueError, AttributeError):
        return None
    return load_cache(certification, cache_dir) if isinstance(certification, str) else None


def remember_course(course: str, certification: str, cache_dir: Path) -> None:
    path = cache_dir / "courses.json"
    try:
        try:
            courses = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            courses = {}
        courses[course] = certification
        cache_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(courses, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except OSError:
        pass   # not remembered: the next test asks again (and still finds the syllabus by its certification)


def find_syllabus(client, info: dict, course: str, title: str, fetch, search, cache_dir: Path, say=print) -> dict:
    cached = load_cache(info["certification"], cache_dir)
    if cached:
        say(f"Domains: syllabus of {info['certification']} from the cache ({cached['url']})")
        return cached
    tried: list[str] = []
    found: list[dict] = []
    searched = False
    queue = list(info["urls"])
    while len(tried) < MAX_PAGES and len(found) < 2:
        if not queue:
            if searched:
                break
            searched = True
            queue = [u for u in search(info["query"]) if u not in tried]
            if not queue:
                break
        url = queue.pop(0)
        if url in tried:
            continue
        tried.append(url)
        try:
            text = fetch(url)
            if len(text) < 500:
                continue
            syllabus = read_syllabus(client, info["certification"], url, text)
        except (webtext.FetchError, ValueError) as e:
            say(f"Domains: {url[:90]} skipped: {e}")
            continue
        if syllabus:
            say(f"Domains: official syllabus found at {url} ({len(syllabus['domains'])} domains)")
            found.append(syllabus)
    if not found:
        raise DomainError(f"no official syllabus found for {info['certification']} (read {len(tried)} page(s))")
    syllabus = found[0] if len(found) == 1 else choose(client, found, course, title)
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        (cache_dir / (slug(info["certification"]) + ".json")).write_text(
            json.dumps({**syllabus, "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds")}, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8")
    except OSError:
        pass   # not cached: the next test looks again
    return syllabus


# ---- 3. the questions ----

def classify(client, syllabus: dict, questions: list[tuple[int, dict]]) -> dict[int, str]:
    """{position in the file: official domain name} for the questions the model could place."""
    domains = syllabus["domains"]
    listing = "\n".join(f"{i + 1}. {d['name']}" + (f" — {'; '.join(d['topics'])}" if d["topics"] else "") for i, d in enumerate(domains))
    system = prompt("domains_classify.txt")
    result: dict[int, str] = {}
    for start in range(0, len(questions), BATCH):
        batch = questions[start:start + BATCH]
        user = f"Syllabus of {syllabus['certification']}:\n\n{listing}\n\nQuestions:\n\n" + "\n\n".join(
            f"[id {n}] {question_text(q)}" for n, (_, q) in enumerate(batch, 1))
        for _ in range(2):                    # one retry for a batch whose answer cannot be read or is incomplete
            try:
                answers = parse_json(client.chat(system, user, 0.0), list)
            except ValueError:
                continue
            for a in answers:
                try:
                    n, k = int(a["id"]), a.get("domain")
                    if 1 <= n <= len(batch) and k is not None and 1 <= int(k) <= len(domains):
                        result[batch[n - 1][0]] = domains[int(k) - 1]["name"]
                except (KeyError, TypeError, ValueError, AttributeError):
                    continue
            if all(i in result for i, _ in batch):
                break
    return result


def quiz_labels(data: dict) -> list[str]:
    """The domain labels Udemy's page gave the quiz's questions, most used first (guessed ones do not count)."""
    count: dict[str, int] = {}
    for q in data.get("questions", []):
        label = str(q.get("domain") or "").strip()
        if label and not q.get("domainGuessed"):
            count[label] = count.get(label, 0) + 1
    return sorted(count, key=lambda k: -count[k])


def align(client, syllabus: dict, labels: list[str]) -> dict[str, str]:
    """{official domain name: the quiz's own label for it}, so guessed questions are spelled like the ones Udemy tagged.
    Only matches the model is sure of; a domain with no label keeps its official name."""
    if not labels:
        return {}
    domains = syllabus["domains"]
    user = ("Official domains:\n" + "\n".join(f"{i + 1}. {d['name']}" for i, d in enumerate(domains)) +
            "\n\nLabels used in the practice test:\n" + "\n".join(f"{i + 1}. {label}" for i, label in enumerate(labels)))
    try:
        answers = parse_json(client.chat(prompt("domains_align.txt"), user, 0.0), list)
    except ValueError:
        return {}
    result: dict[str, str] = {}
    for a in answers:
        try:
            k, m = int(a["domain"]), a.get("label")
            if m is not None and 1 <= k <= len(domains) and 1 <= int(m) <= len(labels) and labels[int(m) - 1] not in result.values():
                result.setdefault(domains[k - 1]["name"], labels[int(m) - 1])
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    return result


def add_domains(data: dict, course: str, client, fetch=webtext.fetch_text, search=webtext.search,
                cache_dir: Path = CACHE_DIR, say=print) -> int:
    """Fill the missing domains of `data` in place (see the module doc). Returns how many questions got one."""
    todo = missing(data)
    if not todo:
        return 0
    syllabus = known_syllabus(course, cache_dir)
    if syllabus:
        say(f"Domains: {len(todo)} of {len(data['questions'])} questions have none; syllabus of {syllabus['certification']} "
            f"from the cache ({syllabus['url']})")
    else:
        info = identify(client, data, course)
        say(f"Domains: {len(todo)} of {len(data['questions'])} questions have none; certification: {info['certification']}")
        syllabus = find_syllabus(client, info, course, data.get("title", ""), fetch, search, cache_dir, say)
        remember_course(course, syllabus["certification"], cache_dir)
    placed = classify(client, syllabus, [(i, data["questions"][i]) for i in todo])
    if not placed:
        raise DomainError("the model placed no question in a domain of the syllabus")
    own = align(client, syllabus, quiz_labels(data))     # the quiz's own spelling where it has one
    for i, name in placed.items():
        data["questions"][i]["domain"] = own.get(name, name)
        data["questions"][i]["domainGuessed"] = True
    questions = data.pop("questions")
    data.pop("syllabus", None)
    # the record sits just before the questions, as in the file the userscript wrote
    data["syllabus"] = {"certification": syllabus["certification"], "url": syllabus["url"], "domains": [d["name"] for d in syllabus["domains"]]}
    data["questions"] = questions
    return len(placed)


def write_domains(file: str | Path, settings: Settings, run=subprocess.run, fetch=webtext.fetch_text, search=webtext.search,
                  cache_dir: Path = CACHE_DIR) -> str | None:
    """Add the missing domains to the quiz JSON `file`; the outcome is a desktop notification. Returns why nothing was
    written (provider down, no syllabus found, ...) or None."""
    path = Path(file)
    name = path.stem
    try:
        client = make_client(settings, "domains", run)
        if client is None:
            return None
        ok, problem = client.check()
        if not ok:
            print(f"No domains for {file}: {problem}. The quiz is saved.")
            if should_announce("domains", problem):
                notify("Quiz saved without domains", f"{name}: {problem}", enabled=settings.notify)
            return problem
        should_announce("domains", None)
        before = path.stat()
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("questions"), list):
            return "not a quiz file"
        total = len(data["questions"])
        print(f"Adding domains ({client.label}) to {file}")
        count = add_domains(data, path.parent.name, client, fetch, search, cache_dir)
        if count == 0:
            return None
        after = path.stat()
        if (after.st_mtime_ns, after.st_size) != (before.st_mtime_ns, before.st_size):
            return "the file was saved again while the domains were being added: nothing was changed"
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        print(f"Domains added to {count} of {total} questions in {path}")
        notify("Domains added", f"{name}: {count} of {total} questions", enabled=settings.notify)
    except Exception as e:
        print(f"Error adding domains to {file}: {e}")
        notify("Adding domains failed", f"{name}: {e}", error=True, enabled=settings.notify)
        return str(e)
