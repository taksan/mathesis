from mathesis import cli


class FakeClient:
    def __init__(self, settings):
        self.model = settings.model

    def check_model(self):
        return True, "ok"

    def chat(self, system, user, temperature=0.2):
        return "## The big idea\nx\n## How it fits together\ny\n## Remember for the exam\n- z"


def test_transcripts_expands_folders_and_skips_summaries(tmp_path):
    (tmp_path / "A").mkdir()
    for name in ["A/01-x.md", "A/01-x-summary.md", "A/02-y.md", "notes.txt"]:
        (tmp_path / name).write_text("t")
    found = cli._transcripts([tmp_path])
    assert [f.name for f in found] == ["01-x.md", "02-y.md"]


def test_summarize_writes_summary_and_skips_existing(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "OllamaClient", FakeClient)
    f = tmp_path / "P" / "C" / "01-L.md"
    f.parent.mkdir(parents=True)
    f.write_text("# L\ntext")
    assert cli.main(["summarize", str(f), "--no-revise", "--model", "fake:1"]) == 0
    out = f.with_name("01-L-summary.md")
    assert "The big idea" in out.read_text() and "model=fake:1" in out.read_text()
    capsys.readouterr()
    assert cli.main(["summarize", str(f)]) == 0
    assert "skip" in capsys.readouterr().out


def test_summarize_stdout_does_not_write(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "OllamaClient", FakeClient)
    f = tmp_path / "P" / "C" / "01-L.md"
    f.parent.mkdir(parents=True)
    f.write_text("t")
    assert cli.main(["summarize", str(f), "--stdout"]) == 0
    assert "The big idea" in capsys.readouterr().out and not f.with_name("01-L-summary.md").exists()


def test_flags_override_environment(monkeypatch):
    monkeypatch.setenv("MATHESIS_MODEL", "from-env:1")
    args = cli.build_parser().parse_args(["doctor", "--model", "from-flag:2", "--port", "6001"])
    s = cli._settings(args)
    assert (s.model, s.port) == ("from-flag:2", 6001)
    args = cli.build_parser().parse_args(["doctor"])
    assert cli._settings(args).model == "from-env:1"
