# Mathesis: full reference

The short version is in the [README](../README.md). This file has every detail.

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

Install `userscript/mathesis.user.js` in Tampermonkey. On a lesson page it adds a small **Mathesis panel** under the profile avatar: a header (the **μ** icon, name, status dot, fold button), a **save** row of chips and, below, a **files** list. The chips are the things you can save here (Udemy quiz results: "to review", "all", "json"; a lecture: "transcript"; a Google Skills lab: "lab"; also "lesson" and "quiz"); a small green dot on a chip says that file already exists. **Unrecognised pages.** Once the page has settled, the script checks that it knows what kind of page this is (Google Skills: a quiz, lesson, lab or video; Udemy: a lecture, or a quiz result whose questions are on the page). If not, the folded button gets an amber warning triangle, its tooltip says "Page type not recognised", and the unfolded panel shows the same line as its status. The button still works, but what it saves is a guess (on Google Skills, the whole page as raw HTML); this is the page to look at with the AI button in inspect mode. When the panel is folded, its single button does the first chip's job; on a quiz with nothing to review (no wrong or marked questions) it does **all** instead (Markdown and JSON), and then opens `all questions`. Each saved file gets a row: click its name to open it locally (Obsidian for Markdown, your text editor for JSON), or use its **⋯** menu: *open locally*, *copy the content* (to the clipboard), *copy file path* (absolute), *show in folder* (the system file manager); a summary or lab guide also has **Regenerate…**, which asks for confirmation and then has the configured AI provider write it again from the saved lesson. A summary or lab guide still being written is greyed with a spinner and "writing…"; one that failed shows "failed" (click it for the reason). There is no status text while the server is online; a spinner with "Analyzing…" and nothing else shows while the page is still loading. **Save or Copy:** while the server answers, the chips save; when it does not, the line "Server offline (retry)" appears (the link checks the server again at once), the row is labelled **copy** and the chips only copy to the clipboard, without trying to reach the server (also if it goes away between the check and the click). Hover anything for a tooltip beside the panel. Drag the header to move the panel anywhere (the position is remembered per site and kept inside the window; double-click the header to put it back). The – button folds it into a **vertical tab glued to the right edge of the window** (the **μ** icon on top, **one save button** under it that does the main action of the page (a small green dot on it says that file exists, and then the button shows the open icon and **opens that file** instead of saving again: unfold the panel to save again or to reach the other files; a spinner replaces the dot while a summary or lab guide is being written); messages (saved, copied, errors) appear as **toasts** in the bottom-right corner instead of blocking dialogs: success fades after a few seconds, an error stays until you dismiss it (so you can copy the error-report ID); only questions that need an answer (overwrite your notes? delete an offline copy?) still use a dialog, the status dot at the bottom; click the μ to expand or fold again, from either state; you can drag it up and down, and the open panel keeps its own place; **the panel always starts folded**: unfolding lasts for that page visit only); double Shift hides it completely.

On a **quiz** page the button reads "Copy Quiz": the userscript saves a readable Markdown copy (numbered questions, `- [ ]` options, your selected option checked) as `NN-<quiz title>.md` and tells the server it is a quiz (`X-Mathesis-Kind: quiz`), so no summary is made.

Some Google Skills lessons are **documents** whose text is not in the page at all: `<ql-iframe>` embeds an Evolve/Adapt course player from `storage.googleapis.com/cloud-training/...`. The button then reads "Copy Lesson" and sends only that URL (`X-Mathesis-Kind: bundle`); the server reads the course JSON next to it, renders the page (text, accordions, tabs, flip cards, tables, code, video transcripts, quiz questions) to Markdown with [markdownify](https://pypi.org/project/markdownify/), saves it and summarizes it like a transcript. Only that bucket is accepted, and the course JSON is cached for 30 minutes (all lessons of a course share it). Other courses embed an Articulate Rise export (`.../content/index.html#/lessons/<id>`); those are read from its `runtime-data.js` (flash cards, tabs, accordions, lists, code, quotes) the same way. **Knowledge checks** (multiple choice) are written as practice: the options as an unticked list (`- [ ]`) and the right answer, with the course's feedback, in an Obsidian callout that starts collapsed (`> [!success]- Answer`), so the answer stays hidden until you open it. Outside Obsidian the callout shows as a plain quote.

If a page has no recognisable content (no transcript, quiz or lab text), the button saves the **whole page HTML** instead: `X-Mathesis-Kind: raw`, file `<course>/<NN-lesson>.raw.html` next to the lessons (or `_raw/<url words>.raw.html` when the page title can't be read). Raw pages are never summarized; they are kept so the page can be analysed and the script taught about it.

On a **lab** page the button reads "Copy Lab" (`X-Mathesis-Kind: lab`). The lab instructions are saved and summarized like a transcript, and, by default, **Claude Code** (the `claude` CLI, run headless with `claude -p`, no tools, empty temporary folder, so it can only turn text into text) also writes `<lab>-lab-guide.md` next to it: the resources the lab creates, a setup block (variables, APIs), `gcloud` commands per lab task, Terraform only for what gcloud cannot create, verification commands and clean-up. Commands it is unsure about carry a `# VERIFY:` comment; read them before running anything. It takes about a minute and runs in parallel with the summary; a notification ("Lab guide ready") opens the guide in Obsidian. `--no-lab-guide` / `MATHESIS_LAB_GUIDE=0` turns it off, `MATHESIS_CLAUDE_MODEL` picks the model, `MATHESIS_CLAUDE` the CLI path; the prompt is `src/mathesis/prompts/lab_guide.txt`. This uses your Claude Code login (usage counts against it); `provider` in the config file switches it (together with summaries) to Gemini, Ollama or another API; `[lab_guide] provider` switches only the lab guides. **Checked commands** (`[lab_guide] check_commands = true` or `MATHESIS_LAB_CHECK=1`, off by default; needs `gcloud` on the server's PATH). With any provider, after the guide is written the server checks every `gcloud` command against the installed gcloud's help (unknown command, unknown flag, missing required flag for design-center), sends the wrong ones back with the real help pages and asks for a corrected guide, up to 2 rounds; a repair that is shorter or has more problems is discarded. Only `--help` is ever run, with an empty `CLOUDSDK_CONFIG` (`src/mathesis/gcloudcheck.py`, prompt `lab_guide_repair.txt`). With **Claude Code** the model also gets an agent mode: it may run `gcloud <anything> --help` before writing each command and uses the flags the help shows instead of guessing them. It gets one tool (Bash), pre-approved only for that pattern (anything else is refused, never asked), and runs in an empty temporary folder with its own `gcloud` that only accepts `--help` and has an empty `CLOUDSDK_CONFIG`, so no account, project or credential is reachable. It is slower and costs more than the default; it needs `gcloud` on the server's PATH (without it the plain mode is used). Prompt: `src/mathesis/prompts/lab_guide_check.txt`.

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

The userscript sends the course, lesson and URL, and on Udemy the course's author (the instructor name(s), read from the course page's own data; the `author` key is left out when the page does not say) (`X-Mathesis-Meta`, percent-encoded JSON); the server adds the type and the hash (if the header is missing, the course is the folder name and there is no lesson or url until a later save sends them). The hash covers only what follows the frontmatter, so it changes when the body changes (for example when you type a note into it) and not when only the metadata does. JSON and raw HTML files get no frontmatter.

Saving again over a file that **has** frontmatter updates our keys (and the hash), keeps any key you added, and replaces the body as before. Saving over a file that **has none** (a file saved before this existed, or one you wrote) does not overwrite it: the server only adds the frontmatter and leaves every other character as it was; the panel tells you ("kept": true in the answer). Summaries, `mathesis summarize` and the lesson matching ignore the frontmatter.

**Notes are protected.** The hash tells the server whether you edited a file after it wrote it (line endings and a missing final newline do not count). When you save over such a file, the server answers `409` (`code: "modified"`, `/status` also reports `"modified": true`) and does not overwrite it. The 409 carries `diff`: a unified diff of the two bodies (frontmatter left out, cut at 300 lines) from the file as it is to the text about to replace it, so the lines you typed into the file show up as removed. The userscript shows it in a dialog (red = would be removed, green = would be added) with three buttons, **Overwrite**, **Keep my text, update only the metadata** and **Cancel** (Esc); against a server that sends no diff it falls back to two plain questions. Overwrite saves over them (the request is repeated with `X-Mathesis-Overwrite: yes`). The metadata button updates the course, author, lesson and URL and leaves every other character, and the stored hash, as they were (`X-Mathesis-Overwrite: metadata`; the file still counts as changed afterwards, so a later save keeps asking); Cancel saves nothing and shows no error. Frontmatter without a hash counts as changed.

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

`userscript/mathesis-udemy.user.js` saves Udemy lectures to `Udemy/<author>/<course>/<NN>-<lecture>.md` through the same server (summaries included). The author folder is the course's first instructor as Udemy shows them, without the tagline after a bar (`Priya Dwivedi | CertShield Academy` is `Priya Dwivedi`); the full string stays in the `author` of the frontmatter and the quiz JSON. Not every page shows the instructor, so the folder found for a course is remembered in the browser (per course); a course whose author was never seen goes to `unknown author`. `scripts/organize-udemy-by-author.py` moves courses saved in the old `Udemy/<course>/` layout (dry run by default; it also fills in a missing `author`, rewrites links in the vault's notes, and with `--merge` folds in files an old script saved at the old path afterwards).
On a **quiz results** page the button reads "Save to Review" ("Copy to Review" when the server is offline): it reads the "incorrect" pill, then the "marked" pill (and restores your pill afterwards), and saves one file, `NN-incorrect.md` (the folder names the course and the tests are numbered, so the quiz title is not repeated), with `X-Mathesis-Kind: quiz-review` (no summary). It has two `#` sections: **Incorrect** (the questions you got wrong; `Question N*` with an asterisk means wrong and **not marked**, i.e. you felt sure: a clear misconception) and **To Review** (questions you marked because you were not sure, but answered correctly; marked questions you got wrong are already under Incorrect). Each question has its domain, the options (your answer ❌, correct answer ✅) and Udemy's explanations; the explanations of the options you did not pick are in a folded callout.  Quizzes that give one "Overall explanation" per question instead of one per option (the "Practice Exams" format) are handled too: that text goes under "### Explanation".

On the same page a second button, the **all** chip, saves both `NN-all questions.md` and `NN-all questions.json` (the questions are read from the page once; the JSON is saved only after the Markdown went through, and offline only the Markdown is copied). The Markdown is `NN-all questions.md` (`X-Mathesis-Kind: quiz-all`, no summary): every question of the attempt in its original order (it reads the "all" pill and restores yours) with the options and Udemy's explanations, but nothing that marks the wrong ones: no ❌, no "your answer", no Incorrect / To Review split and no `*`. Only the correct options are ticked, so the file works as a clean study copy of the whole test.

**Code in questions and explanations.** A `<pre>` block is written as a fenced block. Some course authors type code as plain paragraphs instead (one `<p>` per line, no `<pre>`): the browser collapses their indentation on screen, but the spaces are still in the text, so the script keeps them and fences a run of such paragraphs when it looks like code, with a language tag (`yaml`, `bash`, `json`, `python`, `sql`) when it can tell. No AI is involved, and the rules are conservative: a run needs a strong sign (indentation, a shell command, a code keyword, a bracket line; a lone line only if it is a command that does not read like a sentence), a paragraph with inline markup (`code`, bold, a link) is prose, and prose between two code lines ends the run. The same rules apply to the JSON's question and explanation texts, not to the option texts (kept on one line). Files saved before this keep their unfenced code until the page is saved again. The rules are tested in `tests/test_udemy_fences.py` (run in node; skipped when it is missing).

**to Review** is named after the attempt the page shows ("Attempt N" above the filter pills): attempt 1 is `NN-incorrect.md`, attempt 2 is `NN-incorrect (attempt 2).md`, and so on, so the script never guesses it from how many times you pressed Save. If the page shows no attempt number, nothing is saved. Saving the same attempt again replaces its own file (with the notes check above if you edited it); another attempt is another file. "all questions" (Markdown and JSON) is the same whatever the attempt, so saving it again just overwrites it. Lecture transcripts are unchanged too. The extra attempts count as derived files, so `mathesis` never mistakes them for lessons.

The **json** chip alone saves the same questions as `NN-all questions.json` next to it (`X-Mathesis-Kind: quiz-json`, saved as is, no summary), for other tools. If the server cannot be reached the browser downloads the file instead. Each question has `question`, `type` (`"multi"` when more than one option is correct, else `"single"`), `options` (each with `text`, `correct` and its own `explanation`) and an overall `explanation`; it also has `number` and `domain`. The file records the exam's time limit as `timeLimitMinutes` (an integer, or `null`) and `timeLimitText` (the sentence it came from); `author` holds the course's instructor(s), empty when the page does not say: Udemy's results page has no field for it, so the script reads it from the page text outside the questions, from sentences such as "50-60 multiple-choice questions in 2 hours" or "Time limit: 90 minutes" in the course description, and stores `null` when the page says nothing. Quizzes that only give one overall explanation leave the option explanations empty, and the other way round. Nothing says what you answered. The format is defined by [`schema/quiz-questions.schema.json`](../schema/quiz-questions.schema.json) (JSON Schema 2020-12: a `single` question must have exactly one correct option, a `multi` one at least two), and `tests/test_quiz_schema.py` validates real userscript output against it (`pip install -e '.[dev]'` brings in `jsonschema`).

`summarize` skips files that already have a summary (`--force` to overwrite). Useful flags: `--model`, `--single` (one call with the original prompt), `--no-revise`; `serve` also takes `--no-reload`, `--no-summary`, `--no-notify`, `--host`, `--port`, `--root`.

### Attempts for the quiz platform (QuickQuiz)

The **attempt** chip saves the attempt you are looking at as `NN-attempt N.json` (`X-Mathesis-Kind: quiz-attempt`, next to the quiz files), in the platform's import format ([`schema/quickquiz-attempts.schema.json`](../schema/quickquiz-attempts.schema.json), a copy of what `/api/me/import/schema` serves; `tests/test_attempts.py` validates against it). What goes in it:

- `answers`: the options you chose, as 0-based indexes in the order of `NN-all questions.json` (the page's "Your answer"; unanswered questions are left out), and `marked`: the questions in the page's "marked" filter. `comments` is empty (Udemy has none).
- `id` is `udemy-<the result id in the address>`, so saving the same attempt again and importing it twice imports it once.
- `startedAt`, `finishedAt`, `timeUsedSeconds`: Udemy's results page does not show them, so the script asks Udemy's quiz API for the attempt (`/api-2.0/quizzes/<quiz>/user-attempted-quizzes/`, with your logged-in session, from the browser; nothing goes through the server) and takes the creation and completion times. **Those field names are not documented and were not checked against a live account**: the record it found is logged in the browser console (`[Mathesis] attempt record from Udemy`). If the API gives nothing usable the file says the attempt was taken now and took 0 seconds, and a message says so; edit the three fields by hand then.
- `quiz`: the script writes only the title. The **server** adds `quiz.hash`, the content hash the platform identifies a quiz by, computed from the saved `NN-all questions.json` (the same file you import there; `src/mathesis/attempts.py`, the algorithm of the schema's description, verified against its worked example). So import `NN-all questions.json` first. The hash leaves out `domain`, `domainGuessed`, `author`, `attempt` and `syllabus`, so the exam-domain job does not change it, but it covers `source` (the results page's address) and everything else. If there is no saved quiz JSON with the same title, the attempt keeps the title and the platform matches it by title (which fails when two quizzes share one); the chip saves the quiz JSON first when it is missing.

### Exam domains for the quiz JSON

Udemy shows an exam domain only on the questions whose author filled it in (often few or none), so the JSON has `"domain": ""` for the rest. When a provider is set, saving the JSON starts a background job (a row "exam domains" with a spinner in the panel; saving the same JSON again meanwhile does nothing) that fills in the missing ones from the certification's **official** syllabus. Which provider: `[domains] provider`, else the default `provider` at the top of the config file. There is no built-in choice, so with no provider set nothing runs; `[domains] enabled = false` / `MATHESIS_DOMAINS=0` switches it off.

1. The model says which certification the course prepares for (from the folder name, the test title and the first questions).
2. It finds the syllabus: official exam-guide URLs it is sure of, then a web search for the guide (DuckDuckGo's HTML page; the search carries only the certification name). Each page is read as text (HTML, or PDF through `pdftotext` from poppler-utils when installed) and the model extracts the exam's top-level domains from it. A domain counts only if its name appears in the page text, a page needs at least two, and the model must judge the page to be published by the certifying body itself (a blog or training site is refused). When two official documents turn up (versions of the guide), the model picks the one that matches the course ("new", a year). Only public https pages are read: a host that resolves to a private, loopback or link-local address is refused, on redirects too (`src/mathesis/webtext.py`).
3. The questions without a domain are placed, 10 at a time, in one of those domains (or left empty when none fits). The model's answer must be a domain of the syllabus.

**The syllabus is built once.** It is kept in `~/.cache/mathesis/syllabi/<certification>.json` and never expires; each course folder is remembered in `courses.json` there. Later tests of that course need no certification lookup, search or page read: just the classification calls. Another course for the same exam finds the file after one lookup. To rebuild a syllabus (a new exam version), delete its file (and the course's line in `courses.json`).

What the file gets: the guessed domains carry `"domainGuessed": true`, a `"syllabus"` object (certification, the page it was read from, the domain names) sits before `questions`, and questions that already had a domain are never touched. The names are the official ones, except where the quiz already has a label for the same area: Udemy's labels are often reworded or cut off (`Designing Highly Scalable, Available, and Reliable Cloud-Nat`), so the model also matches each official domain to the labels already in the file (one extra call, only when some questions have a label; only matches it is sure of, a label is used for one domain at most) and the guessed questions are written with that label. A domain with no matching label keeps its official name, and `"syllabus"` always lists the official names. The file is rewritten only if it is unchanged since the job started. If it fails (no provider reachable, no official syllabus found), the quiz stays as saved, the row says "failed" (hover it for the reason) and saving the JSON again retries. The Markdown `all questions` file is not changed. Questions and the syllabus text go to the provider you configured, like summaries do; guesses from a small local model are only as good as the model. Prompts: `domains_*.txt` in `src/mathesis/prompts`.

## Configuration file

Settings can live in a TOML file: `--config`, else `$MATHESIS_CONFIG`, else `config.toml` in the application directory (the checkout; it is gitignored, so an API key in it is never committed). `mathesis config --init` asks a few questions (notes folder, default provider, provider for summaries, provider for lab guides) and writes a minimal valid file; the default answer is "No AI" (`llm = false`: lessons are only saved), so Enter all the way through is safe with no provider installed. You don't have to remember it: the first time you run `mathesis serve`, `doctor` or `summarize` from a terminal with no config file (and no `--config` / `MATHESIS_CONFIG`), it runs these questions for you and then carries on. Without a terminal (a script, a service) it never waits for an answer: the built-in defaults apply and a note says how to create the file, then tells you what to set before starting (`src/mathesis/config.example.toml` lists every option, commented); `mathesis config` shows what is in use; `mathesis doctor` tests the backends. Precedence: file < `MATHESIS_*` environment variables < command-line flags. Restart `mathesis serve` after editing; a mistyped key or unknown provider is reported with its name instead of being ignored.

One **provider** serves everything (summaries and lab guides); a job overrides it only when it needs something different:

```toml
provider = "gemini"            # the one provider: ollama | gemini | openai | openrouter | claude-code | <your own table> | none

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
| `MATHESIS_DOMAINS` / `MATHESIS_DOMAINS_PROVIDER` | on / the default provider (none: off) | exam domains guessed for quiz JSON files |
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


## Inspect mode

For debugging why a userscript does not read a page: `mathesis serve --inspect` (never on by default; not a config-file option; only on 127.0.0.1).

1. The panel shows an **AI** button. Clicking it on a page shares *that page visit* with the server: the button turns red, a toast says so, and clicking again (or leaving the page) stops it. Nothing is shared otherwise.
2. An AI (or you) asks the page questions with `mathesis inspect ACTION [--page N] [--selector CSS] [--max N] [--limit N] [--depth N]`:
   `pages` (what is shared), `info` (URL, title, what the script makes of the page: kind, path, or why it fails), `outline` (the element tree), `html` and `text` (of a selector), `query` (elements with attributes, text and a CSS path), `count`, `parse` (what the save button would send, or the error; on Udemy only counts, because reading a transcript opens its panel).
3. The page only answers these read-only questions. There is **no way to run JavaScript, click or type**; `script`/`style` contents, `value`s of form fields and the panel itself are never sent, long attributes are cut. Page text can still hold things you see on screen (a lab's temporary account, your name): share only pages you are willing to show.

How it works: the page registers with the server (`POST /inspect/register`), opens a **Server-Sent Events** stream (`GET /inspect/stream`, an `EventSource` in the page) on which each command arrives as a `data:` line (a `: ping` comment every 10 s keeps it alive), and answers each with `POST /inspect/answer`. `EventSource` reconnects by itself after a dropped connection; if the server restarted and forgot the page (HTTP 404) the page registers again. It uses the same kind of request to `127.0.0.1` the userscripts already make. The control side (`GET /inspect/pages`, `POST /inspect/call`) needs the token in `.mathesis-inspect-token` (new on every start, mode 600, gitignored; `MATHESIS_INSPECT_TOKEN_FILE` moves it) sent as `X-Mathesis-Inspect-Token`, and refuses any request with an `Origin` header, so a web page cannot read what another page shares. The page side accepts only the sites of the userscripts. Stopping or reloading the server closes open streams after 3 s (`timeout_graceful_shutdown`), and the page reconnects. A page whose stream is gone for 90 s is dropped; without `--inspect` all of these paths are 404.
