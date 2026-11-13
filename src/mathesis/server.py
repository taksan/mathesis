"""HTTP API used by the userscript.

POST /write   Header X-File-Path: .md file path relative to MATHESIS_ROOT; body: the content (UTF-8)
              Header X-Mathesis-Kind: "transcript" (default, gets a summary); "bundle" (body = the lesson iframe URL; the server
              fetches the lesson, converts it to Markdown, saves it and summarizes it); "lab" (lab instructions: summarized like a transcript, and Claude Code also writes <lesson>-lab-guide.md with gcloud/terraform steps); "raw" (whole page HTML, .html path) and any other kind ("quiz", "quiz-review") are saved as is
GET  /status  Header X-File-Path: -> {"exists": bool, "summary_exists": bool, "obsidian_uri": str | null}
              (obsidian_uri opens the summary if there is one, else the file; null when the file does not exist)
POST /reports  JSON {url, title, kind, path, status, error, html, body, ...} -> {"id"}: an error report the userscript uploads when a save fails
GET  /reports  list of reports (newest first); /reports/<id> one report's details; /reports/<id>/html the page; /reports/<id>/body what was sent
GET  /userscript/<name>.user.js  the userscripts of this checkout (install / @updateURL target); /userscript is a page listing them with Install links
"""
import json
import os
import re
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import unquote

from fastapi import BackgroundTasks, FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from . import bundle
from .config import Settings
from .labguide import write_lab_guide
from .notify import notify
from .llm import make_client
from .obsidian import uri_for
from .reports import ReportStore
from .pipeline import summary_path, write_summary
from .userscripts import list_scripts, render_page


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status, self.message = status, message


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        from .version import describe
        version = describe()
        if version != os.environ.get("MATHESIS_VERSION_SHOWN"):  # `uvicorn mathesis.server:app` directly, or a code reload
            print(version, flush=True)
        print(f"Mathesis listening on http://{settings.host}:{settings.port}  (writing under {settings.root})")
        if settings.config_path:
            print(f"config: {settings.config_path}")
        for name in settings.unused_providers():
            print(f"WARNING: [providers.{name}] is set in the config but is not the default provider nor a job's "
                  f"override, so it is not used (provider = \"{name}\" at the top of the file selects it)")
        complained = set()
        for role, enabled, what in [("summary", settings.summary_enabled, "Summaries"),
                                    ("lab_guide", settings.lab_guide_enabled, "Lab guides")]:
            if not enabled:
                print(f"{what}: off")
                continue
            client = make_client(settings, role)
            ok, message = await run_in_threadpool(client.check)
            print(f"{what} ({client.label}): " + (message if ok else
                  f"WARNING: {message}. Lessons are still saved; {what.lower()} are skipped until it is reachable."))
            if not ok and message not in complained:  # one notification per distinct problem, not one per job
                complained.add(message)
                notify("Mathesis: provider not usable", message, error=True, enabled=settings.notify)
        yield

    app = FastAPI(title="Mathesis", lifespan=lifespan)
    app.state.settings = settings
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-File-Path", "X-Mathesis-Kind"],
        allow_private_network=True,  # Chrome's Private Network Access preflight (public site -> 127.0.0.1)
    )

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        return JSONResponse({"error": exc.message}, status_code=exc.status)

    def target_path(raw_path: str | None) -> Path:
        """X-File-Path is relative to the configured root ("Google Skills/Path/Course/01-Lesson.md")."""
        if not raw_path:
            raise ApiError(400, "missing X-File-Path header")
        raw_path = unquote(raw_path)  # userscripts send it percent-encoded: titles may hold non-ASCII characters
        if Path(raw_path).is_absolute() or raw_path.startswith(("/", "\\")):
            raise ApiError(400, "X-File-Path must be relative to the Mathesis root (update the userscript)")
        target = (settings.root / raw_path).resolve()
        if settings.root not in target.parents:
            raise ApiError(403, "path escapes the Mathesis root")
        return target

    reports = ReportStore(settings.report_dir)

    @app.post("/reports")
    async def create_report(request: Request):
        try:
            data = json.loads((await request.body()).decode("utf-8", "replace"))
        except ValueError:
            raise ApiError(400, "the report must be JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "the report must be a JSON object")
        report_id = await run_in_threadpool(reports.create, data)
        print(f"error report {report_id}: {data.get('kind')} {data.get('path')} -> {data.get('error')}")
        return {"id": report_id}

    @app.get("/reports")
    def list_reports():
        return {"reports": reports.list()}

    @app.get("/reports/{report_id}")
    def get_report(report_id: str):
        meta = reports.get(report_id)
        if meta is None:
            raise ApiError(404, f"no report {report_id}")
        return meta

    @app.get("/reports/{report_id}/{which}")
    def get_report_file(report_id: str, which: str):
        text = reports.text(report_id, which)
        if text is None:
            raise ApiError(404, f"no {which} for report {report_id}")
        return Response(text, media_type="text/plain; charset=utf-8")  # plain text: a saved page is never rendered

    @app.get("/userscript", response_class=HTMLResponse)
    def userscripts(request: Request):
        """Install page: every script of the checkout with an Install link."""
        return render_page(list_scripts(settings.userscript_dir), str(request.base_url).rstrip("/"))

    @app.get("/userscript.json")
    def userscripts_json():
        return {"scripts": [s.file for s in list_scripts(settings.userscript_dir)]}

    @app.get("/userscript/{name}")
    def userscript(name: str):
        """Read on every request, so a reinstall / update check always sees the current file."""
        file = settings.userscript_dir / name
        if not re.fullmatch(r"[\w.-]+\.user\.js", name) or not file.is_file():
            raise ApiError(404, f"no userscript named {name}")
        return Response(file.read_text(encoding="utf-8"), media_type="text/javascript; charset=utf-8",
                        headers={"Cache-Control": "no-cache"})

    @app.get("/status")
    def status(x_file_path: str | None = Header(None)):
        """Was this lesson already saved?"""
        target = target_path(x_file_path)
        exists, summary = target.is_file(), summary_path(target)
        return {"exists": exists, "summary_exists": summary.is_file(),
                "obsidian_uri": uri_for(summary if summary.is_file() else target) if exists else None}

    @app.post("/write")
    async def write(request: Request, background: BackgroundTasks, x_file_path: str | None = Header(None),
                    x_mathesis_kind: str | None = Header(None)):
        """X-Mathesis-Kind: "transcript" (default) is summarized; "quiz" is only saved."""
        target = target_path(x_file_path)
        kind = (x_mathesis_kind or "transcript").strip().lower()
        if kind == "raw" and target.suffix != ".html":
            raise ApiError(400, "raw saves must use an .html path")
        content = await request.body()
        if kind == "bundle":
            try:
                content = (await run_in_threadpool(bundle.markdown_for, content.decode("utf-8", "replace"))).encode("utf-8")
            except bundle.BundleError as e:
                notify("Lesson conversion failed", f"{target.name}: {e.message}", error=True, enabled=settings.notify)
                raise ApiError(e.status, e.message)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        except OSError as e:
            notify("Transcript save failed", f"{target.name}: {e}", error=True, enabled=settings.notify)
            raise ApiError(500, str(e))
        print(f"saved {kind} {len(content)} bytes -> {target}")
        if settings.notify_on_save:
            notify("Transcript saved", target.stem, enabled=settings.notify)
        if settings.summary_enabled and content.strip() and kind in ("transcript", "bundle", "lab"):
            background.add_task(write_summary, content.decode("utf-8", "replace"), str(target), settings)
        if settings.lab_guide_enabled and content.strip() and kind == "lab":  # own thread: the summary may take minutes
            threading.Thread(target=write_lab_guide, args=(content.decode("utf-8", "replace"), str(target), settings),
                             daemon=True).start()
        return {"status": "ok", "path": str(target.relative_to(settings.root)), "bytes": len(content), "kind": kind}

    return app


# `uvicorn mathesis.server:app` (used by `mathesis serve`, which needs an import string for --reload)
app = create_app()
