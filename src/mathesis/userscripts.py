"""The userscripts of this checkout: header parsing and the install page served at /userscript."""
import re
from dataclasses import dataclass, field
from html import escape
from pathlib import Path


@dataclass
class Script:
    file: str
    name: str = ""
    version: str = ""
    description: str = ""
    matches: list[str] = field(default_factory=list)


def parse_header(file: Path) -> Script:
    """Reads the // ==UserScript== block (only the fields the page shows)."""
    script = Script(file=file.name, name=file.name)
    text = file.read_text(encoding="utf-8")
    block = re.search(r"// ==UserScript==(.*?)// ==/UserScript==", text, re.S)
    for key, value in re.findall(r"//\s*@(\S+)[ \t]+(.+)", block.group(1) if block else ""):
        if key == "name":
            script.name = value.strip()
        elif key == "version":
            script.version = value.strip()
        elif key == "description":
            script.description = value.strip()
        elif key == "match":
            script.matches.append(value.strip())
    return script


def list_scripts(directory: Path) -> list[Script]:
    return [parse_header(f) for f in sorted(directory.glob("*.user.js"))] if directory.is_dir() else []


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mathesis userscripts</title>
<style>
  :root {{ --bg:#fff; --fg:#1f2328; --muted:#59636e; --card:#f6f8fa; --line:#d1d9e0; --accent:#0969da; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --card:#151b23; --line:#30363d; --accent:#4493f8; }} }}
  body {{ font:16px/1.5 system-ui,sans-serif; background:var(--bg); color:var(--fg); max-width:42rem; margin:2rem auto; padding:0 1rem; }}
  .script {{ background:var(--card); border:1px solid var(--line); border-radius:8px; padding:1rem 1.25rem; margin:1rem 0; }}
  h1 {{ font-size:1.4rem; }} h2 {{ font-size:1.1rem; margin:0 0 .25rem; }}
  .muted {{ color:var(--muted); font-size:.9rem; }} code {{ font-size:.85rem; }}
  a.install {{ display:inline-block; margin-top:.5rem; padding:.4rem .9rem; background:var(--accent); color:#fff; border-radius:6px; text-decoration:none; }}
</style></head><body>
<h1>Mathesis userscripts</h1>
<p class="muted">Click <b>Install</b>: Violentmonkey (or Tampermonkey) opens its install dialog. Installed copies check this server for updates.</p>
{items}
</body></html>
"""

ITEM = """<div class="script"><h2>{name}</h2>
<div class="muted">version <code>{version}</code> · <code>{file}</code></div>
<p>{description}</p>
<div class="muted">Runs on: {matches}</div>
<a class="install" href="{url}">Install</a></div>"""


def render_page(scripts: list[Script], base_url: str) -> str:
    items = "\n".join(
        ITEM.format(
            name=escape(s.name), version=escape(s.version or "?"), file=escape(s.file),
            description=escape(s.description), url=escape(f"{base_url}/userscript/{s.file}"),
            matches=", ".join(f"<code>{escape(m)}</code>" for m in s.matches) or "any page")
        for s in scripts) or "<p>No userscripts found.</p>"
    return PAGE.format(items=items)
