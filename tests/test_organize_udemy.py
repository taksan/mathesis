"""scripts/organize-udemy-by-author.py: Udemy/<course>/ -> Udemy/<author>/<course>/, author fill-in and link rewriting."""
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

from mathesis import frontmatter

spec = importlib.util.spec_from_file_location("organize", Path(__file__).resolve().parent.parent / "scripts" / "organize-udemy-by-author.py")
organize = importlib.util.module_from_spec(spec)
spec.loader.exec_module(organize)


def quiz(author):
    return {"title": "T", **({"author": author} if author is not None else {}), "attempt": "Attempt 1", "source": "https://x",
            "timeLimitMinutes": None, "timeLimitText": "", "questions": [{"number": 1, "domain": "", "question": "q", "type": "single",
            "options": [{"text": "a", "correct": True, "explanation": ""}, {"text": "b", "correct": False, "explanation": ""}], "explanation": ""}]}


def dump(data):
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


@pytest.fixture
def vault(tmp_path, monkeypatch):
    (tmp_path / ".obsidian").mkdir()
    udemy = tmp_path / "_study_roadmap" / "Udemy"
    a = udemy / "course a"
    a.mkdir(parents=True)
    (a / "01-all questions.json").write_text(dump(quiz("Priya Dwivedi | CertShield Academy")), encoding="utf-8")
    (a / "02-all questions.json").write_text(dump(quiz(None)), encoding="utf-8")                     # saved before the author was recorded
    (a / "01-all questions.md").write_text(frontmatter.apply(None, "# Q\n", {"type": "all-questions", "course": "course a"})[0], encoding="utf-8")
    (a / "00-notes.md").write_text("no frontmatter, my notes\n", encoding="utf-8")
    b = udemy / "course b"
    b.mkdir()
    (b / "01.md").write_text("# lesson, no author anywhere\n", encoding="utf-8")
    (tmp_path / "Index.md").write_text("[[_study_roadmap/Udemy/course a/01-all questions#Question 1|q]] and "
                                       "[x](_study_roadmap/Udemy/course%20a/01-all%20questions.md) and [[course a/relative]]\n", encoding="utf-8")
    (tmp_path / ".obsidian" / "workspace.json").write_text('{"file": "_study_roadmap/Udemy/course a/01.md"}', encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["organize", str(udemy), "--write"])
    return tmp_path


def test_folder_name_is_the_first_author_without_the_tagline():
    assert organize.folder_name("Priya Dwivedi | CertShield Academy") == "Priya Dwivedi"
    assert organize.folder_name("BalaSagar | Cloud Architect, AI Engineer, Web & App Developer & Trainer") == "BalaSagar"
    assert organize.folder_name("A/B: C") == "A_B_ C"
    assert organize.folder_name("") == organize.UNKNOWN == "unknown author"


def test_courses_move_under_their_author_and_the_author_is_filled_in(vault):
    assert organize.main() == 0
    udemy = vault / "_study_roadmap" / "Udemy"
    a = udemy / "Priya Dwivedi" / "course a"
    assert not (udemy / "course a").exists() and (udemy / "unknown author" / "course b" / "01.md").is_file()
    assert json.loads((a / "02-all questions.json").read_text(encoding="utf-8"))["author"] == "Priya Dwivedi | CertShield Academy"
    assert list(json.loads((a / "02-all questions.json").read_text(encoding="utf-8")))[:2] == ["title", "author"]   # in its usual place
    front = frontmatter.split((a / "01-all questions.md").read_text(encoding="utf-8"))[0]
    assert 'author: "Priya Dwivedi | CertShield Academy"' in front
    assert not frontmatter.is_modified((a / "01-all questions.md").read_text(encoding="utf-8"))   # the hash still matches: not "edited"
    assert (a / "00-notes.md").read_text(encoding="utf-8") == "no frontmatter, my notes\n"       # a file without frontmatter is not touched


def test_links_are_rewritten_everywhere_but_in_hidden_folders(vault):
    organize.main()
    index = (vault / "Index.md").read_text(encoding="utf-8")
    assert "[[_study_roadmap/Udemy/Priya Dwivedi/course a/01-all questions#Question 1|q]]" in index
    assert "(_study_roadmap/Udemy/Priya%20Dwivedi/course%20a/01-all%20questions.md)" in index
    assert "[[course a/relative]]" in index                                                      # not a path from the Udemy folder
    assert "Udemy/course a/01.md" in (vault / ".obsidian" / "workspace.json").read_text(encoding="utf-8")


def test_a_dry_run_changes_nothing_and_a_second_run_has_nothing_to_do(vault, monkeypatch, capsys):
    udemy = vault / "_study_roadmap" / "Udemy"
    monkeypatch.setattr(sys, "argv", ["organize", str(udemy)])
    organize.main()
    assert (udemy / "course a").is_dir() and "Dry run" in capsys.readouterr().out
    monkeypatch.setattr(sys, "argv", ["organize", str(udemy), "--write"])
    organize.main()
    capsys.readouterr()
    assert organize.main() == 0 and "Nothing to do" in capsys.readouterr().out


def test_a_course_saved_at_the_old_path_after_the_move_is_merged_when_newer(vault, monkeypatch):
    udemy = vault / "_study_roadmap" / "Udemy"
    organize.main()
    moved = udemy / "Priya Dwivedi" / "course a"
    late = udemy / "course a"
    late.mkdir()
    (late / "01-all questions.json").write_text(dump(quiz("Priya Dwivedi | CertShield Academy")) .replace('"T"', '"newer"'), encoding="utf-8")
    (late / "03-new.md").write_text("new\n", encoding="utf-8")
    old = moved / "01-all questions.json"
    os.utime(old, (1, 1))                                                                          # the moved one is older
    monkeypatch.setattr(sys, "argv", ["organize", str(udemy), "--write"])
    with pytest.raises(SystemExit):                                                                # without --merge it refuses
        organize.main()
    monkeypatch.setattr(sys, "argv", ["organize", str(udemy), "--write", "--merge"])
    organize.main()
    assert not late.exists() and (moved / "03-new.md").is_file()
    assert json.loads(old.read_text(encoding="utf-8"))["title"] == "newer"
