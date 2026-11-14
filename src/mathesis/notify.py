"""Desktop notifications through notify-send; never raises."""
import subprocess
import threading
from typing import Callable

CLICK_TIMEOUT = 15 * 60  # how long we keep listening for a click on a notification


def notify(title: str, body: str = "", error: bool = False, enabled: bool = True,
           on_click: Callable[[], None] | None = None, action_label: str = "Open in Obsidian") -> threading.Thread | None:
    """Show a notification. With on_click, the notification gets an "Open in Obsidian"-style action: clicking
    the notification (or its button) calls on_click. notify-send blocks until the notification is closed when
    actions are used, so that wait happens on a background thread. Returns that thread, if any."""
    print(f"[notify] {title}: {body}")
    if not enabled:
        return None
    command = ["notify-send", "-a", "Mathesis", "-u", "critical" if error else "normal",
               "-i", "dialog-error" if error else "document-save"]
    if on_click:
        command += ["-A", "default=Open", "-A", f"open={action_label}"]
    try:
        proc = subprocess.Popen(command + [title, body], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    except Exception as e:  # notify-send missing, no D-Bus session, ...
        print(f"notification failed: {e}")
        return None

    def wait_for_action():
        try:
            out, _ = proc.communicate(timeout=CLICK_TIMEOUT if on_click else 10)
        except subprocess.TimeoutExpired:
            proc.kill()
            return
        except Exception as e:
            print(f"notification failed: {e}")
            return
        if on_click and out.strip() in ("default", "open"):
            try:
                on_click()
            except Exception as e:
                print(f"notification action failed: {e}")

    thread = threading.Thread(target=wait_for_action, daemon=True)
    thread.start()
    return thread
