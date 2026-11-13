"""Settings: built-in defaults < config file (TOML) < MATHESIS_* environment variables < command-line flags.

Config file: --config, else $MATHESIS_CONFIG, else config.toml in the application directory (the checkout; gitignored, optional).
`mathesis config --init` writes a commented example (src/mathesis/config.example.toml).
"""
import os
import stat
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_ROOT = "/home/takeuchi/projects/obsidian-takvault/_study_roadmap"
DEFAULT_REPORTS = Path(tempfile.gettempdir()) / "mathesis-reports"
DEFAULT_USERSCRIPTS = Path(__file__).resolve().parents[2] / "userscript"  # the repo folder (source checkout)
DEFAULT_CONFIG = Path(__file__).resolve().parents[2] / "config.toml"  # the application directory (source checkout)
EXAMPLE_CONFIG = Path(__file__).resolve().parent / "config.example.toml"

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai"  # Gemini's OpenAI-compatible endpoint

# Providers that exist without any config. "type" picks the client: ollama | openai (any OpenAI-compatible API) | claude-code
BUILTIN_PROVIDERS = {
    "ollama": {"type": "ollama"},
    "claude-code": {"type": "claude-code"},
    "gemini": {"type": "openai", "url": GEMINI_URL, "api_key_env": "GEMINI_API_KEY", "model": "gemini-2.5-flash"},
    "openai": {"type": "openai", "url": "https://api.openai.com/v1", "api_key_env": "OPENAI_API_KEY"},
}
PROVIDER_TYPES = ("ollama", "openai", "claude-code")

KNOWN_KEYS = {
    "server": {"host", "port", "root", "userscript_dir", "report_dir", "notify", "notify_on_save",
               "obsidian_open", "obsidian_command"},
    "summary": {"enabled", "provider", "model", "pipeline", "max_revisions"},
    "lab_guide": {"enabled", "provider", "model"},
}


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


def read_config(path: Path) -> dict:
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"cannot read {path}: {e}")
    for section, value in raw.items():
        if section == "providers":
            continue
        if section not in KNOWN_KEYS or not isinstance(value, dict):
            raise ConfigError(f"{path}: unknown section [{section}] (known: {', '.join(KNOWN_KEYS)}, providers.<name>)")
        unknown = set(value) - KNOWN_KEYS[section]
        if unknown:
            raise ConfigError(f"{path}: unknown key(s) in [{section}]: {', '.join(sorted(unknown))} "
                              f"(known: {', '.join(sorted(KNOWN_KEYS[section]))})")
    if not isinstance(raw.get("providers", {}), dict) or not all(isinstance(t, dict) for t in raw.get("providers", {}).values()):
        raise ConfigError(f"{path}: [providers.<name>] must be tables")
    if any("api_key" in t for t in raw.get("providers", {}).values()) and path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        print(f"warning: {path} holds an api_key and is readable by other users (chmod 600 it, or use api_key_env)")
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
    summarize: bool = True
    notify: bool = True
    notify_on_save: bool = False           # also notify when the raw transcript is saved
    pipeline: str = "two-stage"            # "two-stage" or "single"
    max_revisions: int = 2
    lab_guide: bool = True                 # labs also get <lesson>-lab-guide.md (gcloud / terraform)
    claude_command: str = "claude"         # the Claude Code CLI, run headless (claude -p)
    claude_model: str | None = None        # --model for it (unset: Claude Code's default)
    claude_timeout: int = 900              # seconds
    obsidian_open: bool = True             # "Summary ready" notification opens the summary in Obsidian when clicked
    obsidian_command: str | None = None    # command that hands an obsidian:// URI to Obsidian (auto-detected if unset)
    summary_provider: str = "ollama"       # ollama | gemini | openai | <name in [providers.*]> | none
    summary_model: str | None = None       # overrides the provider's model for summaries
    lab_provider: str = "claude-code"      # same choices; "none" = no lab guides
    lab_model: str | None = None           # overrides the provider's model for lab guides
    providers: dict = field(default_factory=dict)  # [providers.<name>] tables from the config file (not ollama / claude-code)
    config_path: Path | None = None        # the config file in use

    @property
    def summary_enabled(self) -> bool:
        return self.summarize and self.summary_provider != "none"

    @property
    def lab_guide_enabled(self) -> bool:
        return self.lab_guide and self.lab_provider != "none"

    def provider_spec(self, name: str, model: str | None = None) -> dict:
        """Everything needed to build the client of provider `name` (built-in defaults < settings < config tables)."""
        spec = dict(BUILTIN_PROVIDERS.get(name, {}))
        spec.update(self.providers.get(name, {}))
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
        if model:
            spec["model"] = model
        spec["name"] = name
        return spec

    def validate(self) -> "Settings":
        for provider in {self.summary_provider, self.lab_provider} - {"none"}:
            self.provider_spec(provider)
        return self

    @classmethod
    def from_env(cls, config: str | Path | None = None) -> "Settings":
        path = find_config(config)
        raw = read_config(path) if path else {}
        server, summary, lab = raw.get("server", {}), raw.get("summary", {}), raw.get("lab_guide", {})
        tables = dict(raw.get("providers", {}))
        ollama, claude = tables.pop("ollama", {}), tables.pop("claude-code", {})
        e = os.environ.get

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
            summarize=flag("MATHESIS_SUMMARIZE", summary.get("enabled"), True),
            notify=flag("MATHESIS_NOTIFY", server.get("notify"), True),
            notify_on_save=flag("MATHESIS_NOTIFY_ON_SAVE", server.get("notify_on_save"), False),
            pipeline=pick("MATHESIS_PIPELINE", summary.get("pipeline"), cls.pipeline),
            max_revisions=pick("MATHESIS_MAX_REVISIONS", summary.get("max_revisions"), cls.max_revisions, int),
            lab_guide=flag("MATHESIS_LAB_GUIDE", lab.get("enabled"), True),
            claude_command=pick("MATHESIS_CLAUDE", claude.get("command"), cls.claude_command),
            claude_model=pick("MATHESIS_CLAUDE_MODEL", claude.get("model"), None) or None,
            claude_timeout=pick("MATHESIS_CLAUDE_TIMEOUT", claude.get("timeout"), cls.claude_timeout, int),
            obsidian_open=flag("MATHESIS_OBSIDIAN_OPEN", server.get("obsidian_open"), True),
            obsidian_command=pick("MATHESIS_OBSIDIAN", server.get("obsidian_command"), None) or None,
            summary_provider=pick("MATHESIS_SUMMARY_PROVIDER", summary.get("provider"), cls.summary_provider),
            summary_model=summary.get("model") or None,
            lab_provider=pick("MATHESIS_LAB_PROVIDER", lab.get("provider"), cls.lab_provider),
            lab_model=lab.get("model") or None,
            providers=tables,
            config_path=path,
        ).validate()
