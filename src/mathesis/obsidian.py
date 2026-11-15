"""Open a note: in the running Obsidian through its obsidian:// URI, or, when Obsidian is not installed, in a text editor."""
import glob
import re
import shlex
import shutil
import subprocess
import sys
import urllib.parse
from pathlib import Path

APPIMAGE_DIRS = ["~/bin", "~/Applications", "~/.local/bin", "~/Downloads"]
# graphical editors tried (in this order) when MATHESIS_EDITOR is not set; a terminal editor cannot be started by a server
GUI_EDITORS = ["gnome-text-editor", "gedit", "kate", "kwrite", "mousepad", "xed", "pluma", "geany", "codium", "code", "subl"]


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


def editor_command(configured: str | None = None) -> list[str] | None:
    """The command that opens a file in a text editor, or None.

    1. MATHESIS_EDITOR (may contain arguments, e.g. "code -r")
    2. macOS: `open -t` (the default text editor); Windows: notepad
    3. the first graphical editor found on PATH (GUI_EDITORS)
    4. xdg-open (whatever the desktop uses for the file type)
    """
    if configured:
        return shlex.split(configured)
    if sys.platform == "darwin":
        return ["open", "-t"]
    if sys.platform.startswith("win"):
        return ["notepad"]
    for name in GUI_EDITORS:
        if shutil.which(name):
            return [name]
    return ["xdg-open"] if shutil.which("xdg-open") else None


def open_in_editor(path: str | Path, configured: str | None = None) -> bool:
    command = editor_command(configured)
    if not command:
        print("No text editor found: set MATHESIS_EDITOR (or [server] editor_command) to a graphical editor")
        return False
    subprocess.Popen(command + [str(path)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    return True


def open_folder(path: str | Path) -> bool:
    """Show the file's folder in the system file manager (selecting the file where the platform allows it)."""
    path = Path(path)
    if sys.platform == "darwin":
        command = ["open", "-R", str(path)]
    elif sys.platform.startswith("win"):
        command = ["explorer", "/select," + str(path)]
    elif shutil.which("xdg-open"):
        command = ["xdg-open", str(path.parent)]
    else:
        print("No file manager found (xdg-open)")
        return False
    subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return True


def have_obsidian(settings) -> bool:
    return find_command(settings.obsidian_command) is not None


def opener_name(settings) -> str:
    """"Obsidian" when it can be reached, else "text editor": what a notification or button should say."""
    return "Obsidian" if have_obsidian(settings) else "text editor"


def open_note(path: str | Path, settings) -> str | None:
    """Open a note in Obsidian if it is installed, else in a text editor. Returns what was used, or None."""
    if have_obsidian(settings) and open_in_obsidian(path, settings.obsidian_command):
        return "Obsidian"
    if not have_obsidian(settings) and open_in_editor(path, settings.editor_command):
        return "text editor"
    return None
