import os
import tempfile
from pathlib import Path

# server.py builds `app` at import time from the settings: never from the developer's own config.toml
_empty = Path(tempfile.mkdtemp(prefix="mathesis-test-config-")) / "config.toml"
_empty.write_text("")
os.environ["MATHESIS_CONFIG"] = str(_empty)
