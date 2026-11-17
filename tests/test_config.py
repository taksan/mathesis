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
provider = "gemini"
[summary]
model = "gemini-2.5-pro"
pipeline = "single"
[lab_guide]
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
provider = "openrouter"
[providers.openrouter]
type = "openai"
url = "https://openrouter.ai/api/v1"
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


def test_config_command_shows_the_providers_in_use(tmp_path, capsys):
    f = write(tmp_path, 'provider = "ollama"\n')
    assert cli.main(["config", "--config", str(f)]) == 0
    assert "summaries: ollama [default]" in capsys.readouterr().out


def test_cli_reports_config_errors(tmp_path, capsys):
    f = write(tmp_path, '[summary]\nprovider = "nope"\n')
    assert cli.main(["doctor", "--config", str(f)]) == 2
    assert "config error" in capsys.readouterr().err


def test_one_default_provider_serves_both_jobs_and_jobs_override_it(tmp_path):
    s = Settings.from_env(write(tmp_path, 'provider = "gemini"\n'))
    assert (s.default_provider, s.summary_provider, s.lab_provider) == ("gemini", "gemini", "gemini")
    s = Settings.from_env(write(tmp_path, 'provider = "gemini"\n[lab_guide]\nprovider = "claude-code"\n[summary]\nmodel = "m-1"\n'))
    assert (s.summary_provider, s.summary_model, s.lab_provider) == ("gemini", "m-1", "claude-code")
    s = Settings.from_env(write(tmp_path, 'provider = "gemini"\n[summary]\nprovider = "none"\n'))
    assert s.summary_provider == "none" and not s.summary_enabled and s.lab_provider == "gemini"


def test_without_a_default_the_original_choices_stay(tmp_path):
    s = Settings.from_env(write(tmp_path, '[summary]\nmodel = "qwen3:8b"\n'))
    assert (s.default_provider, s.summary_provider, s.lab_provider) == (None, "ollama", "claude-code")
    assert s.provider_spec("ollama", s.summary_model)["model"] == "qwen3:8b"


def test_env_overrides_the_default_provider(tmp_path, monkeypatch):
    f = write(tmp_path, 'provider = "gemini"\n')
    monkeypatch.setenv("MATHESIS_PROVIDER", "ollama")
    assert Settings.from_env(f).lab_provider == "ollama"
    monkeypatch.setenv("MATHESIS_LAB_PROVIDER", "claude-code")
    s = Settings.from_env(f)
    assert (s.summary_provider, s.lab_provider) == ("ollama", "claude-code")


def test_default_provider_must_exist(tmp_path):
    with pytest.raises(ConfigError, match="not defined"):
        Settings.from_env(write(tmp_path, 'provider = "gemin"\n'))
    with pytest.raises(ConfigError, match="must be a name"):
        Settings.from_env(write(tmp_path, 'provider = 3\n'))


def test_configured_but_unused_provider_is_reported(tmp_path, capsys):
    f = write(tmp_path, 'provider = "claude-code"\n[providers.gemini]\nmodel = "m"\n[providers.ollama]\n')
    s = Settings.from_env(f)
    assert s.unused_providers() == ["gemini"]                          # empty tables do not count
    assert cli.main(["config", "--config", str(f)]) == 0
    assert "[providers.gemini] is configured but not used" in capsys.readouterr().out
    used = write(tmp_path, 'provider = "gemini"\n[providers.gemini]\nmodel = "m"\n')
    assert Settings.from_env(used).unused_providers() == []


def test_api_keys_come_from_conventional_environment_variables(tmp_path):
    from mathesis.config import api_key_env
    assert (api_key_env("gemini"), api_key_env("openai"), api_key_env("big-router")) == (
        "GEMINI_API_KEY", "OPENAI_API_KEY", "BIG_ROUTER_API_KEY")
    s = Settings()
    assert s.provider_spec("gemini")["api_key_env"] == "GEMINI_API_KEY" and s.provider_spec("gemini")["key_required"]
    custom = Settings(providers={"openrouter": {"type": "openai", "url": "http://x/v1", "key_required": False}})
    spec = custom.provider_spec("openrouter")
    assert spec["api_key_env"] == "OPENROUTER_API_KEY" and not spec.get("key_required")


@pytest.mark.parametrize("line", ['api_key = "k"', 'api_key_env = "MY_KEY"'])
def test_keys_in_the_file_are_refused_with_the_variable_to_use(tmp_path, line):
    with pytest.raises(ConfigError, match="GEMINI_API_KEY"):
        Settings.from_env(write(tmp_path, f'provider = "gemini"\n[providers.gemini]\n{line}\n'))


def test_dotenv_provides_keys_but_never_overrides_the_environment(tmp_path, monkeypatch):
    f = write(tmp_path, 'provider = "gemini"\n')
    (tmp_path / ".env").write_text("# keys\nGEMINI_API_KEY='from-file'\nexport MATHESIS_PORT=6123 # note\nOTHER_KEY=\"x y\"\nbad line\n")
    monkeypatch.setenv("OTHER_KEY", "from-env")
    for name in ("GEMINI_API_KEY", "MATHESIS_PORT"):
        monkeypatch.delenv(name, raising=False)
    s = Settings.from_env(f)
    import os
    assert os.environ["GEMINI_API_KEY"] == "from-file" and s.port == 6123 and os.environ["OTHER_KEY"] == "from-env"
    monkeypatch.delenv("GEMINI_API_KEY")
    monkeypatch.delenv("MATHESIS_PORT")


def test_llm_switch_turns_every_llm_feature_off(tmp_path, monkeypatch):
    assert Settings.from_env().llm is True
    f = write(tmp_path, 'llm = false\nprovider = "gemini"\n[providers.gemini]\nmodel = "x"\n')   # no GEMINI_API_KEY: must not matter
    s = Settings.from_env(f)
    assert s.llm is False and not s.summary_enabled and not s.lab_guide_enabled and s.unused_providers() == []
    monkeypatch.setenv("MATHESIS_LLM", "0")
    assert Settings.from_env().llm is False
    monkeypatch.setenv("MATHESIS_LLM", "1")
    assert Settings.from_env(f).llm is True


def test_llm_must_be_a_boolean(tmp_path):
    with pytest.raises(ConfigError, match="llm must be true or false"):
        Settings.from_env(write(tmp_path, 'llm = "no"\n'))


def test_no_llm_flag_and_summarize_refuses(capsys):
    args = type("A", (), {"config": None, "no_llm": True, "paths": []})()
    assert cli._settings(args).llm is False
    assert cli.cmd_summarize(args) == 1
    assert "LLM features are off" in capsys.readouterr().err
