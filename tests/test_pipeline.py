from pathlib import Path

from mathesis.config import Settings
from mathesis.pipeline import build_user_message, clean_summary, load_prompt, render, summarize, summary_path


class FakeClient:
    """Answers with canned texts in order and records the user messages."""
    def __init__(self, answers):
        self.answers, self.calls = list(answers), []

    def chat(self, system, user, temperature=0.2):
        self.calls.append((system, user))
        return self.answers.pop(0)


def test_summary_path():
    assert summary_path("/a/b/23-Lesson.md") == Path("/a/b/23-Lesson-summary.md")


def test_build_user_message_uses_path_context():
    msg = build_user_message("{learning_path}|{course}|{lesson}|{content}",
                             "TEXT", "/v/Path X/Course Y/05-Some lesson.md")
    assert msg == "Path X|Course Y|Some lesson|TEXT"


def test_clean_summary_drops_empty_technologies_section():
    assert clean_summary("## A\nx\n\n## Technologies & services\n- **None**\n") == "## A\nx\n"
    assert clean_summary("## A\nx\n\n## Technologies & services\nNone\n") == "## A\nx\n"
    kept = "## A\nx\n\n## Technologies & services\n- **Looker**: dashboards\n"
    assert "Looker" in clean_summary(kept)


def test_all_packaged_prompts_exist_and_format():
    for name in ["extract", "synthesize", "single"]:
        system, user = load_prompt(name)
        assert system.strip()
        user.format(learning_path="a", course="b", lesson="c", content="d")
    assert load_prompt("revise")[0].strip()


def test_render_adds_model_footer():
    text = render("## A\nx", {"prompts": "extract+synthesize", "revisions": 1}, Settings(model="m:1"))
    assert text.rstrip().endswith("<!-- summary: model=m:1 pipeline=two-stage prompts=extract+synthesize revisions=1 -->")


GOOD_NOTES = "## The big idea\nx\n## How it fits together\ny\n## Remember for the exam\n- z\n"


def test_two_stage_without_revision():
    dump = "## Key concepts\n- **A**: alpha beta gamma delta\n"
    client = FakeClient([dump, GOOD_NOTES.replace("y", "alpha beta gamma delta")])
    notes, info = summarize("T", "/v/P/C/01-L.md", client, Settings(), log=lambda *_: None)
    assert info["revisions"] == 0 and len(client.calls) == 2
    assert "alpha beta gamma delta" in client.calls[1][1]          # stage 2 receives the fact list, not the transcript


def test_revision_is_requested_for_omitted_facts():
    dump = "## Key concepts\n- **Roles**: tech lead sets technical direction and builds consensus\n"
    client = FakeClient([dump, GOOD_NOTES, GOOD_NOTES.replace("y", "tech lead sets technical direction and builds consensus")])
    notes, info = summarize("T", "/v/P/C/01-L.md", client, Settings(), log=lambda *_: None)
    assert info["revisions"] == 1
    assert "OMITTED FACTS" in client.calls[2][1] and "tech lead" in client.calls[2][1]


def test_single_pipeline_makes_one_call():
    client = FakeClient(["## Summary\nhello"])
    notes, info = summarize("T", "/v/P/C/01-L.md", client, Settings(pipeline="single"), log=lambda *_: None)
    assert len(client.calls) == 1 and info["prompts"] == "single"
