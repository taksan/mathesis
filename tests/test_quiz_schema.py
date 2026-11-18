"""The JSON the Udemy userscript's "Save all as JSON" button writes must match schema/quiz-questions.schema.json.

The fixtures have the structure of real userscript output (run against saved Udemy results pages), trimmed to a few
questions with the course text replaced by placeholders: one quiz explains each option, the other has one overall
explanation per question.
"""
import copy
import json
from pathlib import Path

import pytest

jsonschema = pytest.importorskip("jsonschema")

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "schema" / "quiz-questions.schema.json").read_text(encoding="utf-8"))
FIXTURES = sorted((ROOT / "tests" / "fixtures").glob("quiz-*.json"))
validator = jsonschema.Draft202012Validator(SCHEMA)


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def errors(data):
    return [e.message for e in validator.iter_errors(data)]


def test_the_schema_is_itself_valid():
    jsonschema.Draft202012Validator.check_schema(SCHEMA)


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.name)
def test_userscript_output_validates(path):
    data = load(path)
    assert errors(data) == []
    assert {q["type"] for q in data["questions"]} == {"single", "multi"}  # both kinds are covered by the fixtures


def test_the_two_explanation_formats_are_both_present():
    overall = load(ROOT / "tests" / "fixtures" / "quiz-overall-explanation.json")["questions"]
    per_option = load(ROOT / "tests" / "fixtures" / "quiz-option-explanations.json")["questions"]
    assert all(q["explanation"] for q in overall) and not any(o["explanation"] for q in overall for o in q["options"])
    assert any(o["explanation"] for q in per_option for o in q["options"])


@pytest.fixture
def sample():
    return copy.deepcopy(load(FIXTURES[0]))


def first(data, kind):
    return next(q for q in data["questions"] if q["type"] == kind)


def test_single_must_have_exactly_one_correct_option(sample):
    q = first(sample, "single")
    q["options"][[o["correct"] for o in q["options"]].index(False)]["correct"] = True
    assert errors(sample)
    for o in q["options"]:
        o["correct"] = False
    assert errors(sample)


def test_multi_must_have_at_least_two_correct_options(sample):
    q = first(sample, "multi")
    for o in q["options"][1:]:
        o["correct"] = False
    assert errors(sample)


@pytest.mark.parametrize("change", [
    lambda d: d.pop("title"),
    lambda d: d.pop("timeLimitMinutes"),
    lambda d: d.update(timeLimitMinutes=0),
    lambda d: d.update(timeLimitMinutes="2 hours"),
    lambda d: d.update(timeLimitMinutes=1.5),
    lambda d: d.update(timeLimitText=None),
    lambda d: d.update(questions=[]),
    lambda d: d.update(extra=1),
    lambda d: d["questions"][0].update(type="maybe"),
    lambda d: d["questions"][0].pop("explanation"),
    lambda d: d["questions"][0].update(question=""),
    lambda d: d["questions"][0].update(number=0),
    lambda d: d["questions"][0].update(options=d["questions"][0]["options"][:1]),
    lambda d: d["questions"][0]["options"][0].update(correct="yes"),
    lambda d: d["questions"][0]["options"][0].update(text=""),
    lambda d: d["questions"][0]["options"][0].pop("explanation"),
    lambda d: d["questions"][0]["options"][0].update(selected=True),  # what you picked is deliberately not exported
], ids=["no-title", "no-time-limit", "time-limit-zero", "time-limit-text", "time-limit-fraction", "time-limit-text-null", "no-questions", "extra-key", "bad-type", "no-explanation", "empty-question", "number-zero",
        "one-option", "correct-not-bool", "empty-option", "no-option-explanation", "selected-not-allowed"])
def test_invalid_documents_are_rejected(sample, change):
    change(sample)
    assert errors(sample)


def test_unknown_question_number_is_allowed(sample):
    sample["questions"][0]["number"] = None
    assert errors(sample) == []


def test_time_limit_is_minutes_or_null_with_its_source_text():
    overall = load(ROOT / "tests" / "fixtures" / "quiz-overall-explanation.json")
    per_option = load(ROOT / "tests" / "fixtures" / "quiz-option-explanations.json")
    assert overall["timeLimitMinutes"] == 120 and "2 hours" in overall["timeLimitText"]
    assert per_option["timeLimitMinutes"] is None and per_option["timeLimitText"] == ""


def test_author_is_optional_but_must_be_text(sample):
    sample.pop("author", None)
    assert errors(sample) == []
    sample["author"] = "Priya Dwivedi | CertShield Academy"
    assert errors(sample) == []
    sample["author"] = ["Priya"]
    assert errors(sample)
