#!/usr/bin/env python3
"""Generate and score lesson summaries for a prompt variant.

  python3 -I eval/evaluate.py run <variant> [--only 13-slos,19-design] [--verbose]
  python3 -I eval/evaluate.py score <variant> [--verbose]     (re-score existing outputs)

A variant is eval/prompts/<variant>.txt (system prompt) and optionally
eval/prompts/<variant>.user.txt (user message template; placeholders {learning_path},
{course}, {lesson}, {content}). Outputs go to $EVAL_OUT/<variant>/ (default: eval/out).

Metrics (per lesson, then averaged):
  recall       share of hand-written key facts (facts.json) present in the summary  [deterministic regex]
  faithfulness share of summary claims the judge finds supported by the transcript.
               JUDGE=manual (default): verdicts from <out>/<variant>/judgments.json (written by Claude);
               JUDGE=ollama: JUDGE_MODEL via Ollama
  score        recall x faithfulness   <- headline number
  density      key facts covered per 100 summary words (rewards complete AND compact)
  redundancy   share of claims that repeat an earlier claim (word overlap)
  noise        anecdote hits that should not take space (facts.json "noise")
  tech_recall  expected products present in the Technologies section
  tech_junk    concepts/practices wrongly listed as technologies
"""
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://172.17.0.1:11434")
GEN_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:latest")
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "qwen3:latest")
NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "16384"))
OUT_ROOT = Path(os.environ.get("EVAL_OUT", HERE / "out"))
FACTS = json.loads((HERE / "facts.json").read_text())
ROOT = Path(FACTS["root"])
FLAGS = re.I | re.S


SEED = int(os.environ.get("EVAL_SEED", "42"))


def chat(model, system, user, fmt=None, seed=None, timeout=900):
    seed = SEED if seed is None else seed
    payload = {
        "model": model, "stream": False, "think": False,
        "options": {"temperature": 0.2 if fmt is None else 0, "num_ctx": NUM_CTX, "seed": seed},
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    if fmt:
        payload["format"] = fmt
    req = urllib.request.Request(f"{OLLAMA_URL}/api/chat", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)["message"]["content"].strip()


def transcript_of(lesson):
    return (ROOT / lesson["file"]).read_text(encoding="utf-8")


def user_message(variant, lesson):
    f = HERE / "prompts" / f"{variant}.user.txt"
    template = f.read_text() if f.exists() else "Transcript:\n\n{content}"
    p = (ROOT / lesson["file"])
    return template.format(
        learning_path=p.parent.parent.name, course=p.parent.name,
        lesson=re.sub(r"^\d+-", "", p.stem), content=transcript_of(lesson))


def generate(variant, ids):
    system = (HERE / "prompts" / f"{variant}.txt").read_text()
    out = OUT_ROOT / variant
    out.mkdir(parents=True, exist_ok=True)
    for lid in ids:
        print(f"[{variant}] generating {lid} ...", flush=True)
        (out / f"{lid}.md").write_text(chat(GEN_MODEL, system, user_message(variant, FACTS["lessons"][lid])) + "\n")


# ---------------------------------------------------------------- scoring
def split_tech(text):
    m = re.search(r"^#{2,}\s*Technologies.*$", text, re.M | re.I)
    return (text[:m.start()], text[m.end():]) if m else (text, "")


def claims_of(body):
    """One claim per SENTENCE, tagged with its bullet's concept label: '[Concept] sentence'.
    (Per-bullet counting hides a wrong sentence inside a long bullet.)"""
    out = []
    for line in body.split("\n"):
        s = re.sub(r"^\s*([-*]|\d+\.)\s*", "", line).strip().replace("**", "")
        if not s or s.startswith("#"):
            continue
        m = re.match(r"^([^:]{1,60}):\s+(.*)$", s)
        label, text = (m.group(1), m.group(2)) if m else (None, s)
        for sent in re.split(r"(?<=[.!?])\s+(?=[A-Z\"\u201c(])", text):
            if len(sent.split()) >= 4:
                out.append(f"[{label}] {sent}" if label else sent)
    return out


STOP = set("the a an of to in and or for with that this is are be as by on it its from at can not into which their they you your".split())


def words(s):
    return {w for w in re.findall(r"[a-z0-9%]+", s.lower()) if len(w) > 3 and w not in STOP}


def redundancy(claims):
    seen, dup = [], 0
    for c in claims:
        w = words(c)
        if w and any(len(w & p) / min(len(w), len(p)) >= 0.7 for p in seen if p):
            dup += 1
        seen.append(w)
    return dup / len(claims) if claims else 0.0


def manual_faithfulness(variant, lid, claims):
    """Verdicts written by a human/Claude judge: <out>/<variant>/judgments.json
    {lesson_id: {"unsupported": ["start of claim text", ...]}}. None if the lesson wasn't judged."""
    f = OUT_ROOT / variant / "judgments.json"
    if not f.exists() or lid not in (j := json.loads(f.read_text())):
        return None, []
    bad = [c for c in claims if any(u in c for u in j[lid]["unsupported"])]
    return (1 - len(bad) / len(claims) if claims else 1.0), bad


def faithfulness(transcript, claims):
    if not claims:
        return 1.0, []
    numbered = "\n".join(f"{i + 1}. {c}" for i, c in enumerate(claims))
    system = ("You are a strict fact checker. For each numbered claim, decide whether it is supported by the "
              "transcript (stated or a direct paraphrase/consequence). A claim is NOT supported if it adds facts, "
              "numbers or relations that the transcript does not state, or contradicts it. Answer in JSON.")
    schema = {"type": "object", "required": ["results"], "properties": {"results": {"type": "array", "items": {
        "type": "object", "required": ["id", "supported"],
        "properties": {"id": {"type": "integer"}, "supported": {"type": "boolean"}}}}}}
    raw = chat(JUDGE_MODEL, system, f"TRANSCRIPT:\n{transcript}\n\nCLAIMS:\n{numbered}", fmt=schema)
    verdict = {r["id"]: r["supported"] for r in json.loads(raw)["results"]}
    unsupported = [c for i, c in enumerate(claims) if not verdict.get(i + 1, True)]
    return 1 - len(unsupported) / len(claims), unsupported


def score_lesson(variant, lid, lesson, summary, verbose):
    body, tech = split_tech(summary)
    hits = [all(re.search(p, summary, FLAGS) for p in pats) for _, pats in lesson["facts"]]
    recall = sum(hits) / len(hits)
    claims = claims_of(body)
    if os.environ.get("JUDGE", "manual") == "manual":
        faith, unsupported = manual_faithfulness(variant, lid, claims)
    else:
        faith, unsupported = faithfulness(transcript_of(lesson), claims)
    n_words = len(summary.split())
    names = [n for n in re.findall(r"^\s*[-*]\s*\*\*(.+?)\*\*", tech, re.M) if n.strip().lower() != "none"]
    exp = lesson["tech_expected"]
    tech_recall = (sum(e.lower() in tech.lower() for e in exp) / len(exp)) if exp else None
    junk = [n for n in names if any(re.search(p, n, FLAGS) for p in lesson["tech_forbidden"])]
    noise = [p for p in lesson["noise"] if re.search(p, summary, FLAGS)]
    res = {
        "words": n_words, "recall": recall, "faithfulness": faith, "score": None if faith is None else recall * faith,
        "density": sum(hits) / n_words * 100, "redundancy": redundancy(claims), "noise": len(noise),
        "tech_recall": tech_recall, "tech_junk": len(junk),
    }
    if verbose:
        print(f"  -- {lid}: missed facts:")
        for (name, _), h in zip(lesson["facts"], hits):
            if not h:
                print(f"       x {name}")
        for u in unsupported:
            print(f"       ? unsupported: {u[:110]}")
        for j in junk:
            print(f"       ! tech junk: {j}")
    return res


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


COLS = ["words", "recall", "faithfulness", "score", "density", "redundancy", "noise", "tech_recall", "tech_junk"]


def fmt(v, c):
    if v is None:
        return "  -  "
    return f"{v:5.0f}" if c in ("words", "noise", "tech_junk") else f"{v:5.2f}"


def score(variant, ids, verbose):
    out = OUT_ROOT / variant
    results = {}
    for lid in ids:
        f = out / f"{lid}.md"
        if f.exists() and FACTS["lessons"][lid]["facts"]:
            results[lid] = score_lesson(variant, lid, FACTS["lessons"][lid], f.read_text(), verbose)
    print(f"\nvariant: {variant}   (gen={GEN_MODEL}, judge={'manual/Claude' if os.environ.get('JUDGE','manual')=='manual' else JUDGE_MODEL})")
    print(f"{'lesson':<12}{'split':<9}" + "".join(f"{c[:11]:>12}" for c in COLS))
    for lid, r in results.items():
        print(f"{lid:<12}{FACTS['lessons'][lid]['split']:<9}" + "".join(f"{fmt(r[c], c):>12}" for c in COLS))
    for split in ("tune", "holdout"):
        rs = [r for lid, r in results.items() if FACTS["lessons"][lid]["split"] == split]
        if rs:
            print(f"{'MEAN':<12}{split:<9}" + "".join(f"{fmt(mean([r[c] for r in rs]), c):>12}" for c in COLS))
    (out / "scores.json").write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    args = sys.argv[1:]
    cmd, variant = args[0], args[1]
    ids = list(FACTS["lessons"])
    if "--only" in args:
        ids = args[args.index("--only") + 1].split(",")
    if cmd == "run":
        generate(variant, ids)
    score(variant, ids, "--verbose" in args)
