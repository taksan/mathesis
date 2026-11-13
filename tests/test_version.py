import re
import subprocess

from mathesis import version


def test_describe_has_package_version_and_git_build():
    text = version.describe()
    assert text.startswith("Mathesis ") and re.search(r"\(build \d+\.[0-9a-f]{7,}(\+dirty)?\)$", text)


def test_describe_without_git(monkeypatch):
    def boom(*a, **k):
        raise FileNotFoundError("git")
    monkeypatch.setattr(subprocess, "run", boom)
    assert re.fullmatch(r"Mathesis \d+\.\d+\.\d+", version.describe())


def test_serve_prints_version_first(monkeypatch, capsys):
    import sys, uvicorn
    from mathesis import cli
    monkeypatch.setattr(uvicorn, "run", lambda *a, **k: None)
    monkeypatch.setattr(sys, "argv", ["mathesis", "serve", "--no-reload"])
    cli.main()
    assert capsys.readouterr().out.splitlines()[0].startswith("Mathesis ")
