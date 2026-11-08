"""Error reports: when a save fails, the userscript uploads the page HTML and the failure details here, so the
problem can be inspected later through the API (GET /reports, /reports/<id>, /reports/<id>/html, /reports/<id>/body).

One folder per report in a temporary directory:  <id>/report.json, page.html, body.txt.  Only the newest MAX_REPORTS are kept.
"""
import json
import re
import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path

MAX_REPORTS = 50
ID_PATTERN = re.compile(r"\d{8}-\d{6}-[0-9a-f]{4}")
FILES = {"html": "page.html", "body": "body.txt"}
FIELDS = ("site", "url", "title", "kind", "path", "status", "error", "userAgent", "scriptVersion")


class ReportStore:
    def __init__(self, directory: Path):
        self.directory = directory

    def create(self, data: dict) -> str:
        now = datetime.now(timezone.utc)
        report_id = f"{now:%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
        folder = self.directory / report_id
        folder.mkdir(parents=True, exist_ok=True)
        html, body = str(data.get("html") or ""), str(data.get("body") or "")
        (folder / FILES["html"]).write_text(html, encoding="utf-8")
        (folder / FILES["body"]).write_text(body, encoding="utf-8")
        meta = {"id": report_id, "createdAt": now.isoformat(timespec="seconds"),
                **{k: data.get(k) for k in FIELDS},
                "htmlBytes": len(html.encode("utf-8")), "bodyBytes": len(body.encode("utf-8"))}
        (folder / "report.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        self._prune()
        return report_id

    def ids(self) -> list[str]:
        if not self.directory.is_dir():
            return []
        return sorted((p.name for p in self.directory.iterdir() if ID_PATTERN.fullmatch(p.name) and p.is_dir()), reverse=True)

    def list(self) -> list[dict]:
        return [m for m in (self.get(i) for i in self.ids()) if m]

    def get(self, report_id: str) -> dict | None:
        if not ID_PATTERN.fullmatch(report_id):
            return None
        try:
            return json.loads((self.directory / report_id / "report.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def text(self, report_id: str, which: str) -> str | None:
        if which not in FILES or not ID_PATTERN.fullmatch(report_id):
            return None
        try:
            return (self.directory / report_id / FILES[which]).read_text(encoding="utf-8")
        except OSError:
            return None

    def _prune(self) -> None:
        for old in self.ids()[MAX_REPORTS:]:
            shutil.rmtree(self.directory / old, ignore_errors=True)
