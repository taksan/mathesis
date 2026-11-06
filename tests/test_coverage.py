from mathesis import coverage

DUMP = """## TL;DR
Something.

## Key concepts
- **Error budget**: the amount of downtime a service is willing to tolerate before releases must stop.
- **Canary population**: should be large enough to be representative of the control population.
    - Sub fact: the canary and control differ only by the production change being tested.

## Technologies & services
- **Looker**: dashboards.
"""

NOTES_OK = """## The big idea
x
## How it fits together
The error budget is the amount of downtime a service will tolerate. A canary population must be representative
of the control population, and the canary and control differ only by the production change being tested.
## Remember for the exam
- x
"""


def test_fact_bullets_skip_tldr_and_technologies():
    bullets = coverage.fact_bullets(DUMP)
    assert len(bullets) == 3
    assert not any("Looker" in b for b in bullets)


def test_nothing_missing_when_notes_cover_the_facts():
    assert coverage.missing_facts(DUMP, NOTES_OK) == []


def test_omitted_fact_is_reported():
    notes = NOTES_OK.replace("and the canary and control differ only by the production change being tested", "")
    missing = coverage.missing_facts(DUMP, notes)
    assert len(missing) == 1 and "differ only" in missing[0]


def test_required_sections():
    assert coverage.required_sections_missing(NOTES_OK) == []
    assert coverage.required_sections_missing("## The big idea\nx\n") == ["How it fits together", "Remember for the exam"]
