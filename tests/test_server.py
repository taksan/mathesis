import pytest
from fastapi.testclient import TestClient

from mathesis import server
from mathesis.config import Settings
from mathesis.obsidian import uri_for
from mathesis.pipeline import summary_path


@pytest.fixture
def client(tmp_path):
    settings = Settings(root=tmp_path.resolve(), summarize=False, notify=False, obsidian_command="obs")  # "obs": Obsidian found
    with TestClient(server.create_app(settings)) as c:
        c.root = tmp_path.resolve()
        yield c


def test_write_creates_missing_directories_and_status_reflects_it(client):
    target = client.root / "Path" / "Course" / "01-Lesson.md"
    h = {"X-File-Path": "Path/Course/01-Lesson.md"}
    assert client.get("/status", headers=h).json() == {"exists": False, "summary_exists": False, "opener": "obsidian", "obsidian_uri": None}
    r = client.post("/write", content="# Lesson\nhello".encode(), headers=h)
    assert r.status_code == 200 and r.json()["bytes"] == 14 and r.json()["path"] == "Path/Course/01-Lesson.md"
    assert target.read_text() == "# Lesson\nhello"
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
        assert r.json()["kind"] == "quiz" and quiz.read_text() == "# Final Assessment\n"
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
    assert target.read_text() == "# Lesson\n\nconverted text here\n"
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
    assert r.status_code == 200 and (client.root / name).read_text() == "x"
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
    assert client.get("/files", headers={"X-File-Path": "Udemy/C/05-incorrect.md"}).json() == {"files": []}


def test_files_lists_a_lesson_with_summary_and_guide(client):
    _put(client, "G/C/01-Lab.md")
    h = {"X-File-Path": "G/C/01-Lab.md"}
    assert [f["kind"] for f in client.get("/files", headers=h).json()["files"]] == ["transcript"]
    _put(client, "G/C/01-Lab-summary.md")
    _put(client, "G/C/01-Lab-lab-guide.md")
    assert [f["kind"] for f in client.get("/files", headers=h).json()["files"]] == ["lab-guide", "summary", "transcript"]
    assert client.get("/files", headers={"X-File-Path": "G/C/09-None.md"}).json() == {"files": []}


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
