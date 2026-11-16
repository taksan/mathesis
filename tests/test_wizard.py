import pytest

from mathesis import cli, wizard
from mathesis.config import Settings


def answers(*lines):
    it = iter(lines)

    def ask(prompt):
        try:
            return next(it)
        except StopIteration:
            raise EOFError
    return ask


def run(tmp_path, *lines, **kw):
    out = []
    target = tmp_path / "app" / "config.toml"
    code = wizard.run_init(target, ask=answers(*lines), out=out.append, **kw)
    return code, target, "\n".join(out)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    import os
    for name in [n for n in os.environ if n.startswith("MATHESIS_")]:
        monkeypatch.delenv(name)


def test_all_defaults_need_no_ai_provider(tmp_path):
    notes = tmp_path / "notes"
    code, target, text = run(tmp_path, str(notes))       # then end of input: every other answer is the default
    s = Settings.from_env(target)
    assert code == 0 and notes.is_dir() and not s.llm and not s.summary_enabled and not s.lab_guide_enabled
    lines = [l for l in target.read_text().splitlines() if l and not l.startswith("#")]
    assert "llm = false" in lines and not any(l.startswith(("provider", "[summary]", "[lab_guide]", "[providers")) for l in lines)
    after = text.split("Before you start:")[1]
    assert "No AI is configured" in after and "ollama" not in after.lower().replace("config", "") and "API_KEY" not in after


def test_ollama_config(tmp_path):
    notes = tmp_path / "notes"
    code, target, text = run(tmp_path, str(notes), "ollama")
    s = Settings.from_env(target)
    assert code == 0 and notes.is_dir()
    assert (s.default_provider, s.summary_provider, s.lab_provider, s.root) == ("ollama", "ollama", "ollama", notes.resolve())
    after = text.split("Before you start:")[1]
    assert "ollama pull" in after and "API_KEY" not in after and "doctor" in after
    assert oct(target.stat().st_mode & 0o777) == "0o600"


def test_default_notes_folder_is_in_the_home_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    code, target, _ = run(tmp_path, "")
    assert code == 0 and (tmp_path / "mathesis-notes").is_dir()
    assert 'root = "~/mathesis-notes"' in target.read_text()


def test_gemini_default_with_overrides_and_key_instructions(tmp_path):
    # root, default = gemini (2), summaries = default (1), labs = claude-code (the 3rd entry after the default)
    code, target, text = run(tmp_path, str(tmp_path / "n"), "gemini", "1", "claude-code")
    s = Settings.from_env(target)
    assert (s.default_provider, s.summary_provider, s.lab_provider) == ("gemini", "gemini", "claude-code")
    body = target.read_text()
    assert "\n[summary]\n" not in body and '[lab_guide]\nprovider = "claude-code"' in body   # only the override is written
    after = text.split("Before you start:")[1]
    assert "export GEMINI_API_KEY=..." in after and f"write the line GEMINI_API_KEY=... to {target.parent / '.env'}" in after
    assert "claude` CLI" in after and "ollama pull" not in after


def test_summaries_and_labs_can_be_switched_off(tmp_path):
    code, target, _ = run(tmp_path, str(tmp_path / "n"), "gemini", "5", "5")
    s = Settings.from_env(target)
    assert (s.summary_provider, s.lab_provider) == ("none", "none") and not s.summary_enabled and not s.lab_guide_enabled


def test_menu_lists_default_first_and_rejects_bad_answers(tmp_path):
    out = []
    picked = wizard.choose(answers("9", "nope", "claude-code"), "t", [("gemini", "default (gemini)"), ("ollama", "o"),
                                                                       ("claude-code", "c")], out.append)
    assert picked == "claude-code" and out[1] == "  1) default (gemini)" and out.count("  not a choice, try again") == 2


def test_openai_asks_for_its_model(tmp_path):
    code, target, text = run(tmp_path, str(tmp_path / "n"), "openai", "", "", "my-model")
    s = Settings.from_env(target)
    assert s.provider_spec("openai", None)["model"] == "my-model" and "OPENAI_API_KEY" in text


def test_existing_file_is_kept_unless_forced(tmp_path):
    code, target, _ = run(tmp_path, str(tmp_path / "n"))
    before = target.read_text()
    code, _, text = run(tmp_path, str(tmp_path / "n2"))
    assert code == 1 and "already exists" in text and target.read_text() == before
    code, _, _ = run(tmp_path, str(tmp_path / "n2"), "gemini", force=True)
    assert code == 0 and 'provider = "gemini"' in target.read_text()


def test_cli_init_uses_the_wizard(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("builtins.input", answers(str(tmp_path / "n"), "gemini", "1", "1"))
    target = tmp_path / "c.toml"
    assert cli.main(["config", "--init", "--config", str(target)]) == 0
    assert target.is_file() and "GEMINI_API_KEY" in capsys.readouterr().out


def _args(command, **kw):
    import argparse
    return argparse.Namespace(command=command, config=kw.get("config"))


def test_first_run_asks_once_and_writes_the_default_config(tmp_path, monkeypatch, capsys):
    target = tmp_path / "config.toml"
    monkeypatch.setattr(cli, "DEFAULT_CONFIG", target)
    monkeypatch.setattr("builtins.input", answers(str(tmp_path / "n")))   # then Enter: no AI
    assert cli.first_run_setup(_args("serve"), interactive=True) is True
    assert not Settings.from_env(target).llm and (tmp_path / "n").is_dir()
    out = capsys.readouterr().out
    assert "First run" in out and "then `mathesis serve` starts" not in out
    assert cli.first_run_setup(_args("serve"), interactive=True) is False      # the file exists now: never asks again


def test_first_run_never_prompts_without_a_terminal_or_with_an_explicit_config(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "DEFAULT_CONFIG", tmp_path / "config.toml")
    monkeypatch.setattr("builtins.input", lambda *_: pytest.fail("must not prompt"))
    assert cli.first_run_setup(_args("serve"), interactive=False) is False
    assert "built-in defaults" in capsys.readouterr().err and not (tmp_path / "config.toml").exists()
    assert cli.first_run_setup(_args("serve", config="x.toml"), interactive=True) is False
    monkeypatch.setenv("MATHESIS_CONFIG", "x.toml")
    assert cli.first_run_setup(_args("serve"), interactive=True) is False
    monkeypatch.delenv("MATHESIS_CONFIG")
    assert cli.first_run_setup(_args("config"), interactive=True) is False     # `config` has its own --init


def test_cancelled_first_run_writes_nothing(tmp_path, monkeypatch):
    target = tmp_path / "config.toml"
    monkeypatch.setattr(cli, "DEFAULT_CONFIG", target)

    def interrupt(_):
        raise KeyboardInterrupt
    monkeypatch.setattr("builtins.input", interrupt)
    with pytest.raises(SystemExit) as e:
        cli.first_run_setup(_args("doctor"), interactive=True)
    assert e.value.code == 130 and not target.exists()
