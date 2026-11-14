from types import SimpleNamespace
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
    monkeypatch.setattr(pipeline, "make_client", lambda s, role: SimpleNamespace(check=lambda: (True, "ok"), label="m"))
    monkeypatch.setattr(pipeline, "notify", lambda title, body="", **kw: captured.update(title=title, **kw))
    opened = []
    monkeypatch.setattr(pipeline, "open_note", lambda path, settings: opened.append((path, settings.obsidian_command)))
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


# ---- no Obsidian: a text editor

def _no_obsidian(monkeypatch):
    monkeypatch.setattr(obsidian, "APPIMAGE_DIRS", [])
    monkeypatch.setattr(obsidian.shutil, "which", lambda name: None)


def test_editor_command_prefers_the_configured_one_then_a_graphical_editor(monkeypatch):
    monkeypatch.setattr(obsidian.sys, "platform", "linux")
    assert obsidian.editor_command("code -r") == ["code", "-r"]
    monkeypatch.setattr(obsidian.shutil, "which", lambda name: "/usr/bin/" + name if name in ("kate", "xdg-open") else None)
    assert obsidian.editor_command() == ["kate"]
    monkeypatch.setattr(obsidian.shutil, "which", lambda name: "/usr/bin/xdg-open" if name == "xdg-open" else None)
    assert obsidian.editor_command() == ["xdg-open"]
    monkeypatch.setattr(obsidian.shutil, "which", lambda name: None)
    assert obsidian.editor_command() is None and obsidian.open_in_editor("x.md") is False


def test_open_note_uses_obsidian_when_present_and_an_editor_when_not(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(obsidian.subprocess, "Popen", lambda cmd, **kw: calls.append(cmd))
    note = tmp_path / "a b.md"
    with_obsidian = Settings(root=tmp_path, obsidian_command="obs", editor_command="ed")
    assert obsidian.open_note(note, with_obsidian) == "Obsidian" and calls[-1][0] == "obs"
    assert obsidian.opener_name(with_obsidian) == "Obsidian"
    _no_obsidian(monkeypatch)
    without = Settings(root=tmp_path, editor_command="ed -w")
    assert obsidian.opener_name(without) == "text editor"
    assert obsidian.open_note(note, without) == "text editor" and calls[-1] == ["ed", "-w", str(note)]
    assert obsidian.open_note(note, Settings(root=tmp_path)) is None  # neither Obsidian nor an editor
