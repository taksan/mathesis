"""Google Skills "HTML bundle" lessons -> Markdown.

Those lessons are not in the page: <ql-iframe src="https://storage.googleapis.com/cloud-training/.../index.html#/page/<id>">
embeds an Evolve/Adapt course player. Its content is plain JSON next to index.html
(course/<lang>/{contentObjects,articles,blocks,components}.json), page -> articles -> blocks -> components,
and the text fields are HTML, converted here with markdownify.
All lessons of a course share one bundle, so the JSON is cached for a while.
"""
import base64
import html
import json
import re
import time
import urllib.request
from urllib.parse import urlsplit

from markdownify import markdownify

ALLOWED_HOST, ALLOWED_PATH = "storage.googleapis.com", "/cloud-training/"
FILES = ("contentObjects", "articles", "blocks", "components")
CACHE_SECONDS = 30 * 60
_cache: dict[str, tuple[float, dict]] = {}


class BundleError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def parse_src(src: str) -> tuple[str, str]:
    """(bundle base url, page/contentObject id) from the iframe src. Only Google's training bucket is accepted."""
    src = src.strip()
    parts = urlsplit(src)
    if parts.scheme != "https" or parts.hostname != ALLOWED_HOST or not parts.path.startswith(ALLOWED_PATH) \
            or ".." in parts.path:
        raise BundleError(400, f"not a Google training bundle URL: {src[:80]}")
    page = re.match(r"/(?:page|id)/([0-9a-f]{24})", parts.fragment) or re.match(r"/lessons/([\w-]{8,})", parts.fragment)
    if not page:
        raise BundleError(400, f"the bundle URL has no #/page/<id> or #/lessons/<id>: {src[:200]}")
    path = parts.path.rsplit("/", 1)[0] if parts.path.endswith(".html") else parts.path.rstrip("/")
    return f"https://{ALLOWED_HOST}{path}", page.group(1)


def _get_json(url: str):
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # network, 404, bad JSON
        raise BundleError(502, f"could not read {url.rsplit('/', 1)[-1]} of the bundle: {e}")


def load_course(base: str, fetch=_get_json) -> dict:
    cached = _cache.get(base)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return cached[1]
    lang = "en"
    try:
        lang = fetch(f"{base}/course/config.json").get("_defaultLanguage") or "en"
    except BundleError:
        pass  # the default is fine
    course = {name: fetch(f"{base}/course/{lang}/{name}.json") for name in FILES}
    _cache[base] = (time.time(), course)
    return course


# ------------------------------------------------------------------ HTML -> Markdown

PLACEHOLDER = re.compile(r"\[?\s*add\b[^\]\n]*\]?\.?|add subtitle or remove\.?", re.I)


def to_md(html) -> str:
    if not isinstance(html, str) or not html.strip():
        return ""
    text = markdownify(html, heading_style="ATX", bullets="-", escape_underscores=False, escape_asterisks=False,
                       strip=["img", "span"])
    text = text.replace("​", "").replace("\xa0", " ")
    text = re.sub(r"\*\*\s*\*\*", "", text)                 # empty bold left by styled spans
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return "" if PLACEHOLDER.fullmatch(text) else text


def one_line(html) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\*+", "", to_md(html))).strip()


# ------------------------------------------------------------------ components

LABELS = ("title", "itemTitle", "tabText", "frontText")  # shown titles of items (a component's own "title" is an editor label)
TEXTS = ("body", "text", "backText")
CHILDREN = ("_items", "_transcript", "_video", "_audio", "tooltipMediaVideo", "tooltipMediaAudio")
UI_INSTRUCTION_MAX = 55
UI_INSTRUCTION = re.compile(r"\s*(?:<[^>]+>)*\s*(select|use the|click|press|move|watch|drag|tap)\b", re.I)


def _table(rows) -> str:
    rows = [[one_line(c).replace("|", "\\|") for c in row] for row in rows if isinstance(row, list)]
    rows = [r for r in rows if any(r)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


def _without_title(text: str, labels: list[str]) -> str:
    """Flip cards repeat their title as the first paragraph of the back side: it is already the item's label."""
    paragraphs = text.split("\n\n")
    while len(paragraphs) > 1 and re.sub(r"\s+", " ", paragraphs[0].replace("*", "")).strip().lower() in labels:
        paragraphs.pop(0)
    return "\n\n".join(paragraphs)


def render_node(node, out: list[str], depth: int = 0, in_transcript: bool = False) -> None:
    """Appends the readable text of a component (or of one of its items) to out, in reading order."""
    if isinstance(node, list):
        for item in node:
            render_node(item, out, depth, in_transcript)
        return
    if not isinstance(node, dict) or node.get("_isHidden") is True or node.get("_isEnabled") is False:
        return
    if node.get("_component") == "mcq":
        return _render_mcq(node, out)
    heading = to_md(node.get("displayTitle")) if depth == 0 else ""
    if heading:
        out.append("#### " + one_line(heading))
    labels: list[str] = []
    for key in LABELS:
        if key == "title" and depth == 0:
            continue
        label = one_line(node.get(key))
        if label:
            labels.append(label.lower())
            out.append(f"**{label}**")
    for key in TEXTS:
        text = _without_title(to_md(node.get(key)), labels)
        if text:
            out.append(("Transcript: " + text) if in_transcript and key == "body" else text)
    instruction = to_md(node.get("instruction"))
    # "Select each card to learn more." is chrome; a longer one usually names the topic ("...to explore the five key values")
    if instruction and not (UI_INSTRUCTION.match(instruction) and len(instruction) <= UI_INSTRUCTION_MAX):
        out.append(f"*{instruction}*")
    if isinstance(node.get("_codeString"), str) and node["_codeString"].strip():
        out.append(f"```{node.get('_codeLanguage') or ''}\n{node['_codeString'].strip()}\n```")
    if isinstance(node.get("_rows"), list):
        table = _table(node["_rows"])
        if table:
            out.append(table)
    for key in CHILDREN:
        if key in node:
            render_node(node[key], out, depth + 1, in_transcript or key == "_transcript")


def _render_mcq(node: dict, out: list[str]) -> None:
    question = to_md(node.get("body"))
    if question:
        out.append(question)
    for i, item in enumerate(node.get("_items") or []):
        text = one_line(item.get("text"))
        if text:
            out.append(f"- {'✅' if item.get('_shouldBeSelected') else '⬜'} {text}")


# ------------------------------------------------------------------ pages

def _ordered(items):
    return sorted(items, key=lambda x: x.get("_sortOrder", 0))  # stable: missing order keeps file order


def _visible(x) -> bool:
    return x.get("_isHidden") is not True and x.get("_isEnabled") is not False


def pages_under(course: dict, root_id: str) -> list[dict]:
    """The page with this id, or (for a menu/section id) the pages below it, in order."""
    objects = course["contentObjects"]
    children: dict[str, list[dict]] = {}
    for o in objects:
        children.setdefault(o.get("_parentId"), []).append(o)
    root = next((o for o in objects if o.get("_id") == root_id), None)
    if root is None:
        raise BundleError(404, f"page {root_id} is not in the bundle")
    pages: list[dict] = []

    def walk(o):
        if o.get("_type") == "page":
            pages.append(o)
        else:
            for child in _ordered(children.get(o["_id"], [])):
                walk(child)

    walk(root)
    return pages


def render_page(course: dict, page: dict) -> str:
    def kids(source, parent):
        return _ordered(x for x in course[source] if x.get("_parentId") == parent["_id"] and _visible(x))

    lines = [f"# {one_line(page.get('displayTitle')) or one_line(page.get('title'))}"]
    intro = to_md(page.get("body"))
    if intro:
        lines += ["", intro]
    for article in kids("articles", page):
        title = one_line(article.get("displayTitle"))
        if title and title != lines[0][2:]:
            lines += ["", f"## {title}"]
        for block in kids("blocks", article):
            title = one_line(block.get("displayTitle"))
            if title:
                lines += ["", f"### {title}"]
            for component in kids("components", block):
                parts: list[str] = []
                render_node(component, parts)
                for part in parts:
                    if part != (lines[-1] if lines else None):
                        lines += ["", part]
    return "\n".join(lines).strip() + "\n"


# ------------------------------------------------------------------ Articulate Rise bundles
# Other courses embed a Rise export (".../content/index.html#/lessons/<id>"): all the content is one
# base64 JSON in runtime-data.js, course.lessons[] -> items (blocks) -> items (cards, tabs, paragraphs ...).

RISE_KEYS = ("name", "heading", "title", "date", "paragraph", "description", "code", "caption")


def _get_text(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            return resp.read().decode("utf-8")
    except Exception as e:
        raise BundleError(502, f"could not read {url.rsplit('/', 1)[-1]} of the bundle: {e}")


def load_rise(base: str, fetch_text=_get_text) -> dict:
    cached = _cache.get("rise:" + base)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return cached[1]
    payload = re.search(r'__jsonp\("runtime-data\.js",\s*"([^"]+)"', fetch_text(f"{base}/runtime-data.js"))
    if not payload:
        raise BundleError(502, "runtime-data.js of the bundle has an unknown format")
    try:
        course = json.loads(base64.b64decode(payload.group(1)))["course"]
    except Exception as e:
        raise BundleError(502, f"could not decode runtime-data.js: {e}")
    _cache["rise:" + base] = (time.time(), course)
    return course


def _rise_item(item: dict, out: list[str], heading: str, in_list: str | None, number: int) -> None:
    for key in RISE_KEYS:
        value = item.get(key)
        if not isinstance(value, str):
            continue
        if key == "code":
            if value.strip():
                out.append(f"```\n{html.unescape(value).strip()}\n```")
        elif key == "heading":
            text = one_line(value)
            if text:
                out.append(f"{heading} {text}")
        elif key in ("title", "name", "date"):
            text = one_line(value)
            if text:
                out.append(f"**{text}**")
        else:
            text = to_md(value)
            if not text:
                continue
            if in_list == "numbered":
                text = f"{number}. {text}"
            elif in_list == "bulleted":
                text = f"- {text}"
            out.append(text)
    options = []  # knowledge check: the options, the right ones marked (as in the Adapt quizzes), one list
    for answer in item.get("answers") or []:
        text = one_line(answer.get("title")) if isinstance(answer, dict) else ""
        if text:
            options.append(f"- {'✅' if answer.get('correct') else '⬜'} {text}")
    if options:
        out.append("\n".join(options))
    if options:  # what the course says after answering (often the explanation); a bare "Correct" / "Incorrect" says nothing
        for key, label in (("feedbackCorrect", "Correct"), ("feedbackIncorrect", "Incorrect"), ("feedback", "Feedback")):
            text = to_md(item.get(key))
            if re.sub(r"[^a-z]", "", text.lower()) not in ("", "correct", "incorrect", "feedback"):
                lead = "" if text.lower().startswith(label.lower()) else f"**{label}:** "   # "Correct! ..." already says it
                out.append("> " + lead + text.replace("\n", "\n> "))
    for side in ("front", "back"):  # flash cards and stacks (a front that is only an image has just an alt text)
        card = item.get(side)
        if isinstance(card, dict) and card.get("type") not in ("fullimage",):
            _rise_item(card, out, heading, None, 0)


def render_rise_lesson(lesson: dict) -> str:
    lines = [f"# {one_line(lesson.get('title'))}"]
    for block in lesson.get("items") or []:
        if not isinstance(block, dict):
            continue
        variant = str(block.get("variant") or "")
        heading = "####" if variant.startswith("subheading") else "###"
        kind = block.get("type")
        if kind == "image" and variant == "hero":  # banner: its leftover template text is not shown
            continue
        parts: list[str] = []
        for number, item in enumerate(block.get("items") or [], 1):
            if isinstance(item, dict):
                if kind == "text":  # the variant says which fields are shown; the editor keeps stale text in the others
                    hidden = ("heading",) if "heading" not in variant else ("paragraph",) if variant in ("heading", "subheading") else ()
                    item = {k: v for k, v in item.items() if k not in hidden}
                _rise_item(item, parts, heading, variant if kind == "list" else None, number)
        if kind == "quote":
            parts = ["> " + p.replace("\n", "\n> ") for p in parts]
        elif kind == "list":  # consecutive list items form one list
            parts = ["\n".join(parts)] if parts else []
        for part in parts:
            if part != (lines[-1] if lines else None):
                lines += ["", part]
    return "\n".join(lines).strip() + "\n"


def rise_markdown(base: str, lesson_id: str, fetch_text=_get_text) -> str:
    course = load_rise(base, fetch_text)
    lessons = course.get("lessons") or []
    start = next((i for i, l in enumerate(lessons) if l.get("id") == lesson_id), None)
    if start is None:
        raise BundleError(404, f"lesson {lesson_id} is not in the bundle")
    if lessons[start].get("type") == "section":  # a section id: the lessons up to the next section
        end = next((i for i in range(start + 1, len(lessons)) if lessons[i].get("type") == "section"), len(lessons))
        chosen = lessons[start + 1:end]
    else:
        chosen = [lessons[start]]
    return "\n".join(render_rise_lesson(l) for l in chosen)


def markdown_for(src: str, fetch=_get_json, fetch_text=_get_text) -> str:
    """Markdown of the lesson an iframe src points to."""
    base, page_id = parse_src(src)
    if re.match(r"/lessons/", urlsplit(src.strip()).fragment):
        markdown = rise_markdown(base, page_id, fetch_text)
    else:
        course = load_course(base, fetch)
        markdown = "\n".join(render_page(course, p) for p in pages_under(course, page_id))
    body = " ".join(l for l in markdown.splitlines() if not l.startswith("#"))
    if len(body.split()) < 3:
        raise BundleError(422, "the bundle page has no text content")
    return markdown
