"""Code typed as plain paragraphs in a Udemy quiz is fenced by the userscript (no AI): the pure rules, run in node.

The functions between the <code-in-paragraphs> markers of userscript/mathesis-udemy.user.js are extracted and called with
the lines of consecutive <p> elements, as the page gives them (one paragraph per line, spaces kept).
"""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "userscript" / "mathesis-udemy.user.js"
pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="node is not installed")


def fence(paragraphs: list[list[str] | None]) -> list[dict]:
    """[{start, end, lang, text}] for the code segments of these paragraphs (each a list of lines)."""
    block = re.search(r"// <code-in-paragraphs>(.*?)// </code-in-paragraphs>", SCRIPT.read_text(encoding="utf-8"), re.S).group(1)
    js = block + f"""
const items = {json.dumps(paragraphs)};
console.log(JSON.stringify(codeSegments(items).map((s) => ({{...s,
  text: fencedBlock(items.slice(s.start, s.end + 1).flat(), s.lang)}}))));"""
    done = subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True)
    return json.loads(done.stdout)


def lines(*paragraphs: str) -> list[list[str]]:
    return [p.split("\n") for p in paragraphs]


PIPELINE = lines(
    "You have a pipeline with the following steps and the deployment fails. What is the cause?",
    "steps:", "", "  - name: python", "    entrypoint: pip", "    args: [\"install\", \"-r\", \"requirements.txt\"]", "",
    "  - name: google/cloud-sdk", "    args: ['gcloud', 'run', 'deploy',", "      'hello-${SHORT_SHA}',", "      '--region', 'us-central1']", "",
    "When the pipeline runs, the final step fails. What should you do?")


def test_the_pipeline_yaml_is_one_yaml_block_between_the_sentences():
    [seg] = fence(PIPELINE)
    assert (seg["start"], seg["end"]) == (1, 10)
    assert seg["lang"] == "yaml"
    assert seg["text"] == (
        "\n\n```yaml\nsteps:\n\n  - name: python\n    entrypoint: pip\n    args: [\"install\", \"-r\", \"requirements.txt\"]\n\n"
        "  - name: google/cloud-sdk\n    args: ['gcloud', 'run', 'deploy',\n      'hello-${SHORT_SHA}',\n"
        "      '--region', 'us-central1']\n```\n\n")


def test_no_indentation_in_the_text_no_fence_from_a_key_line_alone():
    assert fence(lines("Note: read the question twice", "Warning: options may repeat")) == []


def test_prose_with_a_trailing_comma_or_bracket_is_not_code():
    assert fence(lines("The services (Cloud Run and GKE)", "must both be reachable (via the VPC)")) == []


def test_a_single_shell_command_is_fenced_as_bash():
    [seg] = fence(lines("Run this:", "gcloud run deploy hello --region us-central1", "and then?"))
    assert (seg["start"], seg["end"], seg["lang"]) == (1, 1, "bash")


def test_a_single_indented_paragraph_is_not_code():
    assert fence(lines("   An author's indented sentence.")) == []


def test_two_command_lines_and_the_prose_after_them():
    [seg] = fence(lines("$ gcloud config set project demo", "$ gcloud run deploy hello", "Which flag is missing?"))
    assert (seg["start"], seg["end"], seg["lang"]) == (0, 1, "bash")


def test_json_and_python_are_recognised():
    [js] = fence(lines("{", '  "name": "demo",', '  "tags": ["a", "b"]', "}"))
    assert js["lang"] == "json"
    [py] = fence(lines("def handler(request):", "    return 'ok'"))
    assert py["lang"] == "python"


def test_common_indentation_is_removed_and_nbsp_counts_as_a_space():
    [seg] = fence(lines("\u00a0\u00a0if x:", "\u00a0\u00a0\u00a0\u00a0y()"))
    assert seg["text"] == "\n\n```\nif x:\n  y()\n```\n\n"


def test_two_blocks_separated_by_prose_stay_two():
    segs = fence(lines("  a = 1", "  b = 2", "In between, a sentence that is only prose.", "  c = 3", "  d = 4"))
    assert [(s["start"], s["end"]) for s in segs] == [(0, 1), (3, 4)]


def test_a_paragraph_that_is_not_plain_text_breaks_the_run():
    assert fence([["  a = 1"], None, ["  b = 2"]]) == []


def test_a_lone_command_that_reads_like_a_sentence_is_not_code():
    assert fence(lines("gcloud get-credentials already manages kubeconfig entries correctly and securely.")) == []
    assert fence(lines("gcloud run deploy, what is the next step?")) == []
