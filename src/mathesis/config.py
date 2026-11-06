"""Settings, read from MATHESIS_* environment variables (the CLI flags set these too)."""
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ROOT = "/home/takeuchi/projects/obsidian-takvault/_study_roadmap/Google Skills"


def _flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() not in ("0", "false", "no", "off", "")


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 5000
    root: Path = Path(DEFAULT_ROOT)        # only files inside this folder may be written
    ollama_url: str = "http://172.17.0.1:11434"
    model: str = "gemma4:12b"              # used for every stage of the pipeline
    num_ctx: int = 16384                   # Ollama's default (2048) would silently truncate transcripts
    summarize: bool = True
    notify: bool = True
    notify_on_save: bool = False           # also notify when the raw transcript is saved
    pipeline: str = "two-stage"            # "two-stage" or "single"
    max_revisions: int = 2

    @classmethod
    def from_env(cls) -> "Settings":
        e = os.environ.get
        return cls(
            host=e("MATHESIS_HOST", cls.host),
            port=int(e("MATHESIS_PORT", cls.port)),
            root=Path(e("MATHESIS_ROOT", DEFAULT_ROOT)).expanduser().resolve(),
            ollama_url=e("MATHESIS_OLLAMA_URL", cls.ollama_url).rstrip("/"),
            model=e("MATHESIS_MODEL", cls.model),
            num_ctx=int(e("MATHESIS_NUM_CTX", cls.num_ctx)),
            summarize=_flag("MATHESIS_SUMMARIZE", True),
            notify=_flag("MATHESIS_NOTIFY", True),
            notify_on_save=_flag("MATHESIS_NOTIFY_ON_SAVE", False),
            pipeline=e("MATHESIS_PIPELINE", cls.pipeline),
            max_revisions=int(e("MATHESIS_MAX_REVISIONS", cls.max_revisions)),
        )
