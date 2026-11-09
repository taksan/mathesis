import subprocess
import time
from types import SimpleNamespace

import pytest

from mathesis import labguide
from mathesis.config import Settings

GUIDE = "# Lab guide: Create a VM\n\n" + "word " * 30 + "\n```bash\ngcloud compute instances create vm\n```\n"


def settings(tmp_path, **kw):
    return Settings(root=tmp_path.resolve(), notify=False, claude_command="python3", **kw)


def fake_run(stdout=GUIDE, code=0, seen=None):
    def run(command, **kwargs):
        if seen is not None:
            seen.append((command, kwargs))
        return SimpleNamespace(returncode=code, stdout=stdout, stderr="boom" if code else "")
    return run


def test_guide_path_sits_next_to_the_lesson():
    assert labguide.guide_path("/n/GS/P/C/05-Lab.md").name == "05-Lab-lab-guide.md"


def test_claude_runs_headless_with_no_tools_in_an_empty_folder(tmp_path):
    seen = []
    out = labguide.generate("Task 1: create a VM", tmp_path / "05-Create a VM.md", settings(tmp_path, claude_model="opus"),
                            fake_run(seen=seen))
    command, kwargs = seen[0]
    assert command[1:3] == ["-p", "--output-format"] and command[command.index("--tools") + 1] == ""
    assert "--no-session-persistence" in command and command[command.index("--model") + 1] == "opus"
    assert "Task 1: create a VM" in kwargs["input"] and "Create a VM" in kwargs["input"]
    assert str(tmp_path) not in kwargs["cwd"] and kwargs["timeout"] == 900
    assert out.startswith("# Lab guide")


def test_clean_removes_a_wrapping_fence():
    assert labguide.clean("```markdown\n# T\n\ntext\n```") == "# T\n\ntext\n"
    assert labguide.clean("# T\n\n```bash\nx\n```") == "# T\n\n```bash\nx\n```\n"   # inner fences stay


def test_failures_are_reported_not_raised(tmp_path, monkeypatch):
    notes = []
    monkeypatch.setattr(labguide, "notify", lambda title, body="", **kw: notes.append((title, kw.get("error"))))
    lesson = tmp_path / "05-Lab.md"
    labguide.write_lab_guide("text", lesson, settings(tmp_path), fake_run(code=1))
    labguide.write_lab_guide("text", lesson, settings(tmp_path), fake_run(stdout="too short"))
    labguide.write_lab_guide("text", lesson, Settings(root=tmp_path, notify=False, claude_command="no-such-cli-xyz"))
    assert [n[0] for n in notes] == ["Lab guide failed"] * 3 and not (tmp_path / "05-Lab-lab-guide.md").exists()


def test_guide_is_written_next_to_the_lesson(tmp_path, monkeypatch):
    notes = []
    monkeypatch.setattr(labguide, "notify", lambda title, body="", **kw: notes.append(title))
    lesson = tmp_path / "05-Lab.md"
    labguide.write_lab_guide("text", lesson, settings(tmp_path), fake_run())
    text = (tmp_path / "05-Lab-lab-guide.md").read_text()
    assert text.startswith("# Lab guide") and "VERIFY" in text.splitlines()[-1] and notes == ["Lab guide ready"]


def test_lab_kind_gets_summary_and_guide_but_a_transcript_gets_no_guide(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from mathesis import server
    summaries, guides = [], []
    monkeypatch.setattr(server, "write_summary", lambda content, file, s: summaries.append(file))
    monkeypatch.setattr(server, "write_lab_guide", lambda content, file, s: guides.append((content, file)))
    monkeypatch.setattr("mathesis.ollama.OllamaClient.check_model", lambda self: (True, "ok"))
    app = server.create_app(Settings(root=tmp_path.resolve(), summarize=True, notify=False))
    with TestClient(app) as c:
        c.post("/write", content=b"Task 1", headers={"X-File-Path": "P/C/05-Lab.md", "X-Mathesis-Kind": "lab"})
        c.post("/write", content=b"video text", headers={"X-File-Path": "P/C/06-Video.md"})
        for _ in range(50):
            if guides:
                break
            time.sleep(0.02)
    target = str(tmp_path.resolve() / "P/C/05-Lab.md")
    assert guides == [("Task 1", target)] and target in summaries and len(summaries) == 2


def test_lab_guide_can_be_switched_off(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from mathesis import server
    guides = []
    monkeypatch.setattr(server, "write_lab_guide", lambda *a: guides.append(a))
    with TestClient(server.create_app(Settings(root=tmp_path.resolve(), summarize=False, notify=False, lab_guide=False))) as c:
        r = c.post("/write", content=b"Task 1", headers={"X-File-Path": "P/C/05-Lab.md", "X-Mathesis-Kind": "lab"})
    time.sleep(0.1)
    assert r.json()["kind"] == "lab" and guides == []
