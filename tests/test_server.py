import pytest
from fastapi.testclient import TestClient

from mathesis import server
from mathesis.config import Settings


@pytest.fixture
def client(tmp_path):
    settings = Settings(root=tmp_path.resolve(), summarize=False, notify=False)
    with TestClient(server.create_app(settings)) as c:
        c.root = tmp_path.resolve()
        yield c


def test_write_creates_missing_directories_and_status_reflects_it(client):
    target = client.root / "Path" / "Course" / "01-Lesson.md"
    h = {"X-File-Path": str(target)}
    assert client.get("/status", headers=h).json() == {"exists": False, "summary_exists": False}
    r = client.post("/write", content="# Lesson\nhello".encode(), headers=h)
    assert r.status_code == 200 and r.json()["bytes"] == 14
    assert target.read_text() == "# Lesson\nhello"
    assert client.get("/status", headers=h).json()["exists"] is True


def test_path_outside_root_is_rejected(client):
    assert client.post("/write", content=b"x", headers={"X-File-Path": "/etc/evil.md"}).status_code == 403
    assert client.get("/status", headers={"X-File-Path": str(client.root / ".." / "x.md")}).status_code == 403


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
        c.post("/write", content=b"transcript", headers={"X-File-Path": str(target)})
        c.post("/write", content=b"   ", headers={"X-File-Path": str(target)})   # blank content: no summary
    assert calls == [("transcript", str(target))]
