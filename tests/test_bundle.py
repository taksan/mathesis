import pytest

from mathesis import bundle

SRC = "https://storage.googleapis.com/cloud-training/T-X/3.0/My%20Course%20(2)/index.html#/page/" + "a" * 24
PAGE = "a" * 24


def course():
    def comp(_id, parent, order, **kw):
        return {"_id": _id, "_parentId": parent, "_sortOrder": order, **kw}
    return {
        "contentObjects": [
            {"_id": "d" * 24, "_type": "menu", "_parentId": "c" * 24, "_sortOrder": 1},
            {"_id": PAGE, "_type": "page", "_parentId": "d" * 24, "_sortOrder": 1,
             "title": "editor title", "displayTitle": "Operational&nbsp;excellence"},
            {"_id": "b" * 24, "_type": "page", "_parentId": "d" * 24, "_sortOrder": 2, "displayTitle": "Second"},
        ],
        "articles": [comp("art1", PAGE, 1, displayTitle="Operational excellence"),
                     comp("art2", "b" * 24, 1, displayTitle="Other")],
        "blocks": [comp("blk1", "art1", 1, displayTitle="Use case"), comp("blk2", "art1", 2),
                   comp("blk3", "art2", 1)],
        "components": [
            comp("c1", "blk1", 2, _component="accordion", title="editor label", instruction="Select the item to learn more.",
                 _items=[{"title": "<strong>Principals</strong>", "body": "<p>The <strong>who</strong>: an identity.</p>"},
                         {"title": "Roles", "body": "<ul><li>basic</li><li>predefined</li></ul>"}]),
            comp("c0", "blk1", 1, _component="text", body="<p>Intro with project_id and *stars*.&nbsp;</p><p><br></p>",
                 displayTitle="Add subtitle or remove"),
            comp("c2", "blk2", 1, _component="videoStream", body="<p>Watch the video.</p>",
                 _transcript={"button": "Open transcript", "body": "<p>You are heading to e-commerce.</p>"}),
            comp("c3", "blk2", 2, _component="code", _codeString="SELECT 1;", _codeLanguage="sql"),
            comp("c4", "blk2", 3, _component="table", _rows=[["Pillar", "Goal"], ["Cost", "a|b"]]),
            comp("c5", "blk2", 4, _component="mcq", body="<p>Which is right?</p>",
                 _items=[{"text": "Yes", "_shouldBeSelected": True}, {"text": "No", "_shouldBeSelected": False}]),
            comp("c6", "blk2", 5, _component="text", body="<p>[Add text]</p>"),
            comp("c7", "blk2", 6, _component="text", body="<p>hidden</p>", _isHidden=True),
            comp("c8", "blk3", 1, _component="text", body="<p>text of another page here</p>"),
        ],
    }


def fetch_from(data, calls=None):
    def fetch(url):
        if calls is not None:
            calls.append(url)
        name = url.rsplit("/", 1)[-1][:-5]
        if name == "config":
            raise bundle.BundleError(404, "none")
        return data[name]
    return fetch


@pytest.fixture(autouse=True)
def clear_cache():
    bundle._cache.clear()


def test_parse_src_accepts_only_google_training_bundles():
    base, page = bundle.parse_src(SRC)
    assert base == "https://storage.googleapis.com/cloud-training/T-X/3.0/My%20Course%20(2)" and page == PAGE
    for bad in ["https://evil.example/cloud-training/x/index.html#/page/" + "a" * 24,
                "http://storage.googleapis.com/cloud-training/x/index.html#/page/" + "a" * 24,
                "https://storage.googleapis.com/other-bucket/x/index.html#/page/" + "a" * 24,
                "https://storage.googleapis.com/cloud-training/../x/index.html#/page/" + "a" * 24,
                "https://storage.googleapis.com/cloud-training/x/index.html"]:
        with pytest.raises(bundle.BundleError) as e:
            bundle.parse_src(bad)
        assert e.value.status == 400


def test_page_is_rendered_in_reading_order_as_markdown():
    md = bundle.markdown_for(SRC, fetch_from(course()))
    assert md.startswith("# Operational excellence\n")           # entity decoded
    assert "## Operational excellence" not in md                  # article title equal to the page title is not repeated
    assert "### Use case" in md
    assert md.index("Intro with project_id and *stars*.") < md.index("**Principals**")   # sort order, no escaping
    assert "**Principals**\n\nThe **who**: an identity." in md
    assert "- basic\n- predefined" in md
    assert "Transcript: You are heading to e-commerce." in md
    assert "```sql\nSELECT 1;\n```" in md
    assert "| Pillar | Goal |\n| --- | --- |\n| Cost | a\\|b |" in md
    assert "- ✅ Yes\n\n- ⬜ No" in md or "- ✅ Yes\n- ⬜ No" in md
    for absent in ("editor label", "editor title", "Select the item", "[Add text]", "Add subtitle", "hidden", "another page", "&nbsp;"):
        assert absent not in md


def test_flip_card_back_does_not_repeat_the_title():
    data = course()
    data["components"] = [{"_id": "f1", "_parentId": "blk1", "_sortOrder": 1, "_component": "flipCard",
                           "instruction": "Flip each card to review the principles.",
                           "_items": [{"frontText": "<p><strong>Manage incidents</strong></p>",
                                       "backText": "<p>Manage incidents</p><p>Follow clear procedures.</p>"},
                                      {"frontText": "<p>Automate change</p>",
                                       "backText": "<p><strong>Automate change</strong></p><p>Use CI/CD pipelines.</p>"}]}]
    md = bundle.markdown_for(SRC, fetch_from(data))
    assert "*Flip each card to review the principles.*" in md
    assert md.count("Manage incidents") == 1 and md.count("Automate change") == 1
    assert "**Manage incidents**\n\nFollow clear procedures." in md
    assert "**Automate change**\n\nUse CI/CD pipelines." in md


def test_long_instructions_naming_the_topic_are_kept_and_short_ui_ones_dropped():
    data = course()
    data["components"] = [
        {"_id": "i1", "_parentId": "blk1", "_sortOrder": 1, "_component": "accordion", "body": "<p>Body text of the accordion.</p>",
         "instruction": "Select each item below to explore the five key business values you will build."},
        {"_id": "i2", "_parentId": "blk1", "_sortOrder": 2, "_component": "tabs", "body": "<p>Body text of the tabs.</p>",
         "instruction": "Select each card to learn more."}]
    md = bundle.markdown_for(SRC, fetch_from(data))
    assert "explore the five key business values" in md and "learn more" not in md


def test_a_menu_id_renders_every_page_below_it_and_unknown_ids_fail():
    src = SRC.replace("a" * 24, "d" * 24)
    md = bundle.markdown_for(src, fetch_from(course()))
    assert "# Operational excellence" in md and "# Second" in md and "another page" in md
    with pytest.raises(bundle.BundleError) as e:
        bundle.markdown_for(SRC.replace("a" * 24, "f" * 24), fetch_from(course()))
    assert e.value.status == 404


def test_course_json_is_cached_between_lessons():
    calls = []
    fetch = fetch_from(course(), calls)
    bundle.markdown_for(SRC, fetch)
    n = len(calls)
    bundle.markdown_for(SRC.replace("a" * 24, "b" * 24), fetch)
    assert len(calls) == n


def test_empty_page_is_an_error():
    data = course()
    data["components"] = []
    with pytest.raises(bundle.BundleError) as e:
        bundle.markdown_for(SRC, fetch_from(data))
    assert e.value.status == 422


# ---- Articulate Rise bundles (#/lessons/<id>)

def _rise_fetch(lessons):
    import base64, json
    payload = base64.b64encode(json.dumps({"course": {"lessons": lessons}}).encode()).decode()
    return lambda url: f'__jsonp("runtime-data.js","{payload}");'


RISE = "https://storage.googleapis.com/cloud-training/cls-html5-courses/X/v1/EN/content/index.html#/lessons/lesson-aaaa1111"


def test_rise_lesson_is_rendered_by_variant():
    block = lambda t, v, items: {"type": t, "variant": v, "items": items}
    lesson = {"id": "lesson-aaaa1111", "type": "blocks", "title": "Monitoring", "items": [
        block("image", "hero", [{"heading": "<p>template banner text</p>"}]),
        block("text", "paragraph", [{"heading": "<strong>Heading</strong>", "paragraph": "<p>Real <b>text</b> here.</p>"}]),
        block("text", "heading", [{"heading": "<p>Golden signals</p>", "paragraph": "<p>stale unshown text</p>"}]),
        block("list", "bulleted", [{"paragraph": "<p>one</p>"}, {"paragraph": "<p>two</p>"}]),
        block("interactive", "accordion", [{"title": "Latency", "description": "<p>How long it takes.</p>"}]),
        block("interactive", "flashcard", [{"front": {"type": "fullimage", "description": "Front of card 1"},
                                            "back": {"description": "<p>Card back</p>"}}]),
        block("multimedia", "code", [{"code": "up{job=&quot;x&quot;}"}]),
    ]}
    bundle._cache.clear()
    md = bundle.markdown_for(RISE, fetch_text=_rise_fetch([lesson]))
    assert md.startswith("# Monitoring")
    assert "Real **text** here." in md and "### Golden signals" in md and "- one\n- two" in md
    assert "**Latency**\n\nHow long it takes." in md and "Card back" in md and 'up{job="x"}' in md
    for hidden in ("template banner", "Heading", "stale unshown", "Front of card"):
        assert hidden not in md


def test_rise_knowledge_check_keeps_its_options_and_marks_the_right_ones():
    check = {"type": "knowledgeCheck", "variant": "multiple choice", "items": [{
        "type": "MULTIPLE_CHOICE", "title": "<p>Which mode?</p>",
        "answers": [{"title": "<p>Quick</p>", "correct": False}, {"title": "<p>Deep</p>", "correct": True}, {"title": "", "correct": False}],
        "feedbackCorrect": "<p>Yes</p>"}]}
    lesson = {"id": "lesson-aaaa1111", "type": "blocks", "title": "Modes", "items": [check]}
    bundle._cache.clear()
    md = bundle.markdown_for(RISE, fetch_text=_rise_fetch([lesson]))
    assert "**Which mode?**\n\n- ⬜ Quick\n- ✅ Deep" in md and md.count("- ") == 2


def test_rise_unknown_lesson_and_bad_payload():
    import pytest
    bundle._cache.clear()
    with pytest.raises(bundle.BundleError) as e:
        bundle.markdown_for(RISE, fetch_text=_rise_fetch([]))
    assert e.value.status == 404
    bundle._cache.clear()
    with pytest.raises(bundle.BundleError) as e:
        bundle.markdown_for(RISE, fetch_text=lambda url: "<html>")
    assert e.value.status == 502
