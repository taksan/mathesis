import json
import threading

import pytest
from fastapi.testclient import TestClient

from mathesis import domains, server, webtext
from mathesis.config import Settings

GUIDE = ("Professional Cloud DevOps Engineer. Certification exam guide. " * 20 +
         "\nSection 1: Bootstrapping and maintaining a Google Cloud organization (~20% of the exam)\n1.1 Designing the hierarchy\n"
         "Section 2: Building and implementing CI/CD pipelines (~25% of the exam)\n2.1 Cloud Build and Cloud Deploy\n"
         "Section 3: Applying site reliability engineering practices (~25% of the exam)\n3.1 SLOs and error budgets\n")
OFFICIAL = "https://services.example.com/devops_exam_guide.pdf"
BLOG = "https://blog.example.org/devops-guide"


def quiz(*domain_values):
    stems = ["Which tool builds containers?", "Define an SLO for latency", "How do you structure folders and org policy?", "Pick a Terraform backend"]
    return {"title": "Practice Test 1", "author": "A", "attempt": "Attempt 1", "source": "https://x", "timeLimitMinutes": None,
            "timeLimitText": "", "questions": [
                {"number": i + 1, "domain": domain_values[i] if i < len(domain_values) else "", "question": stems[i], "type": "single",
                 "options": [{"text": "a", "correct": True, "explanation": ""}, {"text": "b", "correct": False, "explanation": ""}],
                 "explanation": ""} for i in range(4)]}


class Model:
    """Answers each kind of prompt the way a good model would, and counts the calls."""
    label = "fake"

    def __init__(self, certification="Google Cloud Professional Cloud DevOps Engineer", urls=(OFFICIAL,), official=(OFFICIAL,),
                 domains_=None, placement=None):
        self.certification, self.urls, self.official = certification, list(urls), set(official)
        self.names = domains_ or ["Section 1: Bootstrapping and maintaining a Google Cloud organization",
                                  "Section 2: Building and implementing CI/CD pipelines",
                                  "Section 3: Applying site reliability engineering practices"]
        self.placement = placement or {}
        self.calls = []

    def check(self):
        return True, "fake"

    def chat(self, system, user, temperature=0.2):
        if "identify which certification" in system:
            self.calls.append("identify")
            return json.dumps({"certification": self.certification, "search_query": "devops exam guide", "urls": self.urls})
        if "extract the official syllabus" in system:
            self.calls.append("syllabus")
            url = user.split("Page: ")[1].split("\n")[0]
            return "```json\n" + json.dumps({"official": url in self.official, "certification": self.certification, "version_note": "",
                                              "domains": [{"name": n, "topics": ["t"]} for n in self.names]}) + "\n```"
        if "assign certification" in system:
            self.calls.append("classify")
            ids = [int(x.split("]")[0]) for x in user.split("[id ")[1:]]
            return json.dumps([{"id": i, "domain": self.placement.get(i, 2)} for i in ids])
        raise AssertionError("unexpected prompt: " + system[:60])


def pages(mapping):
    seen = []

    def fetch(url):
        seen.append(url)
        if url not in mapping:
            raise webtext.FetchError("no such page")
        return mapping[url]
    fetch.seen = seen
    return fetch


def test_parse_json_takes_the_first_value_of_the_wanted_type():
    assert domains.parse_json('Sure!\n```json\n{"a": 1}\n```', dict) == {"a": 1}
    assert domains.parse_json('[1] then [{"id": 1}]', list) == [1]
    assert domains.parse_json('{"x": 1} [2]', list) == [2]
    with pytest.raises(ValueError):
        domains.parse_json("no json here", dict)


def test_only_questions_without_a_domain_are_filled_and_marked(tmp_path):
    data = quiz("Security / IAM")                      # question 1 has Udemy's own domain
    model = Model(placement={1: 1, 2: 3, 3: 1})       # ids count the questions sent: the three without one
    n = domains.add_domains(data, "Course", model, pages({OFFICIAL: GUIDE}), lambda q: [], tmp_path, say=lambda m: None)
    q = data["questions"]
    assert n == 3 and q[0]["domain"] == "Security / IAM" and "domainGuessed" not in q[0]
    assert q[1]["domain"].startswith("Section 1") and q[2]["domain"].startswith("Section 3") and q[3]["domain"].startswith("Section 1")
    assert all(x["domainGuessed"] is True for x in q[1:])
    assert list(data)[-2:] == ["syllabus", "questions"]            # the record sits just before the questions
    assert data["syllabus"] == {"certification": "Google Cloud Professional Cloud DevOps Engineer", "url": OFFICIAL,
                                "domains": model.names}


def test_a_domain_name_that_is_not_on_the_page_is_dropped(tmp_path):
    model = Model(domains_=["Section 1: Bootstrapping and maintaining a Google Cloud organization", "Section 9: Invented by the model",
                            "Section 2: Building and implementing CI/CD pipelines"])
    syllabus = domains.read_syllabus(model, "X", OFFICIAL, GUIDE)
    assert [d["name"][:9] for d in syllabus["domains"]] == ["Section 1", "Section 2"]


def test_a_page_with_fewer_than_two_checked_domains_is_no_syllabus():
    assert domains.read_syllabus(Model(domains_=["Section 1: Bootstrapping and maintaining a Google Cloud organization", "Made up"]), "X", OFFICIAL, GUIDE) is None


def test_a_blog_is_skipped_and_the_search_finds_the_official_guide(tmp_path):
    model = Model(urls=[BLOG], official=[OFFICIAL])
    fetch = pages({BLOG: GUIDE, OFFICIAL: GUIDE})
    data = quiz()
    domains.add_domains(data, "Course", model, fetch, lambda q: [BLOG, OFFICIAL], tmp_path, say=lambda m: None)
    assert fetch.seen == [BLOG, OFFICIAL] and data["syllabus"]["url"] == OFFICIAL


def test_without_an_official_syllabus_nothing_is_changed(tmp_path):
    model = Model(urls=[BLOG], official=[])
    data = quiz()
    with pytest.raises(domains.DomainError, match="no official syllabus"):
        domains.add_domains(data, "Course", model, pages({BLOG: GUIDE}), lambda q: [], tmp_path, say=lambda m: None)
    assert "syllabus" not in data and not any(q["domain"] for q in data["questions"])


def test_the_syllabus_is_built_once_and_then_reused(tmp_path):
    first = Model()
    fetch = pages({OFFICIAL: GUIDE})
    domains.add_domains(quiz(), "Course A", first, fetch, lambda q: [], tmp_path, say=lambda m: None)
    assert first.calls.count("identify") == 1 and first.calls.count("syllabus") == 1 and fetch.seen == [OFFICIAL]
    assert (tmp_path / "google-cloud-professional-cloud-devops-engineer.json").is_file()
    # the same course again: not even the certification is asked, and nothing is fetched or searched
    again = Model()
    fetch2, searched = pages({}), []
    domains.add_domains(quiz(), "Course A", again, fetch2, lambda q: searched.append(q) or [], tmp_path, say=lambda m: None)
    assert again.calls == ["classify"] and fetch2.seen == [] and searched == []
    # another course of the same exam: the certification is asked (one call), the syllabus is still not searched for
    other = Model()
    domains.add_domains(quiz(), "Course B", other, fetch2, lambda q: searched.append(q) or [], tmp_path, say=lambda m: None)
    assert other.calls == ["identify", "classify"] and fetch2.seen == [] and searched == []


def test_questions_the_model_cannot_place_stay_without_a_domain(tmp_path):
    class Odd(Model):
        def chat(self, system, user, temperature=0.2):
            if "assign certification" in system:
                return '[{"id": 1, "domain": 99}, {"id": 2, "domain": null}, {"id": "x"}, {"id": 3, "domain": 1}]'
            return super().chat(system, user, temperature)
    data = quiz()
    domains.add_domains(data, "Course", Odd(), pages({OFFICIAL: GUIDE}), lambda q: [], tmp_path, say=lambda m: None)
    assert [bool(q["domain"]) for q in data["questions"]] == [False, False, True, False]


def test_write_domains_updates_the_file_in_place_and_leaves_the_rest(tmp_path, monkeypatch):
    path = tmp_path / "Udemy" / "Course" / "01-all questions.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(quiz("Security / IAM"), indent=2, ensure_ascii=False) + "\n")
    monkeypatch.setattr(domains, "make_client", lambda settings, role, run=None: Model())
    s = Settings(root=tmp_path, notify=False, domains_provider="gemini")
    assert domains.write_domains(path, s, fetch=pages({OFFICIAL: GUIDE}), search=lambda q: [], cache_dir=tmp_path / "cache") is None
    saved = json.loads(path.read_text())
    assert [bool(q["domain"]) for q in saved["questions"]] == [True] * 4 and saved["questions"][0]["domain"] == "Security / IAM"
    assert path.read_text().endswith("}\n") and not list(path.parent.glob("*.tmp"))


def test_write_domains_reports_a_failure_and_keeps_the_file(tmp_path, monkeypatch):
    path = tmp_path / "01-all questions.json"
    original = json.dumps(quiz(), indent=2) + "\n"
    path.write_text(original)
    monkeypatch.setattr(domains, "make_client", lambda settings, role, run=None: Model(urls=[], official=[]))
    s = Settings(root=tmp_path, notify=False, domains_provider="gemini")
    problem = domains.write_domains(path, s, fetch=pages({}), search=lambda q: [], cache_dir=tmp_path / "cache")
    assert "no official syllabus" in problem and path.read_text() == original


def test_nothing_to_do_when_every_question_has_a_domain(tmp_path, monkeypatch):
    path = tmp_path / "01-all questions.json"
    path.write_text(json.dumps(quiz("a", "b", "c", "d")))
    monkeypatch.setattr(domains, "make_client", lambda *a, **k: pytest.fail("no model needed"))
    assert not domains.needs_domains(path.read_text())
    assert domains.needs_domains(json.dumps(quiz("a"))) and not domains.needs_domains("not json")


# ---- the web tools ----

@pytest.mark.parametrize("url", ["http://example.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://192.168.1.5/x",
                                 "https://169.254.169.254/latest", "https://[::1]/x", "ftp://example.com/x", "file:///etc/passwd"])
def test_only_public_https_pages_are_read(url):
    with pytest.raises(webtext.FetchError):
        webtext.check_url(url)


def test_html_becomes_text_without_scripts_or_styles():
    text = webtext.html_to_text("<html><head><title>t</title><style>x{}</style></head><body><h1>Guide</h1><script>evil()</script>"
                                "<ul><li>One</li><li>Two &amp; three</li></ul></body></html>")
    assert text == "Guide\nOne\nTwo & three"


def test_search_results_are_unwrapped_and_limited_to_https(monkeypatch):
    page = ('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcloud.example.com%2Fguide&amp;rut=1">x</a>'
            '<a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2Fplain.example.com%2F&amp;rut=2">y</a>'
            '<a class="result__a" href="https://other.example.com/doc.pdf">z</a>')

    class Resp:
        def read(self, n=-1):
            return page.encode()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False
    monkeypatch.setattr(webtext, "_open", lambda url, data=None: Resp())
    assert webtext.search("q") == ["https://cloud.example.com/guide", "https://other.example.com/doc.pdf"]


def test_a_search_that_fails_finds_nothing(monkeypatch):
    def boom(url, data=None):
        raise OSError("down")
    monkeypatch.setattr(webtext, "_open", boom)
    assert webtext.search("q") == []


# ---- the server ----

def _client(tmp_path, **kw):
    settings = Settings(root=tmp_path.resolve(), summarize=False, notify=False, **kw)
    return TestClient(server.create_app(settings))


def test_saving_a_quiz_json_with_missing_domains_starts_the_job(tmp_path, monkeypatch):
    started, release = threading.Event(), threading.Event()

    def fake(file, settings):
        started.set()
        release.wait(5)
    monkeypatch.setattr(server.exam_domains, "write_domains", fake)
    h = {"X-File-Path": "Udemy/C/01-all%20questions.json", "X-Mathesis-Kind": "quiz-json"}
    with _client(tmp_path, domains_provider="gemini") as c:
        assert c.post("/write", content=json.dumps(quiz()).encode(), headers=h).status_code == 200
        assert started.wait(5)
        files = c.get("/files", headers={"X-File-Path": "Udemy/C/01-all%20questions.md"}).json()["files"]
        assert [(f["kind"], f["state"]) for f in files if f["kind"] == "domains"] == [("domains", "pending")]
        again = c.post("/write", content=json.dumps(quiz()).encode(), headers=h)    # a second click while it works
        assert again.status_code == 409 and again.json()["code"] == "pending"
        release.set()


def test_no_job_without_a_provider_or_when_every_question_has_a_domain(tmp_path, monkeypatch):
    monkeypatch.setattr(server.exam_domains, "write_domains", lambda file, settings: pytest.fail("must not run"))
    h = {"X-File-Path": "Udemy/C/01-all%20questions.json", "X-Mathesis-Kind": "quiz-json"}
    with _client(tmp_path) as c:                                    # no provider set
        assert c.post("/write", content=json.dumps(quiz()).encode(), headers=h).status_code == 200
    with _client(tmp_path, domains_provider="gemini") as c:        # nothing missing
        assert c.post("/write", content=json.dumps(quiz("a", "b", "c", "d")).encode(), headers=h).status_code == 200


def test_domains_settings_follow_the_default_provider_and_can_be_switched_off():
    assert not Settings().domains_enabled                                      # no provider set: no built-in choice
    assert Settings(domains_provider="gemini").domains_enabled
    assert not Settings(domains_provider="gemini", domains=False).domains_enabled
    assert not Settings(domains_provider="gemini", llm=False).domains_enabled
