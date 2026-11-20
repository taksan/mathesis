"""Reading public web pages as text, and a web search: the tools the domain guesser (domains.py) uses to find an exam's official syllabus.

Whatever the model asks for is only ever a public https page: a URL that comes out of a model (or out of a quiz it read) must not
reach the machine's own network, so the host has to resolve to public addresses only, on every redirect too. PDFs (exam guides are
often PDFs) are turned into text with `pdftotext` when it is installed. The search sends only the query the caller builds (a
certification name), to DuckDuckGo's HTML page.
"""
import html
import ipaddress
import re
import shutil
import socket
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

MAX_BYTES = 8_000_000
TIMEOUT = 25
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0 mathesis", "Accept-Language": "en"}
SEARCH_URL = "https://html.duckduckgo.com/html/"


class FetchError(Exception):
    """The page could not be read; the message says why."""


def check_url(url: str) -> None:
    """Raise FetchError unless `url` is https and its host resolves to public addresses only."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise FetchError(f"only https pages are read: {url[:100]}")
    try:
        found = {info[4][0] for info in socket.getaddrinfo(parts.hostname, parts.port or 443, proto=socket.IPPROTO_TCP)}
    except OSError as e:
        raise FetchError(f"cannot resolve {parts.hostname}: {e}")
    for address in found:
        ip = ipaddress.ip_address(address.split("%")[0])
        if not ip.is_global:
            raise FetchError(f"{parts.hostname} is not a public address: not read")


class _Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)          # every hop, not just the first URL
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(url: str, data: bytes | None = None):
    check_url(url)
    opener = urllib.request.build_opener(_Redirects)
    return opener.open(urllib.request.Request(url, data=data, headers=HEADERS), timeout=TIMEOUT)


class _Text(HTMLParser):
    BLOCK = {"p", "div", "li", "br", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "ul", "ol", "table", "dt", "dd"}
    SKIP = {"script", "style", "noscript", "svg", "head", "template"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skipping += 1
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skipping:
            self.skipping -= 1
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skipping:
            self.parts.append(data)


def html_to_text(page: str) -> str:
    parser = _Text()
    parser.feed(page)
    text = html.unescape("".join(parser.parts))
    lines = (re.sub(r"[ \t ]+", " ", line).strip() for line in text.splitlines())
    return "\n".join(line for line in lines if line)


def pdf_to_text(data: bytes) -> str:
    if not shutil.which("pdftotext"):
        raise FetchError("the page is a PDF and pdftotext is not installed (poppler-utils)")
    done = subprocess.run(["pdftotext", "-layout", "-", "-"], input=data, capture_output=True, timeout=60)
    if done.returncode != 0:
        raise FetchError("pdftotext could not read the PDF")
    return done.stdout.decode("utf-8", "replace").strip()


def fetch_text(url: str) -> str:
    """The text of a public https page (HTML or PDF). Raises FetchError."""
    try:
        with _open(url) as resp:
            kind = (resp.headers.get_content_type() or "").lower()
            data = resp.read(MAX_BYTES + 1)
    except FetchError:
        raise
    except urllib.error.HTTPError as e:
        raise FetchError(f"{url[:100]} answered HTTP {e.code}")
    except Exception as e:
        raise FetchError(f"cannot read {url[:100]}: {e}")
    if len(data) > MAX_BYTES:
        raise FetchError(f"{url[:100]} is too large")
    if kind == "application/pdf" or data[:5] == b"%PDF-":
        return pdf_to_text(data)
    if kind not in ("text/html", "application/xhtml+xml", "text/plain"):
        raise FetchError(f"{url[:100]} is {kind or 'of an unknown type'}, not a page")
    page = data.decode("utf-8", "replace")
    return page if kind == "text/plain" else html_to_text(page)


def search(query: str, limit: int = 8) -> list[str]:
    """Result URLs for a query (DuckDuckGo's HTML page); an empty list when the search is unavailable."""
    try:
        with _open(SEARCH_URL + "?" + urllib.parse.urlencode({"q": query})) as resp:
            page = resp.read(MAX_BYTES).decode("utf-8", "replace")
    except Exception:
        return []
    urls: list[str] = []
    for href in re.findall(r'class="result__a"[^>]*href="([^"]+)"', page):
        href = html.unescape(href)
        if href.startswith("//"):
            href = "https:" + href
        target = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query).get("uddg")
        url = target[0] if target else href
        if url.startswith("https://") and url not in urls:
            urls.append(url)
        if len(urls) >= limit:
            break
    return urls
