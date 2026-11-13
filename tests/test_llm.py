import io
import json
import urllib.error

import pytest

from mathesis import llm, pipeline
from mathesis.config import ConfigError, Settings
from mathesis.llm import ClaudeCodeClient, OpenAIClient, make_client
from mathesis.ollama import OllamaClient


class Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass


def http_error(code, body="{}"):
    return urllib.error.HTTPError("http://x", code, "err", {}, io.BytesIO(body.encode()))


def gemini(monkeypatch, **spec):
    monkeypatch.setenv("GEMINI_API_KEY", "k-123")
    return OpenAIClient(Settings().provider_spec("gemini") | spec, sleep=lambda s: None)


def test_gemini_is_a_builtin_openai_compatible_provider(monkeypatch):
    spec = Settings(summary_provider="gemini").provider_spec("gemini", "gemini-2.5-pro")
    assert spec["type"] == "openai" and spec["url"].endswith("/v1beta/openai") and spec["model"] == "gemini-2.5-pro"
    assert make_client(Settings(summary_provider="gemini"), "summary").label == "gemini:gemini-2.5-flash"


def test_chat_posts_openai_format_with_bearer_key(monkeypatch):
    seen = {}

    def urlopen(req, timeout=None):
        seen.update(url=req.full_url, auth=req.get_header("Authorization"), body=json.loads(req.data))
        return Resp(json.dumps({"choices": [{"message": {"content": " hello "}}]}).encode())

    monkeypatch.setattr(llm.urllib.request, "urlopen", urlopen)
    assert gemini(monkeypatch).chat("sys", "usr", 0.1) == "hello"
    assert seen["url"].endswith("/v1beta/openai/chat/completions") and seen["auth"] == "Bearer k-123"
    assert seen["body"]["model"] == "gemini-2.5-flash" and seen["body"]["messages"][0] == {"role": "system", "content": "sys"}


def test_rate_limits_are_retried_then_reported_without_the_key(monkeypatch):
    calls = []

    def urlopen(req, timeout=None):
        calls.append(1)
        if len(calls) < 3:
            raise http_error(429)
        return Resp(json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode())

    monkeypatch.setattr(llm.urllib.request, "urlopen", urlopen)
    assert gemini(monkeypatch).chat("s", "u") == "ok" and len(calls) == 3

    monkeypatch.setattr(llm.urllib.request, "urlopen", lambda req, timeout=None: (_ for _ in ()).throw(http_error(400, "bad model")))
    with pytest.raises(RuntimeError) as e:
        gemini(monkeypatch).chat("s", "u")
    assert "400" in str(e.value) and "bad model" in str(e.value) and "k-123" not in str(e.value)


def test_check_reports_missing_key_bad_key_and_unreachable(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    ok, msg = OpenAIClient(Settings().provider_spec("gemini")).check()
    assert not ok and "GEMINI_API_KEY" in msg
    monkeypatch.setattr(llm.urllib.request, "urlopen", lambda req, timeout=None: (_ for _ in ()).throw(http_error(403)))
    assert not gemini(monkeypatch).check()[0]
    monkeypatch.setattr(llm.urllib.request, "urlopen", lambda req, timeout=None: (_ for _ in ()).throw(OSError("refused")))
    ok, msg = gemini(monkeypatch).check()
    assert not ok and "cannot reach" in msg
    monkeypatch.setattr(llm.urllib.request, "urlopen", lambda req, timeout=None: (_ for _ in ()).throw(http_error(404)))
    assert gemini(monkeypatch).check()[0]                       # a server without /models still works
    monkeypatch.setattr(llm.urllib.request, "urlopen", lambda req, timeout=None: Resp(b"{}"))
    assert gemini(monkeypatch).check()[0]


def test_local_openai_server_needs_no_key():
    s = Settings(providers={"lmstudio": {"type": "openai", "url": "http://localhost:1234/v1", "model": "m"}},
                 summary_provider="lmstudio")
    client = make_client(s, "summary")
    assert client.api_key is None and "Authorization" not in client._headers()


def test_factory_picks_clients_and_none_disables():
    s = Settings(summary_provider="ollama", lab_provider="claude-code")
    assert isinstance(make_client(s, "summary"), OllamaClient) and isinstance(make_client(s, "lab_guide"), ClaudeCodeClient)
    assert make_client(Settings(summary_provider="none"), "summary") is None
    assert not Settings(summary_provider="none").summary_enabled and not Settings(lab_provider="none").lab_guide_enabled
    with pytest.raises(ConfigError):
        make_client(Settings(summary_provider="nope"), "summary")


def test_role_model_override_and_second_ollama():
    s = Settings(summary_provider="big", summary_model="qwen3:8b", model="gemma4:12b",
                 providers={"big": {"type": "ollama", "url": "http://gpu:11434/"}})
    c = make_client(s, "summary")
    assert (c.url, c.model) == ("http://gpu:11434", "qwen3:8b")
    assert make_client(Settings(), "summary").model == "gemma4:12b"


def test_unreachable_backend_saves_the_lesson_and_skips_the_summary(tmp_path, monkeypatch):
    llm._announced.clear()
    notes = []
    monkeypatch.setattr(pipeline, "notify", lambda title, body="", **kw: notes.append((title, kw.get("error"))))
    monkeypatch.setattr(pipeline, "summarize", lambda *a, **k: pytest.fail("must not run"))
    monkeypatch.setattr("mathesis.ollama.OllamaClient.check_model", lambda self: (False, "cannot reach Ollama"))
    lesson = tmp_path / "P" / "C" / "01-L.md"
    lesson.parent.mkdir(parents=True)
    lesson.write_text("transcript")
    s = Settings(root=tmp_path)
    pipeline.write_summary("transcript", lesson, s)
    pipeline.write_summary("transcript", lesson, s)
    assert lesson.read_text() == "transcript" and not lesson.with_name("01-L-summary.md").exists()
    assert notes == [("Saved without summary", None)]                  # told once, not on every save


def test_summary_goes_through_the_configured_provider(tmp_path, monkeypatch):
    calls = []

    class Fake:
        label = "gemini:g-1"

        def check(self):
            return True, "ok"

        def chat(self, system, user, temperature=0.2):
            calls.append(1)
            return "## The big idea\nx\n## How it fits together\ny\n## Remember for the exam\n- z"

    monkeypatch.setattr(pipeline, "make_client", lambda s, role: Fake())
    monkeypatch.setattr(pipeline, "notify", lambda *a, **k: None)
    lesson = tmp_path / "P" / "C" / "01-L.md"
    lesson.parent.mkdir(parents=True)
    pipeline.write_summary("text", lesson, Settings(root=tmp_path, pipeline="single"))
    assert "model=gemini:g-1" in lesson.with_name("01-L-summary.md").read_text() and calls
