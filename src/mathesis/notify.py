"""Desktop notifications through notify-send; never raises."""
import subprocess


def notify(title: str, body: str = "", error: bool = False, enabled: bool = True) -> None:
    print(f"[notify] {title}: {body}")
    if not enabled:
        return
    try:
        subprocess.run(
            ["notify-send", "-a", "Mathesis", "-u", "critical" if error else "normal",
             "-i", "dialog-error" if error else "document-save", title, body],
            timeout=5, check=False,
        )
    except Exception as e:  # notify-send missing, no D-Bus session, ...
        print(f"notification failed: {e}")
