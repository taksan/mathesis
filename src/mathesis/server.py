"""HTTP API used by the userscript.

POST /write   Header X-File-Path: .md file path relative to MATHESIS_ROOT; body: the content (UTF-8)
              Header X-Mathesis-Meta: percent-encoded JSON {"course", "author", "lesson", "url"} for the frontmatter (type and hash are the server's)
              Markdown files get YAML frontmatter (type, course, author, lesson, url, hash of the body). A file that already exists without
              frontmatter is not overwritten: the frontmatter is added and the rest is left as it is ("kept": true in the answer).
              A file whose body no longer matches the hash in its frontmatter (the person added notes) is not overwritten either:
              409 {"error", "code": "modified", "diff"} (what saving would change, a unified diff) unless the request has X-Mathesis-Overwrite: yes (replace it) or metadata (keep the
              text, only update the frontmatter: "metadata_only": true in the answer)
              409 {"code": "pending"} while a summary / lab guide of that file is still being written: nothing is saved or started
              Header X-Mathesis-Kind: "transcript" (default, gets a summary); "bundle" (body = the lesson iframe URL; the server
              fetches the lesson, converts it to Markdown, saves it and summarizes it); "lab" (lab instructions: summarized like a transcript, and Claude Code also writes <lesson>-lab-guide.md with gcloud/terraform steps); "raw" (whole page HTML, .html path) and any other kind ("quiz", "quiz-review", "quiz-all", "quiz-json") are saved as is
GET  /inspect/stream  (only with --inspect) SSE commands for a shared page; see pageinspect.py
GET  /status  Header X-File-Path: -> {"exists": bool, "modified": bool, "summary_exists": bool, "opener": "obsidian" | "editor", "obsidian_uri": str | null}
GET  /files   Header X-File-Path: the page's main file -> {"files": [{kind, label, state "ready"|"pending"|"failed", path, opener "obsidian"|"editor", obsidian_uri?, attempt?, error?}]}
              every document of the page: transcript, summary, lab guide (pending / failed while the background job runs), or for a quiz
              result the review attempts, "all questions" and its JSON
GET  /file    Header X-File-Path: one path from /files -> its text (plain). Browsers may only ask from udemy.com / skills.google pages.
POST /regenerate  Header X-File-Path: the lesson's main file; Header X-Mathesis-Kind: "summary" | "lab-guide" -> 202; the configured provider writes
              it again in the background and the old file is replaced only when the new one is ready (a failure keeps it and shows as
              "failed" with the file still listed). 409 when LLM features or that job are off, or it is already being written
POST /open    Header X-File-Path: one path from /files: opens it in a text editor on the server machine (the "editor" opener);
              with X-Mathesis-Open: folder it shows its folder in the file manager instead
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
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

from . import bundle, frontmatter
from .config import Settings
from .labguide import guide_path, write_lab_guide
from .notify import notify
from .llm import make_client
from .obsidian import editor_command, find_command, have_obsidian, open_folder, open_in_editor, uri_for
from .reports import ReportStore
from .pipeline import summary_path, write_summary
from . import pageinspect as inspect_mode
from .files import Jobs, page_files
from . import domains as exam_domains
from . import attempts as quiz_attempts
from .lessons import is_derived
from .userscripts import list_scripts, render_page


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None, **extra):
        self.status, self.message, self.code, self.extra = status, message, code, extra


PAGE_ORIGINS = re.compile(r"^https://([a-z0-9-]+\.)*(udemy\.com|skills\.google|cloudskillsboost\.google)$")   # the sites the userscripts run on


def _inspect_routes(app: FastAPI, settings: Settings) -> None:
    """Inspect mode (`serve --inspect`): see pageinspect.py. Only registered when the mode is on, so otherwise these paths are 404."""
    import hmac
    import secrets as _secrets
    from .config import inspect_token_file

    TOKEN_FILE = inspect_token_file()
    hub = inspect_mode.Hub()
    token = _secrets.token_urlsafe(32)
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.touch(mode=0o600)
    TOKEN_FILE.chmod(0o600)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    app.state.hub, app.state.inspect_token, app.state.inspect_token_file = hub, token, TOKEN_FILE

    def from_page(request: Request) -> None:
        """The page side: only the sites of the userscripts (a browser always sends the Origin of the page)."""
        origin = request.headers.get("origin")
        if origin is not None and not PAGE_ORIGINS.match(origin):
            raise ApiError(403, "not a page Mathesis serves")

    def from_control(request: Request, x_mathesis_inspect_token: str | None) -> None:
        """The control side: the token, and never from a web page (a page could otherwise read what other pages share)."""
        if request.headers.get("origin") is not None:
            raise ApiError(403, "the inspect API is not for web pages")
        if not x_mathesis_inspect_token or not hmac.compare_digest(x_mathesis_inspect_token, token):
            raise ApiError(401, f"missing or wrong token (the file {TOKEN_FILE} holds it)")

    def guarded(fn):
        try:
            return fn()
        except inspect_mode.InspectError as e:
            raise ApiError(e.status, e.message)

    @app.get("/inspect")
    def inspect_enabled(request: Request):
        from_page(request)
        return {"enabled": True}

    @app.post("/inspect/register")
    async def inspect_register(request: Request):
        from_page(request)
        data = json.loads((await request.body() or b"{}") or b"{}")
        page = guarded(lambda: hub.register(data.get("url", ""), data.get("title", "")))
        print(f"inspect: page {page.number} shared: {page.url}")
        return {"id": page.secret, "page": page.number}

    @app.get("/inspect/stream")
    async def inspect_stream(request: Request, id: str):
        """Server-Sent Events: each command for the page is one `data:` line (the page answers with POST /inspect/answer)."""
        from_page(request)
        if not hub.known(id):
            raise ApiError(404, "this page is not shared (any more)")
        return StreamingResponse(inspect_mode.events(hub, id, request.is_disconnected, run_in_threadpool), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/inspect/answer")
    async def inspect_answer(request: Request, id: str, command: str):
        from_page(request)
        body = await request.body()
        if len(body) > inspect_mode.MAX_RESULT:
            raise ApiError(413, "answer too large")
        try:
            result = json.loads(body or b"{}")
        except ValueError:
            raise ApiError(400, "answer is not JSON")
        guarded(lambda: hub.answer(id, command, result))
        return {"status": "ok"}

    @app.post("/inspect/close")
    def inspect_close(request: Request, id: str):
        from_page(request)
        hub.close(id)
        return {"status": "ok"}

    @app.get("/inspect/pages")
    def inspect_pages(request: Request, x_mathesis_inspect_token: str | None = Header(None)):
        from_control(request, x_mathesis_inspect_token)
        return {"pages": hub.listing()}

    @app.post("/inspect/call")
    async def inspect_call(request: Request, x_mathesis_inspect_token: str | None = Header(None)):
        """Body {"op", "args", "page"}: the page does the operation and its answer is returned."""
        from_control(request, x_mathesis_inspect_token)
        try:
            data = json.loads((await request.body()) or b"{}")
        except ValueError:
            raise ApiError(400, "the body must be JSON")
        args = data.get("args") if isinstance(data.get("args"), dict) else {}
        return await run_in_threadpool(lambda: guarded(lambda: hub.call(data.get("page"), str(data.get("op", "")), args)))


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        from .version import describe
        version = describe()
        if version != os.environ.get("MATHESIS_VERSION_SHOWN"):  # `uvicorn mathesis.server:app` directly, or a code reload
            print(version, flush=True)
        print(f"Mathesis listening on http://{settings.host}:{settings.port}  (writing under {settings.root})")
        if settings.inspect:
            print(f"INSPECT MODE: the AI button appears in the panel; a page you share can be read (read-only) with `mathesis inspect`. "
                  f"Token: {app.state.inspect_token_file}")
        if settings.config_path:
            print(f"config: {settings.config_path}")
        if find_command(settings.obsidian_command):
            print("notes open in: Obsidian")
        else:
            editor = editor_command(settings.editor_command)
            print("Obsidian not found: notes open in a text editor (" + (" ".join(editor) if editor else
                  "NONE found: set MATHESIS_EDITOR") + ")")
        for name in settings.unused_providers():
            print(f"WARNING: [providers.{name}] is set in the config but is not the default provider nor a job's "
                  f"override, so it is not used (provider = \"{name}\" at the top of the file selects it)")
        if not settings.llm:
            print("LLM features: off (no summaries, no lab guides, no provider is contacted); files are only saved")
        complained = set()
        for role, enabled, what in [("summary", settings.summary_enabled, "Summaries"),
                                    ("lab_guide", settings.lab_guide_enabled, "Lab guides"),
                                    ("domains", settings.domains_enabled, "Exam domains")]:
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
        allow_headers=["Content-Type", "X-File-Path", "X-Mathesis-Kind", "X-Mathesis-Meta", "X-Mathesis-Overwrite", "X-Mathesis-Open"],
        allow_private_network=True,  # Chrome's Private Network Access preflight (public site -> 127.0.0.1)
    )

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        return JSONResponse({"error": exc.message, **({"code": exc.code} if exc.code else {}), **exc.extra}, status_code=exc.status)

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
    if settings.inspect:
        _inspect_routes(app, settings)
    jobs = Jobs()
    app.state.jobs = jobs

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
        obsidian = have_obsidian(settings)
        modified = False
        if exists and target.suffix == ".md":
            try:
                modified = frontmatter.is_modified(target.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError):
                pass
        return {"exists": exists, "modified": modified, "summary_exists": summary.is_file(), "opener": "obsidian" if obsidian else "editor",
                "obsidian_uri": uri_for(summary if summary.is_file() else target) if exists and obsidian else None}

    def listing(target: Path) -> list[dict]:
        obsidian = have_obsidian(settings)
        files = page_files(target, settings.root, jobs, obsidian)
        for f in files:
            if f["path"]:
                f["abs_path"] = str(settings.root / f["path"])  # for "copy file path"
                if f["opener"] == "obsidian":
                    f["obsidian_uri"] = uri_for(settings.root / f["path"])
        return files

    @app.get("/files")
    def files(x_file_path: str | None = Header(None)):
        """Every document of the page whose main file is X-File-Path (see files.page_files)."""
        return {"files": listing(target_path(x_file_path)), "inspect": settings.inspect}   # inspect: the panel shows its AI button

    def listed_file(raw_path: str | None) -> Path:
        """The path of a file that GET /files lists for some page; anything else is refused."""
        target = target_path(raw_path)
        if not target.is_file():
            raise ApiError(404, "this file is not saved")
        main = target.with_name(re.sub(r"-(summary|lab-guide)\.md$", ".md", target.name))  # a summary belongs to its lesson
        if re.match(r"\d+-attempt \d+\.json$", target.name):                                  # an attempt, to its quiz
            main = quiz_attempts.quiz_file_for(target)
        if str(target.relative_to(settings.root)) not in {f["path"] for f in listing(main)}:
            raise ApiError(403, "not a file Mathesis wrote for a page")
        return target

    # Reading a note's text is more sensitive than listing names: only the sites the userscripts run on may do it from a browser
    # (any web page could otherwise ask for a note it can guess the path of). Requests without an Origin are not from a page.
    NOTE_ORIGINS = re.compile(r"^https://([a-z0-9-]+\.)*(udemy\.com|skills\.google|cloudskillsboost\.google)$")

    @app.get("/file")
    def read_file(request: Request, x_file_path: str | None = Header(None)):
        """The text of one file from GET /files (what "copy the content" puts on the clipboard)."""
        origin = request.headers.get("origin")
        if origin and not NOTE_ORIGINS.match(origin):
            raise ApiError(403, "this page may not read notes")
        target = listed_file(x_file_path)
        return Response(target.read_text(encoding="utf-8"), media_type="text/plain; charset=utf-8")

    @app.post("/open")
    def open_file(x_file_path: str | None = Header(None), x_mathesis_open: str | None = Header(None)):
        """Open one file from GET /files in a text editor on the server machine (what the Open button does for the editor
        opener). Only files of a page listing are opened, never an arbitrary path."""
        target = listed_file(x_file_path)
        if (x_mathesis_open or "").lower() == "folder":
            if not open_folder(target):
                raise ApiError(501, "no file manager found on the server machine (xdg-open)")
            return {"opened_with": "file manager", "path": str(target.relative_to(settings.root))}
        if not open_in_editor(target, settings.editor_command):
            raise ApiError(501, "no text editor found on the server machine: set MATHESIS_EDITOR")
        return {"opened_with": "text editor", "path": str(target.relative_to(settings.root))}

    FILE_TYPES = {"transcript": "transcript", "bundle": "lesson", "lab": "lab", "quiz": "quiz",
                  "quiz-review": "to-review", "quiz-all": "all-questions"}

    def page_meta(raw: str | None, kind: str, target: Path) -> dict[str, str]:
        """Frontmatter values: the type from the kind, course / lesson / url from X-Mathesis-Meta (percent-encoded JSON, sent
        by the userscript); without it the course is the folder name and there is no lesson or url."""
        sent = {}
        if raw:
            try:
                data = json.loads(unquote(raw))
                sent = {k: " ".join(str(data[k]).split())[:500] for k in ("course", "author", "lesson", "url") if isinstance(data, dict) and data.get(k)}
            except ValueError:
                pass  # not JSON: the file is still saved, with what the server can work out
        # no lesson name is invented: a file name such as "01-incorrect" is not the lesson. Missing keys can be filled in by a later save.
        return {"type": FILE_TYPES[kind], "course": sent.get("course") or target.parent.name,
                "author": sent.get("author", ""), "lesson": sent.get("lesson", ""), "url": sent.get("url", "")}

    def lab_page(target: Path) -> bool:
        """A lab: its frontmatter says type: lab (or a guide was already written for it)."""
        if guide_path(target).is_file():
            return True
        try:
            front, _ = frontmatter.split(target.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            return False
        return any(re.fullmatch(r'type\s*:\s*"?lab"?\s*', line) for line in front or [])

    def start_lab_guide(target: Path, text: str) -> None:
        jobs.start(target, "lab-guide")
        threading.Thread(target=jobs.run, args=(target, "lab-guide", guide_path(target), write_lab_guide, text, str(target), settings),
                         daemon=True).start()

    @app.post("/regenerate", status_code=202)
    def regenerate(background: BackgroundTasks, x_file_path: str | None = Header(None), x_mathesis_kind: str | None = Header(None)):
        """Write the summary or lab guide of a saved lesson again with the configured provider, replacing the file only when the
        new one is ready (a failure keeps the old one). X-File-Path: the lesson's main file; X-Mathesis-Kind: summary | lab-guide."""
        target = target_path(x_file_path)
        kind = (x_mathesis_kind or "").strip().lower()
        if kind not in ("summary", "lab-guide"):
            raise ApiError(400, "X-Mathesis-Kind must be summary or lab-guide")
        if target.suffix != ".md" or is_derived(target.name) or not target.is_file():
            raise ApiError(404, "this lesson is not saved")
        if not settings.llm:
            raise ApiError(409, "LLM features are off (llm = false): there is no provider to regenerate with", "llm-off")
        if not (settings.summary_enabled if kind == "summary" else settings.lab_guide_enabled):
            raise ApiError(409, f"no provider is set for {'summaries' if kind == 'summary' else 'lab guides'}", "disabled")
        if (jobs.get(target, kind) or {}).get("state") == "pending":
            raise ApiError(409, "it is already being written", "pending")
        try:
            text = frontmatter.strip(target.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError) as e:
            raise ApiError(500, f"cannot read the lesson: {e}")
        if not text.strip():
            raise ApiError(409, "the saved lesson is empty")
        if kind == "summary":
            jobs.start(target, "summary")
            background.add_task(jobs.run, target, "summary", summary_path(target), write_summary, text, str(target), settings)
        else:
            if not lab_page(target):
                raise ApiError(409, "only lab pages have a lab guide")
            start_lab_guide(target, text)
        return {"status": "started", "kind": kind, "path": str(target.relative_to(settings.root))}

    @app.post("/write")
    async def write(request: Request, background: BackgroundTasks, x_file_path: str | None = Header(None),
                    x_mathesis_kind: str | None = Header(None), x_mathesis_meta: str | None = Header(None),
                    x_mathesis_overwrite: str | None = Header(None)):
        """X-Mathesis-Kind: "transcript" (default) is summarized; "quiz" is only saved."""
        target = target_path(x_file_path)
        kind = (x_mathesis_kind or "transcript").strip().lower()
        if kind == "raw" and target.suffix != ".html":
            raise ApiError(400, "raw saves must use an .html path")
        busy = [k for k in ("summary", "lab-guide", "domains") if (jobs.get(target, k) or {}).get("state") == "pending"]
        if busy:   # a second click while the AI is still writing: do nothing (no second job, and the file under the job is not touched)
            raise ApiError(409, "generation in progress: the summary / lab guide / exam domains of this page are still being written", "pending")
        content = await request.body()
        if kind == "bundle":
            try:
                content = (await run_in_threadpool(bundle.markdown_for, content.decode("utf-8", "replace"))).encode("utf-8")
            except bundle.BundleError as e:
                notify("Lesson conversion failed", f"{target.name}: {e.message}", error=True, enabled=settings.notify)
                raise ApiError(e.status, e.message)
        written, kept, hashed = content, False, None
        if kind == "quiz-attempt":   # the attempt file of the quiz platform: the userscript names the quiz by title, the hash comes from the saved quiz
            if target.suffix != ".json":
                raise ApiError(400, "attempts must use a .json path")
            try:
                content, hashed = quiz_attempts.add_hash(content, quiz_attempts.quiz_file_for(target))
            except (ValueError, UnicodeDecodeError):
                raise ApiError(400, "the attempt is not valid JSON")
            written = content
        if kind in FILE_TYPES and target.suffix == ".md":  # frontmatter: type, course, lesson, url, hash of the body
            try:
                existing = target.read_text(encoding="utf-8") if target.is_file() else None
                mode = (x_mathesis_overwrite or "").lower()
                if existing is not None and mode == "metadata":  # keep the text as it is, only refresh the metadata
                    refreshed = frontmatter.refresh(existing, page_meta(x_mathesis_meta, kind, target))
                    target.write_text(refreshed, encoding="utf-8")
                    print(f"updated metadata only {target}")
                    return {"status": "ok", "path": str(target.relative_to(settings.root)), "bytes": 0, "kind": kind,
                            "kept": True, "metadata_only": True}
                if existing is not None and frontmatter.is_modified(existing) and mode != "yes":
                    raise ApiError(409, "this file was changed after it was saved (your notes?): saving would overwrite them", "modified",
                                   diff=frontmatter.diff(existing, content.decode("utf-8")))
                text, kept = frontmatter.apply(existing, content.decode("utf-8"), page_meta(x_mathesis_meta, kind, target))
                written = text.encode("utf-8")
            except UnicodeDecodeError:
                pass  # not text we can add metadata to: saved as before
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(written)
        except OSError as e:
            notify("Transcript save failed", f"{target.name}: {e}", error=True, enabled=settings.notify)
            raise ApiError(500, str(e))
        print(f"saved {kind} {len(content)} bytes -> {target}")
        if settings.notify_on_save:
            notify("Transcript saved", target.stem, enabled=settings.notify)
        text = content.decode("utf-8", "replace")
        if settings.summary_enabled and content.strip() and kind in ("transcript", "bundle", "lab"):
            jobs.start(target, "summary")
            background.add_task(jobs.run, target, "summary", summary_path(target), write_summary, text, str(target), settings)
        if settings.lab_guide_enabled and content.strip() and kind == "lab":  # own thread: the summary may take minutes
            start_lab_guide(target, text)
        if kind == "quiz-json" and settings.domains_enabled and exam_domains.needs_domains(content):  # own thread: it searches the web
            jobs.start(target, "domains")
            threading.Thread(target=jobs.run, args=(target, "domains", target, exam_domains.write_domains, str(target), settings),
                             daemon=True).start()
        # kept: the file existed without frontmatter, so only the metadata was added and its text was left alone
        return {"status": "ok", "path": str(target.relative_to(settings.root)), "bytes": len(content), "kind": kind,
                "kept": kept, **({"quiz": hashed} if hashed else {})}

    return app


# `uvicorn mathesis.server:app` (used by `mathesis serve`, which needs an import string for --reload)
app = create_app()
