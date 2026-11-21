"""One-off: rename the GUESSED domains of already-saved quiz JSON files to the labels the quiz itself uses for the same areas.

New saves do this on their own (`mathesis.domains.align`); this script fixes files saved before that. For each file it takes the
labels Udemy gave the questions (the ones without `"domainGuessed"`), asks the `[domains]` provider which of them names the same area
as each official domain in the file's `"syllabus"`, and renames the guessed questions whose domain is that official name. Nothing else
in the file changes. Dry run unless --write.

    uv run python scripts/realign-domains.py "<folder or file>" [...]            # shows what would change
    uv run python scripts/realign-domains.py --write "<folder or file>" [...]
"""
import argparse
import json
import os
import sys
from pathlib import Path

from mathesis.config import Settings
from mathesis.domains import align, quiz_labels
from mathesis.llm import make_client


def realign(data: dict, client) -> tuple[dict[str, str], int]:
    """(official name -> label used, questions renamed); `data` is changed in place."""
    syllabus = data.get("syllabus") or {}
    names = syllabus.get("domains") or []
    labels = quiz_labels(data)
    if not names or not labels:
        return {}, 0
    mapping = align(client, {"domains": [{"name": n} for n in names]}, labels)
    renamed = 0
    for q in data["questions"]:
        if q.get("domainGuessed") and q.get("domain") in mapping:
            q["domain"] = mapping[q["domain"]]
            renamed += 1
    return mapping, renamed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="+", help="quiz JSON files, or folders searched for *.json")
    ap.add_argument("--write", action="store_true", help="save the changes (default: only show them)")
    ap.add_argument("--config", help="config file (default: as `mathesis serve`)")
    args = ap.parse_args()

    client = make_client(Settings.from_env(args.config), "domains")
    if client is None:
        sys.exit("No provider is set for domains ([domains] provider, or the default provider).")
    ok, problem = client.check()
    if not ok:
        sys.exit(f"Provider not reachable: {problem}")

    files = []
    for p in map(Path, args.paths):
        files += sorted(p.glob("*.json")) if p.is_dir() else [p]
    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("questions"), list):
                continue
            before = {i: q.get("domain") for i, q in enumerate(data["questions"])}
            mapping, renamed = realign(data, client)
        except (OSError, ValueError) as e:
            print(f"{path.name}: skipped ({e})")
            continue
        if not renamed:
            print(f"{path.name}: nothing to change")
            continue
        print(f"{path.name}: {renamed} question(s) renamed")
        for official, label in mapping.items():
            print(f"    {official}  ->  {label}")
        for i, q in enumerate(data["questions"]):
            if before[i] != q["domain"]:
                print(f"    #{q.get('number') or i + 1}: {before[i]!r} -> {q['domain']!r}")
        if args.write:
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            os.replace(tmp, path)
    if not args.write:
        print("\nDry run: nothing was written. Add --write to save.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
