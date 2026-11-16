# Mathesis

*μάθησις*, "learning". A personal study tool: userscripts save lessons, labs and quiz results from **Google Skills** and **Udemy** into a folder of Markdown notes (made for an Obsidian vault), through a small local server. An AI model can optionally write a summary of each lesson and a `gcloud`/Terraform guide for each lab.

```
browser (userscript) --POST--> mathesis serve (127.0.0.1:5000) --> notes folder (+ summaries if an AI is set up)
```

## Install

Needs Python 3.11+ and a userscript manager (Violentmonkey or Tampermonkey).

```bash
git clone git@github.com:taksan/mathesis.git && cd mathesis
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/mathesis serve
```

The first run asks a few questions (notes folder, AI provider) and writes `config.toml`. Pressing Enter through all of them is safe: the default is **no AI**, so lessons are only saved.

Then, with the server running, install the scripts from `http://127.0.0.1:5000/userscript` (one for Google Skills, one for Udemy). They update from the same address.

## Use

Open a lesson, lab or quiz-results page. The **μ** panel appears at the top right (it starts folded: click the μ to open it, or use the single save button, which does the page's main action).

| Page                 | Chip                 | Saves                                                                |
|----------------------|----------------------|----------------------------------------------------------------------|
| Video lesson         | transcript           | `NN-lesson.md`                                                       |
| Document lesson      | lesson               | the lesson as Markdown                                               |
| Lab                  | lab                  | lab text, plus a lab guide if AI is on                               |
| Quiz (Google Skills) | quiz                 | the quiz as Markdown                                                 |
| Udemy quiz results   | to review, all, json | the wrong and marked questions, or every question (Markdown or JSON) |

- Saved files are listed in the panel: click to open (Obsidian or your text editor); **⋯** has copy content, copy path, show in folder and, for summaries and lab guides, **Regenerate**.
- If the server is down the buttons say *Copy*: the text goes to the clipboard and is kept as an offline copy in the browser, to send later.
- Files you edited are never overwritten silently: the server asks first.
- Shift twice hides the panel.

Other commands: `mathesis doctor` (checks everything), `mathesis summarize PATH` (summaries for existing files), `mathesis config` (show settings), `mathesis config --init --force` (redo the questions).

## Using offline - no server

The scripts work without Python or the server. You get no summaries, lab guides or notes folder; you copy or download the text and keep it yourself.

1. Install a userscript manager (Violentmonkey or Tampermonkey).
2. Open `userscript/mathesis.user.js` (Google Skills) and `userscript/mathesis-udemy.user.js` (Udemy) from a clone, or their *Raw* view on GitHub, and let the manager install them (or paste them into a new script). They then try to update from `127.0.0.1:5000`, which finds nothing; update by installing the new file.

What works with no server (the panel says "Server offline" and the chips say *copy*):

- **Copy:** every chip (transcript, lab, lesson, quiz, to review, all, json) puts the text on the clipboard, in the same Markdown.
- **Offline copies:** each copy is also kept in the browser for that site and listed in the panel, where you can copy it again, **download it as a file** or delete it.
- **Quiz JSON:** the browser downloads the file.
- Panel, folding, drag, Shift twice to hide: unchanged.

Not available: summaries and lab guides, the saved-files list, open in Obsidian or an editor, frontmatter and the edited-notes check. If you start the server later, *send to the server* in an offline copy's menu saves it like a normal save.

## Options

Settings come from `config.toml`, then `MATHESIS_*` environment variables, then command-line flags. `src/mathesis/config.example.toml` lists everything.

```toml
llm = true                       # false (the default of the first-run questions): no AI at all
provider = "gemini"              # ollama | gemini | openai | claude-code | none
[server]
root = "~/mathesis-notes"        # the only folder the server may write into
[lab_guide]
provider = "claude-code"         # optional: a different provider for one job ([summary] works the same)
```

API keys are never stored in the config: export `GEMINI_API_KEY` / `OPENAI_API_KEY` (or put them in a gitignored `.env` next to `config.toml`).

| Variable                                             | Default                                 |                                           |
|------------------------------------------------------|-----------------------------------------|-------------------------------------------|
| `MATHESIS_ROOT`                                      | notes folder from the config            | where notes are written                   |
| `MATHESIS_CONFIG`                                    | `config.toml` in the checkout           | config file                               |
| `MATHESIS_LLM`                                       | on                                      | `0` turns every AI feature off            |
| `MATHESIS_PROVIDER`                                  | none                                    | one provider for summaries and lab guides |
| `MATHESIS_SUMMARY_PROVIDER`, `MATHESIS_LAB_PROVIDER` | the provider above                      | per job (`none` = off)                    |
| `MATHESIS_MODEL`, `MATHESIS_OLLAMA_URL`              | `gemma4:12b`, `http://172.17.0.1:11434` | Ollama model and address                  |
| `MATHESIS_HOST`, `MATHESIS_PORT`                     | `127.0.0.1`, `5000`                     | server address                            |
| `MATHESIS_LAB_CHECK` | off | `1`: Claude Code reads `gcloud ... --help` (only that) while writing lab guides, so commands use real flags; slower, needs `gcloud` |
| `MATHESIS_NOTIFY`                                    | on                                      | desktop notifications                     |
| `MATHESIS_OBSIDIAN`, `MATHESIS_EDITOR`               | auto-detected                           | how notes are opened                      |

Server flags: `mathesis serve --no-llm --no-reload --no-notify --host --port --root`.

## Limitations

- **Only Google Skills and Udemy**, and only the pages the scripts recognise. They read the page's HTML, so a site redesign can break them (a failed save uploads an error report you can inspect at `/reports`).
- **Local and single-user.** The server listens on 127.0.0.1 and has no login; don't expose it. Written for Linux: notifications and "open in editor" use `notify-send` and `xdg-open` (macOS and Windows are best effort).
- **With an external AI provider, lesson text is sent to that service.** Lab capture leaves out the lab account's username and password. Ollama and `provider = "none"` keep everything local.
- **Summaries need a working provider.** If it is down, the lesson is still saved and only the summary is skipped. The quiz-to-lesson matching always uses Ollama embeddings.
- Pending and failed summaries live in server memory: a restart forgets them.
- Offline copies are limited by the browser's storage (about 5 MB per site) and are not your notes.
- Quiz and lesson text belongs to its publishers: keep the saved notes private.

## More

Every detail (file formats, frontmatter and the notes protection, quiz JSON schema, HTTP API, all variables, how summaries are made): [docs/reference.md](docs/reference.md). Tests: `.venv/bin/pip install -e ".[dev]" && .venv/bin/pytest`.
