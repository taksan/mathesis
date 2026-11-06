"""Open a file in the running Obsidian through its obsidian:// URI."""
import glob
import re
import shlex
import shutil
import subprocess
import urllib.parse
from pathlib import Path

APPIMAGE_DIRS = ["~/bin", "~/Applications", "~/.local/bin", "~/Downloads"]


def uri_for(path: str | Path) -> str:
    """obsidian://open?path=<absolute path>: needs no vault name; the file must be inside a known vault."""
    return "obsidian://open?path=" + urllib.parse.quote(str(Path(path).resolve()), safe="")


def find_command(configured: str | None = None) -> list[str] | None:
    """The command that hands a URI to Obsidian, or None.

    1. MATHESIS_OBSIDIAN (may contain arguments)
    2. an Obsidian*.AppImage in the usual places (a plain `obsidian` launcher script often drops arguments)
    3. xdg-open, but only if an obsidian:// handler is registered
    """
    if configured:
        return shlex.split(configured)
    for d in APPIMAGE_DIRS:
        found = glob.glob(str(Path(d).expanduser() / "Obsidian*.AppImage"))
        if found:  # newest version wins: compare 1.15.0 > 1.2.0 numerically, not as text
            return [max(found, key=lambda f: [int(n) for n in re.findall(r"\d+", Path(f).name)])]
    if shutil.which("xdg-open") and shutil.which("xdg-mime"):
        handler = subprocess.run(["xdg-mime", "query", "default", "x-scheme-handler/obsidian"],
                                 capture_output=True, text=True).stdout.strip()
        if handler:
            return ["xdg-open"]
    return None


def open_in_obsidian(path: str | Path, configured: str | None = None) -> bool:
    """Ask the running Obsidian to open `path`. Returns False if no way to reach Obsidian was found."""
    command = find_command(configured)
    if not command:
        print("Obsidian command not found: set MATHESIS_OBSIDIAN to the Obsidian AppImage path")
        return False
    subprocess.Popen(command + [uri_for(path)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    return True
