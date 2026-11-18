"""Inspect mode: let an AI (or you, with curl) look at a page you are browsing, to debug why the userscript does not parse it.

Only with `mathesis serve --inspect`. The flow:

    page (userscript, after you click "AI")  --register / long-poll-->  server  <--call (token)--  `mathesis inspect ...`
                                              <--commands, results--

* The page asks first and answers only read-only questions (the DOM: outline, html, text, query, count, plus what the userscript's
  own parser makes of the page). There is no way to run JavaScript or click anything. Passwords and form values are never sent.
* Sharing is per page visit, started by the person with the AI button and stopped by it (or by leaving the page).
* The page side is open to the sites the userscripts run on; the control side (list pages, ask, read answers) needs a random token
  that only this machine's files hold, and refuses any request that comes from a web page (it has an Origin header).
"""
import secrets
import threading
import time
from collections import deque

OPS = ("info", "outline", "html", "text", "query", "count", "parse")
MAX_PAGES = 20
MAX_RESULT = 3_000_000       # bytes of one answer
STALE = 90                   # seconds without a poll: the page is gone (closed, navigated away)
POLL_WAIT = 20               # seconds a poll waits for a command


class InspectError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


class Page:
    def __init__(self, number: int, url: str, title: str):
        self.number, self.url, self.title = number, url, title
        self.secret = secrets.token_urlsafe(24)      # what only that page knows: it polls and answers with it
        self.opened = self.seen = time.time()
        self.queue: deque = deque()
        self.answers: dict[str, dict] = {}


class Hub:
    """The shared pages and their command queues. In memory; a restart forgets everything and the pages register again."""

    def __init__(self):
        self.cond = threading.Condition()
        self.pages: dict[str, Page] = {}
        self.counter = 0

    def _drop_stale(self):
        now = time.time()
        for secret in [s for s, p in self.pages.items() if now - p.seen > STALE]:
            del self.pages[secret]

    def register(self, url: str, title: str) -> Page:
        with self.cond:
            self._drop_stale()
            if len(self.pages) >= MAX_PAGES:
                raise InspectError(429, "too many shared pages")
            self.counter += 1
            page = Page(self.counter, str(url)[:500], str(title)[:200])
            self.pages[page.secret] = page
            return page

    def _page(self, secret: str) -> Page:
        page = self.pages.get(secret)
        if not page:
            raise InspectError(404, "this page is not shared (any more)")
        return page

    def poll(self, secret: str, wait: float = POLL_WAIT) -> dict | None:
        """The next command for the page, waiting up to `wait` seconds for one."""
        deadline = time.time() + wait
        with self.cond:
            while True:
                page = self._page(secret)
                page.seen = time.time()
                if page.queue:
                    return page.queue.popleft()
                left = deadline - time.time()
                if left <= 0:
                    return None
                self.cond.wait(min(left, 1.0))

    def answer(self, secret: str, command_id: str, result: dict) -> None:
        with self.cond:
            page = self._page(secret)
            page.seen = time.time()
            page.answers[command_id] = result
            self.cond.notify_all()

    def close(self, secret: str) -> None:
        with self.cond:
            self.pages.pop(secret, None)
            self.cond.notify_all()

    def listing(self) -> list[dict]:
        with self.cond:
            self._drop_stale()
            return [{"page": p.number, "url": p.url, "title": p.title, "shared_for": int(time.time() - p.opened),
                     "last_seen": int(time.time() - p.seen)} for p in self.pages.values()]

    def call(self, number: int | None, op: str, args: dict, timeout: float = 30) -> dict:
        """Ask a page (default: the newest) to do `op` and wait for the answer."""
        if op not in OPS:
            raise InspectError(400, f"unknown operation {op!r}: use one of {', '.join(OPS)}")
        with self.cond:
            self._drop_stale()
            pages = sorted(self.pages.values(), key=lambda p: p.number)
            if not pages:
                raise InspectError(404, "no page is shared: click the AI button in the Mathesis panel of the page")
            page = next((p for p in pages if p.number == number), None) if number else pages[-1]
            if not page:
                raise InspectError(404, f"page {number} is not shared; shared: {[p.number for p in pages]}")
            command_id = secrets.token_hex(8)
            page.queue.append({"id": command_id, "op": op, "args": args})
            self.cond.notify_all()
            deadline = time.time() + timeout
            while command_id not in page.answers:
                left = deadline - time.time()
                if left <= 0 or page.secret not in self.pages:
                    raise InspectError(504, "the page did not answer (closed, asleep in a background tab, or the sharing was stopped)")
                self.cond.wait(min(left, 1.0))
            return page.answers.pop(command_id)
