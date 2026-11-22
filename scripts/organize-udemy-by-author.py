"""One-off: move the Udemy courses of a vault from  Udemy/<course>/  to  Udemy/<author>/<course>/.

The userscript now saves into that hierarchy; this brings the existing content in line:

  * each course folder moves under its author's folder. The author is the course's own (the `author` of its quiz JSON files, else of
    its Markdown frontmatter); the folder is the primary author's name as Udemy shows it, without the "| tagline" after the bar
    ("Priya Dwivedi | CertShield Academy" -> "Priya Dwivedi"). A course with no author anywhere goes to "unknown author".
  * the author is written where it was missing: the quiz JSON files (`author` is not part of the quiz's hash) and the frontmatter of
    the Markdown files that have one. Nothing else in a file changes.
  * links that name the old path (`[[_study_roadmap/Udemy/<course>/...]]`, or the percent-encoded form in a Markdown link) in every
    .md / .canvas of the vault are rewritten. Hidden folders (.obsidian, .git) are left alone.

Dry run unless --write. Nothing is committed. Run it with Obsidian closed (it moves files and edits notes).

    uv run python scripts/organize-udemy-by-author.py "<vault>/_study_roadmap/Udemy"
    uv run python scripts/organize-udemy-by-author.py --write "<vault>/_study_roadmap/Udemy"

Safe to run again: it only touches course folders that still sit directly in Udemy/ (for example one the old script created after the
first run); --merge moves their newer files into the course folder that already exists under the author.
"""
import argparse
import json
import re
import shutil
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import quote

from mathesis import frontmatter

UNKNOWN = "unknown author"


def folder_name(author: str) -> str:
    """The folder for an author string as Udemy shows it: the first name before a " | " tagline, made safe for a path
    (the same rule as the userscript's `authorFolder`)."""
    first = re.split(r"\s+\|\s+", (author or "").strip())[0]
    name = re.sub(r"\s+", " ", re.sub(r'[:/\\?*"<>|]', "_", first)).strip().strip(".")
    return name or UNKNOWN


def is_course(folder: Path) -> bool:
    """A course holds files; an author folder (already organised) holds only folders."""
    return any(p.is_file() for p in folder.iterdir())


def course_author(folder: Path) -> str:
    found: Counter = Counter()
    for f in folder.glob("*.json"):
        try:
            a = str(json.loads(f.read_text(encoding="utf-8")).get("author") or "").strip()
        except (OSError, ValueError, AttributeError):
            continue
        if a:
            found[a] += 1
    for f in folder.glob("*.md"):
        front, _ = frontmatter.split(f.read_text(encoding="utf-8"))
        for line in front or []:
            m = re.match(r'author\s*:\s*"(.*)"\s*$', line)
            if m and m.group(1).strip():
                found[json.loads('"' + m.group(1) + '"').strip()] += 1
    return found.most_common(1)[0][0] if found else ""


def fill_author(folder: Path, author: str) -> tuple[int, int]:
    """Put `author` into the JSON and Markdown files of the (already moved) folder that lack it. Returns (json files, md files)."""
    nj = nm = 0
    for f in sorted(folder.glob("*.json")):
        text = f.read_text(encoding="utf-8")
        try:
            data = json.loads(text)
        except ValueError:
            continue
        if not isinstance(data, dict) or not isinstance(data.get("questions"), list) or str(data.get("author") or "").strip():
            continue
        if json.dumps(data, indent=2, ensure_ascii=False) + "\n" != text:   # not written by Mathesis: do not reformat it
            print(f"    skipped {f.name}: not in the format Mathesis writes")
            continue
        out = {}
        for k, v in data.items():
            if k != "author":
                out[k] = v
            if k == "title":
                out["author"] = author
        out.setdefault("author", author)
        f.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        nj += 1
    for f in sorted(folder.glob("*.md")):
        text = f.read_text(encoding="utf-8")
        front, _ = frontmatter.split(text)
        if front is None or any(re.match(r"author\s*:", l) for l in front):
            continue
        f.write_text(frontmatter.refresh(text, {"author": author}), encoding="utf-8")
        nm += 1
    return nj, nm


def merge_into(source: Path, target: Path) -> None:
    """Move the files of `source` into the existing `target` (a save from the old script landed at the old path after the course had
    been moved): a file replaces the one there only when it is newer; an older one is left behind and reported."""
    for f in sorted(source.iterdir()):
        dest = target / f.name
        if dest.exists() and f.stat().st_mtime <= dest.stat().st_mtime:
            print(f"    kept {dest.name} already in {target.parent.name}/{target.name} (the one at the old path is not newer): {f}")
            continue
        print(f"    {'replaced' if dest.exists() else 'added'} {dest.name}")
        shutil.move(str(f), str(dest))
    if not any(source.iterdir()):
        source.rmdir()


def vault_root(start: Path) -> Path:
    for p in [start, *start.parents]:
        if (p / ".obsidian").is_dir():
            return p
    return start


def rewrite_links(root: Path, moves: dict[str, str], write: bool) -> int:
    """{old 'Udemy/<course>/' -> new 'Udemy/<author>/<course>/'} applied (plain and percent-encoded) to every .md/.canvas of the vault."""
    pairs = [(old, new) for old, new in moves.items()]
    pairs += [(quote(old, safe="/"), quote(new, safe="/")) for old, new in moves.items()]
    changed = 0
    for f in root.rglob("*"):
        if not f.is_file() or f.suffix not in (".md", ".canvas") or any(part.startswith(".") for part in f.relative_to(root).parts):
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        new = text
        for old, replacement in pairs:
            new = new.replace(old, replacement)
        if new != text:
            changed += 1
            print(f"    links updated in {f.relative_to(root)}")
            if write:
                f.write_text(new, encoding="utf-8")
    return changed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("udemy", help="the vault's Udemy folder, e.g. <vault>/_study_roadmap/Udemy")
    ap.add_argument("--write", action="store_true", help="do it (default: only show the plan)")
    ap.add_argument("--merge", action="store_true", help="when the course already exists under its author, move the newer files into it")
    args = ap.parse_args()
    udemy = Path(args.udemy).expanduser().resolve()
    if not udemy.is_dir():
        sys.exit(f"not a folder: {udemy}")
    root = vault_root(udemy)
    rel = udemy.relative_to(root).as_posix()

    plan = []
    for folder in sorted(p for p in udemy.iterdir() if p.is_dir() and not p.name.startswith((".", "_")) and is_course(p)):
        author = course_author(folder)
        plan.append((folder, author, folder_name(author)))
    if not plan:
        print("Nothing to do: no course folder sits directly in", udemy)
        return 0
    taken = {}
    for folder, author, name in plan:
        print(f"{folder.name}\n    -> {name}/{folder.name}" + ("" if author else "   (no author found in its files)"))
        if (udemy / name / folder.name).exists() and not args.merge:
            sys.exit(f"{udemy / name / folder.name} already exists (an old-path save after the move?): nothing was changed. "
                     "Use --merge to move its newer files into it.")
        taken.setdefault(name, []).append(folder.name)
    print(f"\n{len(plan)} course(s) into {len(taken)} author folder(s): " + ", ".join(f"{n} ({len(c)})" for n, c in sorted(taken.items())))

    moves = {f"{rel}/{folder.name}/": f"{rel}/{name}/{folder.name}/" for folder, _, name in plan}
    moves.update({f"Udemy/{folder.name}/": f"Udemy/{name}/{folder.name}/" for folder, _, name in plan if rel != "Udemy"})
    if args.write:
        for folder, author, name in plan:
            (udemy / name).mkdir(exist_ok=True)
            target = udemy / name / folder.name
            if target.exists():
                merge_into(folder, target)
            else:
                shutil.move(str(folder), str(target))
            if author:
                nj, nm = fill_author(target, author)
                if nj or nm:
                    print(f"    {folder.name}: author written into {nj} JSON and {nm} Markdown file(s)")
    n = rewrite_links(root, moves, args.write)
    print(f"\n{n} note(s) {'updated' if args.write else 'would be updated'} for links." + ("" if args.write else "\nDry run: nothing was changed. Add --write."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
