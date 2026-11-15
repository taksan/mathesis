# Mathesis

*μάθησις*, "learning". Saves the transcript of a Google Skills lesson from the browser and turns it into study notes with an LLM: a local [Ollama](https://ollama.com) model by default, or Gemini / any OpenAI-compatible API (see [Configuration file](#configuration-file)).

```
browser (userscript)  --POST transcript-->  mathesis serve  --Ollama-->  <lesson>.md + <lesson>-summary.md
```

## Install

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"        # dev adds pytest and httpx2
.venv/bin/mathesis doctor                # checks Ollama, the model, folders, prompts, notifications
```

Pull the model once: `ollama pull gemma4:12b` (not needed if you use another provider).

## Use

```bash
mathesis serve                           # server on 127.0.0.1:5000, hot reload on code changes
# the first line it prints is the version, e.g. "Mathesis 0.1.0 (build 50.778ef39)": <commit count>.<sha> of the checkout, "+dirty" if files are uncommitted
mathesis summarize PATH [PATH ...]       # write <file>-summary.md for transcript files, or every .md in a folder
mathesis summarize lesson.md --stdout    # print the notes instead of writing a file
mathesis doctor
```

Install `userscript/mathesis.user.js` in Tampermonkey. On a lesson page it adds a small **Mathesis panel** under the profile avatar: a status dot (amber = nothing saved yet, green = something saved, grey = server offline; a spinner with "Analyzing…" and no buttons while the page is still loading) and a table with **one row per kind of file**: the Save button on the left and, once that file exists, an **Open** button on the right (on Udemy quiz results: "Save to Review", "Save all as JSON", "Save all questions"). There is no status text while the server is online: a row with an Open button is saved. **Save or Copy:** while the server answers, the buttons say "Save …" and send to it; when it does not, the line "Server offline (retry)" appears (the link checks the server again at once), the buttons say "Copy …" and only copy to the clipboard, without trying to reach the server (also if it goes away between the check and the click). Hover a button for a tooltip that says what it will do. Drag its header to move it anywhere (the position is remembered per site and kept inside the window; double-click the header to put it back). The – button folds the panel to a small pill (also remembered); double Shift hides it completely.

On a **quiz** page the button reads "Copy Quiz": the userscript saves a readable Markdown copy (numbered questions, `- [ ]` options, your selected option checked) as `NN-<quiz title>.md` and tells the server it is a quiz (`X-Mathesis-Kind: quiz`), so no summary is made.

Some Google Skills lessons are **documents** whose text is not in the page at all: `<ql-iframe>` embeds an Evolve/Adapt course player from `storage.googleapis.com/cloud-training/...`. The button then reads "Copy Lesson" and sends only that URL (`X-Mathesis-Kind: bundle`); the server reads the course JSON next to it, renders the page (text, accordions, tabs, flip cards, tables, code, video transcripts, quiz questions) to Markdown with [markdownify](https://pypi.org/project/markdownify/), saves it and summarizes it like a transcript. Only that bucket is accepted, and the course JSON is cached for 30 minutes (all lessons of a course share it). Other courses embed an Articulate Rise export (`.../content/index.html#/lessons/<id>`); those are read from its `runtime-data.js` (flash cards, tabs, accordions, lists, code, quotes) the same way.

If a page has no recognisable content (no transcript, quiz or lab text), the button saves the **whole page HTML** instead: `X-Mathesis-Kind: raw`, file `<course>/<NN-lesson>.raw.html` next to the lessons (or `_raw/<url words>.raw.html` when the page title can't be read). Raw pages are never summarized; they are kept so the page can be analysed and the script taught about it.

On a **lab** page the button reads "Copy Lab" (`X-Mathesis-Kind: lab`). The lab instructions are saved and summarized like a transcript, and, by default, **Claude Code** (the `claude` CLI, run headless with `claude -p`, no tools, empty temporary folder, so it can only turn text into text) also writes `<lab>-lab-guide.md` next to it: the resources the lab creates, a setup block (variables, APIs), `gcloud` commands per lab task, Terraform only for what gcloud cannot create, verification commands and clean-up. Commands it is unsure about carry a `# VERIFY:` comment; read them before running anything. It takes about a minute and runs in parallel with the summary; a notification ("Lab guide ready") opens the guide in Obsidian. `--no-lab-guide` / `MATHESIS_LAB_GUIDE=0` turns it off, `MATHESIS_CLAUDE_MODEL` picks the model, `MATHESIS_CLAUDE` the CLI path; the prompt is `src/mathesis/prompts/lab_guide.txt`. This uses your Claude Code login (usage counts against it); `provider` in the config file switches it (together with summaries) to Gemini, Ollama or another API; `[lab_guide] provider` switches only the lab guides.

The **Open** button asks the server what exists (`GET /files`, sending the page's main file) instead of guessing file names. One document: Open opens it. Several (every attempt of a quiz review; summary, lab guide and transcript of a lesson or lab): it reads "Open ▾" and lists them, newest attempt first. A summary or lab guide still being written shows greyed out with a spinner in that list (and a spinner badge on the button) until the file exists; one that failed shows "failed". The server keeps those jobs in memory, so a reload of the page shows them correctly, a restart of the server forgets them. Markdown files open in Obsidian (the server returns the `obsidian://` link, so the userscript never holds a local path; this needs the handler registered on your system); JSON files, and Markdown when Obsidian is missing, open in the text editor of the machine running the server (`POST /open`, only for files the listing returned; if no editor is found, the path is copied instead).

When a save fails, the userscript also uploads an **error report** (`POST /reports`): the page HTML, the URL, what was sent, the server's error and the script version. The alert shows the report ID. Reports are kept in a temporary folder (`MATHESIS_REPORT_DIR`, default `<tmp>/mathesis-reports`, newest 50) and can be inspected through the API:

```
GET /reports                 list, newest first
GET /reports/<id>            details (kind, path, status, error, url, sizes)
GET /reports/<id>/html       the page as it was (served as plain text, never rendered)
GET /reports/<id>/body       what the script sent (the lesson URL for bundles, the text otherwise)
```

Press **Shift twice** quickly on a page to hide or show the button (remembered per site).  The first time a script runs on a site, a toast (click to dismiss, gone after 8 s) tells you this; it is shown once per site.

## Installing the userscripts from the server

With `mathesis serve` running, install each script with **Install from URL** (Tampermonkey: Utilities; Violentmonkey: "+" > Install from URL):

- `http://127.0.0.1:5000/userscript/mathesis.user.js` (Google Skills)
- `http://127.0.0.1:5000/userscript/mathesis-udemy.user.js` (Udemy)

`http://127.0.0.1:5000/userscript` is a page listing the scripts with an **Install** button for each (`/userscript.json` is the plain list). They carry `@updateURL`/`@downloadURL` pointing at the same address, and the server reads the file on every request. `MATHESIS_USERSCRIPT_DIR` changes the folder (default: `userscript/` of the checkout). `@version` is `<commit count>.<sha>` of the commit that last changed the script (the count always grows, so update checks see a newer version; `scripts/stamp-userscripts.sh` sets it after you commit).

## Udemy

`userscript/mathesis-udemy.user.js` saves Udemy lectures to `Udemy/<course>/<NN>-<lecture>.md` through the same server (summaries included).
On a **quiz results** page the button reads "Save to Review" ("Copy to Review" when the server is offline): it reads the "incorrect" pill, then the "marked" pill (and restores your pill afterwards), and saves one file, `NN-incorrect.md` (the folder names the course and the tests are numbered, so the quiz title is not repeated), with `X-Mathesis-Kind: quiz-review` (no summary). It has two `#` sections: **Incorrect** (the questions you got wrong; `Question N*` with an asterisk means wrong and **not marked**, i.e. you felt sure: a clear misconception) and **To Review** (questions you marked because you were not sure, but answered correctly; marked questions you got wrong are already under Incorrect). Each question has its domain, the options (your answer ❌, correct answer ✅) and Udemy's explanations; the explanations of the options you did not pick are in a folded callout.  Quizzes that give one "Overall explanation" per question instead of one per option (the "Practice Exams" format) are handled too: that text goes under "### Explanation".

On the same page a second button, **Copy All Questions**, saves `NN-all questions.md` (`X-Mathesis-Kind: quiz-all`, no summary): every question of the attempt in its original order (it reads the "all" pill and restores yours) with the options and Udemy's explanations, but nothing that marks the wrong ones: no ❌, no "your answer", no Incorrect / To Review split and no `*`. Only the correct options are ticked, so the file works as a clean study copy of the whole test.

Saving **to Review** again when its file already exists asks what to do: **Keep both** saves this one as another attempt (`NN-incorrect (attempt 2).md`; the number is the page's "Attempt N", or the next free one), **Overwrite** replaces the file, **Cancel** (or Esc) saves nothing. That file depends on the attempt; "all questions" (Markdown and JSON) is the same whatever the attempt, so saving it again just overwrites it. Lecture transcripts are unchanged too. The extra attempts count as derived files, so `mathesis` never mistakes them for lessons.

A third button, **Save all as JSON**, saves the same questions as `NN-all questions.json` next to it (`X-Mathesis-Kind: quiz-json`, saved as is, no summary), for other tools. If the server cannot be reached the browser downloads the file instead. Each question has `question`, `type` (`"multi"` when more than one option is correct, else `"single"`), `options` (each with `text`, `correct` and its own `explanation`) and an overall `explanation`; it also has `number` and `domain`. The file records the exam's time limit as `timeLimitMinutes` (an integer, or `null`) and `timeLimitText` (the sentence it came from): Udemy's results page has no field for it, so the script reads it from the page text outside the questions, from sentences such as "50-60 multiple-choice questions in 2 hours" or "Time limit: 90 minutes" in the course description, and stores `null` when the page says nothing. Quizzes that only give one overall explanation leave the option explanations empty, and the other way round. Nothing says what you answered. The format is defined by [`schema/quiz-questions.schema.json`](schema/quiz-questions.schema.json) (JSON Schema 2020-12: a `single` question must have exactly one correct option, a `multi` one at least two), and `tests/test_quiz_schema.py` validates real userscript output against it (`pip install -e '.[dev]'` brings in `jsonschema`).

`summarize` skips files that already have a summary (`--force` to overwrite). Useful flags: `--model`, `--single` (one call with the original prompt), `--no-revise`; `serve` also takes `--no-reload`, `--no-summary`, `--no-notify`, `--host`, `--port`, `--root`.

## Configuration file

Settings can live in a TOML file: `--config`, else `$MATHESIS_CONFIG`, else `config.toml` in the application directory (the checkout; it is gitignored, so an API key in it is never committed). `mathesis config --init` asks four questions (notes folder, default provider, provider for summaries, provider for lab guides) and writes a minimal valid file, then tells you what to set before starting (`src/mathesis/config.example.toml` lists every option, commented); `mathesis config` shows what is in use; `mathesis doctor` tests the backends. Precedence: file < `MATHESIS_*` environment variables < command-line flags. Restart `mathesis serve` after editing; a mistyped key or unknown provider is reported with its name instead of being ignored.

One **provider** serves everything (summaries and lab guides); a job overrides it only when it needs something different:

```toml
provider = "gemini"            # the one provider: ollama | gemini | openai | claude-code | <your own table> | none

[summary]                      # optional: only what differs from the above
# model = "gemini-3.8-flash"   # another model of the same provider
# provider = "ollama"          # or another provider, for this job only

[lab_guide]
# provider = "claude-code"

[providers.gemini]             # details of a provider (url, model); only used when it is selected above
# model = "gemini-3.8-flash"
```

Without a `provider` line the original behavior stays: Ollama for summaries, Claude Code for lab guides. `mathesis config` shows the provider each job ends up with (`[default]` or `[override]`) and warns about a configured provider nothing uses.

**API keys are never put in the config file.** Export `GEMINI_API_KEY` in the shell that starts `mathesis serve`, or write `GEMINI_API_KEY=...` to a `.env` file next to the config file (gitignored; variables already in the environment win) (`OPENAI_API_KEY` for `openai`, `<NAME>_API_KEY` for a provider you define, e.g. `OPENROUTER_API_KEY`). The server checks it at startup and complains (log line plus desktop notification) if it is missing; `mathesis config` and `mathesis doctor` show whether it is set. Gemini is reached through its OpenAI-compatible endpoint, so any other OpenAI-style server works the same way: add `[providers.<name>]` with `type = "openai"`, `url`, `model` (export `<NAME>_API_KEY` if it needs a key), e.g. OpenRouter, LM Studio, vLLM. Rate-limit answers (HTTP 429/5xx) are retried with a pause. The default Gemini model is `gemini-3.8-flash` (the 2.5 models are deprecated); change `model` for another one, since Google renames models often.

**No LLM at all.** `llm = false` at the top of the config file (or `MATHESIS_LLM=0`, or `mathesis serve --no-llm`) switches every LLM feature off: no summaries, no lab guides, no provider is contacted or checked (so a missing key or an unreachable Ollama is not a warning), no "Saved without summary" notifications and no pending spinners in the panel. Everything else works as before: transcripts, quizzes, labs and JSON are saved, Open works, and the providers in the file are just parked. `mathesis summarize` refuses to run, and `mathesis doctor` / `mathesis config` say the LLM is off. Use `provider = "none"` instead to switch a single job off.

**Fallback.** If the chosen backend is down, unreachable, has no key or (Claude Code) is not installed, the lesson or lab is saved anyway and only the summary / lab guide is skipped, with one desktop notification per outage ("Saved without summary"). The backend is checked again on every save, so starting Ollama later is enough. `provider = "none"` (or `--no-summary`) switches a job off on purpose.

Privacy: with an external provider the lesson text (transcripts, lab instructions) is sent to that service. Lab capture already leaves out the lab account's username and password. The embedding model that matches quiz questions to lessons always runs on Ollama.

## Environment variables

They override the config file; command-line flags override them.

| Variable | Default | Meaning |
|---|---|---|
| `MATHESIS_ROOT` | the Obsidian `_study_roadmap` folder (holds `Google Skills/` and `Udemy/`) | the only folder the server may write into |
| `MATHESIS_CONFIG` | `config.toml` in the application directory | the config file |
| `MATHESIS_PROVIDER` | none (`ollama` for summaries, `claude-code` for lab guides) | the one provider for every job |
| `MATHESIS_SUMMARY_PROVIDER` / `MATHESIS_LAB_PROVIDER` | the provider above | override per job (`none` = off) |
| `MATHESIS_MODEL` | `gemma4:12b` | Ollama model used for every stage |
| `MATHESIS_OLLAMA_URL` | `http://172.17.0.1:11434` | Ollama server |
| `MATHESIS_NUM_CTX` | `16384` | context window (Ollama's default of 2048 truncates transcripts) |
| `MATHESIS_EMBED_MODEL` | `bge-m3:latest` | embedding model that finds which lesson a quiz question comes from |
| `MATHESIS_PIPELINE` | `two-stage` | or `single` |
| `MATHESIS_MAX_REVISIONS` | `2` | completeness revision rounds |
| `MATHESIS_HOST` / `MATHESIS_PORT` | `127.0.0.1` / `5000` | server address |
| `MATHESIS_SUMMARIZE` / `MATHESIS_NOTIFY` / `MATHESIS_NOTIFY_ON_SAVE` | on / on / off | summaries, desktop notifications |
| `MATHESIS_REPORT_DIR` | `<tmp>/mathesis-reports` | where error reports are kept |
| `MATHESIS_LAB_GUIDE` / `MATHESIS_CLAUDE` / `MATHESIS_CLAUDE_MODEL` / `MATHESIS_CLAUDE_TIMEOUT` | on / `claude` / Claude Code's default / `900` | lab guides written by Claude Code |
| `MATHESIS_OBSIDIAN_OPEN` | on | clicking the "Summary ready" notification opens the summary in Obsidian |
| `MATHESIS_OBSIDIAN` | auto-detected | command that hands an `obsidian://` URI to Obsidian, e.g. the path of the Obsidian AppImage |
| `MATHESIS_EDITOR` | auto-detected | text editor used instead when Obsidian is not installed, e.g. `gedit` or `code -r` (a graphical editor on PATH is tried, then `xdg-open`; macOS `open -t`, Windows notepad) |

The userscripts only send paths relative to `MATHESIS_ROOT` (`Google Skills/...`, `Udemy/...`), so no local folder is exposed in them. To move your notes, change `MATHESIS_ROOT` on the server; the server refuses absolute paths and anything that escapes the root.

## How the notes are made

1. **extract**: transcript to a faithful fact list, including a *Decision guide* when the lesson helps choose between options.
2. **synthesize**: fact list to notes organized by ideas: big idea, themes, *How to choose* (only when there is a decision guide), exam list.
3. **revise** (up to 2 rounds): `mathesis.coverage` checks every fact and required section made it into the notes; omissions are sent back to be merged in.

When a summary is ready you get a desktop notification; clicking it (or its "Open in Obsidian" button) opens the summary in the running Obsidian. Check it with `mathesis doctor --click-test`. On Wayland/GNOME the window may only flash in the taskbar instead of jumping to the front. **Without Obsidian** (none found, see `mathesis doctor` or the first lines the server prints) the notification button says "Open in text editor", the userscript's purple button reads "Open in editor", and the note opens in a text editor on the machine running the server (`POST /open`).

Every summary ends with a hidden comment naming the model, pipeline and revisions. Prompts live in `src/mathesis/prompts/` and are read on every request, so editing them needs no restart. `eval/` holds the experiments and the scoring scripts used to choose them (see `eval/evaluate.py`).

## Develop

```bash
.venv/bin/pytest
```
