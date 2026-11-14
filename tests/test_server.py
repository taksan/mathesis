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
