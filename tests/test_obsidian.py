import urllib.parse
from pathlib import Path

from mathesis import notify as notify_mod
from mathesis import obsidian, pipeline
from mathesis.config import Settings


def test_uri_encodes_the_absolute_path(tmp_path):
    f = tmp_path / "Google Skills" / "23-Connecting: networks.md"
    uri = obsidian.uri_for(f)
    assert uri.startswith("obsidian://open?path=") and " " not in uri and ":" not in uri.split("path=")[1]
    assert urllib.parse.unquote(uri.split("path=")[1]) == str(f.resolve())


def test_find_command_prefers_config_then_latest_appimage(tmp_path, monkeypatch):
    assert obsidian.find_command("my-obsidian --flag") == ["my-obsidian", "--flag"]
    (tmp_path / "Obsidian-1.2.0.AppImage").write_text("")
    (tmp_path / "Obsidian-1.15.0.AppImage").write_text("")
    monkeypatch.setattr(obsidian, "APPIMAGE_DIRS", [str(tmp_path)])
    assert obsidian.find_command() == [str(tmp_path / "Obsidian-1.15.0.AppImage")]


def test_find_command_none_when_nothing_available(tmp_path, monkeypatch):
    monkeypatch.setattr(obsidian, "APPIMAGE_DIRS", [str(tmp_path)])
    monkeypatch.setattr(obsidian.shutil, "which", lambda name: None)
    assert obsidian.find_command() is None
    assert obsidian.open_in_obsidian(tmp_path / "x.md") is False


def test_open_in_obsidian_passes_the_uri(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(obsidian.subprocess, "Popen", lambda cmd, **kw: calls.append(cmd))
    assert obsidian.open_in_obsidian(tmp_path / "a b.md", "obs") is True
    assert calls[0][0] == "obs" and calls[0][1] == obsidian.uri_for(tmp_path / "a b.md")


class FakeProc:
    def __init__(self, output):
        self.output = output

    def communicate(self, timeout=None):
        return self.output, ""

    def kill(self):
        pass


def _fake_popen(monkeypatch, output):
    seen = []
    monkeypatch.setattr(notify_mod.subprocess, "Popen", lambda cmd, **kw: seen.append(cmd) or FakeProc(output))
    return seen


def test_clicking_the_notification_runs_the_action(monkeypatch):
    seen, clicked = _fake_popen(monkeypatch, "open\n"), []
    notify_mod.notify("Summary ready", "x", on_click=lambda: clicked.append(1)).join(2)
    assert clicked == [1]
    assert "-A" in seen[0] and "open=Open in Obsidian" in seen[0] and "default=Open" in seen[0]


def test_default_action_also_counts(monkeypatch):
    _fake_popen(monkeypatch, "default\n")
    clicked = []
    notify_mod.notify("t", on_click=lambda: clicked.append(1)).join(2)
    assert clicked == [1]


def test_dismissed_notification_does_nothing(monkeypatch):
    _fake_popen(monkeypatch, "")
    clicked = []
    notify_mod.notify("t", on_click=lambda: clicked.append(1)).join(2)
    assert clicked == []


def test_no_action_buttons_without_on_click(monkeypatch):
    seen = _fake_popen(monkeypatch, "")
    notify_mod.notify("t", "b").join(2)
    assert "-A" not in seen[0]


def test_disabled_notifications_do_not_spawn_anything(monkeypatch):
    seen = _fake_popen(monkeypatch, "")
    assert notify_mod.notify("t", enabled=False) is None and seen == []


def _run_write_summary(tmp_path, monkeypatch, **settings):
    captured = {}
    monkeypatch.setattr(pipeline, "summarize", lambda *a, **k: ("## The big idea\nx", {"prompts": "p", "revisions": 0}))
    monkeypatch.setattr(pipeline, "OllamaClient", lambda s: None)
    monkeypatch.setattr(pipeline, "notify", lambda title, body="", **kw: captured.update(title=title, **kw))
    opened = []
    monkeypatch.setattr(pipeline, "open_in_obsidian", lambda path, cmd=None: opened.append((path, cmd)))
    lesson = tmp_path / "P" / "C" / "01-L.md"
    lesson.parent.mkdir(parents=True)
    pipeline.write_summary("text", lesson, Settings(root=tmp_path, **settings))
    return captured, opened, lesson


def test_summary_ready_notification_opens_the_summary_file(tmp_path, monkeypatch):
    captured, opened, lesson = _run_write_summary(tmp_path, monkeypatch, obsidian_command="obs")
    assert captured["title"] == "Summary ready" and callable(captured["on_click"])
    captured["on_click"]()
    assert opened == [(lesson.with_name("01-L-summary.md"), "obs")]
    assert lesson.with_name("01-L-summary.md").exists()


def test_open_can_be_disabled(tmp_path, monkeypatch):
    captured, _, _ = _run_write_summary(tmp_path, monkeypatch, obsidian_open=False)
    assert captured["on_click"] is None
