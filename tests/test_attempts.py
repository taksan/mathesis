"""The attempt file for the quiz platform: schema/quickquiz-attempts.schema.json, and the hash the server adds from the saved quiz."""
import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mathesis import attempts, server
from mathesis.config import Settings

jsonschema = pytest.importorskip("jsonschema")
SCHEMA = json.loads((Path(__file__).resolve().parent.parent / "schema" / "quickquiz-attempts.schema.json").read_text(encoding="utf-8"))
EXAMPLE = SCHEMA["x-hashExample"]


def quiz():
    return copy.deepcopy(EXAMPLE["quiz"])


def attempt_file(title="Mini quiz"):
    """What the userscript writes: the quiz is named by its title only."""
    return {"format": "quickquiz-attempts", "version": 1, "exportedAt": "2026-11-21T16:00:00+00:00", "attempts": [{
        "id": "udemy-1812019057", "quiz": {"title": title}, "startedAt": "2026-11-21T12:45:29+00:00",
        "finishedAt": "2026-11-21T13:37:15+00:00", "finishReason": "submitted", "timeUsedSeconds": 3106,
        "answers": {"1": [1]}, "marked": [1], "comments": {}}]}


def test_the_hash_is_the_one_in_the_platforms_own_worked_example():
    assert attempts.quiz_hash(EXAMPLE["quiz"]) == EXAMPLE["sha256"]


def test_domains_author_attempt_and_syllabus_do_not_change_the_hash_but_content_does():
    base = attempts.quiz_hash(quiz())
    q = quiz()
    q["author"], q["attempt"], q["syllabus"] = "Someone", "Attempt 7", {"certification": "x"}
    q["questions"][0]["domain"], q["questions"][0]["domainGuessed"] = "Another domain", True
    assert attempts.quiz_hash(q) == base
    q["source"] = "https://example.com/other-results"
    assert attempts.quiz_hash(q) != base


def test_the_saved_quiz_hash_is_added_to_the_attempt(tmp_path):
    (tmp_path / "01-all questions.json").write_text(json.dumps(quiz()), encoding="utf-8")
    out, note = attempts.add_hash(json.dumps(attempt_file()).encode(), tmp_path / "01-all questions.json")
    data = json.loads(out)
    assert note == "hash" and data["attempts"][0]["quiz"] == {"hash": EXAMPLE["sha256"], "title": "Mini quiz"}
    assert list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(data)) == []


def test_without_a_saved_quiz_or_with_another_title_the_attempt_keeps_its_title(tmp_path):
    raw = json.dumps(attempt_file()).encode()
    assert attempts.add_hash(raw, tmp_path / "01-all questions.json") == (raw, "no quiz")
    (tmp_path / "01-all questions.json").write_text(json.dumps(quiz()), encoding="utf-8")
    out, note = attempts.add_hash(json.dumps(attempt_file("A different quiz")).encode(), tmp_path / "01-all questions.json")
    assert note == "other quiz" and json.loads(out)["attempts"][0]["quiz"] == {"title": "A different quiz"}


def test_the_userscripts_attempt_validates_without_a_hash():
    assert list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(attempt_file())) == []


@pytest.mark.parametrize("name,expected", [("03-attempt 2.json", "03-all questions.json"), ("attempt 1.json", "all questions.json")])
def test_an_attempt_belongs_to_the_quiz_json_of_its_number(name, expected):
    assert attempts.quiz_file_for(Path("/x") / name) == Path("/x") / expected


@pytest.fixture
def client(tmp_path):
    settings = Settings(root=tmp_path.resolve(), summarize=False, notify=False, obsidian_command="obs")
    with TestClient(server.create_app(settings)) as c:
        c.root = tmp_path.resolve()
        yield c


def test_the_server_saves_the_attempt_with_the_hash_and_lists_it(client):
    folder = "Udemy/Course"
    qh = {"X-File-Path": f"{folder}/01-all%20questions.json", "X-Mathesis-Kind": "quiz-json"}
    assert client.post("/write", content=json.dumps(quiz()).encode(), headers=qh).status_code == 200
    ah = {"X-File-Path": f"{folder}/01-attempt%201.json", "X-Mathesis-Kind": "quiz-attempt"}
    r = client.post("/write", content=json.dumps(attempt_file()).encode(), headers=ah)
    assert r.status_code == 200 and r.json()["quiz"] == "hash"
    saved = json.loads((client.root / folder / "01-attempt 1.json").read_text(encoding="utf-8"))
    assert saved["attempts"][0]["quiz"]["hash"] == EXAMPLE["sha256"]
    listed = client.get("/files", headers={"X-File-Path": f"{folder}/01-all%20questions.md"}).json()["files"]
    assert [(f["kind"], f["attempt"]) for f in listed if f["kind"] == "import"] == [("import", 1)]
    opened = client.get("/file", headers={"X-File-Path": f"{folder}/01-attempt%201.json"})
    assert opened.status_code == 200 and "udemy-1812019057" in opened.text      # a listed file: it can be read and opened like the others


def test_the_server_refuses_an_attempt_that_is_not_json_or_not_a_json_path(client):
    h = {"X-File-Path": "Udemy/C/01-attempt%201.json", "X-Mathesis-Kind": "quiz-attempt"}
    assert client.post("/write", content=b"not json", headers=h).status_code == 400
    bad = {"X-File-Path": "Udemy/C/01-attempt.md", "X-Mathesis-Kind": "quiz-attempt"}
    assert client.post("/write", content=json.dumps(attempt_file()).encode(), headers=bad).status_code == 400
