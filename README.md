# Mathesis

*μάθησις*, "learning". Saves the transcript of a Google Skills lesson from the browser and turns it into study notes with a local [Ollama](https://ollama.com) model.

```
browser (userscript)  --POST transcript-->  mathesis serve  --Ollama-->  <lesson>.md + <lesson>-summary.md
```

## Install

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"        # dev adds pytest and httpx2
.venv/bin/mathesis doctor                # checks Ollama, the model, folders, prompts, notifications
```

Pull the model once: `ollama pull gemma4:12b`.

## Use

```bash
mathesis serve                           # server on 127.0.0.1:5000, hot reload on code changes
mathesis summarize PATH [PATH ...]       # write <file>-summary.md for transcript files, or every .md in a folder
mathesis summarize lesson.md --stdout    # print the notes instead of writing a file
mathesis doctor
```

Install `userscript/mathesis.user.js` in Tampermonkey. On a lesson page it adds a button under the profile avatar: red = not saved yet, green = saved (with summary).

On a **quiz** page the button reads "Copy Quiz": the userscript saves a readable Markdown copy (numbered questions, `- [ ]` options, your selected option checked) as `NN-<quiz title>.md` and tells the server it is a quiz (`X-Mathesis-Kind: quiz`), so no summary is made.

## Installing the userscripts from the server

With `mathesis serve` running, install each script with **Install from URL** (Tampermonkey: Utilities; Violentmonkey: "+" > Install from URL):

- `http://127.0.0.1:5000/userscript/mathesis.user.js` (Google Skills)
- `http://127.0.0.1:5000/userscript/mathesis-udemy.user.js` (Udemy)

`http://127.0.0.1:5000/userscript` is a page listing the scripts with an **Install** button for each (`/userscript.json` is the plain list). They carry `@updateURL`/`@downloadURL` pointing at the same address, and the server reads the file on every request. `MATHESIS_USERSCRIPT_DIR` changes the folder (default: `userscript/` of the checkout). `@version` is `<commit count>.<sha>` of the commit that last changed the script (the count always grows, so update checks see a newer version; `scripts/stamp-userscripts.sh` sets it after you commit).

## Udemy

`userscript/mathesis-udemy.user.js` saves Udemy lectures to `Udemy/<course>/<NN>-<lecture>.md` through the same server (summaries included).
On a **quiz results** page the button reads "Copy Incorrect Questions": it selects the "incorrect" pill (and restores your pill afterwards), and saves only the wrong questions as `NN-<quiz title> - incorrect.md` with `X-Mathesis-Kind: quiz-review` (no summary). Each question has its domain, the options (your answer ❌, correct answer ✅) and Udemy's explanations; the explanations of the options you did not pick are in a folded callout.

`summarize` skips files that already have a summary (`--force` to overwrite). Useful flags: `--model`, `--single` (one call with the original prompt), `--no-revise`; `serve` also takes `--no-reload`, `--no-summary`, `--no-notify`, `--host`, `--port`, `--root`.

## Configuration

Environment variables (command-line flags override them):

| Variable | Default | Meaning |
|---|---|---|
| `MATHESIS_ROOT` | the Obsidian `_study_roadmap` folder (holds `Google Skills/` and `Udemy/`) | the only folder the server may write into |
| `MATHESIS_MODEL` | `gemma4:12b` | Ollama model used for every stage |
| `MATHESIS_OLLAMA_URL` | `http://172.17.0.1:11434` | Ollama server |
| `MATHESIS_NUM_CTX` | `16384` | context window (Ollama's default of 2048 truncates transcripts) |
| `MATHESIS_EMBED_MODEL` | `bge-m3:latest` | embedding model that finds which lesson a quiz question comes from |
| `MATHESIS_PIPELINE` | `two-stage` | or `single` |
| `MATHESIS_MAX_REVISIONS` | `2` | completeness revision rounds |
| `MATHESIS_HOST` / `MATHESIS_PORT` | `127.0.0.1` / `5000` | server address |
| `MATHESIS_SUMMARIZE` / `MATHESIS_NOTIFY` / `MATHESIS_NOTIFY_ON_SAVE` | on / on / off | summaries, desktop notifications |
| `MATHESIS_OBSIDIAN_OPEN` | on | clicking the "Summary ready" notification opens the summary in Obsidian |
| `MATHESIS_OBSIDIAN` | auto-detected | command that hands an `obsidian://` URI to Obsidian, e.g. the path of the Obsidian AppImage |

If you change the notes folder, change `BASE_DIR` in the userscript too: the server only accepts paths inside `MATHESIS_ROOT`.

## How the notes are made

1. **extract**: transcript to a faithful fact list, including a *Decision guide* when the lesson helps choose between options.
2. **synthesize**: fact list to notes organized by ideas: big idea, themes, *How to choose* (only when there is a decision guide), exam list.
3. **revise** (up to 2 rounds): `mathesis.coverage` checks every fact and required section made it into the notes; omissions are sent back to be merged in.

When a summary is ready you get a desktop notification; clicking it (or its "Open in Obsidian" button) opens the summary in the running Obsidian. Check it with `mathesis doctor --click-test`. On Wayland/GNOME the window may only flash in the taskbar instead of jumping to the front.

Every summary ends with a hidden comment naming the model, pipeline and revisions. Prompts live in `src/mathesis/prompts/` and are read on every request, so editing them needs no restart. `eval/` holds the experiments and the scoring scripts used to choose them (see `eval/evaluate.py`).

## Develop

```bash
.venv/bin/pytest
```
