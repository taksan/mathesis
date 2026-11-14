from mathesis import lessons


class FakeClient:
    """Embeds a text as a 3-dim vector counting topic words, so similarity is predictable."""
    embed_model = "fake"

    def embed(self, texts):
        topics = ["toil", "postmortem", "canary"]
        return [[float(t.lower().count(w)) + 0.01 for w in topics] for t in texts]


def _course(tmp_path):
    (tmp_path / "20-Toil.md").write_text("# Toil\n\n" + "Toil is manual repetitive work. Toil should be bounded. " * 6)
    (tmp_path / "11-Postmortems.md").write_text("# Postmortems\n\n" + "A blameless postmortem teaches the team. Postmortem culture. " * 6)
    (tmp_path / "20-Toil-summary.md").write_text("## summary about toil toil toil")
    (tmp_path / "36-Final Assessment.md").write_text("# Final Assessment\n\n*20 questions · multiple choice · passing score 75%*\n\n## 1. toil toil")
    return tmp_path


def test_lesson_files_skip_summaries_and_quiz_copies(tmp_path):
    assert [f.name for f in lessons.lesson_files(_course(tmp_path))] == ["11-Postmortems.md", "20-Toil.md"]


def test_passages_merge_tiny_paragraphs_and_drop_the_title():
    text = "# Title\n\nshort one\n\n" + "x" * 250 + "\n\ntail"
    out = lessons.passages(text)
    assert len(out) == 2 and out[0].startswith("short one") and out[0].endswith("x" * 250)   # tiny paragraph merged forward
    assert out[1] == "tail" and "Title" not in "".join(out)


def test_search_returns_one_best_passage_per_lesson_most_similar_first(tmp_path):
    idx = lessons.LessonIndex(FakeClient(), cache_path=tmp_path / "cache.json").build(_course(tmp_path))
    top = idx.search("Why should toil be limited?", k=2)
    assert [m.title for m in top] == ["20-Toil", "11-Postmortems"]
    assert top[0].score > top[1].score and "Toil" in top[0].passage


def test_embeddings_are_cached_on_disk(tmp_path):
    calls = []

    class Counting(FakeClient):
        def embed(self, texts):
            calls.append(len(texts))
            return super().embed(texts)

    course = _course(tmp_path)
    lessons.LessonIndex(Counting(), cache_path=tmp_path / "c.json").build(course)
    first = sum(calls)
    lessons.LessonIndex(Counting(), cache_path=tmp_path / "c.json").build(course)
    assert first > 0 and sum(calls) == first        # second build embeds nothing new


def test_all_questions_file_is_derived_not_a_lesson(tmp_path):
    course = tmp_path / "Course"
    course.mkdir()
    for name in ("01-Intro.md", "02-Quiz - incorrect.md", "02-Quiz - all questions.md", "03-incorrect.md", "03-all questions.md", "03-lessons to learn.md"):
        (course / name).write_text("x")
    assert [f.name for f in lessons.lesson_files(course)] == ["01-Intro.md"]
