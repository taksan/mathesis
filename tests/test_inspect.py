import asyncio
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from mathesis import pageinspect, server
from mathesis.config import ConfigError, Settings


@pytest.fixture
def inspecting(tmp_path, monkeypatch):
    monkeypatch.setenv("MATHESIS_INSPECT_TOKEN_FILE", str(tmp_path / "token"))
    settings = Settings(root=tmp_path.resolve(), summarize=False, notify=False, inspect=True)
    with TestClient(server.create_app(settings)) as c:
        c.token = (tmp_path / "token").read_text()
        yield c


PAGE = {"Origin": "https://partner.skills.google"}


def test_inspect_is_off_unless_asked_for(tmp_path):
    with TestClient(server.create_app(Settings(root=tmp_path.resolve(), notify=False))) as c:
        assert c.get("/inspect").status_code == 404 and c.get("/inspect/pages").status_code == 404
        assert c.get("/files", headers={"X-File-Path": "a/b.md"}).json()["inspect"] is False


def test_inspect_only_on_a_loopback_host():
    with pytest.raises(ConfigError):
        Settings(inspect=True, host="0.0.0.0").validate()


def test_token_file_is_private_and_files_tells_the_panel(inspecting, tmp_path):
    assert (tmp_path / "token").stat().st_mode & 0o777 == 0o600
    assert inspecting.get("/files", headers={"X-File-Path": "a/b.md"}).json()["inspect"] is True


def test_control_side_needs_the_token_and_refuses_web_pages(inspecting):
    assert inspecting.get("/inspect/pages").status_code == 401
    assert inspecting.get("/inspect/pages", headers={"X-Mathesis-Inspect-Token": "nope"}).status_code == 401
    assert inspecting.post("/inspect/call", json={"op": "info"}).status_code == 401
    web = {"X-Mathesis-Inspect-Token": inspecting.token, "Origin": "https://evil.example"}
    assert inspecting.get("/inspect/pages", headers=web).status_code == 403          # even with the token: a web page may not
    assert inspecting.get("/inspect/pages", headers={"X-Mathesis-Inspect-Token": inspecting.token}).json() == {"pages": []}


def test_page_side_only_for_the_sites_of_the_userscripts(inspecting):
    assert inspecting.post("/inspect/register", content="{}", headers={"Origin": "https://evil.example"}).status_code == 403
    assert inspecting.post("/inspect/register", content="{}", headers={"Origin": "https://www.udemy.com"}).status_code == 200
    assert inspecting.get("/inspect/stream", params={"id": "guess"}, headers=PAGE).status_code == 404   # the id is the secret
    assert inspecting.get("/inspect/stream", params={"id": "guess"}, headers={"Origin": "https://evil.example"}).status_code == 403


def test_a_command_reaches_the_page_and_its_answer_comes_back(inspecting):
    reg = inspecting.post("/inspect/register", content='{"url": "https://partner.skills.google/x", "title": "T"}', headers=PAGE).json()
    auth = {"X-Mathesis-Inspect-Token": inspecting.token}
    assert inspecting.get("/inspect/pages", headers=auth).json()["pages"][0]["url"].endswith("/x")

    hub = inspecting.app.state.hub

    def page():   # what the userscript does: get the command (from the SSE stream), do it, answer with a POST
        cmd = hub.poll(reg["id"], wait=5)
        inspecting.post("/inspect/answer", params={"id": reg["id"], "command": cmd["id"]}, headers=PAGE,
                        content='{"ok": true, "data": {"op": "%s", "selector": "%s"}}' % (cmd["op"], cmd["args"]["selector"]))

    t = threading.Thread(target=page)
    t.start()
    got = inspecting.post("/inspect/call", headers=auth, json={"op": "count", "args": {"selector": "a"}}).json()
    t.join()
    assert got == {"ok": True, "data": {"op": "count", "selector": "a"}}


def test_unknown_operations_are_refused_and_nothing_is_shared_by_default(inspecting):
    auth = {"X-Mathesis-Inspect-Token": inspecting.token}
    assert inspecting.post("/inspect/call", headers=auth, json={"op": "eval", "args": {"js": "1"}}).status_code == 400   # no way to run code
    r = inspecting.post("/inspect/call", headers=auth, json={"op": "info"})
    assert r.status_code == 404 and "AI button" in r.json()["error"]


def test_stopping_and_stale_pages_disappear(monkeypatch):
    hub = pageinspect.Hub()
    page = hub.register("https://x", "t")
    assert hub.poll(page.secret, wait=0) is None
    hub.close(page.secret)
    with pytest.raises(pageinspect.InspectError):
        hub.poll(page.secret, wait=0)
    old = hub.register("https://y", "t")
    old.seen -= pageinspect.STALE + 1
    assert hub.listing() == []


def test_a_page_that_never_answers_times_out():
    hub = pageinspect.Hub()
    hub.register("https://x", "t")
    start = time.time()
    with pytest.raises(pageinspect.InspectError) as e:
        hub.call(None, "info", {}, timeout=0.3)
    assert e.value.status == 504 and time.time() - start < 3


def _stream(hub, secret, disconnected):
    async def blocking(fn, *args):
        return await asyncio.to_thread(fn, *args)
    return pageinspect.events(hub, secret, disconnected, blocking)


def test_the_stream_sends_each_command_as_an_sse_data_line():
    hub = pageinspect.Hub()
    page = hub.register("https://x", "t")

    async def run():
        async def never():
            return False
        gen = _stream(hub, page.secret, never)
        assert (await anext(gen)).startswith(":")                              # a comment first: the connection is open
        waiting = asyncio.ensure_future(asyncio.to_thread(hub.call, None, "count", {"selector": "a"}, 5))
        line = await anext(gen)
        assert line.startswith("data: ") and line.endswith("\n\n")
        command = json.loads(line[len("data: "):])
        assert command["op"] == "count" and command["args"] == {"selector": "a"}
        hub.answer(page.secret, command["id"], {"ok": True, "data": 3})
        assert await waiting == {"ok": True, "data": 3}
        await gen.aclose()

    asyncio.run(run())


def test_a_command_taken_for_a_closed_stream_goes_back_to_the_queue():
    hub = pageinspect.Hub()
    page = hub.register("https://x", "t")
    page.queue.append({"id": "c1", "op": "info", "args": {}})
    calls = iter([False, True])             # connected when it starts, gone by the time the command is taken

    async def disconnected():
        return next(calls, True)

    async def run():
        return [chunk async for chunk in _stream(hub, page.secret, disconnected)]

    chunks = asyncio.run(run())
    assert not any(c.startswith("data:") for c in chunks)
    assert [c["id"] for c in page.queue] == ["c1"]                              # not lost


def test_the_stream_ends_when_the_page_is_not_shared_any_more():
    hub = pageinspect.Hub()
    page = hub.register("https://x", "t")
    hub.close(page.secret)

    async def never():
        return False

    async def run():
        return [chunk async for chunk in _stream(hub, page.secret, never)]

    assert asyncio.run(run()) == [": mathesis inspect stream\n\n"]
