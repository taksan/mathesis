"""HTTP API used by the userscript.

POST /write   Header X-File-Path: absolute path of the .md file; body: the content (UTF-8)
              Header X-Mathesis-Kind: "transcript" (default, gets a summary); any other kind ("quiz", "quiz-review") is saved as is
GET  /status  Header X-File-Path: -> {"exists": bool, "summary_exists": bool}
GET  /userscript/<name>.user.js  the userscripts of this checkout (install / @updateURL target); /userscript lists them
"""
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .config import Settings
from .notify import notify
from .ollama import OllamaClient
from .pipeline import summary_path, write_summary


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status, self.message = status, message


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        print(f"Mathesis listening on http://{settings.host}:{settings.port}  (writing under {settings.root})")
        if settings.summarize:
            ok, message = await run_in_threadpool(OllamaClient(settings).check_model)
            print(("Summary " if ok else "ERROR: ") + message + (f" (pipeline={settings.pipeline})" if ok else ""))
            if not ok:
                notify("Mathesis: summaries unavailable", message, error=True, enabled=settings.notify)
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
        """Validated target from the X-File-Path header: it must lie inside the configured root."""
        if not raw_path:
            raise ApiError(400, "missing X-File-Path header")
        target = Path(raw_path).resolve()
        if settings.root not in target.parents:
            raise ApiError(403, f"path outside {settings.root}")
        return target

    @app.get("/userscript")
    def userscripts():
        d = settings.userscript_dir
        return {"scripts": sorted(f.name for f in d.glob("*.user.js")) if d.is_dir() else []}

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
        return {"exists": target.is_file(), "summary_exists": summary_path(target).is_file()}

    @app.post("/write")
    async def write(request: Request, background: BackgroundTasks, x_file_path: str | None = Header(None),
                    x_mathesis_kind: str | None = Header(None)):
        """X-Mathesis-Kind: "transcript" (default) is summarized; "quiz" is only saved."""
        target = target_path(x_file_path)
        kind = (x_mathesis_kind or "transcript").strip().lower()
        content = await request.body()
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        except OSError as e:
            notify("Transcript save failed", f"{target.name}: {e}", error=True, enabled=settings.notify)
            raise ApiError(500, str(e))
        print(f"saved {kind} {len(content)} bytes -> {target}")
        if settings.notify_on_save:
            notify("Transcript saved", target.stem, enabled=settings.notify)
        if settings.summarize and content.strip() and kind == "transcript":
            background.add_task(write_summary, content.decode("utf-8", "replace"), str(target), settings)
        return {"status": "ok", "path": str(target), "bytes": len(content), "kind": kind}

    return app


# `uvicorn mathesis.server:app` (used by `mathesis serve`, which needs an import string for --reload)
app = create_app()
