import json

import pytest
from fastapi.testclient import TestClient

from mathesis import frontmatter, server
from mathesis.config import Settings
from mathesis.obsidian import uri_for
from mathesis.pipeline import summary_path


def body(path):
    """What the file says, without the frontmatter the server adds."""
    return frontmatter.strip(path.read_text())


@pytest.fixture
def client(tmp_path):
    settings = Settings(root=tmp_path.resolve(), summarize=False, notify=False, obsidian_command="obs")  # "obs": Obsidian found
    with TestClient(server.create_app(settings)) as c:
        c.root = tmp_path.resolve()
        yield c


def test_write_creates_missing_directories_and_status_reflects_it(client):
    target = client.root / "Path" / "Course" / "01-Lesson.md"
    h = {"X-File-Path": "Path/Course/01-Lesson.md"}
    assert client.get("/status", headers=h).json() == {"exists": False, "modified": False, "summary_exists": False, "opener": "obsidian", "obsidian_uri": None}
    r = client.post("/write", content="# Lesson\nhello".encode(), headers=h)
    assert r.status_code == 200 and r.json()["bytes"] == 14 and r.json()["path"] == "Path/Course/01-Lesson.md"
    assert body(target) == "# Lesson\nhello"
    status = client.get("/status", headers=h).json()
    assert status["exists"] is True
    assert status["obsidian_uri"] == uri_for(target)                       # the lesson itself ...
    summary_path(target).write_text("notes")
    assert client.get("/status", headers=h).json()["obsidian_uri"] == uri_for(summary_path(target))  # ... or its summary


def test_quiz_json_is_saved_as_is_next_to_the_markdown(client):
    body = '{"title": "Quiz", "questions": []}\n'
    h = {"X-File-Path": "Udemy/Course/02-all%20questions.json", "X-Mathesis-Kind": "quiz-json"}
    r = client.post("/write", content=body.encode(), headers=h)
    assert r.status_code == 200 and r.json()["kind"] == "quiz-json" and r.json()["path"] == "Udemy/Course/02-all questions.json"
    assert (client.root / "Udemy" / "Course" / "02-all questions.json").read_text() == body
    assert client.get("/status", headers=h).json()["exists"] is True
    assert not list((client.root / "Udemy" / "Course").glob("*summary*"))  # saved only: nothing is summarized


def test_path_outside_root_is_rejected(client):
    assert client.post("/write", content=b"x", headers={"X-File-Path": "../evil.md"}).status_code == 403
    assert client.get("/status", headers={"X-File-Path": "a/../../x.md"}).status_code == 403
    r = client.post("/write", content=b"x", headers={"X-File-Path": "/etc/evil.md"})  # absolute paths are refused
    assert r.status_code == 400 and "relative" in r.json()["error"]
    assert str(client.root) not in client.get("/status", headers={"X-File-Path": "../x.md"}).text


def test_missing_header_is_a_400(client):
    assert client.post("/write", content=b"x").status_code == 400
    assert client.get("/status").json() == {"error": "missing X-File-Path header"}


def test_cors_preflight_with_private_network_access(client):
    r = client.options("/write", headers={
        "Origin": "https://partner.skills.google", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-file-path", "Access-Control-Request-Private-Network": "true"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-private-network"] == "true"
    assert "x-file-path" in r.headers["access-control-allow-headers"].lower()


def test_summary_runs_in_background_when_enabled(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(server, "write_summary", lambda content, file, settings: calls.append((content, file)))
    settings = Settings(root=tmp_path.resolve(), summarize=True, notify=False)
    app = server.create_app(settings)
    monkeypatch.setattr("mathesis.ollama.OllamaClient.check_model", lambda self: (True, "ok"))
    with TestClient(app) as c:
        target = tmp_path.resolve() / "P" / "C" / "01-L.md"
        c.post("/write", content=b"transcript", headers={"X-File-Path": "P/C/01-L.md"})
        c.post("/write", content=b"   ", headers={"X-File-Path": "P/C/01-L.md"})   # blank content: no summary
    assert calls == [("transcript", str(target))]


def test_quiz_is_saved_but_never_summarized(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(server, "write_summary", lambda content, file, settings: calls.append(file))
    monkeypatch.setattr("mathesis.ollama.OllamaClient.check_model", lambda self: (True, "ok"))
    app = server.create_app(Settings(root=tmp_path.resolve(), summarize=True, notify=False))
    with TestClient(app) as c:
        quiz = tmp_path.resolve() / "P" / "C" / "36-Final Assessment.md"
        r = c.post("/write", content="# Final Assessment\n".encode(),
                   headers={"X-File-Path": "P/C/36-Final Assessment.md", "X-Mathesis-Kind": "quiz"})
        assert r.json()["kind"] == "quiz" and body(quiz) == "# Final Assessment\n"
        lesson = tmp_path.resolve() / "P" / "C" / "01-L.md"
        c.post("/write", content=b"text", headers={"X-File-Path": "P/C/01-L.md", "X-Mathesis-Kind": "transcript"})
        c.post("/write", content=b"text", headers={"X-File-Path": "P/C/02-M.md"})   # no header = transcript
    assert calls == [str(lesson), str(lesson.with_name("02-M.md"))]


def test_preflight_allows_the_kind_header(client):
    r = client.options("/write", headers={
        "Origin": "https://partner.skills.google", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-file-path,x-mathesis-kind",
        "Access-Control-Request-Private-Network": "true"})
    assert r.status_code == 200


def test_userscripts_are_served_and_path_traversal_is_refused(tmp_path):
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "a.user.js").write_text("// ==UserScript==\n// @name A <b>\n// @version abc\n// @match https://x.test/*\n// ==/UserScript==\n")
    (tmp_path / "secret.user.js").write_text("nope")
    settings = Settings(root=tmp_path.resolve(), userscript_dir=scripts, summarize=False, notify=False)
    with TestClient(server.create_app(settings)) as c:
        r = c.get("/userscript/a.user.js")
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/javascript")
        assert "@version abc" in r.text
        assert "A &lt;b&gt;" in c.get("/userscript").text  # header text is escaped
        assert c.get("/userscript.json").json() == {"scripts": ["a.user.js"]}
        page = c.get("/userscript")
        assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
        assert "http://testserver/userscript/a.user.js" in page.text and "<code>abc</code>" in page.text
        assert c.get("/userscript/missing.user.js").status_code == 404
        assert c.get("/userscript/..%2Fsecret.user.js").status_code == 404
        assert c.get("/userscript/a.txt").status_code == 404


def test_raw_page_is_saved_as_html_and_never_summarized(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(server, "write_summary", lambda content, file, settings: calls.append(file))
    monkeypatch.setattr("mathesis.ollama.OllamaClient.check_model", lambda self: (True, "ok"))
    app = server.create_app(Settings(root=tmp_path.resolve(), summarize=True, notify=False))
    html = "<!DOCTYPE html>\n<html><body>Ünïcode page</body></html>"
    with TestClient(app) as c:
        r = c.post("/write", content=html.encode(), headers={
            "X-File-Path": "Udemy/Course/03-Odd lesson.raw.html", "X-Mathesis-Kind": "raw"})
        assert r.status_code == 200 and r.json()["kind"] == "raw"
        assert (tmp_path / "Udemy/Course/03-Odd lesson.raw.html").read_text(encoding="utf-8") == html
        bad = c.post("/write", content=b"x", headers={"X-File-Path": "Udemy/Course/x.md", "X-Mathesis-Kind": "raw"})
        assert bad.status_code == 400 and not (tmp_path / "Udemy/Course/x.md").exists()
    assert calls == []


def test_bundle_is_converted_saved_and_summarized(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(server, "write_summary", lambda content, file, settings: calls.append((content, file)))
    monkeypatch.setattr("mathesis.ollama.OllamaClient.check_model", lambda self: (True, "ok"))
    seen = []
    monkeypatch.setattr(server.bundle, "markdown_for", lambda src: seen.append(src) or "# Lesson\n\nconverted text here\n")
    app = server.create_app(Settings(root=tmp_path.resolve(), summarize=True, notify=False))
    with TestClient(app) as c:
        r = c.post("/write", content=b"https://storage.googleapis.com/cloud-training/x/index.html#/page/abc",
                   headers={"X-File-Path": "Google Skills/P/C/08-Lesson.md", "X-Mathesis-Kind": "bundle"})
        assert r.status_code == 200 and r.json()["kind"] == "bundle"
    target = tmp_path / "Google Skills/P/C/08-Lesson.md"
    assert body(target) == "# Lesson\n\nconverted text here\n"
    assert seen == ["https://storage.googleapis.com/cloud-training/x/index.html#/page/abc"]
    assert calls == [("# Lesson\n\nconverted text here\n", str(target))]


def test_bundle_failure_is_reported_and_nothing_is_written(tmp_path, monkeypatch):
    def boom(src):
        raise server.bundle.BundleError(502, "could not read components.json")
    monkeypatch.setattr(server.bundle, "markdown_for", boom)
    with TestClient(server.create_app(Settings(root=tmp_path.resolve(), summarize=False, notify=False))) as c:
        r = c.post("/write", content=b"https://x", headers={"X-File-Path": "a/b.md", "X-Mathesis-Kind": "bundle"})
    assert r.status_code == 502 and "components.json" in r.json()["error"]
    assert not (tmp_path / "a").exists()


def test_percent_encoded_path_with_non_ascii_title(client):
    from urllib.parse import quote
    name = "Udemy/Curso/05-Prática – Quiz 1 - incorrect.md"
    r = client.post("/write", content=b"x", headers={"X-File-Path": quote(name), "X-Mathesis-Kind": "quiz-review"})
    assert r.status_code == 200 and body(client.root / name) == "x"
    assert client.get("/status", headers={"X-File-Path": quote(name)}).json()["exists"] is True
    assert client.post("/write", content=b"x", headers={"X-File-Path": quote("../x.md")}).status_code == 403


def test_error_reports_are_stored_listed_and_served(tmp_path):
    import json
    settings = Settings(root=tmp_path.resolve(), report_dir=tmp_path / "reports", summarize=False, notify=False)
    with TestClient(server.create_app(settings)) as c:
        assert c.get("/reports").json() == {"reports": []}
        r = c.post("/reports", content=json.dumps({
            "kind": "bundle", "path": "Google Skills/P/C/08-L.md", "status": 400, "error": "no #/page/<id>",
            "url": "https://partner.skills.google/x", "title": "T", "html": "<html><script>alert(1)</script></html>",
            "body": "https://storage.googleapis.com/cloud-training/x"}), headers={"Content-Type": "text/plain"})
        report_id = r.json()["id"]
        listed = c.get("/reports").json()["reports"]
        assert [x["id"] for x in listed] == [report_id] and listed[0]["error"] == "no #/page/<id>"
        meta = c.get(f"/reports/{report_id}").json()
        assert meta["kind"] == "bundle" and meta["status"] == 400 and meta["htmlBytes"] > 0 and "html" not in meta
        page = c.get(f"/reports/{report_id}/html")
        assert page.text.startswith("<html>") and page.headers["content-type"].startswith("text/plain")  # never rendered
        assert c.get(f"/reports/{report_id}/body").text.endswith("/cloud-training/x")
        assert c.get("/reports/20260101-000000-abcd").status_code == 404
        assert c.get("/reports/..%2F..%2Fetc/html").status_code == 404
        assert c.get(f"/reports/{report_id}/other").status_code == 404
        assert c.post("/reports", content=b"not json").status_code == 400


def test_reports_keep_only_the_newest(tmp_path, monkeypatch):
    from mathesis import reports
    monkeypatch.setattr(reports, "MAX_REPORTS", 3)
    store = reports.ReportStore(tmp_path)
    made = []
    for i in range(5):
        monkeypatch.setattr(reports.secrets, "token_hex", lambda n, i=i: f"{i:04x}")
        made.append(store.create({"error": str(i)}))
    assert store.ids() == sorted(set(made), reverse=True)[:3]


def test_without_obsidian_status_says_editor_and_open_uses_the_editor(tmp_path, monkeypatch):
    from mathesis import obsidian
    monkeypatch.setattr(obsidian, "APPIMAGE_DIRS", [])
    monkeypatch.setattr(obsidian.shutil, "which", lambda name: None)
    opened = []
    from types import SimpleNamespace  # only obsidian.py sees the fake: the server's own git/version calls stay real
    monkeypatch.setattr(obsidian, "subprocess", SimpleNamespace(Popen=lambda cmd, **kw: opened.append(cmd), DEVNULL=-3))
    settings = Settings(root=tmp_path.resolve(), summarize=False, notify=False, editor_command="ed")
    with TestClient(server.create_app(settings)) as c:
        h = {"X-File-Path": "P/C/01-L.md"}
        assert c.post("/open", headers=h).status_code == 404                # not saved yet
        c.post("/write", content=b"x", headers={**h, "X-Mathesis-Kind": "quiz"})
        status = c.get("/status", headers=h).json()
        assert status["exists"] and status["opener"] == "editor" and status["obsidian_uri"] is None
        r = c.post("/open", headers=h)
        assert r.json()["opened_with"] == "text editor" and opened == [["ed", str(tmp_path.resolve() / "P/C/01-L.md")]]
    import dataclasses
    with TestClient(server.create_app(dataclasses.replace(settings, editor_command=None))) as c:
        assert c.post("/open", headers={"X-File-Path": "P/C/01-L.md"}).status_code == 501  # no editor at all


def _put(client, rel, text="x"):
    f = client.root / rel
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text)
    return f


def test_files_lists_quiz_attempts_newest_first_json_and_all_questions(client):
    for name in ["02-incorrect.md", "02-incorrect (attempt 2).md", "02-incorrect (attempt 10).md", "02-all questions.md",
                 "02-all questions.json", "03-incorrect.md", "02-lessons to learn.md"]:
        _put(client, f"Udemy/C/{name}")
    r = client.get("/files", headers={"X-File-Path": "Udemy/C/02-incorrect.md"}).json()["files"]
    assert [(f["kind"], f.get("attempt")) for f in r] == [("incorrect", 10), ("incorrect", 2), ("incorrect", 1), ("all", None), ("json", None)]
    assert r[0]["path"] == "Udemy/C/02-incorrect (attempt 10).md" and r[0]["opener"] == "obsidian"
    assert r[0]["obsidian_uri"] == uri_for(client.root / "Udemy/C/02-incorrect (attempt 10).md")
    assert r[-1]["opener"] == "editor" and "obsidian_uri" not in r[-1]
    assert client.get("/files", headers={"X-File-Path": "Udemy/C/05-incorrect.md"}).json()["files"] == []


def test_files_lists_a_lesson_with_summary_and_guide(client):
    _put(client, "G/C/01-Lab.md")
    h = {"X-File-Path": "G/C/01-Lab.md"}
    assert [f["kind"] for f in client.get("/files", headers=h).json()["files"]] == ["transcript"]
    _put(client, "G/C/01-Lab-summary.md")
    _put(client, "G/C/01-Lab-lab-guide.md")
    assert [f["kind"] for f in client.get("/files", headers=h).json()["files"]] == ["lab-guide", "summary", "transcript"]
    assert client.get("/files", headers={"X-File-Path": "G/C/09-None.md"}).json()["files"] == []


def test_files_shows_pending_and_failed_jobs(client):
    target = _put(client, "G/C/01-Lab.md").resolve()
    jobs = client.app.state.jobs
    h = {"X-File-Path": "G/C/01-Lab.md"}
    jobs.start(target, "summary")
    got = {f["kind"]: f for f in client.get("/files", headers=h).json()["files"]}
    assert got["summary"]["state"] == "pending" and got["summary"]["path"] is None
    jobs.finish(target, "summary", target.with_name("01-Lab-summary.md"))   # ended without writing a file
    got = {f["kind"]: f for f in client.get("/files", headers=h).json()["files"]}
    assert got["summary"]["state"] == "failed" and "server log" in got["summary"]["error"]
    _put(client, "G/C/01-Lab-summary.md")
    jobs.start(target, "summary")
    jobs.finish(target, "summary", target.with_name("01-Lab-summary.md"))   # written: nothing pending any more
    got = {f["kind"]: f for f in client.get("/files", headers=h).json()["files"]}
    assert got["summary"]["state"] == "ready" and got["summary"]["path"].endswith("01-Lab-summary.md")


def test_open_only_opens_files_of_a_page(client, monkeypatch):
    opened = []
    monkeypatch.setattr(server, "open_in_editor", lambda path, configured=None: opened.append(path) or True)
    _put(client, "Udemy/C/02-all questions.json")
    _put(client, "Udemy/C/random.txt")
    _put(client, "G/C/01-L.md")
    _put(client, "G/C/01-L-summary.md")
    ok = client.post("/open", headers={"X-File-Path": "Udemy/C/02-all questions.json"})
    assert ok.status_code == 200 and opened[-1].name == "02-all questions.json"
    assert client.post("/open", headers={"X-File-Path": "G/C/01-L-summary.md"}).status_code == 200
    assert client.post("/open", headers={"X-File-Path": "Udemy/C/random.txt"}).status_code == 403
    assert client.post("/open", headers={"X-File-Path": "Udemy/C/gone.md"}).status_code == 404
    assert client.post("/open", headers={"X-File-Path": "../x.md"}).status_code == 403
    assert len(opened) == 2


def test_open_reports_a_missing_editor(client, monkeypatch):
    monkeypatch.setattr(server, "open_in_editor", lambda path, configured=None: False)
    _put(client, "Udemy/C/02-all questions.json")
    r = client.post("/open", headers={"X-File-Path": "Udemy/C/02-all questions.json"})
    assert r.status_code == 501 and "MATHESIS_EDITOR" in r.json()["error"]


def test_llm_off_starts_no_jobs_and_lists_no_pending_summary(tmp_path):
    settings = Settings(root=tmp_path.resolve(), llm=False, notify=False, obsidian_command="obs")
    with TestClient(server.create_app(settings)) as c:
        h = {"X-File-Path": "G/C/01-Lab.md", "X-Mathesis-Kind": "lab"}
        assert c.post("/write", content=b"lab text, plenty of words", headers=h).status_code == 200
        kinds = [f["kind"] for f in c.get("/files", headers={"X-File-Path": "G/C/01-Lab.md"}).json()["files"]]
        assert kinds == ["transcript"]                       # no pending summary, no pending lab guide


def test_a_job_that_wrote_nothing_reports_why(client):
    target = _put(client, "G/C/01-L.md").resolve()
    jobs = client.app.state.jobs
    jobs.start(target, "summary")
    jobs.run(target, "summary", target.with_name("01-L-summary.md"), lambda: "Ollama is not reachable at http://x:11434")
    got = {f["kind"]: f for f in client.get("/files", headers={"X-File-Path": "G/C/01-L.md"}).json()["files"]}
    assert got["summary"]["state"] == "failed" and got["summary"]["error"] == "Ollama is not reachable at http://x:11434"


def test_a_job_that_raises_is_marked_failed(client):
    target = _put(client, "G/C/01-L.md").resolve()
    jobs = client.app.state.jobs

    def boom():
        raise RuntimeError("x")
    jobs.start(target, "summary")
    with pytest.raises(RuntimeError):
        jobs.run(target, "summary", target.with_name("01-L-summary.md"), boom)
    assert jobs.get(target, "summary")["state"] == "failed"


def meta_header(**values):
    from urllib.parse import quote
    return quote(json.dumps(values))


def test_markdown_files_get_frontmatter_with_a_hash_of_the_body(client):
    h = {"X-File-Path": "Udemy/Curso/02-incorrect.md", "X-Mathesis-Kind": "quiz-review",
         "X-Mathesis-Meta": meta_header(course="Curso Ç", author="Priya D | Acme", lesson="Prática 1", url="https://example.com/q/1")}
    assert client.post("/write", content="# Incorrect\n\nq1\n".encode(), headers=h).json()["kept"] is False
    text = (client.root / "Udemy/Curso/02-incorrect.md").read_text()
    front, rest = frontmatter.split(text)
    assert rest == "# Incorrect\n\nq1\n"
    assert front[0] == 'type: "to-review"' and 'course: "Curso Ç"' in front and 'lesson: "Prática 1"' in front
    assert 'url: "https://example.com/q/1"' in front and 'author: "Priya D | Acme"' in front
    assert front.index('course: "Curso Ç"') < front.index('author: "Priya D | Acme"') < front.index('lesson: "Prática 1"')
    assert front[-1] == 'hash: "' + frontmatter.body_hash(rest) + '"'


def test_kinds_map_to_file_types_and_fall_back_to_the_path(client):
    for kind, expected in [("transcript", "transcript"), ("lab", "lab"), ("quiz-all", "all-questions"), ("quiz", "quiz")]:
        client.post("/write", content=b"text", headers={"X-File-Path": f"G/Course X/05-{kind}.md", "X-Mathesis-Kind": kind})
        front, _ = frontmatter.split((client.root / f"G/Course X/05-{kind}.md").read_text())
        assert f'type: "{expected}"' in front and 'course: "Course X"' in front
        assert not any(l.startswith(("lesson:", "url:", "author:")) for l in front)      # nothing invented from the file name
    client.post("/write", content=b"x", headers={"X-File-Path": "G/C/06-a.md", "X-Mathesis-Meta": "not json"})
    assert frontmatter.split((client.root / "G/C/06-a.md").read_text())[0] is not None


def test_json_and_raw_files_get_no_frontmatter(client):
    client.post("/write", content=b'{"a": 1}', headers={"X-File-Path": "U/C/02-all questions.json", "X-Mathesis-Kind": "quiz-json"})
    assert (client.root / "U/C/02-all questions.json").read_text() == '{"a": 1}'
    client.post("/write", content=b"<html></html>", headers={"X-File-Path": "U/C/x.html", "X-Mathesis-Kind": "raw"})
    assert (client.root / "U/C/x.html").read_text() == "<html></html>"


def test_saving_over_a_file_without_frontmatter_only_adds_the_metadata(client):
    f = _put(client, "Udemy/Curso/02-incorrect.md", "# my own notes\nQ1 ... >Conflict\n")
    h = {"X-File-Path": "Udemy/Curso/02-incorrect.md", "X-Mathesis-Kind": "quiz-review"}
    r = client.post("/write", content=b"# brand new text\n", headers=h).json()
    assert r["kept"] is True
    front, rest = frontmatter.split(f.read_text())
    assert rest == "# my own notes\nQ1 ... >Conflict\n"                      # not one character of it changed
    assert front[0] == 'type: "to-review"' and front[-1] == 'hash: "' + frontmatter.body_hash(rest) + '"'


def test_saving_over_a_file_with_frontmatter_replaces_the_body_and_keeps_other_keys(client):
    h = {"X-File-Path": "G/C/01-L.md", "X-Mathesis-Meta": meta_header(url="https://a")}
    client.post("/write", content=b"first\n", headers=h)
    f = client.root / "G/C/01-L.md"
    f.write_text(f.read_text().replace('type: "transcript"', 'type: "transcript"\nstatus: reviewed'))
    h["X-Mathesis-Meta"] = meta_header(url="https://b")
    assert client.post("/write", content=b"second\n", headers=h).json()["kept"] is False
    front, rest = frontmatter.split(f.read_text())
    assert rest == "second\n" and "status: reviewed" in front and 'url: "https://b"' in front
    assert front[-1] == 'hash: "' + frontmatter.body_hash("second\n") + '"'
    assert sum(l.startswith("hash:") for l in front) == 1 and sum(l.startswith("url:") for l in front) == 1


def test_the_hash_ignores_the_frontmatter():
    a, _ = frontmatter.apply(None, "same body\n", {"type": "lab", "course": "A"})
    b, _ = frontmatter.apply(None, "same body\n", {"type": "lab", "course": "B", "url": "u"})
    hash_of = lambda t: [l for l in frontmatter.split(t)[0] if l.startswith("hash:")][0]
    assert hash_of(a) == hash_of(b)
    c, _ = frontmatter.apply(a, "different body\n", {})
    assert hash_of(c) != hash_of(a)
    assert frontmatter.split("---\nno end\n")[0] is None                    # an unclosed block is not frontmatter


def test_a_file_edited_after_saving_asks_before_it_is_overwritten(client):
    h = {"X-File-Path": "Udemy/Curso/02-incorrect.md", "X-Mathesis-Kind": "quiz-review"}
    assert client.post("/write", content=b"# first\n", headers=h).status_code == 200
    f = client.root / "Udemy/Curso/02-incorrect.md"
    assert client.get("/status", headers=h).json()["modified"] is False
    assert client.post("/write", content=b"# again\n", headers=h).status_code == 200      # untouched file: no warning
    f.write_text(f.read_text() + "\nMy note: remember this.\n")
    assert client.get("/status", headers=h).json()["modified"] is True
    r = client.post("/write", content=b"# newest\n", headers=h)
    assert r.status_code == 409 and r.json()["code"] == "modified"
    assert "My note" in f.read_text()                                                      # nothing was overwritten
    ok = client.post("/write", content=b"# newest\n", headers={**h, "X-Mathesis-Overwrite": "yes"})
    assert ok.status_code == 200 and body(f) == "# newest\n"
    assert client.get("/status", headers=h).json()["modified"] is False


def test_only_a_changed_body_counts_as_an_edit():
    text, _ = frontmatter.apply(None, "body\n", {"type": "lab"})
    assert not frontmatter.is_modified(text)
    assert not frontmatter.is_modified(text.rstrip("\n"))                                  # an editor dropped the last newline
    assert not frontmatter.is_modified(text.replace('type: "lab"', 'type: "lab"\nmine: 1'))  # only the metadata changed
    assert frontmatter.is_modified(text + "a note\n")
    assert frontmatter.is_modified("---\ntype: x\n---\nbody\n")                            # frontmatter without a hash
    assert not frontmatter.is_modified("# plain file\n")                                   # no frontmatter: never overwritten anyway


def test_a_review_file_without_an_attempt_number_is_attempt_one(client):
    _put(client, "Udemy/C/03-incorrect.md")                                   # saved before attempts were in the name
    r = client.get("/files", headers={"X-File-Path": "Udemy/C/03-incorrect.md"}).json()["files"]
    assert [(f["kind"], f["attempt"], f["label"]) for f in r] == [("incorrect", 1, "Attempt 1")]
    _put(client, "Udemy/C/03-incorrect (attempt 2).md")
    r = client.get("/files", headers={"X-File-Path": "Udemy/C/03-incorrect (attempt 2).md"}).json()["files"]
    assert [f["attempt"] for f in r] == [2, 1]                                 # the plain file still counts, as the first


def test_metadata_only_keeps_the_text_and_the_stored_hash(client):
    h = {"X-File-Path": "Udemy/Curso/01-incorrect.md", "X-Mathesis-Kind": "quiz-review"}
    client.post("/write", content=b"# generated\n", headers=h)
    f = client.root / "Udemy/Curso/01-incorrect.md"
    f.write_text(f.read_text() + "\nMy note.\n")
    before_front, before_body = frontmatter.split(f.read_text())
    assert client.post("/write", content=b"# newer\n", headers=h).status_code == 409
    r = client.post("/write", content=b"# newer\n", headers={**h, "X-Mathesis-Overwrite": "metadata",
                    "X-Mathesis-Meta": meta_header(course="Curso", lesson="Teste 1", url="https://example.com/q")})
    assert r.status_code == 200 and r.json()["metadata_only"] is True
    front, body_after = frontmatter.split(f.read_text())
    assert body_after == before_body and "My note." in body_after                       # not a character of the text changed
    assert 'url: "https://example.com/q"' in front and 'lesson: "Teste 1"' in front
    assert front[-1] == before_front[-1]                                                # the hash is the old one: still "changed"
    assert client.get("/status", headers=h).json()["modified"] is True


def test_files_carry_the_absolute_path(client):
    _put(client, "Udemy/C/02-all questions.json")
    f = client.get("/files", headers={"X-File-Path": "Udemy/C/02-all questions.json"}).json()["files"][0]
    assert f["abs_path"] == str(client.root / "Udemy/C/02-all questions.json")


def test_show_in_folder_only_for_listed_files(client, monkeypatch):
    shown = []
    monkeypatch.setattr(server, "open_folder", lambda p: shown.append(p) or True)
    _put(client, "Udemy/C/02-all questions.json")
    _put(client, "Udemy/C/random.txt")
    ok = client.post("/open", headers={"X-File-Path": "Udemy/C/02-all questions.json", "X-Mathesis-Open": "folder"})
    assert ok.status_code == 200 and ok.json()["opened_with"] == "file manager" and shown[-1].name == "02-all questions.json"
    assert client.post("/open", headers={"X-File-Path": "Udemy/C/random.txt", "X-Mathesis-Open": "folder"}).status_code == 403
    monkeypatch.setattr(server, "open_folder", lambda p: False)
    assert client.post("/open", headers={"X-File-Path": "Udemy/C/02-all questions.json", "X-Mathesis-Open": "folder"}).status_code == 501


def test_file_text_is_served_to_the_course_sites_only(client):
    _put(client, "Udemy/C/02-incorrect.md", "# the text\n")
    h = {"X-File-Path": "Udemy/C/02-incorrect.md"}
    assert client.get("/file", headers=h).text == "# the text\n"                                   # no Origin: not a web page
    assert client.get("/file", headers={**h, "Origin": "https://www.udemy.com"}).status_code == 200
    assert client.get("/file", headers={**h, "Origin": "https://partner.skills.google"}).status_code == 200
    assert client.get("/file", headers={**h, "Origin": "https://evil.example"}).status_code == 403
    assert client.get("/file", headers={**h, "Origin": "https://udemy.com.evil.example"}).status_code == 403
    assert client.get("/file", headers={"X-File-Path": "Udemy/C/none.md"}).status_code == 404
    _put(client, "Udemy/C/random.txt")
    assert client.get("/file", headers={"X-File-Path": "Udemy/C/random.txt"}).status_code == 403   # not a file of a page


def _regen_client(tmp_path, **kw):
    settings = Settings(root=tmp_path.resolve(), notify=False, obsidian_command="obs", **kw)
    return TestClient(server.create_app(settings))


def test_regenerate_rewrites_the_summary_and_keeps_the_old_one_on_failure(tmp_path, monkeypatch):
    calls = []

    def fake(content, file, settings):
        calls.append(content)
        if "boom" in content:
            return "provider down"
        server_summary = tmp_path / "G/C/01-Lab-summary.md"
        server_summary.write_text("NEW summary", encoding="utf-8")
    monkeypatch.setattr(server, "write_summary", fake)
    with _regen_client(tmp_path, summary_provider="gemini") as c:
        lesson = tmp_path / "G/C/01-Lab.md"
        lesson.parent.mkdir(parents=True)
        lesson.write_text("---\ntype: \"transcript\"\n---\nthe lesson text", encoding="utf-8")
        (tmp_path / "G/C/01-Lab-summary.md").write_text("OLD summary", encoding="utf-8")
        h = {"X-File-Path": "G/C/01-Lab.md", "X-Mathesis-Kind": "summary"}
        r = c.post("/regenerate", headers=h)
        assert r.status_code == 202 and calls == ["the lesson text"]                # frontmatter is not sent to the model
        assert (tmp_path / "G/C/01-Lab-summary.md").read_text() == "NEW summary"
        got = {f["kind"]: f for f in c.get("/files", headers={"X-File-Path": "G/C/01-Lab.md"}).json()["files"]}
        assert got["summary"]["state"] == "ready"
        lesson.write_text("boom", encoding="utf-8")
        (tmp_path / "G/C/01-Lab-summary.md").write_text("KEPT", encoding="utf-8")
        assert c.post("/regenerate", headers=h).status_code == 202
        got = {f["kind"]: f for f in c.get("/files", headers={"X-File-Path": "G/C/01-Lab.md"}).json()["files"]}
        assert got["summary"]["state"] == "failed" and got["summary"]["error"] == "provider down" and got["summary"]["path"]
        assert (tmp_path / "G/C/01-Lab-summary.md").read_text() == "KEPT"


def test_regenerate_refuses_what_cannot_be_done(tmp_path):
    with _regen_client(tmp_path, summary_provider="gemini") as c:
        (tmp_path / "G/C").mkdir(parents=True)
        (tmp_path / "G/C/01-Lab.md").write_text("text", encoding="utf-8")
        (tmp_path / "G/C/01-Lab-summary.md").write_text("s", encoding="utf-8")
        ok = {"X-File-Path": "G/C/01-Lab.md", "X-Mathesis-Kind": "summary"}
        assert c.post("/regenerate", headers={**ok, "X-Mathesis-Kind": "transcript"}).status_code == 400
        assert c.post("/regenerate", headers={**ok, "X-File-Path": "G/C/09-None.md"}).status_code == 404
        assert c.post("/regenerate", headers={**ok, "X-File-Path": "G/C/01-Lab-summary.md"}).status_code == 404   # not a lesson
        assert c.post("/regenerate", headers={**ok, "X-File-Path": "../x.md"}).status_code == 403
        assert c.post("/regenerate", headers={**ok, "X-Mathesis-Kind": "lab-guide"}).status_code == 409           # lab guides off
        c.app.state.jobs.start((tmp_path / "G/C/01-Lab.md").resolve(), "summary")
        r = c.post("/regenerate", headers=ok)
        assert r.status_code == 409 and r.json()["code"] == "pending"
    with _regen_client(tmp_path, llm=False) as c:
        r = c.post("/regenerate", headers=ok)
        assert r.status_code == 409 and r.json()["code"] == "llm-off"


def test_regenerate_lab_guide_only_for_labs(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(server, "write_lab_guide", lambda content, file, settings: seen.append(content))
    with _regen_client(tmp_path, summary_provider="none", lab_provider="gemini") as c:
        (tmp_path / "G/C").mkdir(parents=True)
        (tmp_path / "G/C/01-Lab.md").write_text("---\ntype: \"lab\"\n---\nlab text", encoding="utf-8")
        (tmp_path / "G/C/02-Talk.md").write_text("---\ntype: \"transcript\"\n---\ntalk", encoding="utf-8")
        h = {"X-Mathesis-Kind": "lab-guide"}
        assert c.post("/regenerate", headers={**h, "X-File-Path": "G/C/02-Talk.md"}).status_code == 409
        assert c.post("/regenerate", headers={**h, "X-File-Path": "G/C/01-Lab.md"}).status_code == 202
        import time
        for _ in range(50):
            if seen:
                break
            time.sleep(0.05)
        assert seen == ["lab text"]


def test_write_while_generating_does_nothing(client):
    target = _put(client, "G/C/01-Lab.md").resolve()
    before = target.read_text(encoding="utf-8")
    jobs = client.app.state.jobs
    jobs.start(target, "lab-guide")   # the AI is still writing
    r = client.post("/write", content="new text", headers={"X-File-Path": "G/C/01-Lab.md", "X-Mathesis-Kind": "lab"})
    assert r.status_code == 409 and r.json()["code"] == "pending"
    assert target.read_text(encoding="utf-8") == before            # nothing saved
    assert jobs.get(target, "summary") is None                      # and no second job started
    jobs.finish(target, "lab-guide", target.with_name("01-Lab-lab-guide.md"), "stopped")
    jobs.finish(target, "lab-guide", target.with_name("01-Lab-lab-guide.md"))
    assert client.post("/write", content="new text", headers={"X-File-Path": "G/C/01-Lab.md", "X-Mathesis-Kind": "lab"}).status_code == 200   # finished (failed): saving works again
