"""Settings: built-in defaults < config file (TOML) < MATHESIS_* environment variables < command-line flags.

Config file: --config, else $MATHESIS_CONFIG, else config.toml in the application directory (the checkout; gitignored, optional).
API keys (GEMINI_API_KEY, ...) come from the environment or from a `.env` file next to the config file (gitignored).
`mathesis config --init` writes a commented example (src/mathesis/config.example.toml).
"""
import os
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_ROOT = "/home/takeuchi/projects/obsidian-takvault/_study_roadmap"
DEFAULT_REPORTS = Path(tempfile.gettempdir()) / "mathesis-reports"
DEFAULT_USERSCRIPTS = Path(__file__).resolve().parents[2] / "userscript"  # the repo folder (source checkout)
DEFAULT_INSPECT_TOKEN = Path(__file__).resolve().parents[2] / ".mathesis-inspect-token"  # written by `serve --inspect`, read by `mathesis inspect`


def inspect_token_file() -> Path:
    return Path(os.environ.get("MATHESIS_INSPECT_TOKEN_FILE") or DEFAULT_INSPECT_TOKEN)


DEFAULT_CONFIG = Path(__file__).resolve().parents[2] / "config.toml"  # the application directory (source checkout)
EXAMPLE_CONFIG = Path(__file__).resolve().parent / "config.example.toml"

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai"  # Gemini's OpenAI-compatible endpoint

# Providers that exist without any config. "type" picks the client: ollama | openai (any OpenAI-compatible API) | claude-code
BUILTIN_PROVIDERS = {
    "ollama": {"type": "ollama"},
    "claude-code": {"type": "claude-code"},
    "gemini": {"type": "openai", "url": GEMINI_URL, "model": "gemini-3.8-flash", "key_required": True},
    "openai": {"type": "openai", "url": "https://api.openai.com/v1", "key_required": True},
    "openrouter": {"type": "openai", "url": "https://openrouter.ai/api/v1", "key_required": True},   # one key, many vendors' models
}
PROVIDER_TYPES = ("ollama", "openai", "claude-code")

KNOWN_KEYS = {
    "server": {"host", "port", "root", "userscript_dir", "report_dir", "notify", "notify_on_save",
               "obsidian_open", "obsidian_command", "editor_command"},
    "summary": {"enabled", "provider", "model", "pipeline", "max_revisions"},
    "lab_guide": {"enabled", "provider", "model", "check_commands"},
}


def api_key_env(provider: str) -> str:
    """The environment variable that holds a provider's API key: GEMINI_API_KEY, OPENAI_API_KEY, <NAME>_API_KEY.
    Keys are never read from the config file, so the file can be shared or committed safely."""
    return provider.upper().replace("-", "_") + "_API_KEY"


class ConfigError(ValueError):
    """The configuration is wrong; the message says what to fix."""


def find_config(explicit: str | Path | None = None) -> Path | None:
    """The config file in use: an explicit one must exist; the default location is optional."""
    chosen = explicit or os.environ.get("MATHESIS_CONFIG")
    if chosen:
        path = Path(chosen).expanduser()
        if not path.is_file():
            raise ConfigError(f"config file not found: {path}")
        return path.resolve()
    return DEFAULT_CONFIG if DEFAULT_CONFIG.is_file() else None


def load_dotenv(path: Path) -> list[str]:
    """Put KEY=VALUE lines of a .env file into the environment (variables already set win). Returns the names loaded."""
    loaded = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return loaded
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.removeprefix("export ").partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        if key and key not in os.environ:
            os.environ[key] = value
            loaded.append(key)
    return loaded


def read_config(path: Path) -> dict:
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"cannot read {path}: {e}")
    for section, value in raw.items():
        if section == "providers":
            continue
        if section == "provider":
            if not isinstance(value, str):
                raise ConfigError(f"{path}: provider must be a name, e.g. provider = \"gemini\"")
            continue
        if section == "llm":
            if not isinstance(value, bool):
                raise ConfigError(f"{path}: llm must be true or false, e.g. llm = false")
            continue
        if section not in KNOWN_KEYS or not isinstance(value, dict):
            raise ConfigError(f"{path}: unknown section [{section}] (known: {', '.join(KNOWN_KEYS)}, providers.<name>)")
        unknown = set(value) - KNOWN_KEYS[section]
        if unknown:
            raise ConfigError(f"{path}: unknown key(s) in [{section}]: {', '.join(sorted(unknown))} "
                              f"(known: {', '.join(sorted(KNOWN_KEYS[section]))})")
    if not isinstance(raw.get("providers", {}), dict) or not all(isinstance(t, dict) for t in raw.get("providers", {}).values()):
        raise ConfigError(f"{path}: [providers.<name>] must be tables")
    return raw


def _flag_text(value: str) -> bool:
    return value.strip().lower() not in ("0", "false", "no", "off", "")


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 5000
    root: Path = Path(DEFAULT_ROOT)        # only files inside this folder may be written
    userscript_dir: Path = DEFAULT_USERSCRIPTS  # *.user.js served at /userscript/<name> (install / update URL)
    report_dir: Path = DEFAULT_REPORTS     # error reports uploaded by the userscripts (temporary on purpose)
    ollama_url: str = "http://172.17.0.1:11434"
    model: str = "gemma4:12b"              # the Ollama model (every stage of the pipeline)
    embed_model: str = "bge-m3:latest"     # finds which lesson a quiz question comes from (always Ollama)
    num_ctx: int = 16384                   # Ollama's default (2048) would silently truncate transcripts
    llm: bool = True                       # False: no LLM feature at all (summaries, lab guides); files are only saved
    summarize: bool = True
    notify: bool = True
    notify_on_save: bool = False           # also notify when the raw transcript is saved
    pipeline: str = "two-stage"            # "two-stage" or "single"
    max_revisions: int = 2
    lab_guide: bool = True                 # labs also get <lesson>-lab-guide.md (gcloud / terraform)
    lab_check_commands: bool = False       # Claude Code may read `gcloud ... --help` (nothing else) before it writes a lab guide
    claude_command: str = "claude"         # the Claude Code CLI, run headless (claude -p)
    claude_model: str | None = None        # --model for it (unset: Claude Code's default)
    claude_timeout: int = 900              # seconds
    obsidian_open: bool = True             # "Summary ready" notification opens the summary in Obsidian when clicked
    obsidian_command: str | None = None    # command that hands an obsidian:// URI to Obsidian (auto-detected if unset)
    editor_command: str | None = None      # text editor used instead when Obsidian is not installed (auto-detected if unset)
    default_provider: str | None = None    # the one provider for every job; [summary] / [lab_guide] override it
    summary_provider: str = "ollama"       # resolved: ollama | gemini | openai | <name in [providers.*]> | none
    summary_model: str | None = None       # overrides the provider's model for summaries
    lab_provider: str = "claude-code"      # resolved, same choices; "none" = no lab guides
    lab_model: str | None = None           # overrides the provider's model for lab guides
    providers: dict = field(default_factory=dict)  # [providers.<name>] tables from the config file (not ollama / claude-code)
    configured_providers: tuple = ()       # names of every [providers.<name>] table in the file that sets something
    config_path: Path | None = None        # the config file in use
    inspect: bool = False                  # `serve --inspect`: pages can be shared with an AI for debugging (never from the config file)

    @property
    def summary_enabled(self) -> bool:
        return self.llm and self.summarize and self.summary_provider != "none"

    @property
    def lab_guide_enabled(self) -> bool:
        return self.llm and self.lab_guide and self.lab_provider != "none"

    def provider_spec(self, name: str, model: str | None = None) -> dict:
        """Everything needed to build the client of provider `name` (built-in defaults < settings < config tables)."""
        spec = dict(BUILTIN_PROVIDERS.get(name, {}))
        spec.update(self.providers.get(name, {}))
        for gone in ("api_key", "api_key_env"):
            if gone in spec:
                raise ConfigError(f"[providers.{name}] {gone} is not a setting any more: export the key as "
                                  f"{api_key_env(name)} in the environment of the server")
        kind = spec.get("type")
        if kind not in PROVIDER_TYPES:
            raise ConfigError(f"provider {name!r} is not defined: use ollama, claude-code, gemini, openai or add "
                              f"[providers.{name}] with type = \"openai\" | \"ollama\" | \"claude-code\"")
        if kind == "ollama":
            spec.setdefault("url", self.ollama_url)
            spec.setdefault("model", self.model)
            spec.setdefault("num_ctx", self.num_ctx)
        elif kind == "claude-code":
            spec.setdefault("command", self.claude_command)
            spec.setdefault("model", self.claude_model)
            spec.setdefault("timeout", self.claude_timeout)
        elif not spec.get("url"):
            raise ConfigError(f"provider {name!r} needs a url")
        else:
            spec["api_key_env"] = api_key_env(name)
        if model:
            spec["model"] = model
        spec["name"] = name
        return spec

    def unused_providers(self) -> list[str]:
        """Providers the file configures that neither summaries nor lab guides use (a forgotten `provider = ...` line)."""
        if not self.llm:  # no LLM at all: the providers in the file are simply parked
            return []
        return sorted(set(self.configured_providers) - {self.summary_provider, self.lab_provider})

    def validate(self) -> "Settings":
        if self.inspect and self.host not in ("127.0.0.1", "localhost", "::1"):
            raise ConfigError("--inspect shows page contents to whoever holds the token: it only runs on a loopback host (127.0.0.1)")
        if not self.llm:  # nothing will call a provider, so a missing key or a typo in one does not matter
            return self
        for provider in {self.default_provider, self.summary_provider, self.lab_provider} - {None, "none"}:
            self.provider_spec(provider)
        return self

    @classmethod
    def from_env(cls, config: str | Path | None = None) -> "Settings":
        path = find_config(config)
        load_dotenv((path.parent if path else DEFAULT_CONFIG.parent) / ".env")  # keys; before anything reads the environment
        raw = read_config(path) if path else {}
        server, summary, lab = raw.get("server", {}), raw.get("summary", {}), raw.get("lab_guide", {})
        tables = dict(raw.get("providers", {}))
        ollama, claude = tables.pop("ollama", {}), tables.pop("claude-code", {})
        e = os.environ.get
        default = e("MATHESIS_PROVIDER") or raw.get("provider") or None

        def pick(env, value, default, conv=lambda v: v):
            """environment variable, else config file value, else default"""
            if e(env) is not None:
                return conv(e(env))
            return default if value is None else conv(value)

        def flag(env, value, default):
            if value is not None and not isinstance(value, bool):
                raise ConfigError(f"{path}: {env.removeprefix('MATHESIS_').lower()} must be true or false, got {value!r}")
            return pick(env, value, default, lambda v: _flag_text(v) if isinstance(v, str) else v)

        folder = lambda v: Path(v).expanduser().resolve()
        return cls(
            host=pick("MATHESIS_HOST", server.get("host"), cls.host),
            port=pick("MATHESIS_PORT", server.get("port"), cls.port, int),
            root=pick("MATHESIS_ROOT", server.get("root"), Path(DEFAULT_ROOT), folder),
            userscript_dir=pick("MATHESIS_USERSCRIPT_DIR", server.get("userscript_dir"), DEFAULT_USERSCRIPTS, folder),
            report_dir=pick("MATHESIS_REPORT_DIR", server.get("report_dir"), DEFAULT_REPORTS, folder),
            ollama_url=pick("MATHESIS_OLLAMA_URL", ollama.get("url"), cls.ollama_url, lambda v: str(v).rstrip("/")),
            model=pick("MATHESIS_MODEL", ollama.get("model"), cls.model),
            embed_model=pick("MATHESIS_EMBED_MODEL", ollama.get("embed_model"), cls.embed_model),
            num_ctx=pick("MATHESIS_NUM_CTX", ollama.get("num_ctx"), cls.num_ctx, int),
            llm=flag("MATHESIS_LLM", raw.get("llm"), True),
            summarize=flag("MATHESIS_SUMMARIZE", summary.get("enabled"), True),
            notify=flag("MATHESIS_NOTIFY", server.get("notify"), True),
            notify_on_save=flag("MATHESIS_NOTIFY_ON_SAVE", server.get("notify_on_save"), False),
            pipeline=pick("MATHESIS_PIPELINE", summary.get("pipeline"), cls.pipeline),
            max_revisions=pick("MATHESIS_MAX_REVISIONS", summary.get("max_revisions"), cls.max_revisions, int),
            lab_guide=flag("MATHESIS_LAB_GUIDE", lab.get("enabled"), True),
            lab_check_commands=flag("MATHESIS_LAB_CHECK", lab.get("check_commands"), False),
            claude_command=pick("MATHESIS_CLAUDE", claude.get("command"), cls.claude_command),
            claude_model=pick("MATHESIS_CLAUDE_MODEL", claude.get("model"), None) or None,
            claude_timeout=pick("MATHESIS_CLAUDE_TIMEOUT", claude.get("timeout"), cls.claude_timeout, int),
            obsidian_open=flag("MATHESIS_OBSIDIAN_OPEN", server.get("obsidian_open"), True),
            obsidian_command=pick("MATHESIS_OBSIDIAN", server.get("obsidian_command"), None) or None,
            editor_command=pick("MATHESIS_EDITOR", server.get("editor_command"), None) or None,
            default_provider=default,
            # a job's own provider, else the one default provider; with neither, the built-in choice per job
            summary_provider=e("MATHESIS_SUMMARY_PROVIDER") or summary.get("provider") or default or cls.summary_provider,
            summary_model=summary.get("model") or None,
            lab_provider=e("MATHESIS_LAB_PROVIDER") or lab.get("provider") or default or cls.lab_provider,
            lab_model=lab.get("model") or None,
            providers=tables,
            configured_providers=tuple(n for n, t in raw.get("providers", {}).items() if t),
            config_path=path,
            inspect=_flag_text(e("MATHESIS_INSPECT", "")),
        ).validate()
