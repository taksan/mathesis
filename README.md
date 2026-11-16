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

Install `userscript/mathesis.user.js` in Tampermonkey. On a lesson page it adds a small **Mathesis panel** under the profile avatar: a header (the **μ** icon, name, status dot, fold button), a **save** row of chips and, below, a **files** list. The chips are the things you can save here (Udemy quiz results: "to review", "all", "json"; a lecture: "transcript"; a Google Skills lab: "lab"; also "lesson" and "quiz"); a small green dot on a chip says that file already exists. Each saved file gets a row: click its name to open it locally (Obsidian for Markdown, your text editor for JSON), or use its **⋯** menu: *open locally*, *copy the content* (to the clipboard), *copy file path* (absolute), *show in folder* (the system file manager); a summary or lab guide also has **Regenerate…**, which asks for confirmation and then has the configured AI provider write it again from the saved lesson. A summary or lab guide still being written is greyed with a spinner and "writing…"; one that failed shows "failed" (click it for the reason). There is no status text while the server is online; a spinner with "Analyzing…" and nothing else shows while the page is still loading. **Save or Copy:** while the server answers, the chips save; when it does not, the line "Server offline (retry)" appears (the link checks the server again at once), the row is labelled **copy** and the chips only copy to the clipboard, without trying to reach the server (also if it goes away between the check and the click). Hover anything for a tooltip beside the panel. Drag the header to move the panel anywhere (the position is remembered per site and kept inside the window; double-click the header to put it back). The – button folds it into a **vertical tab glued to the right edge of the window** (the **μ** icon on top, **one save button** under it that does the main action of the page (a small green dot on it says that file exists; a spinner replaces the dot while a summary or lab guide is being written); messages (saved, copied, errors) appear as **toasts** in the bottom-right corner instead of blocking dialogs: success fades after a few seconds, an error stays until you dismiss it (so you can copy the error-report ID); only questions that need an answer (overwrite your notes? delete an offline copy?) still use a dialog, the status dot at the bottom; click the μ to expand or fold again, from either state; you can drag it up and down, and the open panel keeps its own place; also remembered: **the panel starts folded** until you unfold it once); double Shift hides it completely.

On a **quiz** page the button reads "Copy Quiz": the userscript saves a readable Markdown copy (numbered questions, `- [ ]` options, your selected option checked) as `NN-<quiz title>.md` and tells the server it is a quiz (`X-Mathesis-Kind: quiz`), so no summary is made.

Some Google Skills lessons are **documents** whose text is not in the page at all: `<ql-iframe>` embeds an Evolve/Adapt course player from `storage.googleapis.com/cloud-training/...`. The button then reads "Copy Lesson" and sends only that URL (`X-Mathesis-Kind: bundle`); the server reads the course JSON next to it, renders the page (text, accordions, tabs, flip cards, tables, code, video transcripts, quiz questions) to Markdown with [markdownify](https://pypi.org/project/markdownify/), saves it and summarizes it like a transcript. Only that bucket is accepted, and the course JSON is cached for 30 minutes (all lessons of a course share it). Other courses embed an Articulate Rise export (`.../content/index.html#/lessons/<id>`); those are read from its `runtime-data.js` (flash cards, tabs, accordions, lists, code, quotes) the same way.

If a page has no recognisable content (no transcript, quiz or lab text), the button saves the **whole page HTML** instead: `X-Mathesis-Kind: raw`, file `<course>/<NN-lesson>.raw.html` next to the lessons (or `_raw/<url words>.raw.html` when the page title can't be read). Raw pages are never summarized; they are kept so the page can be analysed and the script taught about it.

On a **lab** page the button reads "Copy Lab" (`X-Mathesis-Kind: lab`). The lab instructions are saved and summarized like a transcript, and, by default, **Claude Code** (the `claude` CLI, run headless with `claude -p`, no tools, empty temporary folder, so it can only turn text into text) also writes `<lab>-lab-guide.md` next to it: the resources the lab creates, a setup block (variables, APIs), `gcloud` commands per lab task, Terraform only for what gcloud cannot create, verification commands and clean-up. Commands it is unsure about carry a `# VERIFY:` comment; read them before running anything. It takes about a minute and runs in parallel with the summary; a notification ("Lab guide ready") opens the guide in Obsidian. `--no-lab-guide` / `MATHESIS_LAB_GUIDE=0` turns it off, `MATHESIS_CLAUDE_MODEL` picks the model, `MATHESIS_CLAUDE` the CLI path; the prompt is `src/mathesis/prompts/lab_guide.txt`. This uses your Claude Code login (usage counts against it); `provider` in the config file switches it (together with summaries) to Gemini, Ollama or another API; `[lab_guide] provider` switches only the lab guides.

The files list asks the server what exists (`GET /files`, sending the page's main file) instead of guessing file names: every attempt of a quiz review (newest first), "all questions" and its JSON, or the summary, lab guide and transcript of a lesson or lab. The server keeps pending and failed summaries / lab guides in memory, so a reload of the page shows them correctly and a restart of the server forgets them. Markdown files open in Obsidian (the server returns the `obsidian://` link, so the userscript never holds a local path; this needs the handler registered on your system); JSON files, and Markdown when Obsidian is missing, open in the text editor of the machine running the server (`POST /open`, only for files the listing returned; if no editor is found, the path is copied instead). *Show in folder* is `POST /open` with `X-Mathesis-Open: folder`. *Regenerate* is `POST /regenerate` (`X-File-Path`: the lesson's main file, `X-Mathesis-Kind`: `summary` or `lab-guide`): it runs the same job as a save, in the background, and replaces the file only when the new text is ready, so a failure (provider down, bad answer) keeps the previous file and the row says "not regenerated" with the reason. It answers 409 when LLM features or that job are switched off, when the job is already running, or for a lab guide on a page that is not a lab. Edits you made to a summary or guide are replaced, which is what the confirmation says; your transcript and notes are never touched.

**Offline copies.** When the server is not running the chips say *copy*: besides putting the text on the clipboard they keep an **offline copy** in that site's browser storage (`localStorage` on udemy.com or skills.google, one key per file; about 5 MB per site, so a few dozen notes; clearing the site data removes them). The panel lists them under "offline copies" (tagged *offline*), for the page they were made on (every attempt of a quiz counts as the same page). Click one, or use its ⋯ menu: *copy the content*, *download as a file*, *delete*, and, once the server answers again, *send to the server*: it is written like any save (frontmatter, hash, the "file changed, overwrite?" and "update only the metadata" questions) and the offline copy is removed. They are copies kept in the browser, not files in your notes: Obsidian cannot open them and your own notes are not in them. Lecture bundles (only a link) and raw page saves are not kept. *Copy the content* reads the text through `GET /file` (browsers may only ask from udemy.com and skills.google pages) and puts it on the clipboard.

**Frontmatter.** Every Markdown file the server saves (transcripts, labs, lessons, quizzes, "to Review", "all questions") starts with YAML metadata that Obsidian shows as properties:

```yaml
---
type: "to-review"          # transcript | lesson | lab | quiz | to-review | all-questions
course: "Professional Cloud DevOps Engineer"
lesson: "Practice Test 1"
url: "https://www.udemy.com/course/.../learn/quiz/..."
hash: "sha256:..."         # of the text after the frontmatter
---
```

The userscript sends the course, lesson and URL (`X-Mathesis-Meta`, percent-encoded JSON); the server adds the type and the hash (if the header is missing, the course is the folder name and there is no lesson or url until a later save sends them). The hash covers only what follows the frontmatter, so it changes when the body changes (for example when you type a note into it) and not when only the metadata does. JSON and raw HTML files get no frontmatter.

Saving again over a file that **has** frontmatter updates our keys (and the hash), keeps any key you added, and replaces the body as before. Saving over a file that **has none** (a file saved before this existed, or one you wrote) does not overwrite it: the server only adds the frontmatter and leaves every other character as it was; the panel tells you ("kept": true in the answer). Summaries, `mathesis summarize` and the lesson matching ignore the frontmatter.

**Notes are protected.** The hash tells the server whether you edited a file after it wrote it (line endings and a missing final newline do not count). When you save over such a file, the server answers `409` (`code: "modified"`, `/status` also reports `"modified": true`) and does not overwrite it. The userscript then asks: "The file was changed after it was saved (your notes?). Saving will overwrite those changes. Overwrite them?" Yes saves over them (the request is repeated with `X-Mathesis-Overwrite: yes`). On No it asks a second question: "Keep your text as it is and only update the metadata (frontmatter) of the file?" Yes updates the course, lesson and URL and leaves every other character, and the stored hash, as they were (`X-Mathesis-Overwrite: metadata`; the file still counts as changed afterwards, so a later save keeps asking); No saves nothing and shows no error. Frontmatter without a hash counts as changed.

When a save fails, the userscript also uploads an **error report** (`POST /reports`): the page HTML, the URL, what was sent, the server's error and the script version. The error toast shows the report ID. Reports are kept in a temporary folder (`MATHESIS_REPORT_DIR`, default `<tmp>/mathesis-reports`, newest 50) and can be inspected through the API:

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

**to Review** is named after the attempt the page shows ("Attempt N" above the filter pills): attempt 1 is `NN-incorrect.md`, attempt 2 is `NN-incorrect (attempt 2).md`, and so on, so the script never guesses it from how many times you pressed Save. If the page shows no attempt number, nothing is saved. Saving the same attempt again replaces its own file (with the notes check above if you edited it); another attempt is another file. "all questions" (Markdown and JSON) is the same whatever the attempt, so saving it again just overwrites it. Lecture transcripts are unchanged too. The extra attempts count as derived files, so `mathesis` never mistakes them for lessons.

A third button, **Save all as JSON**, saves the same questions as `NN-all questions.json` next to it (`X-Mathesis-Kind: quiz-json`, saved as is, no summary), for other tools. If the server cannot be reached the browser downloads the file instead. Each question has `question`, `type` (`"multi"` when more than one option is correct, else `"single"`), `options` (each with `text`, `correct` and its own `explanation`) and an overall `explanation`; it also has `number` and `domain`. The file records the exam's time limit as `timeLimitMinutes` (an integer, or `null`) and `timeLimitText` (the sentence it came from): Udemy's results page has no field for it, so the script reads it from the page text outside the questions, from sentences such as "50-60 multiple-choice questions in 2 hours" or "Time limit: 90 minutes" in the course description, and stores `null` when the page says nothing. Quizzes that only give one overall explanation leave the option explanations empty, and the other way round. Nothing says what you answered. The format is defined by [`schema/quiz-questions.schema.json`](schema/quiz-questions.schema.json) (JSON Schema 2020-12: a `single` question must have exactly one correct option, a `multi` one at least two), and `tests/test_quiz_schema.py` validates real userscript output against it (`pip install -e '.[dev]'` brings in `jsonschema`).

`summarize` skips files that already have a summary (`--force` to overwrite). Useful flags: `--model`, `--single` (one call with the original prompt), `--no-revise`; `serve` also takes `--no-reload`, `--no-summary`, `--no-notify`, `--host`, `--port`, `--root`.

## Configuration file

Settings can live in a TOML file: `--config`, else `$MATHESIS_CONFIG`, else `config.toml` in the application directory (the checkout; it is gitignored, so an API key in it is never committed). `mathesis config --init` asks a few questions (notes folder, default provider, provider for summaries, provider for lab guides) and writes a minimal valid file; the default answer is "No AI" (`llm = false`: lessons are only saved), so Enter all the way through is safe with no provider installed. You don't have to remember it: the first time you run `mathesis serve`, `doctor` or `summarize` from a terminal with no config file (and no `--config` / `MATHESIS_CONFIG`), it runs these questions for you and then carries on. Without a terminal (a script, a service) it never waits for an answer: the built-in defaults apply and a note says how to create the file, then tells you what to set before starting (`src/mathesis/config.example.toml` lists every option, commented); `mathesis config` shows what is in use; `mathesis doctor` tests the backends. Precedence: file < `MATHESIS_*` environment variables < command-line flags. Restart `mathesis serve` after editing; a mistyped key or unknown provider is reported with its name instead of being ignored.

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
