import pytest

from mathesis import cli
from mathesis.config import ConfigError, Settings, find_config


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    import os
    for name in [n for n in os.environ if n.startswith("MATHESIS_")]:
        monkeypatch.delenv(name)
    monkeypatch.setattr("mathesis.config.DEFAULT_CONFIG", tmp_path / "none.toml")


def write(tmp_path, text):
    f = tmp_path / "config.toml"
    f.write_text(text)
    return f


def test_no_file_means_defaults():
    s = Settings.from_env()
    assert (s.summary_provider, s.lab_provider, s.config_path) == ("ollama", "claude-code", None)


def test_file_values_env_overrides_file(tmp_path, monkeypatch):
    f = write(tmp_path, '''
[summary]
provider = "gemini"
model = "gemini-2.5-pro"
pipeline = "single"
[lab_guide]
provider = "gemini"
enabled = false
[providers.ollama]
url = "http://gpu:11434/"
model = "qwen3:8b"
[providers.claude-code]
model = "sonnet"
[server]
port = 6001
notify = false
''')
    s = Settings.from_env(f)
    assert (s.summary_provider, s.summary_model, s.pipeline, s.lab_guide, s.port, s.notify) == (
        "gemini", "gemini-2.5-pro", "single", False, 6001, False)
    assert (s.ollama_url, s.model, s.claude_model, s.config_path) == ("http://gpu:11434", "qwen3:8b", "sonnet", f.resolve())
    monkeypatch.setenv("MATHESIS_MODEL", "env:1")
    monkeypatch.setenv("MATHESIS_PORT", "7000")
    monkeypatch.setenv("MATHESIS_SUMMARY_PROVIDER", "ollama")
    s = Settings.from_env(f)
    assert (s.model, s.port, s.summary_provider) == ("env:1", 7000, "ollama")


def test_flags_beat_the_file(tmp_path):
    f = write(tmp_path, '[providers.ollama]\nmodel = "from-file:1"\n')
    args = cli.build_parser().parse_args(["doctor", "--config", str(f), "--model", "from-flag:2"])
    assert cli._settings(args).model == "from-flag:2"


def test_custom_provider_table(tmp_path):
    f = write(tmp_path, '''
[summary]
provider = "openrouter"
[providers.openrouter]
type = "openai"
url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"
model = "google/gemini-2.5-flash"
''')
    spec = Settings.from_env(f).provider_spec("openrouter")
    assert spec["type"] == "openai" and spec["model"] == "google/gemini-2.5-flash"


@pytest.mark.parametrize("text, message", [
    ('[summary]\nprovder = "x"\n', "unknown key"),
    ('[sumary]\nprovider = "x"\n', "unknown section"),
    ('[summary]\nprovider = "nope"\n', "not defined"),
    ('[summary]\nprovider = "mine"\n[providers.mine]\nmodel = "m"\n', "not defined"),   # custom table without a type
    ('[summary]\nenabled = "yes"\n', "true or false"),
    ('[summary\n', "cannot read"),
])
def test_bad_config_is_explained(tmp_path, text, message):
    with pytest.raises(ConfigError, match=message):
        Settings.from_env(write(tmp_path, text))


def test_explicit_missing_file_is_an_error(tmp_path):
    with pytest.raises(ConfigError, match="not found"):
        find_config(tmp_path / "missing.toml")


def test_config_command_init_and_show(tmp_path, capsys):
    target = tmp_path / "sub" / "config.toml"
    assert cli.main(["config", "--init", "--config", str(target)]) == 0
    assert target.is_file() and oct(target.stat().st_mode & 0o777) == "0o600"
    assert cli.main(["config", "--init", "--config", str(target)]) == 1          # never overwrites
    capsys.readouterr()
    assert Settings.from_env(target).summary_provider == "ollama"                 # the example parses and is valid
    assert cli.main(["config", "--config", str(target)]) == 0
    assert "summaries: ollama" in capsys.readouterr().out


def test_cli_reports_config_errors(tmp_path, capsys):
    f = write(tmp_path, '[summary]\nprovider = "nope"\n')
    assert cli.main(["doctor", "--config", str(f)]) == 2
    assert "config error" in capsys.readouterr().err


def test_model_without_provider_is_an_error_not_a_silent_ollama_request(tmp_path):
    f = write(tmp_path, '[summary]\nmodel = "gemini-3.8-flash"\n[lab_guide]\nprovider = "gemini"\n')
    with pytest.raises(ConfigError, match=r"\[summary\] sets model .* no provider"):
        Settings.from_env(f)
    ok = write(tmp_path, '[summary]\nprovider = "gemini"\nmodel = "gemini-3.8-flash"\n')
    assert Settings.from_env(ok).summary_model == "gemini-3.8-flash"


def test_configured_but_unused_provider_is_reported(tmp_path, capsys):
    f = write(tmp_path, '[providers.gemini]\nmodel = "m"\n[providers.ollama]\n[lab_guide]\nprovider = "claude-code"\n')
    s = Settings.from_env(f)
    assert s.unused_providers() == ["gemini"]                          # empty tables do not count
    assert cli.main(["config", "--config", str(f)]) == 0
    assert "[providers.gemini] is configured but not used" in capsys.readouterr().out
    used = write(tmp_path, '[providers.gemini]\nmodel = "m"\n[summary]\nprovider = "gemini"\n')
    assert Settings.from_env(used).unused_providers() == []
