"""Deterministic completeness check: every fact bullet of the stage-1 dump must be represented in the final notes."""
import re
STOP = set("the a an of to in and or for with that this is are be as by on it its from at can not into which their they you your when then than also such more most only each other have has will would should could about over under between within through".split())

def words(s):
    return {w for w in re.findall(r"[a-z0-9%.]+", s.lower().replace("**", "")) if len(w) > 3 and w not in STOP}

def fact_bullets(dump):
    """Bullets/sub-bullets/numbered lines of the dump, excluding TL;DR and Technologies sections."""
    out, skip = [], False
    for line in dump.split("\n"):
        if re.match(r"^#{1,6}\s", line):
            skip = bool(re.match(r"^#{2,}\s*(TL;DR|Technologies)", line, re.I))
            continue
        if skip:
            continue
        m = re.match(r"^\s*([-*]|\d+\.)\s+(.*\S)", line)
        if m:
            out.append(m.group(2))
    return out

def missing_facts(dump, notes, threshold=0.5):
    nw = words(notes)
    miss = []
    for b in fact_bullets(dump):
        w = words(b)
        if len(w) >= 3 and len(w & nw) / len(w) < threshold:
            miss.append(b.replace("**", ""))
    return miss

def required_sections_missing(notes):
    return [h for h in ["The big idea", "How it fits together", "Remember for the exam"] if not re.search(rf"^##\s*{h}", notes, re.M | re.I)]

if __name__ == "__main__":
    import sys, pathlib
    d = pathlib.Path(sys.argv[1])
    for f in sorted(d.glob("*.dump.md")):
        lid = f.name.replace(".dump.md", "")
        notes = (d / f"{lid}.md").read_text()
        mf = missing_facts(f.read_text(), notes)
        print(f"{lid}: {len(fact_bullets(f.read_text()))} fact bullets, {len(mf)} missing; missing sections: {required_sections_missing(notes)}")
        for m in mf: print("    -", m[:130])
