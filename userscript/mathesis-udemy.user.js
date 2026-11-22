// ==UserScript==
// @name         Mathesis: save Udemy transcript
// @namespace    http://tampermonkey.net/
// @version      176.4a9f170
// @updateURL    http://127.0.0.1:5000/userscript/mathesis-udemy.user.js
// @downloadURL  http://127.0.0.1:5000/userscript/mathesis-udemy.user.js
// @description  Adds buttons that save a Udemy lesson transcript, or the incorrect and marked-for-review questions (or all questions, as Markdown or JSON) of a quiz result, to the local Mathesis server (mathesis serve)
// @match        https://www.udemy.com/course/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Files land in <BASE_DIR>/<author>/<course>/<NN-lesson>.md under the server's MATHESIS_ROOT (where that is on disk is the server's business).
  const BASE_DIR = 'Udemy';
  const SERVER = 'http://127.0.0.1:5000';

  // ---- toasts: messages that do not block the page (an toast() hides the panel and stops everything until it is closed) ----
  // ok fades after a few seconds, info a bit later, an error stays until it is dismissed (it may carry an error-report ID to copy).
  // Questions that need an answer (overwrite your notes?) still use confirm().
  function toast(message, kind = 'info') {
    if (!document.body || !document.head) { console.log('[Mathesis]', message); return null; }
    let box = document.getElementById('mathesis-toasts');
    if (!box) {
      const st = document.createElement('style');
      st.textContent = `
        #mathesis-toasts { position: fixed; bottom: 20px; right: 20px; z-index: 2147483647; display: flex; flex-direction: column; gap: 8px;
          align-items: flex-end; max-width: min(420px, calc(100vw - 32px)); pointer-events: none; }
        #mathesis-toasts .mx-toast { pointer-events: auto; display: flex; gap: 10px; align-items: flex-start; box-sizing: border-box; max-width: 100%;
          padding: 10px 8px 10px 12px; background: #1d2531; color: #F2F0EB; border: 1px solid #46536a; border-left: 4px solid #8ab4f8; border-radius: 8px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; white-space: pre-line;
          animation: mathesis-toast-in 0.18s ease-out; transition: opacity 0.2s ease; }
        #mathesis-toasts .mx-toast.ok { border-left-color: #34a853; }
        #mathesis-toasts .mx-toast.error { border-left-color: #ff8a80; user-select: text; }
        #mathesis-toasts .mx-toast.out { opacity: 0; }
        #mathesis-toasts .mx-toast-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
        #mathesis-toasts .mx-toast-x { flex: none; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: #9aa8bb;
          font: 16px/22px system-ui, sans-serif; cursor: pointer; }
        #mathesis-toasts .mx-toast-x:hover, #mathesis-toasts .mx-toast-x:focus-visible { background: #8ab4f8; color: #14202f; outline: none; }
        @keyframes mathesis-toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) { #mathesis-toasts .mx-toast { animation: none; transition: none; } }
      `;
      document.head.appendChild(st);
      box = document.createElement('div');
      box.id = 'mathesis-toasts';
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = 'mx-toast ' + kind;
    t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const text = document.createElement('div');
    text.className = 'mx-toast-text';
    text.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'mx-toast-x';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    let timer = null;
    const remove = () => { clearTimeout(timer); t.classList.add('out'); setTimeout(() => t.remove(), 200); };
    const arm = () => { const ms = kind === 'error' ? 0 : kind === 'ok' ? 4500 : 9000; if (ms) timer = setTimeout(remove, ms); };
    close.addEventListener('click', remove);
    t.addEventListener('mouseenter', () => clearTimeout(timer)); // reading it: it stays
    t.addEventListener('mouseleave', arm);
    t.append(text, close);
    box.append(t);
    while (box.children.length > 5) box.firstChild.remove();
    arm();
    return t;
  }
  toast.ok = (message) => toast(message, 'ok');
  toast.error = (message) => toast(message, 'error');

  const normalizeName = (s) => (s || '').replace(/[:/\\?*"<>|]/g, '_').replace(/\s+/g, ' ').trim();

  // ---- page access (Udemy's markup is not documented: every selector has a fallback) ----

  const currentItem = () => document.querySelector("[aria-current='true'] [data-purpose='item-title']")
    || document.querySelector("[data-purpose='item-title'][aria-current='true']");
  const transcriptToggle = () => document.querySelector('[data-purpose="transcript-toggle"]');
  const cues = () => [...document.querySelectorAll('[data-purpose="transcript-cue"], [data-purpose="cue-text"]')];

  // /course/<slug>/learn/lecture/<id> -> "slug with spaces"
  function courseName() {
    const slug = (location.pathname.match(/\/course\/([^/]+)/) || [])[1];
    if (!slug) throw new Error('Course not found in the URL');
    return normalizeName(decodeURIComponent(slug).replace(/-/g, ' '));
  }

  // Udemy titles lectures "12. Title" in the curriculum: keep that number, zero-padded to the course size.
  // Items without a number (quizzes, practice tests) get their position in the sidebar instead.
  function lessonFileName() {
    const item = currentItem();
    if (!item) throw new Error('Current lesson not found in the curriculum sidebar');
    const title = item.textContent.trim();
    const all = [...document.querySelectorAll("[data-purpose='item-title']")];
    const m = title.match(/^(\d+)\.\s*(.*)$/s);
    const number = m ? m[1] : String(all.indexOf(item) + 1);
    const name = m ? m[2].trim() : title;
    const width = Math.max(String(all.length).length, number.length, 2);
    const prefix = number === '0' ? '' : number.padStart(width, '0') + '-';
    return { title: name, prefix, base: `${prefix}${normalizeName(name)}` };
  }

  // The course's instructor(s), as Udemy shows them. Udemy's course-taking pages carry them as JSON in the app's data-module-args (every
  // page, not only the overview tab; the quiz results page does not have them); the instructor profile on the page is the fallback.
  // [] when neither is there.
  function courseAuthors() {
    try {
      for (const el of document.querySelectorAll('[data-module-args]')) {
        const raw = el.getAttribute('data-module-args');
        if (!raw.includes('instructors_info')) continue;
        const list = (JSON.parse(raw).instructorInfo || {}).instructors_info || [];
        const names = list.map((i) => String(i.display_name || i.title || '').trim()).filter(Boolean);
        if (names.length) return names;
      }
    } catch (e) { /* not JSON: try the page */ }
    // Page fallbacks, most reliable first: the instructor profile link (also on the quiz results page), the older bio block, then the
    // name shown on instructor replies.
    for (const sel of ['a[data-purpose="instructor-url"]', '[data-purpose="instructor-bio"] a[href*="/user/"]', '[data-purpose="instructor-name"]']) {
      const names = [...new Set([...document.querySelectorAll(sel)].map((e) => e.textContent.trim()).filter(Boolean))];
      if (names.length) return names;
    }
    return [];
  }
  const courseAuthor = () => courseAuthors().join(', ');

  // Courses are filed under their author: Udemy/<author>/<course>/. The folder is the first instructor's name without the tagline after
  // a bar ("Priya Dwivedi | CertShield Academy" -> "Priya Dwivedi"). Not every page shows the instructor, so the folder found for a
  // course is remembered in this browser: a page without one reuses it instead of filing the same course somewhere else. Never found:
  // "unknown author" (scripts/organize-udemy-by-author.py moves such a course once its author is known).
  const UNKNOWN_AUTHOR = 'unknown author';
  const authorFolder = () => {
    const slug = (location.pathname.match(/\/course\/([^/]+)/) || [])[1] || '';
    const key = 'mathesis-author-folder:' + slug;
    const found = normalizeName((courseAuthors()[0] || '').split(/\s+\|\s+/)[0]).replace(/^\.+|\.+$/g, '');
    try {
      if (found) { localStorage.setItem(key, found); return found; }
      return localStorage.getItem(key) || UNKNOWN_AUTHOR;
    } catch (e) { return found || UNKNOWN_AUTHOR; } // storage blocked: not remembered
  };

  // Goes to the server for the frontmatter of the Markdown file (the server adds the file type and the hash itself).
  function metaHeader() {
    let meta = { url: location.href };
    try { meta = { course: courseName(), author: courseAuthor(), lesson: lessonFileName().title, url: location.href }; } catch (e) { /* page still loading */ }
    return encodeURIComponent(JSON.stringify(meta));
  }

  // The JSON copy of a quiz's questions sits next to the Markdown one: "NN-all questions.json".
  const jsonPathToWrite = () => computePathToWrite(true).replace(/\.md$/, '.json');

  function computePathToWrite(allQuestions = false) {
    const { base, prefix } = lessonFileName();
    // Quiz results: the folder already names the course and the tests are numbered, so the file is just "NN-incorrect.md"
    // (or "NN-all questions.md"), not "NN-<verbose quiz title> - incorrect.md".
    // "Incorrect + To Review" depends on the attempt: the page says which one ("Attempt 2"), so attempt 1 is NN-incorrect.md and the
    // others are NN-incorrect (attempt N).md. "All questions" is the same whatever the attempt.
    if (isQuizReview()) {
      const n = attemptNumber();
      const suffix = allQuestions ? 'all questions' : n >= 2 ? `incorrect (attempt ${n})` : 'incorrect';
      return `${BASE_DIR}/${authorFolder()}/${courseName()}/${prefix}${suffix}.md`;
    }
    return `${BASE_DIR}/${authorFolder()}/${courseName()}/${base}.md`;
  }

  // ---- transcript ----

  // Cue lines break mid-sentence: join, split into sentences, group into paragraphs (same as the Google Skills script).
  const MAX_PARAGRAPH = 450;
  function formatTranscript(lines) {
    const text = lines.map((l) => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
    const sentences = text.split(/(?<=[.!?]["”’)]?)\s+(?=["“(]?[A-Z0-9])/);
    const paragraphs = [];
    let current = '';
    for (const sentence of sentences) {
      if (current && (current + ' ' + sentence).length > MAX_PARAGRAPH) {
        paragraphs.push(current);
        current = sentence;
      } else {
        current = current ? current + ' ' + sentence : sentence;
      }
    }
    if (current) paragraphs.push(current);
    return paragraphs.join('\n\n');
  }

  // Nothing recognisable on the page: the click handler saves the whole page HTML instead (kind "raw", no summary).
  const RAW = Symbol('raw');
  function rawPathToWrite() {
    try {
      return computePathToWrite().replace(/\.md$/, '.raw.html');
    } catch (e) { // not even the title/breadcrumb could be read: name it after the URL
      return `${BASE_DIR}/_raw/${normalizeName(decodeURIComponent(location.pathname).replace(/\//g, ' '))}.raw.html`;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Opens the transcript panel when needed, reads it, and closes it again if we opened it.
  async function readTranscriptLines() {
    const toggle = transcriptToggle();
    let opened = false;
    if (!cues().length && toggle) {
      toggle.click();
      opened = true;
      for (let i = 0; i < 20 && !cues().length; i++) await sleep(150);
    }
    let lines = cues().map((c) => c.innerText);
    if (!lines.length) {
      // fallback used by the original script: the whole side panel
      const panel = document.querySelector('#ct-sidebar-scroll-container');
      lines = panel ? [panel.innerText] : [];
    }
    if (opened && transcriptToggle()) transcriptToggle().click();
    return lines;
  }

  async function getTranscript() {
    if (isQuizReview()) return getReview();
    const lines = await readTranscriptLines();
    const body = formatTranscript(lines);
    if (!body) return RAW;
    return `# ${lessonFileName().title}\n\n${body}\n`;
  }

  // ---- quiz results: the incorrect questions only ----

  const STATUS = '[data-purpose="question-result-header-status-label"]';
  const statusLabels = () => [...document.querySelectorAll(STATUS)];
  const isQuizReview = () => statusLabels().length > 0;

  // The text of a code block with its lines. Udemy separates them with <br>, or with one <p>/<div>/<li> per line, which `textContent`
  // drops (every block came out as one line); its indentation is non-breaking spaces. A line that is only a space stays a blank line.
  function codeText(pre) {
    let out = '';
    const walk = (x) => {
      if (x.nodeType === 3) { out += x.textContent; return; }
      if (x.nodeType !== 1) return;
      const tag = x.tagName.toLowerCase();
      if (tag === 'br') { out += '\n'; return; }
      const block = tag === 'p' || tag === 'div' || tag === 'li' || tag === 'tr';
      if (block && out && !out.endsWith('\n')) out += '\n';
      [...x.childNodes].forEach(walk);
      if (block && !out.endsWith('\n')) out += '\n';
    };
    walk(pre);
    return out.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+/, '').trimEnd();
  }

  // Rich text (question, options, explanations) -> Markdown.
  function mdNode(n) {
    if (n.nodeType === 3) return n.textContent.replace(/\s+/g, ' ');
    if (n.nodeType !== 1) return '';
    const kids = () => [...n.childNodes].map(mdNode).join('');
    const wrap = (mark, t) => {
      const lead = t.match(/^\s*/)[0], trail = t.match(/\s*$/)[0], core = t.trim();
      return core ? lead + mark + core + mark + trail : t;
    };
    switch (n.tagName.toLowerCase()) {
      case 'strong': case 'b': return wrap('**', kids());
      case 'em': case 'i': return wrap('*', kids());
      case 'code': return '`' + n.textContent + '`';
      case 'a': {
        const text = kids().trim(), href = n.getAttribute('href') || '';
        return /^https?:/.test(href) && text ? `[${text}](${href})` : text;
      }
      case 'br': return '\n';
      case 'img': return /^https?:/.test(n.src) ? `![${n.alt || ''}](${n.src})` : '';
      case 'pre': return '\n\n```\n' + codeText(n) + '\n```\n\n';
      case 'p': case 'div': return '\n\n' + kids().trim() + '\n\n';
      case 'ul': case 'ol': {
        const items = [...n.children].filter((c) => c.tagName === 'LI').map((li, i) => {
          const body = mdNode(li).trim().replace(/\n{2,}/g, '\n').replace(/\n/g, '\n  ');
          return `${n.tagName === 'OL' ? i + 1 + '.' : '-'} ${body}`;
        });
        return '\n\n' + items.join('\n') + '\n\n';
      }
      default: return kids();
    }
  }
  const toMarkdown = (el) => (el ? mdNode(el).replace(/\*\*(\s*`[^`\n]+`\s*)\*\*/g, '$1') // bold split around inline code
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '');
  const oneLine = (el) => toMarkdown(el).replace(/\s*\n+\s*/g, ' ');
  const quote = (text) => text.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');

  // The filter pills: "60 all", "34 correct", "26 incorrect", "0 skipped", "28 marked".
  function pills() {
    return [...document.querySelectorAll('input[type="radio"]')].map((input) => {
      const label = input.id && document.querySelector(`label[for="${input.id}"]`);
      const m = label && label.textContent.trim().match(/^(\d[\d,]*)\s+(all|correct|incorrect|skipped|marked)$/i);
      return m ? { input, label, count: parseInt(m[1].replace(/,/g, ''), 10), name: m[2].toLowerCase() } : null;
    }).filter(Boolean);
  }

  // The page only renders the questions of the selected pill: select it and wait until exactly its questions are shown.
  async function selectPill(pill) {
    if (!pill.input.checked) pill.label.click();
    for (let i = 0; i < 30; i++) { // up to ~4.5s for React to re-render
      if (pill.input.checked && statusLabels().length === pill.count) return true;
      await sleep(150);
    }
    return false;
  }

  // Smallest ancestor of a status label that contains only that question.
  function paneOf(label) {
    let el = label;
    while (el.parentElement && el.parentElement.querySelectorAll(STATUS).length === 1) el = el.parentElement;
    return el;
  }

  function parseQuestion(pane) {
    const answers = [...pane.querySelectorAll('[data-purpose="answer"]')].map((a) => {
      const tag = a.querySelector('[data-purpose="answer-result-header-user-label"]');
      return {
        text: oneLine(a.querySelector('[id="answer-text"]')),
        selected: !!tag && /^your\b/i.test(tag.textContent.trim()),
        correct: /answer-correct/.test(a.className),
        explanation: toMarkdown(a.parentElement.querySelector('[id="question-explanation"]')),
      };
    });
    const domain = pane.querySelector('[data-purpose="domain-pane"]');
    return {
      number: (pane.textContent.match(/Question\s*(\d+)/) || [])[1],
      domain: domain && domain.lastElementChild ? domain.lastElementChild.textContent.trim() : '',
      stem: toMarkdown(pane.querySelector('[id="question-prompt"]')),
      // Two formats: explanations per option (id="question-explanation" inside each option's block), or one
      // "Overall explanation" for the whole question (id="overall-explanation"), as in the "Practice Exams" quizzes.
      overall: toMarkdown(pane.querySelector('[id="overall-explanation"]')),
      answers,
    };
  }

  // plain: for re-taking the quiz: the correct options are shown, but nothing says what you picked or got wrong.
  function formatQuestion(q, unmarked = false, plain = false) {
    const lines = [`## Question ${q.number}${unmarked ? '*' : ''}`, ''];
    if (q.domain) lines.push(`*Domain: ${q.domain}*`, '');
    lines.push(q.stem, '');
    for (const a of q.answers) {
      if (plain) {
        lines.push(`- [${a.correct ? 'x' : ' '}] ${a.text}${a.correct ? ' *(correct answer)*' : ''}`);
        continue;
      }
      const note = a.selected && a.correct ? ' *(your answer, correct)*' : a.selected ? ' *(your answer)*' : a.correct ? ' *(correct answer)*' : '';
      lines.push(`- [${a.selected ? 'x' : ' '}] ${a.correct ? '✅' : a.selected ? '❌' : ''} ${a.text}${note}`.replace(/\] {2}/, '] '));
    }
    lines.push('');
    const isShown = (a) => (plain ? a.correct : a.correct || a.selected);
    const shown = q.answers.filter((a) => isShown(a) && a.explanation);
    const others = q.answers.filter((a) => !isShown(a) && a.explanation);
    if (q.overall) lines.push('### Explanation', '', q.overall, '');
    if (shown.length) lines.push('### Explanation', '', shown.map((a) => a.explanation).join('\n\n'), '');
    if (others.length) lines.push('> [!note]- Why the other options are wrong', quote(others.map((a) => a.explanation).join('\n\n')), '');
    return lines.join('\n');
  }

  const attemptNumber = () => parseInt((attemptLabel().match(/\d+/) || [])[0], 10) || 0;
  function attemptLabel() {
    for (const el of document.querySelectorAll('div, span, h1, h2, h3')) {
      if (!el.children.length && /^Attempt \d+$/.test(el.textContent.trim())) return el.textContent.trim();
    }
    return '';
  }

  // "# Incorrect": the wrong answers; "Question N*" = wrong and NOT marked (you were sure: a clear misconception).
  // "# To Review": questions marked ("not sure") that were answered correctly.
  // Both come from the page's filter pills ("marked" and "incorrect"); the pill that was selected is restored afterwards.
  async function getReview() {
    const all = pills();
    const incorrect = all.find((p) => p.name === 'incorrect');
    const marked = all.find((p) => p.name === 'marked');
    const previous = all.find((p) => p.input.checked);
    const number = (l) => (paneOf(l).textContent.match(/Question\s*(\d+)/) || [])[1];
    const format = (labels, unmarked) => labels.map((l) => formatQuestion(parseQuestion(paneOf(l)), unmarked && unmarked.has(number(l))));
    const markedNumbers = new Set();
    let wrong, toReview = [], markedCount = 0, unmarkedCount = 0, warning = '';
    try {
      if (marked && marked.count) { // first: which questions are marked, and the correct ones among them
        markedCount = marked.count;
        if (!(await selectPill(marked))) warning += `Could not show exactly the ${marked.count} marked questions; saved what is on the page. `;
        statusLabels().forEach((l) => markedNumbers.add(number(l)));
        toReview = format(statusLabels().filter((l) => /^correct$/i.test(l.textContent.trim())));
      }
      const wrongLabels = () => statusLabels().filter((l) => /^incorrect$/i.test(l.textContent.trim()));
      if (incorrect && incorrect.count) {
        if (!(await selectPill(incorrect))) warning += `Could not show exactly the ${incorrect.count} incorrect questions; saved what is on the page. `;
      }
      const unmarked = new Set(wrongLabels().map(number).filter((n) => !markedNumbers.has(n)));
      unmarkedCount = unmarked.size;
      wrong = incorrect && !incorrect.count ? [] : format(wrongLabels(), unmarked);
    } finally {
      if (previous && !previous.input.checked) previous.label.click();
    }
    if (!wrong.length && !toReview.length) { toast('No incorrect or marked-and-correct questions in this attempt'); return null; }
    if (warning) toast(warning.trim());
    const total = (all.find((p) => p.name === 'all') || {}).count;
    const attempt = attemptLabel();
    const section = (title, facts, questions) => [`# ${title}`, '', `*${[attempt, ...facts].filter(Boolean).join(' · ')}*`, '',
      questions.length ? questions.join('\n\n') : '*None*'].join('\n');
    return [
      section('Incorrect', [`${wrong.length} incorrect${total ? ` of ${total}` : ''} questions`,
        `${unmarkedCount} not marked (*): wrong although you felt sure`], wrong),
      section('To Review', [`${toReview.length} marked and answered correctly (${markedCount} marked in total)`], toReview),
    ].join('\n\n') + '\n';
  }

  // "# All questions": every question of the attempt in its original order (the "all" pill), with the explanations,
  // but without the ❌, "your answer", the Incorrect / To Review split or the * for unmarked wrong answers.
  // Every question of the attempt, parsed, in the page's order (the "all" pill; the selected pill is restored afterwards).
  async function collectAllQuestions() {
    const all = pills();
    const everything = all.find((p) => p.name === 'all');
    const previous = all.find((p) => p.input.checked);
    let questions, warning = '';
    try {
      if (everything && !(await selectPill(everything))) warning = `Could not show exactly the ${everything.count} questions; saved what is on the page. `;
      questions = statusLabels().map((l) => parseQuestion(paneOf(l)));
    } finally {
      if (previous && !previous.input.checked) previous.label.click();
    }
    if (!questions.length) { toast('No questions found on this page'); return null; }
    if (warning) toast(warning.trim());
    return questions;
  }

  async function getAllQuestions(preloaded) {
    const questions = preloaded || await collectAllQuestions();
    if (!questions) return null;
    const attempt = attemptLabel();
    return [`# ${lessonFileName().title}`, '', `*${[attempt, `${questions.length} questions`].filter(Boolean).join(' · ')}*`, '',
      questions.map((q) => formatQuestion(q, false, true)).join('\n\n')].join('\n') + '\n';
  }

  // The same questions as JSON, for other tools. Nothing says what you picked or got wrong, as in "Copy all questions".
  // type: "multi" when more than one option is correct, else "single". The option explanations are empty in the quizzes that
  // only have an overall explanation (and the overall explanation is empty in the ones that explain each option).
  function questionToJson(q) {
    return {
      number: Number(q.number) || null,
      domain: q.domain,
      question: q.stem,
      type: q.answers.filter((a) => a.correct).length > 1 ? 'multi' : 'single',
      options: q.answers.map((a) => ({ text: a.text, correct: a.correct, explanation: a.explanation })),
      explanation: q.overall,
    };
  }

  // The exam's time limit. Udemy's results page has no field for it, but course descriptions often say it in a sentence
  // such as "50-60 multiple-choice questions in 2 hours" or "Time limit: 90 minutes". Only text outside the questions is
  // searched. Returns { minutes, text } or null when the page does not say.
  function examTimeLimit() {
    let text = document.body.textContent;
    for (const label of statusLabels()) text = text.split(paneOf(label).textContent).join(' '); // not the questions' own text
    text = text.replace(/\s+/g, ' ');
    const patterns = [
      /\d+(?:\s*[-–]\s*\d+)?\s+(?:multiple[- ]choice\s+)?questions?\s+in\s+(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/i,
      /(?:time limit|time allowed|duration)\s*[:\-–]?\s*(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return { minutes: Math.round(parseFloat(m[1].replace(',', '.')) * (/^h/i.test(m[2]) ? 60 : 1)), text: m[0] };
    }
    return null;
  }

  async function getQuizJson(preloaded) {
    const questions = preloaded || await collectAllQuestions();
    if (!questions) return null;
    const limit = examTimeLimit();
    return JSON.stringify({
      title: lessonFileName().title,
      author: courseAuthor(),
      attempt: attemptLabel(),
      source: location.href,
      timeLimitMinutes: limit ? limit.minutes : null,
      timeLimitText: limit ? limit.text : '',
      questions: questions.map(questionToJson),
    }, null, 2) + '\n';
  }

  // ---- button ----

  const style = document.createElement('style');
  style.textContent = `
    #mathesis-panel {
      position: fixed; top: 64px; right: 56px; z-index: 2147483647;
      width: max-content; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px;
      background: #252e3b; color: #e6ebf2; border: 1px solid #3b4658; border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    #mathesis-panel * { box-sizing: border-box; font: inherit; }
    #mathesis-head { display: flex; align-items: center; gap: 8px; margin: 0 -10px 2px; padding: 9px 12px; background: #151a21;
      border-bottom: 1px solid #3b4658; border-radius: 11px 11px 0 0; }
    #mathesis-dot { width: 9px; height: 9px; border-radius: 50%; background: #f9ab00; flex: none; }
    #mathesis-panel.saved #mathesis-dot { background: #34a853; }
    #mathesis-panel.unknown #mathesis-dot { background: #9aa0a6; }
    #mathesis-title { flex: 1; font-weight: 600; letter-spacing: 0.02em; }
    #mathesis-fold { background: none; border: none; color: #9aa0a6; cursor: pointer; padding: 0 4px; font-size: 16px; line-height: 1; }
    #mathesis-fold:hover { color: #e8eaed; }
    #mathesis-status { color: #9aa8bb; font-size: 12px; margin-top: -2px; }
    #mathesis-spinner { display: none; width: 12px; height: 12px; flex: none; border: 2px solid #46536a; border-top-color: #8ab4f8;
      border-radius: 50%; animation: mathesis-spin 0.8s linear infinite; }
    @keyframes mathesis-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { #mathesis-spinner { animation-duration: 2.4s; } }
    /* while the page is still being analysed: spinner and text only, no buttons */
    #mathesis-panel.loading #mathesis-spinner { display: block; }
    #mathesis-panel.loading #mathesis-dot { display: none; }
    #mathesis-panel.loading button.mx { display: none !important; }
    #mathesis-panel.loading #mathesis-status { color: #e8eaed; font-size: 13px; margin-top: 0; }
    /* folded: a vertical tab glued to the right edge of the window (+ on top, the name, the status dot at the bottom) */
    #mathesis-panel.folded { right: 0 !important; width: auto; padding: 0; border-right: 0; border-radius: 10px 0 0 10px; }
    #mathesis-panel.folded #mathesis-head { flex-direction: column; gap: 10px; margin: 0; padding: 12px 7px; border: 0; border-radius: 9px 0 0 9px; }
    #mathesis-panel.folded #mathesis-mark { order: 0; }
    #mathesis-panel.folded .mx-quick { order: 1; }
    #mathesis-panel.folded #mathesis-spinner { order: 2; }
    #mathesis-panel.folded #mathesis-dot { order: 3; }
    #mathesis-panel.folded #mathesis-title, #mathesis-panel.folded #mathesis-fold { display: none; }
    #mathesis-panel.folded > :not(#mathesis-head):not(#mathesis-tip) { display: none; }
    /* the icon (a small mu) always sits first in the header and toggles the fold; the quick action only shows when folded */
    #mathesis-panel #mathesis-mark { flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 7px; background: #8ab4f8;
      color: #14202f; cursor: pointer; font: 700 19px/22px Georgia, "Times New Roman", serif; text-align: center; }
    #mathesis-panel #mathesis-mark:hover { filter: brightness(1.08); }
    #mathesis-panel #mathesis-mark:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    #mathesis-panel button.mx-quick { display: none; position: relative; width: 30px; height: 30px; padding: 0; border-radius: 8px; background: transparent;
      color: #F2F0EB; border: 1px solid #46536a; cursor: pointer; align-items: center; justify-content: center;
      transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease; }
    #mathesis-panel.folded button.mx-quick { display: inline-flex; }
    #mathesis-panel.loading button.mx-quick { display: none; }
    #mathesis-panel button.mx-quick:hover { background: #8ab4f8; border-color: #8ab4f8; color: #14202f; }
    #mathesis-panel button.mx-quick:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    .mx-quick svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .mx-quick .mx-saved { position: absolute; top: 3px; right: 3px; }
    .mx-quick .mx-warn { position: absolute; top: -4px; right: -4px; width: 14px; height: 14px; pointer-events: none; }
    .mx-quick .mx-warn svg { width: 14px; height: 14px; }
    .mx-quick .mx-quick-spin { position: absolute; top: 2px; right: 2px; width: 9px; height: 9px; border-width: 1.5px; }
    #mathesis-panel #mathesis-ai { flex: none; height: 22px; padding: 0 6px; border: 1px solid #46536a; border-radius: 7px; background: transparent; color: #9aa0a6;
      cursor: pointer; font: 700 10px/20px system-ui, sans-serif; }
    #mathesis-panel #mathesis-ai:hover { color: #e8eaed; border-color: #8ab4f8; }
    #mathesis-panel #mathesis-ai.on { background: #f28b82; border-color: #f28b82; color: #3b0f0c; }
    #mathesis-panel.folded #mathesis-ai { order: 4; padding: 0 3px; }
    @media (prefers-reduced-motion: reduce) { #mathesis-panel button.mx-quick { transition: none; } }
    #mathesis-panel button.mx { width: 100%; padding: 8px 12px; border-radius: 8px; cursor: pointer; text-align: center; }
    #mathesis-panel button.mx:focus-visible, #mathesis-fold:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    #mathesis-panel button.primary { background: #8ab4f8; color: #14202f; border: 1px solid #8ab4f8; font-weight: 600; }
    #mathesis-panel button.primary:hover { filter: brightness(1.08); }
    #mathesis-panel button.ghost { background: transparent; color: #e8eaed; border: 1px solid #46536a; }
    #mathesis-panel button.ghost:hover { background: rgba(255, 255, 255, 0.08); filter: none; }
    #mathesis-panel button.ghost.saved { border-color: #34a853; color: #81c995; }
    #mathesis-save, #mathesis-files { display: flex; flex-direction: column; gap: 7px; }
    #mathesis-files { gap: 2px; border-top: 1px solid #3b4658; padding-top: 8px; margin-top: 2px; }
    #mathesis-files:empty { display: none; }
    #mathesis-panel.loading #mathesis-save, #mathesis-panel.loading #mathesis-files { display: none; }
    #mathesis-panel { min-width: 250px; }
    #mathesis-panel.folded { min-width: 0; }
    .mx-label { font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase; color: #9aa8bb; margin-bottom: 3px; }
    .mx-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    #mathesis-panel button.mx-chip { height: 30px; padding: 0 12px; border-radius: 15px; background: transparent; color: #F2F0EB;
      border: 1px solid #46536a; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
      transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease; }
    #mathesis-panel button.mx-chip:hover, #mathesis-panel .mx-ib:hover, #mathesis-panel .mx-name:hover { background: #8ab4f8; border-color: #8ab4f8; color: #14202f; }
    #mathesis-panel button.mx-chip:focus-visible, #mathesis-panel .mx-ib:focus-visible, #mathesis-panel .mx-name:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    .mx-saved { width: 6px; height: 6px; border-radius: 50%; background: #34a853; flex: none; }
    .mx-file { display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 4px 0 6px; border-radius: 6px; position: relative; }
    .mx-file:hover { background: rgba(138, 180, 248, 0.10); }
    #mathesis-panel .mx-name { flex: 1; min-width: 0; text-align: left; background: transparent; border: 0; color: #F2F0EB; padding: 3px 4px;
      border-radius: 5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background-color 0.25s ease, color 0.25s ease; }
    .mx-file.wait .mx-name { color: #9aa8bb; cursor: default; }
    .mx-wait { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #9aa8bb; }
    .mx-bad { flex: none; font-size: 11px; color: #ff8a80; }
    .mx-spin { width: 11px; height: 11px; border: 2px solid #46536a; border-top-color: #8ab4f8; border-radius: 50%; animation: mathesis-spin 0.8s linear infinite; }
    @media (prefers-reduced-motion: reduce) { .mx-spin { animation: none; } #mathesis-panel button.mx-chip, #mathesis-panel .mx-ib, #mathesis-panel .mx-name { transition: none; } }
    .mx-more { position: relative; flex: none; }
    #mathesis-panel .mx-ib { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px;
      background: transparent; color: #F2F0EB; border: 1px solid #46536a; cursor: pointer; padding: 0; transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease; }
    .mx-menu { position: absolute; right: 0; top: 100%; margin-top: 4px; min-width: 210px; padding: 4px; z-index: 4;
      background: #1d2531; border: 1px solid #46536a; border-radius: 8px; }
    .mx-menu[hidden] { display: none !important; }
    #mathesis-panel .mx-menu button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; background: transparent; border: 0;
      border-radius: 5px; color: #F2F0EB; text-align: left; cursor: pointer; transition: background-color 0.25s ease, color 0.25s ease; }
    #mathesis-panel .mx-menu button:hover, #mathesis-panel .mx-menu button:focus-visible { background: #8ab4f8; color: #14202f; outline: none; }
    .mx-menu svg { width: 14px; height: 14px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    #mathesis-tip { position: absolute; top: 0; width: 230px; max-width: 40vw; padding: 7px 9px; background: #121821; color: #F2F0EB;
      border: 1px solid #46536a; border-radius: 6px; font-size: 12px; line-height: 1.4; pointer-events: none; opacity: 0;
      transition: opacity 0.15s; z-index: 3; text-align: left; white-space: normal; }
    #mathesis-tip.show { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { #mathesis-tip { transition: none; } }
    #mathesis-status:empty, #mathesis-note:empty { display: none; }
    .mx-tag { flex: none; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; color: #9aa8bb; border: 1px solid #46536a; border-radius: 8px; padding: 0 6px; }
    #mathesis-note { color: #bdc1c6; font-size: 12px; max-width: 280px; }
    #mathesis-retry { background: none; border: 0; padding: 0; color: #8ab4f8; text-decoration: underline; cursor: pointer; font-size: 12px; }
    #mathesis-retry[disabled] { color: #9aa0a6; text-decoration: none; cursor: default; }
  `;
  document.head.appendChild(style);

  // One small panel instead of loose buttons: a header (status dot, name, fold), the main action, a status line,
  // then the secondary actions. Amber dot = not saved yet, green = saved, grey = server unreachable.
  const panel = document.createElement('div');
  panel.id = 'mathesis-panel';
  const head = document.createElement('div');
  head.id = 'mathesis-head';
  const dot = document.createElement('span');
  dot.id = 'mathesis-dot';
  const title = document.createElement('span');
  title.id = 'mathesis-title';
  title.textContent = 'Mathesis';
  const mark = document.createElement('button');
  mark.id = 'mathesis-mark';
  mark.type = 'button';
  mark.textContent = '\u03BC'; // small mu: the icon of Mathesis
  const quick = document.createElement('button');
  quick.type = 'button';
  quick.className = 'mx-quick';
  const fold = document.createElement('button');
  fold.id = 'mathesis-fold';
  fold.type = 'button';
  const spinner = document.createElement('span');
  spinner.id = 'mathesis-spinner';
  head.append(mark, title, spinner, dot, quick, fold);
  const statusEl = document.createElement('div');
  statusEl.id = 'mathesis-status';
  statusEl.setAttribute('role', 'status');
  const setFolded = (folded, remember) => {
    panel.classList.toggle('folded', folded);
    fold.textContent = folded ? '+' : '–';
    fold.title = fold.ariaLabel = folded ? 'Expand' : 'Collapse';
    mark.title = mark.ariaLabel = folded ? 'Mathesis: click to expand' : 'Mathesis: click to collapse';
  };
  fold.addEventListener('click', () => setFolded(!panel.classList.contains('folded'), true));
  // the icon toggles the fold: a pointer click is decided when the pointer is released (the header owns the drag, so the click never reaches the icon)
  mark.addEventListener('click', (e) => { if (e.detail === 0) setFolded(!panel.classList.contains('folded'), true); }); // keyboard: a pointer click is handled with the drag, below
  setFolded(true, false); // every page starts folded; unfolding is for that visit only

  // Drag the header to move the panel; the position is remembered per site and kept inside the window.
  // Double-click the header to put the panel back where it started.
  const POS_KEY = 'mathesis-panel-pos';
  const viewW = () => document.documentElement.clientWidth || window.innerWidth;
  const viewH = () => document.documentElement.clientHeight || window.innerHeight;
  function clampPos() {
    const r = panel.getBoundingClientRect();
    if (!r.width) return; // hidden
    const top = Math.min(Math.max(0, r.top), Math.max(0, viewH() - r.height));
    const right = Math.min(Math.max(0, viewW() - r.right), Math.max(0, viewW() - r.width));
    if (Math.abs(top - r.top) > 0.5) panel.style.top = top + 'px';
    if (Math.abs(right - (viewW() - r.right)) > 0.5) panel.style.right = right + 'px';
  }
  const savePos = () => {
    const r = panel.getBoundingClientRect();
    try {
      let right = Math.round(viewW() - r.right);
      if (panel.classList.contains('folded')) { // glued to the edge: only the height is the person's choice, the open panel keeps its own place
        const before = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
        right = before && Number.isFinite(before.right) ? before.right : null; // null: the default place
      }
      localStorage.setItem(POS_KEY, JSON.stringify({ top: Math.round(r.top), right }));
    } catch (e) { /* not remembered */ }
  };
  try {
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (pos && Number.isFinite(pos.top)) panel.style.top = pos.top + 'px';
    if (pos && Number.isFinite(pos.right)) panel.style.right = pos.right + 'px';
  } catch (e) { /* storage blocked or bad value: default position */ }
  let drag = null, moved = false;
  head.title = 'Drag to move · double-click to reset';
  head.style.cssText += 'cursor:grab;user-select:none;touch-action:none;';
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('#mathesis-fold, .mx-quick, #mathesis-ai')) return;
    const r = panel.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, top: r.top, right: viewW() - r.right, onMark: !!e.target.closest('#mathesis-mark') };
    moved = false;
    head.setPointerCapture(e.pointerId);
    head.style.cursor = 'grabbing';
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag
    moved = true;
    if (!panel.classList.contains('folded')) panel.style.right = drag.right - dx + 'px'; // folded: up and down only
    panel.style.top = drag.top + dy + 'px';
    clampPos();
  });
  const endDrag = (e) => {
    if (!drag) return;
    const toggle = drag.onMark && e.type === 'pointerup';
    drag = null;
    head.style.cursor = 'grab';
    try { head.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    if (moved) savePos();
    else if (toggle) setFolded(!panel.classList.contains('folded'), true);
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('#mathesis-fold, .mx-quick, #mathesis-ai')) return;
    panel.style.top = panel.style.right = '';
    try { localStorage.removeItem(POS_KEY); } catch (err) { /* nothing stored */ }
  });
  window.addEventListener('resize', clampPos);

  // Until the page type is known (Udemy renders quiz results after the page loads) and the server has answered, the
  // panel shows a spinner and "Analyzing…" and no buttons: anything shown earlier would describe the wrong page.
  const SETTLE_MS = 8000; // after this long, stop waiting for the page and show what we have
  let pageStart = Date.now();
  const setLoading = () => {
    panel.classList.add('loading');
    panel.classList.remove('saved', 'unknown');
    statusEl.textContent = 'Analyzing…';
  };
  setLoading();


  // The save chips of this page. Order: to review, all, json.
  const rowSpecs = () => (isQuizReview() ? [
    { chip: 'to review', kinds: ['incorrect'], save: () => copyLesson(false),
      quick: () => (hasReview() ? copyLesson(false) : saveAll()), // the folded button: with nothing to review it saves everything instead
      tipOn: 'Saves the questions you got wrong or marked, with explanations, as NN-incorrect.md (the attempt is in the name for attempts after the first). Saving again replaces this attempt.',
      tipOff: 'Copies the questions you got wrong or marked, with explanations, to the clipboard. The server is offline: an offline copy is kept in this browser, and nothing reaches your notes.' },
    { chip: 'all', kinds: ['all'], save: saveAll,
      tipOn: 'Saves every question with its explanations as NN-all questions.md (a clean copy of the whole test) and as NN-all questions.json (for other tools). Overwrites the previous files.',
      tipOff: 'Copies every question with its explanations to the clipboard. The server is offline: an offline copy is kept in this browser, and nothing reaches your notes.' },
    { chip: 'json', kinds: ['json'], save: saveJson,
      tipOn: 'Saves every question as a JSON file (options, correct answers, explanations) for other tools. Overwrites the previous file.',
      tipOff: 'Copies every question as JSON to the clipboard. The server is offline: an offline copy is kept in this browser, and nothing reaches your notes.' },
    { chip: 'attempt', kinds: ['import'], save: saveAttempt,
      tipOn: "Saves this attempt (what you answered, the questions you marked, when it was taken) as NN-attempt N.json, in the import format of the quiz platform. The dates come from Udemy's API. Import NN-all questions.json there first: the attempt finds its quiz by the hash of that file. Overwrites the previous file.",
      tipOff: 'Copies this attempt in the quiz platform import format to the clipboard. The server is offline: an offline copy is kept in this browser, and nothing reaches your notes.' },
  ] : [
    { chip: 'transcript', kinds: ['transcript'], save: () => copyLesson(false),
      tipOn: 'Saves the transcript of this lesson as a Markdown note and writes a summary in the background. Saving again overwrites it.',
      tipOff: 'Copies the transcript to the clipboard. The server is offline: an offline copy is kept in this browser, and nothing reaches your notes.' },
  ]);
  const transcriptName = () => 'transcript';
  const pagePath = () => computePathToWrite(false);
  const pageKey = () => pagePath().replace(/ \(attempt \d+\)(?=\.md$)/, ''); // every attempt of a quiz belongs to the same page // quiz results: the review file; the server finds its siblings and attempts
  const statusOf = (filePath) => fetch(`${SERVER}/status`, { headers: { 'X-File-Path': encodeURIComponent(filePath) } }).then((r) => r.json());

  // ---- save chips on top, one row per file below (click a name to open it, "⋯" for the rest) ----
  // `rowSpecs()`, `pagePath()` and `transcriptName()` come from the page type (above). The server (GET /files) says what exists, what is
  // still being written (summary, lab guide) and which program opens each file, so this script never guesses a file name.
  let serverUp = true;        // false: the chips only copy to the clipboard; nothing is sent
  let files = [];             // answer of GET /files for this page
  let lastChecked = null, pollTimer = null, noteTimer = null, renderKey = '';
  const saveEl = document.createElement('div');
  saveEl.id = 'mathesis-save';
  const filesEl = document.createElement('div');
  filesEl.id = 'mathesis-files';
  const noteEl = document.createElement('div');
  noteEl.id = 'mathesis-note';
  noteEl.setAttribute('role', 'status');
  const say = (message) => {
    noteEl.textContent = message;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { noteEl.textContent = ''; }, 8000);
  };
  const closeMenus = () => {
    filesEl.querySelectorAll('.mx-menu').forEach((m) => { m.hidden = true; });
    filesEl.querySelectorAll('[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  };
  document.addEventListener('click', closeMenus);

  // One tooltip per panel, shown beside it (so it never covers a button): on the left, or on the right when the panel has been
  // dragged to the left half of the window. It follows the hovered or focused element.
  const tipEl = document.createElement('div');
  tipEl.id = 'mathesis-tip';
  tipEl.setAttribute('aria-hidden', 'true');
  function tipOn(node, text) {
    if (typeof text === 'string') node.setAttribute('aria-label', text);
    const show = () => {
      const p = panel.getBoundingClientRect(), c = node.getBoundingClientRect();
      tipEl.textContent = typeof text === 'function' ? text() : text;
      tipEl.style.top = Math.max(0, c.top - p.top - 4) + 'px';
      const onRight = p.left + p.width / 2 < viewW() / 2;
      tipEl.style.left = onRight ? 'calc(100% + 10px)' : 'auto';
      tipEl.style.right = onRight ? 'auto' : 'calc(100% + 10px)';
      tipEl.classList.add('show');
    };
    const hide = () => tipEl.classList.remove('show');
    node.addEventListener('mouseenter', show);
    node.addEventListener('mouseleave', hide);
    node.addEventListener('focus', show);
    node.addEventListener('blur', hide);
  }
  const hideTip = () => tipEl.classList.remove('show');

  const ICONS = {
    open: '<svg viewBox="0 0 16 16"><path d="M4 1.8h5l3 3V14H4z"/><path d="M9 1.8v3h3"/></svg>',
    content: '<svg viewBox="0 0 16 16"><rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/></svg>',
    folder: '<svg viewBox="0 0 16 16"><path d="M1.8 4.2h4l1.4 1.6h7v6.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/></svg>',
    regenerate: '<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1"/><path d="M13.5 2.5v3h-3"/></svg>',
  };

  const ICON_SAVE = '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h8l3 3v8h-11z"/><path d="M5 2.5v3.5h5V2.5M5 13.5v-4h6v4"/></svg>';
  // Folded: one button does the main action of the page (the first chip: the transcript, or the quiz to review).
  let quickSpec = null;
  // the file this button's action already made: then the button opens it (to save again, or for the other files, unfold the panel)
  // On a quiz with nothing to review (no wrong or marked questions) the button saves, and then opens, the "all questions" file instead.
  const nothingToReview = () => !!quickSpec && quickSpec.chip === 'to review' && !hasReview();
  const quickKinds = () => (nothingToReview() ? ['all'] : quickSpec.kinds);
  const quickFile = () => (quickSpec && serverUp ? files.find((f) => quickKinds().includes(f.kind) && f.state === 'ready') : null);
  quick.addEventListener('click', () => { const f = quickFile(); if (f) openFile(f); else if (quickSpec) (quickSpec.quick || quickSpec.save)(); });
  tipOn(quick, () => {
    if (!quickSpec) return '';
    const warned = unrecognised ? '⚠ ' + WARN_NOTE + ' ' : '';
    const f = quickFile();
    if (f) return warned + `Open · ${displayName(f)} in ${via(f)}. Unfold the panel (μ) to save again or for the other files.`;
    if (nothingToReview()) return warned + (serverUp ? 'Save · all questions. Nothing to review in this attempt (no wrong or marked questions), so this saves the whole test as Markdown and JSON.'
      : 'Copy · all questions. Nothing to review in this attempt, so this copies the whole test. The server is offline: an offline copy is kept in this browser.');
    return warned + `${serverUp ? 'Save' : 'Copy'} · ${quickSpec.chip}. ${serverUp ? quickSpec.tipOn : quickSpec.tipOff}`;
  });
  // The page type is decided when the page has settled (the panel is no longer "loading"): a page the script does not recognise
  // (see pageRecognised) gets a warning badge on this button, since what a click would save is a guess.
  const WARN_NOTE = 'Page type not recognised: Mathesis does not know what to save from this page.';
  const ICON_WARN = '<svg viewBox="0 0 16 16"><path d="M8 1.6 15.3 14.2H.7z" fill="#f9ab00" stroke="#f9ab00" stroke-width="1.2"/><path d="M8 6v4M8 11.8v.1" stroke="#14202f" stroke-width="1.8"/></svg>';
  let unrecognised = false;
  // Known: a lecture (its transcript) and a quiz result (its questions). Not known: a quiz you are taking, an assignment, a result
  // page whose questions never showed up, or a page whose lesson the sidebar does not name.
  const pageRecognised = () => {
    try { computePathToWrite(); } catch (e) { return false; }
    if (/\/result\//.test(location.pathname)) return isQuizReview();
    return /\/learn\/lecture\//.test(location.pathname);
  };
  function updateQuick(specs) {
    quickSpec = specs[0] || null;
    quick.style.display = quickSpec ? '' : 'none';
    quick.textContent = '';
    if (!quickSpec) return;
    quick.insertAdjacentHTML('beforeend', quickFile() ? ICONS.open : serverUp ? ICON_SAVE : ICONS.copy);
    if (unrecognised) {
      const warn = document.createElement('span');
      warn.className = 'mx-warn';
      warn.innerHTML = ICON_WARN;
      quick.append(warn);
    }
    if (serverUp && files.some((f) => f.state === 'pending')) { // a summary / lab guide is being written: a spinner instead of the dot
      const spin = document.createElement('span');
      spin.className = 'mx-spin mx-quick-spin';
      quick.append(spin);
    } else if (serverUp && files.some((f) => quickKinds().includes(f.kind) && f.state === 'ready')) { // a small green dot: that file exists
      const dot = document.createElement('span');
      dot.className = 'mx-saved';
      quick.append(dot);
    }
    quick.setAttribute('aria-label', (unrecognised ? 'Warning: ' + WARN_NOTE + ' ' : '') + (quickFile() ? `Open ${displayName(quickFile())}` : `${serverUp ? 'Save' : 'Copy'} ${nothingToReview() ? 'all questions' : quickSpec.chip}`));
  }

  const displayName = (f) => ({
    incorrect: `to review · attempt ${f.attempt || 1}`, all: 'all questions', json: 'all questions (json)', import: `attempt ${f.attempt || 1} (import)`,
    'lab-guide': 'lab guide', summary: 'summary', transcript: transcriptName(),
  }[f.kind] || f.label.toLowerCase());
  const via = (f) => (f.opener === 'obsidian' ? 'Obsidian' : 'your text editor');

  // ---- offline copies: with the server down, a save also keeps the text in this site's browser storage ----
  // They are copies, not files in your notes: copy their content, download them, or send them
  // to the server once it is back. Stored per site (localStorage), one key per file.
  const OFF = 'mathesis-offline:';
  const offlineKinds = { 'quiz-review': 'incorrect', 'quiz-all': 'all', 'quiz-json': 'json', 'quiz-attempt': 'import', transcript: 'transcript', bundle: 'transcript', lab: 'transcript', quiz: 'transcript' };
  const offlineName = (e) => displayName({ kind: offlineKinds[e.kind] || 'transcript', attempt: parseInt((e.path.match(/\(attempt (\d+)\)/) || [])[1], 10) || 1, label: e.path });
  function offlineAll() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(OFF)) { try { out.push(JSON.parse(localStorage.getItem(key))); } catch (e) { /* a broken entry is skipped */ } }
      }
    } catch (e) { /* storage blocked */ }
    return out.filter((e) => e && e.path && typeof e.text === 'string');
  }
  function offlineFor(key) { return offlineAll().filter((e) => e.page === key).sort((a, b) => b.savedAt - a.savedAt); }
  function keepOffline(kind, path, text) {
    if (kind === 'raw' || kind === 'bundle') return false; // a bundle's body is only a link: nothing to review
    let page;
    try { page = pageKey(); } catch (e) { return false; }
    let meta = {};
    try { meta = JSON.parse(decodeURIComponent(metaHeader())); } catch (e) { /* no metadata */ }
    try {
      localStorage.setItem(OFF + encodeURIComponent(path), JSON.stringify({ path, kind, text, meta, page, savedAt: Date.now() }));
      renderRows();
      return true;
    } catch (e) { say('Could not keep an offline copy here: the browser storage is full or blocked.'); return false; }
  }
  function offlineDelete(path) {
    try { localStorage.removeItem(OFF + encodeURIComponent(path)); } catch (e) { /* nothing stored */ }
    renderRows();
  }
  function downloadText(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // The file in the notes was edited after the server wrote it (409 "modified"): show what saving would change and ask. `diff` is a
  // unified diff from the file as it is to the text about to replace it ("-" lines would be lost: usually the person's notes).
  // Resolves to 'yes' (overwrite), 'metadata' (keep the text, update the frontmatter) or null (cancel). Without a diff: plain prompts.
  function askModified(diff, text) {
    if (!diff) {
      if (confirm(text + ' Overwrite them?')) return Promise.resolve('yes');
      return Promise.resolve(confirm('Keep your text as it is and only update the metadata (frontmatter) of the file?') ? 'metadata' : null);
    }
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:13px/1.4 system-ui,sans-serif';
      const box = document.createElement('div');
      box.style.cssText = 'background:#252e3b;color:#e6ebf2;border:1px solid #3b4658;border-radius:12px;padding:16px;width:min(900px,92vw);max-height:86vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,.5)';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;font-size:14px';
      title.textContent = 'This file was changed after it was saved';
      const note = document.createElement('div');
      note.style.color = '#9aa8bb';
      const lines = diff.split('\n');
      const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
      const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      note.textContent = `Saving would remove ${removed} line(s) now in your notes (red) and add ${added} (green). `
        + 'Lines you typed into the file show up as removed.';
      const pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;overflow:auto;background:#151a21;border-radius:8px;padding:10px;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;flex:1';
      lines.forEach((l) => {
        const row = document.createElement('div');
        row.textContent = l || ' ';
        if (l.startsWith('+') && !l.startsWith('+++')) { row.style.color = '#7ee2a0'; row.style.background = 'rgba(52,168,83,.16)'; }
        else if (l.startsWith('-') && !l.startsWith('---')) { row.style.color = '#ff9b95'; row.style.background = 'rgba(234,67,53,.16)'; }
        else if (l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++')) row.style.color = '#8ab4f8';
        else row.style.color = '#b8c0cc';
        pre.appendChild(row);
      });
      const buttons = document.createElement('div');
      buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap';
      const done = (value) => { wrap.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      const button = (label, value, primary) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = `cursor:pointer;border-radius:8px;padding:7px 12px;border:1px solid #46536a;background:${primary ? '#8ab4f8' : 'transparent'};color:${primary ? '#10151c' : '#e6ebf2'};font-weight:600`;
        b.addEventListener('click', () => done(value));
        return b;
      };
      buttons.append(button('Cancel', null), button('Keep my text, update only the metadata', 'metadata'), button('Overwrite', 'yes', true));
      box.append(title, note, pre, buttons);
      wrap.appendChild(box);
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      buttons.firstChild.focus();
    });
  }

  async function uploadOffline(e, overwrite) {
    try {
      const r = await fetch(`${SERVER}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-File-Path': encodeURIComponent(e.path), 'X-Mathesis-Kind': e.kind,
                   'X-Mathesis-Meta': encodeURIComponent(JSON.stringify(e.meta || {})), ...(overwrite ? { 'X-Mathesis-Overwrite': overwrite } : {}) },
        body: e.text,
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409 && d.code === 'modified') { // the file in your notes has changes the server did not write
        const choice = await askModified(d.diff, 'The file in your notes was changed after it was saved (your notes?). Sending this copy will overwrite those changes.');
        if (choice) return uploadOffline(e, choice);
        say('Not sent: the offline copy is still here.');
        return;
      }
      if (!r.ok) throw new Error(d.error || r.status + ' ' + r.statusText);
      offlineDelete(e.path);
      say(d.metadata_only ? 'Only the metadata of the file in your notes was updated; the offline copy was removed.'
        : d.kept ? 'That file already existed without metadata, so only its metadata was added; the offline copy was removed.'
        : 'Sent to the server; the offline copy was removed.');
      refreshFiles();
    } catch (error) { say(`Could not send it: ${error.message}`); }
  }
  function offlineRow(e) {
    const row = document.createElement('div');
    row.className = 'mx-file';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'mx-name';
    name.textContent = offlineName(e);
    name.addEventListener('click', () => toClipboard(e.text, 'Content copied.'));
    tipOn(name, `An offline copy kept in this browser (${new Date(e.savedAt).toLocaleString()}). Click to copy its content.`);
    const tag = document.createElement('span');
    tag.className = 'mx-tag';
    tag.textContent = 'offline';
    const more = document.createElement('div');
    more.className = 'mx-more';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mx-ib';
    toggle.textContent = '⋯';
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', 'false');
    tipOn(toggle, 'Copy, download, send to the server, delete');
    const menu = document.createElement('div');
    menu.className = 'mx-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    const items = [
      ['content', 'Copy the content', () => toClipboard(e.text, 'Content copied.')],
      ['folder', 'Download as a file', () => downloadText(e.path.split('/').pop(), e.text)],
      ...(serverUp ? [['open', 'Send to the server', () => uploadOffline(e)]] : []),
      ['copy', 'Delete this offline copy', () => { if (confirm('Delete this offline copy from the browser?')) offlineDelete(e.path); }],
    ];
    for (const [icon, text, run] of items) {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.innerHTML = ICONS[icon];
      item.append(document.createTextNode(text));
      item.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenus(); run(); });
      menu.append(item);
    }
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wasHidden = menu.hidden;
      closeMenus();
      menu.hidden = !wasHidden;
      toggle.setAttribute('aria-expanded', String(wasHidden));
      if (wasHidden) menu.querySelector('button').focus();
    });
    menu.addEventListener('keydown', (ev) => {
      const all = [...menu.querySelectorAll('button')];
      const i = all.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); all[(i + 1) % all.length].focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); all[(i - 1 + all.length) % all.length].focus(); }
      else if (ev.key === 'Escape') { closeMenus(); toggle.focus(); }
    });
    more.append(toggle, menu);
    row.append(name, tag, more);
    return row;
  }

  async function toClipboard(text, done) {
    try { await navigator.clipboard.writeText(text); say(done); } catch (e) { say('Could not copy: ' + e.message); }
  }
  async function serverCall(path, f, headers = {}) {
    const r = await fetch(`${SERVER}${path}`, { method: path === '/open' || path === '/regenerate' ? 'POST' : 'GET', headers: { 'X-File-Path': encodeURIComponent(f.path), ...headers } });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw Object.assign(new Error(d.error || r.status + ' ' + r.statusText), { code: d.code }); }
    return r;
  }
  async function openFile(f) {
    if (f.opener === 'obsidian' && f.obsidian_uri) { window.location.href = f.obsidian_uri; return; }
    try { await serverCall('/open', f); } catch (e) { toClipboard(f.abs_path || f.path, `Could not open it (${e.message}). The path was copied.`); }
  }
  async function showInFolder(f) {
    try { await serverCall('/open', f, { 'X-Mathesis-Open': 'folder' }); } catch (e) { say(`Could not open the folder: ${e.message}`); }
  }
  async function copyContent(f) { // the text of a saved file, from the server, to the clipboard
    try { await toClipboard(await (await serverCall('/file', f)).text(), 'Content copied.'); } catch (e) { say(`Could not copy the content: ${e.message}`); }
  }

  async function regenerate(f) { // summary / lab guide: the configured provider writes it again (the old file is replaced when the new one is ready)
    const lesson = files.find((x) => x.kind === 'transcript');
    const what = displayName(f).toLowerCase();
    if (!lesson) { toast.error(`Could not regenerate the ${what}: the lesson itself is not saved.`); return; }
    if (files.some((x) => x.state === 'pending')) { toast('Generation in progress… wait for it to finish.'); return; }
    if (!confirm(`Regenerate the ${what}?\n\nThe AI provider writes it again from the saved lesson and replaces the current file, so any edits you made to it are lost. This can take a few minutes. If it fails, the current file is kept.`)) return;
    try {
      await serverCall('/regenerate', lesson, { 'X-Mathesis-Kind': f.kind });
      toast.ok(`Regenerating the ${what}…`);
      lastChecked = null; // ask the server again now: the row shows "writing…" until it is done
    } catch (e) { if (e.code === 'pending') toast('Generation in progress… wait for it to finish.'); else toast.error(`Could not regenerate the ${what}: ${e.message}`); }
  }

  function fileRow(f) {
    const row = document.createElement('div');
    row.className = 'mx-file' + (f.state === 'pending' ? ' wait' : '');
    const reusable = f.state === 'failed' && f.path; // a regeneration failed: the previous file is still there
    const name = document.createElement(f.state === 'ready' || reusable ? 'button' : 'span');
    name.className = 'mx-name';
    name.textContent = displayName(f);
    row.append(name);
    if (f.state === 'pending') {
      const wait = document.createElement('span');
      wait.className = 'mx-wait';
      wait.innerHTML = '<span class="mx-spin"></span>writing…';
      row.append(wait);
      return row;
    }
    if (f.state === 'failed' && !reusable) {
      const bad = document.createElement('span');
      bad.className = 'mx-bad';
      bad.textContent = 'failed';
      bad.title = f.error || '';
      name.addEventListener('click', () => say(`The ${displayName(f)} was not written (${f.error || 'see the server log'}). Save again to retry.`));
      row.append(bad);
      return row;
    }
    name.type = 'button';
    name.addEventListener('click', () => openFile(f));
    tipOn(name, `Open locally in ${via(f)}`);
    if (reusable) {
      const bad = document.createElement('span');
      bad.className = 'mx-bad';
      bad.textContent = 'not regenerated';
      bad.title = `${f.error || 'see the server log'}. The previous file was kept.`;
      row.append(bad);
    }
    const more = document.createElement('div');
    more.className = 'mx-more';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mx-ib';
    toggle.textContent = '⋯';
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', 'false');
    tipOn(toggle, 'Open locally, copy the content or the path, show in folder');
    const menu = document.createElement('div');
    menu.className = 'mx-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    for (const [icon, text, run] of [
      ['open', `Open locally in ${via(f)}`, () => openFile(f)],
      ['content', 'Copy the content', () => copyContent(f)],
      ['copy', 'Copy file path', () => toClipboard(f.abs_path || f.path, 'Path copied.')],
      ['folder', 'Show in folder', () => showInFolder(f)],
      ...(f.kind === 'summary' || f.kind === 'lab-guide' ? [['regenerate', 'Regenerate…', () => regenerate(f)]] : []),
    ]) {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.innerHTML = ICONS[icon];
      item.append(document.createTextNode(text));
      item.addEventListener('click', (e) => { e.stopPropagation(); closeMenus(); run(); });
      menu.append(item);
    }
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasHidden = menu.hidden;
      closeMenus();
      menu.hidden = !wasHidden;
      toggle.setAttribute('aria-expanded', String(wasHidden));
      if (wasHidden) menu.querySelector('button').focus();
    });
    menu.addEventListener('keydown', (e) => {
      const all = [...menu.querySelectorAll('button')];
      const i = all.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length].focus(); }
      else if (e.key === 'Escape') { closeMenus(); toggle.focus(); }
    });
    more.append(toggle, menu);
    row.append(more);
    return row;
  }

  function renderRows() {
    const specs = rowSpecs();
    let pk = null;
    try { pk = pageKey(); } catch (e) { /* page still loading */ }
    const offline = pk ? offlineFor(pk) : [];
    unrecognised = !panel.classList.contains('loading') && !pageRecognised();
    const key = JSON.stringify([serverUp, files, specs.map((s) => s.chip), offline.map((e) => [e.path, e.savedAt]), unrecognised]);
    if (key === renderKey) return;
    renderKey = key;
    hideTip();
    // save chips (a small green dot says that file exists)
    saveEl.textContent = '';
    const label = document.createElement('div');
    label.className = 'mx-label';
    label.textContent = serverUp ? 'save' : 'copy';
    const chips = document.createElement('div');
    chips.className = 'mx-chips';
    for (const spec of specs) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mx-chip'; // all chips look alike: a highlighted one would read as the selected pill
      if (serverUp && files.some((f) => spec.kinds.includes(f.kind) && f.state === 'ready')) {
        const dot = document.createElement('span');
        dot.className = 'mx-saved';
        chip.append(dot);
      }
      chip.append(document.createTextNode(spec.chip));
      chip.addEventListener('click', spec.save);
      tipOn(chip, serverUp ? spec.tipOn : spec.tipOff);
      chips.append(chip);
    }
    saveEl.append(label, chips);
    updateQuick(specs);
    // files
    filesEl.textContent = '';
    const shown = serverUp ? files : [];
    if (shown.length) {
      const head = document.createElement('div');
      head.className = 'mx-label';
      head.textContent = 'files';
      filesEl.append(head);
      for (const f of shown) filesEl.append(fileRow(f));
    }
    if (offline.length) {
      const head = document.createElement('div');
      head.className = 'mx-label';
      head.style.marginTop = shown.length ? '6px' : '0';
      head.textContent = 'offline copies';
      filesEl.append(head);
      for (const e of offline) filesEl.append(offlineRow(e));
    }
  }

  // Server offline: the only status text there is, with a retry link just after it.
  function showStatus(offline, again) {
    statusEl.textContent = '';
    if (!offline) { if (!pageRecognised()) statusEl.textContent = '⚠ ' + WARN_NOTE; return; }
    statusEl.append(document.createTextNode(again ? 'Server still offline ' : 'Server offline '));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.id = 'mathesis-retry';
    retry.textContent = '(retry)';
    retry.addEventListener('click', () => {
      retry.disabled = true;
      retry.textContent = '(checking…)';
      refreshFiles(true);
    });
    statusEl.append(retry);
  }

  function settle(up, list, again) {
    panel.classList.remove('loading');
    serverUp = up;
    files = list;
    panel.classList.toggle('unknown', !up);
    if (!up) inspector.available(false);
    panel.classList.toggle('saved', files.some((f) => f.state === 'ready'));
    showStatus(!up, again);
    renderRows();
    clearTimeout(pollTimer);
    // a summary or lab guide is being written: ask again until it is done
    if (up && files.some((f) => f.state === 'pending')) pollTimer = setTimeout(() => { lastChecked = null; }, 3000);
  }

  let wasOffline = false;
  function refreshFiles(retry = false) {
    let filePath;
    try { filePath = pagePath(); } catch (e) { // page still loading; retried below
      if (Date.now() - pageStart > SETTLE_MS) { settle(true, []); inspector.probe(); } // a page the script cannot read is the one to inspect
      return;
    }
    lastChecked = filePath;
    return fetch(`${SERVER}/files`, { headers: { 'X-File-Path': encodeURIComponent(filePath) } })
      .then((r) => r.json())
      .then((d) => { if (lastChecked === filePath) { wasOffline = false; settle(true, d.files || []); inspector.available(!!d.inspect); } })
      .catch(() => {
        // The server may just be busy or restarting (or the request was cut by a navigation): show it, then check again
        if (lastChecked !== filePath) return;
        settle(false, [], retry || wasOffline);
        wasOffline = true;
        setTimeout(() => { if (lastChecked === filePath) lastChecked = null; }, 3000); // the 1 s timer below retries
      });
  }

  // ---- Inspect mode (only when the server runs with --inspect): the AI button shares this page, read-only, with `mathesis inspect`.
  // The page answers questions about itself (outline, html, text, query, count, parse); it cannot run code or click anything, and
  // password / form values are never sent. Sharing lasts until you click AI again or leave the page.
  const inspector = (() => {
    const ai = document.createElement('button');
    ai.id = 'mathesis-ai';
    ai.type = 'button';
    ai.textContent = 'AI';
    ai.style.display = 'none';
    head.insertBefore(ai, fold);
    let sid = null, sharing = false, answered = 0, loopToken = 0, stream = null;
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const clip = (s, n) => (s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s);
    const num = (v, d, max) => Math.min(Math.max(parseInt(v, 10) || d, 1), max);
    const ours = '#mathesis-panel, #mathesis-toast, #mathesis-toasts, #mathesis-tip, .mx-toast';
    const pick = (selector) => {
      if (typeof selector !== 'string' || selector.length > 500) throw new Error('selector must be a string of at most 500 characters');
      return selector;
    };
    // a copy of the element that is safe to send: no scripts / styles, no form values, no data: blobs, nothing of this panel
    function sanitized(el) {
      const c = el.cloneNode(true);
      (c.querySelectorAll ? c.querySelectorAll('script, style, noscript, ' + ours) : []).forEach((n) => n.remove());
      (c.querySelectorAll ? [c, ...c.querySelectorAll('*')] : [c]).forEach((n) => {
        if (!n.attributes) return;
        const tag = n.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') { n.removeAttribute('value'); if (tag === 'textarea') n.textContent = ''; }
        for (const a of [...n.attributes]) if (a.value.length > 300) n.setAttribute(a.name, clip(a.value, 300));
      });
      return c;
    }
    const label = (el) => {
      const tag = el.tagName.toLowerCase();
      const cls = [...el.classList].filter((x) => !/^mx-/.test(x)).slice(0, 3).map((x) => '.' + x).join('');
      const keep = ['role', 'aria-label', 'data-purpose', 'name', 'type', 'href'].filter((a) => el.hasAttribute(a))
        .map((a) => `${a}=${JSON.stringify(clip(el.getAttribute(a), 60))}`).join(' ');
      return tag + (el.id ? '#' + el.id : '') + cls + (keep ? ' [' + keep + ']' : '') + (el.shadowRoot ? ' {shadow}' : '');
    };
    const cssPath = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && n !== document.documentElement && parts.length < 7; n = n.parentElement) {
        const same = n.parentElement ? [...n.parentElement.children].filter((x) => x.tagName === n.tagName) : [n];
        parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : same.length > 1 ? `:nth-of-type(${same.indexOf(n) + 1})` : ''));
        if (n.id) break;
      }
      return parts.join(' > ');
    };
    const ops = {
      info: () => ({ url: location.href, title: document.title, readyState: document.readyState, viewport: [innerWidth, innerHeight],
        iframes: document.querySelectorAll('iframe').length, userAgent: navigator.userAgent, script: scriptInfo() }),
      outline: (a) => {
        const root = a.selector ? document.querySelector(pick(a.selector)) : document.body;
        if (!root) throw new Error('no element matches ' + a.selector);
        const depth = num(a.depth, 4, 12), lines = [];
        const walk = (el, d) => {
          if (lines.length >= 400 || el.matches(ours)) return;
          const kids = [...el.children];
          const own = kids.length || /^(script|style|noscript)$/i.test(el.tagName) ? '' : ' ' + JSON.stringify(clip((el.textContent || '').trim().replace(/\s+/g, ' '), 50));
          lines.push('  '.repeat(d) + label(el) + (d >= depth && kids.length ? ` (+${kids.length} children)` : '') + (own === ' ""' ? '' : own));
          if (d < depth) kids.forEach((k) => walk(k, d + 1));
        };
        walk(root, 0);
        return lines.join('\n') + (lines.length >= 400 ? '\n…(cut at 400 lines: narrow it with --selector)' : '');
      },
      html: (a) => {
        const els = [...document.querySelectorAll(pick(a.selector || 'html'))].slice(0, 5);
        if (!els.length) throw new Error('no element matches ' + a.selector);
        return clip(els.map((el) => sanitized(el).outerHTML).join('\n\n'), num(a.max, 60000, 2000000));
      },
      text: (a) => {
        const els = [...document.querySelectorAll(pick(a.selector || 'body'))].slice(0, 20);
        if (!els.length) throw new Error('no element matches ' + a.selector);
        return clip(els.map((el) => (el.innerText || el.textContent || '').trim()).join('\n---\n'), num(a.max, 60000, 2000000));
      },
      query: (a) => {
        const els = [...document.querySelectorAll(pick(a.selector))];
        return { total: els.length, shown: Math.min(els.length, num(a.limit, 50, 500)),
          elements: els.slice(0, num(a.limit, 50, 500)).map((el) => ({ path: cssPath(el), tag: el.tagName.toLowerCase(), id: el.id || undefined,
            class: el.className && typeof el.className === 'string' ? el.className : undefined,
            attrs: Object.fromEntries([...el.attributes].filter((x) => !['id', 'class', 'value', 'style'].includes(x.name)).slice(0, 12).map((x) => [x.name, clip(x.value, 120)])),
            text: clip((el.textContent || '').trim().replace(/\s+/g, ' '), 120), children: el.children.length, visible: !!(el.offsetWidth || el.offsetHeight) })) };
      },
      count: (a) => ({ selector: a.selector, count: document.querySelectorAll(pick(a.selector)).length }),
      parse: () => scriptParse(clip),
    };
    async function execute(cmd) {
      const a = cmd.args || {};
      try {
        if (!ops[cmd.op]) throw new Error('unknown operation ' + cmd.op);
        return { ok: true, data: await ops[cmd.op](a) };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    function show() {
      ai.classList.toggle('on', sharing);
      ai.title = ai.ariaLabel = sharing ? `Sharing this page with the AI (read-only; ${answered} requests answered). Click to stop.`
        : 'Share this page with the AI so it can inspect it (read-only: no scripts run, no form values sent)';
    }
    async function register() {
      const r = await fetch(`${SERVER}/inspect/register`, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ url: location.href, title: document.title }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      sid = (await r.json()).id;
    }
    function open(token) { // commands arrive as Server-Sent Events; each is answered with a POST
      const es = new EventSource(`${SERVER}/inspect/stream?id=${encodeURIComponent(sid)}`);
      stream = es;
      es.onmessage = async (ev) => {
        if (token !== loopToken) return;
        let cmd;
        try { cmd = JSON.parse(ev.data); } catch (e) { return; }
        const result = await execute(cmd);
        try {
          await fetch(`${SERVER}/inspect/answer?id=${encodeURIComponent(sid)}&command=${encodeURIComponent(cmd.id)}`,
            { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(result) });
          answered++; show();
        } catch (e) { /* the server went away: the stream reconnects or ends below */ }
      };
      es.onerror = async () => {
        // the browser reconnects by itself after a dropped connection; CLOSED means the server refused (it restarted and forgot this page)
        if (es.readyState !== EventSource.CLOSED || token !== loopToken) return;
        es.close();
        while (sharing && token === loopToken) {
          try { await register(); open(token); return; } catch (e) { await nap(3000); }
        }
      };
    }
    async function start() {
      try { await register(); } catch (e) { toast.error('Could not share the page: ' + e.message); return; }
      sharing = true; answered = 0; show(); open(++loopToken);
      toast.ok('The AI can now inspect this page (read-only: it cannot run code or click; passwords and form values are never sent). Click AI again to stop.');
    }
    function stop(quiet) {
      sharing = false; loopToken++;
      if (stream) { stream.close(); stream = null; }
      const id = sid; sid = null;
      if (id) { try { navigator.sendBeacon(`${SERVER}/inspect/close?id=${encodeURIComponent(id)}`); } catch (e) { /* closed anyway: it goes stale */ } }
      show();
      if (!quiet) toast('Stopped sharing this page.');
    }
    ai.addEventListener('click', () => (sharing ? stop() : start()));
    window.addEventListener('pagehide', () => { if (sharing) stop(true); });
    show();
    let probed = 0;
    const probe = () => { // no /files answer without a page path: ask the server directly (at most every 10 s)
      if (Date.now() - probed < 10000) return;
      probed = Date.now();
      fetch(`${SERVER}/inspect`).then((r) => (r.ok ? r.json() : {})).then((d) => { if (d && d.enabled) ai.style.display = ''; }).catch(() => {});
    };
    return { probe, available(on) { ai.style.display = on ? '' : 'none'; if (!on && sharing) stop(true); } };
  })();

  const scriptInfo = () => { // what this script makes of the page (for the AI): nothing is clicked or changed
    const o = {};
    try { o.version = GM_info.script.version; } catch (e) { /* not exposed with @grant none */ }
    o.kind = isQuizReview() ? 'quiz results' : cues().length || transcriptToggle() ? 'lecture' : 'other';
    try { o.path = pagePath(); } catch (e) { o.pathError = String((e && e.message) || e); }
    return o;
  };
  const scriptParse = (clip) => {
    const out = scriptInfo();
    try {
      out.transcriptToggle = !!transcriptToggle(); out.cues = cues().length; out.quizStatusLabels = statusLabels().length; out.pills = pills().length;
      out.currentItem = currentItem() ? clip(currentItem().textContent.trim(), 200) : null;
      try { out.course = courseName(); } catch (e) { out.courseError = String((e && e.message) || e); }
      try { out.lesson = lessonFileName(); } catch (e) { out.lessonError = String((e && e.message) || e); }
    } catch (e) { out.error = String((e && e.stack) || e); }
    return out; // reading the transcript opens the transcript panel, so it is not done here: ask for html / text / query of it
  };

  const pageReady = () => {
    if (Date.now() - pageStart > SETTLE_MS) return true;
    try { computePathToWrite(); } catch (e) { return false; } // the sidebar has not rendered the current item yet
    return !/\/result\//.test(location.pathname) || isQuizReview(); // a results URL waits for its questions
  };

  // A failed save uploads the page and the failure to the server (POST /reports) and returns the report ID, or null
  // when even that is not possible (server unreachable). The ID lets the problem be inspected later with GET /reports/<id>.
  function reportFailure(info) {
    let version = null;
    try { version = GM_info.script.version; } catch (e) { /* not exposed with @grant none */ }
    return fetch(SERVER + '/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        ...info, site: location.hostname, url: location.href, title: document.title, scriptVersion: version,
        userAgent: navigator.userAgent, html: '<!DOCTYPE html>\n' + document.documentElement.outerHTML,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d && d.id) || null)
      .catch(() => null);
  }

  // Resolves to true when the text reached the server and was saved. `preloaded`: the questions, when the caller already read them.
  async function copyLesson(allQuestions = false, preloaded = null) {
    let kind = isQuizReview() ? (allQuestions ? 'quiz-all' : 'quiz-review') : 'transcript';
    let text = allQuestions ? await getAllQuestions(preloaded) : await getTranscript();
    let filePath;
    if (text === RAW) {
      kind = 'raw';
      text = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      filePath = rawPathToWrite();
    } else if (!text) {
      return false;
    } else {
      try {
        filePath = computePathToWrite(allQuestions);
      } catch (e) {
        console.error(e);
        toast.error('Could not compute file path: ' + e.message);
        return false;
      }
    }

    const copyOnly = (why) => {
      const kept = keepOffline(kind, filePath, text); // an offline copy in this browser, and the clipboard
      return navigator.clipboard.writeText(text)
        .then(() => toast.ok(why + 'Copied to the clipboard' + (kept ? ' and kept as an offline copy in this browser (see the panel).' : '.')))
        .catch((error) => toast.error('Could not copy text to clipboard: ' + error));
    };
    if (!serverUp) { copyOnly(''); return false; } // no server: nothing is sent

    if (kind === 'quiz-review' && !attemptNumber()) { // the file is named after the attempt: never guess it
      toast.error('Could not find the attempt number ("Attempt N") on this page, so the review was not saved. Try again once the results have loaded.');
      return false;
    }

    if (files.some((f) => f.state === 'pending')) { toast('Generation in progress… wait for it to finish.'); return false; } // a summary / lab guide is still being written: do nothing

    const send = (overwrite) => fetch(`${SERVER}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-File-Path': encodeURIComponent(filePath), 'X-Mathesis-Kind': kind, 'X-Mathesis-Meta': metaHeader(),
                 ...(overwrite ? { 'X-Mathesis-Overwrite': overwrite } : {}) },
      body: text,
    })
      .then((response) => {
        if (!response.ok) { // show the server's reason (it answers {"error": "...", "code": "..."})
          return response.json().catch(() => ({})).then((d) => { throw Object.assign(new Error(d.error || response.status + ' ' + response.statusText), { status: response.status, code: d.code, diff: d.diff }); });
        }
        return response.json();
      })
      .catch((error) => {
        // the file has notes in it (its body no longer matches the hash in its frontmatter): ask, then save over them
        if (error.code !== 'modified') throw error;
        return askModified(error.diff, 'The file was changed after it was saved (your notes?). Saving will overwrite those changes.').then((choice) => {
          if (choice) return send(choice);
          throw Object.assign(new Error('cancelled'), { cancelled: true }); // declined: nothing is saved, and it is not an error
        });
      });
    return send(false)
      .then((data) => {
        console.log('[Mathesis] saved', data);
        refreshFiles();
        if (data.metadata_only) {
          toast('Only the metadata (frontmatter) was updated. Your text is untouched.');
          return true;
        }
        if (data.kept) { // a file with your own text and no metadata: the server only added the metadata
          toast('This file already existed without metadata, so it was not overwritten: only the metadata (frontmatter) was added, and your text is untouched.');
          return true;
        }
        toast.ok(kind === 'raw' ? 'No standard transcript found: the page HTML was saved as raw (' + data.path + ')'
          : kind === 'quiz-review' ? 'Incorrect and to-review questions saved!'
          : kind === 'quiz-all' ? 'All questions saved!' : 'Transcript sent successfully!');
        return true;
      })
      .catch(async (error) => {
        if (error.cancelled) return false;
        if (error.code === 'pending') { toast('Generation in progress… wait for it to finish.'); return false; } // another tab started it
        console.error('Error:', error);
        if (!error.status) { copyOnly('Could not reach the Mathesis server. '); return false; } // it went away since the last check
        const id = await reportFailure({ kind, path: filePath, status: error.status || null, error: String(error.message || error), body: text });
        toast.error('Could not send: ' + error + (id ? '\n\nError report: ' + id + ' (tell Claude this ID)' : ''));
        return false;
      });
  }
  // The "all" button: the whole test as Markdown (NN-all questions.md) and JSON (NN-all questions.json), read from the page once.
  // Offline, only the Markdown goes to the clipboard (the JSON would replace it there): the json button still copies the JSON.
  async function saveAll() {
    const questions = await collectAllQuestions();
    if (!questions) return;
    const saved = await copyLesson(true, questions);
    if (saved && serverUp) await saveJson(questions);
  }
  // Nothing to review: no question was answered wrong or marked (a perfect score, or an attempt without answers).
  const hasReview = () => pills().some((p) => (p.name === 'incorrect' || p.name === 'marked') && p.count > 0);
  async function saveJson(preloaded) {
    const text = await getQuizJson(preloaded);
    if (!text) return;
    let filePath;
    try {
      filePath = jsonPathToWrite();
    } catch (e) {
      console.error(e);
      toast.error('Could not compute file path: ' + e.message);
      return;
    }
    const copyJson = (why) => {
      const kept = keepOffline('quiz-json', filePath, text); // an offline copy in this browser, and the clipboard
      return navigator.clipboard.writeText(text)
        .then(() => toast.ok(why + 'Copied the JSON to the clipboard' + (kept ? ' and kept as an offline copy in this browser (see the panel).' : '.')))
        .catch((e) => toast.error('Could not copy text to clipboard: ' + e));
    };
    if (!serverUp) { copyJson(''); return; } // no server: nothing is sent
    try {
      const response = await fetch(`${SERVER}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-File-Path': encodeURIComponent(filePath), 'X-Mathesis-Kind': 'quiz-json' },
        body: text,
      });
      if (!response.ok) {
        const d = await response.json().catch(() => ({}));
        throw Object.assign(new Error(d.error || response.status + ' ' + response.statusText), { status: response.status });
      }
      const data = await response.json();
      console.log('[Mathesis] saved', data);
      refreshFiles();
      toast.ok('All questions saved as JSON! (' + data.path + ')');
    } catch (error) {
      console.error('Error:', error);
      if (!error.status) { copyJson('Could not reach the Mathesis server. '); return; } // it went away since the last check
      const id = await reportFailure({ kind: 'quiz-json', path: filePath, status: error.status, error: String(error.message || error), body: text });
      toast.error('Could not send: ' + error + (id ? '\n\nError report: ' + id + ' (tell Claude this ID)' : ''));
    }
  }

  // ---- the attempt, for the quiz platform (QuickQuiz import): "NN-attempt N.json" ----
  // Format: schema/quickquiz-attempts.schema.json. What the results page knows: the options you chose ("Your answer"), the questions
  // you marked (the "marked" filter) and the attempt's id (the number in the URL). Udemy does not show when you took it, so the dates
  // come from Udemy's quiz API (the same session, nothing leaves the browser); without them the file says "now" and 0 seconds.
  const resultIds = () => {
    const m = location.pathname.match(/\/learn\/quiz\/(\d+)\/result\/(\d+)/);
    return m ? { quizId: m[1], attemptId: m[2] } : null;
  };

  async function markedNumbers() {
    const all = pills();
    const marked = all.find((p) => p.name === 'marked');
    const previous = all.find((p) => p.input.checked);
    if (!marked || !marked.count) return [];
    try {
      if (!(await selectPill(marked))) toast(`Could not show exactly the ${marked.count} marked questions; the marked list may be incomplete.`);
      const numbers = statusLabels().map((l) => parseInt((paneOf(l).textContent.match(/Question\s*(\d+)/) || [])[1], 10)).filter(Boolean);
      return [...new Set(numbers)].sort((a, b) => a - b);
    } finally {
      if (previous && !previous.input.checked) previous.label.click();
    }
  }

  // The attempt's record in Udemy's API: { startedAt, finishedAt, timeUsedSeconds } as ISO strings / seconds, or null. The field names are
  // not documented, so the record is searched for date-like values by name; what was found is logged to the console.
  const isoOf = (record, names) => {
    for (const n of names) {
      const t = Date.parse(record[n]);
      if (typeof record[n] === 'string' && !Number.isNaN(t)) return new Date(t).toISOString();
    }
    return null;
  };
  async function attemptTimes(ids) {
    const base = `/api-2.0/quizzes/${ids.quizId}/user-attempted-quizzes/`;
    for (const query of ['?version=1&page_size=100&fields[user_attempted_quiz]=id,created,viewed_time,completion_time,version', '?version=1&page_size=100']) {
      try {
        let url = base + query, record = null;
        for (let page = 0; url && !record && page < 10; page++) {
          const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
          if (!r.ok) break;
          const data = await r.json();
          record = (data.results || []).find((x) => String(x.id) === ids.attemptId) || null;
          url = data.next ? data.next.replace(/^https?:\/\/[^/]+/, '') : null;
        }
        if (!record) continue;
        console.log('[Mathesis] attempt record from Udemy', record);
        const startedAt = isoOf(record, ['created', 'started_time', 'created_time', 'start_time']);
        const finishedAt = isoOf(record, ['completion_time', 'completed_time', 'finished_time', 'finish_time', 'submitted_time', 'modified']);
        if (!startedAt || !finishedAt) continue;
        const used = Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000);
        return { startedAt, finishedAt, timeUsedSeconds: used >= 0 ? used : 0 };
      } catch (e) { console.warn('[Mathesis] could not read the attempt from Udemy', e); }
    }
    return null;
  }

  function attemptName() {
    const n = attemptNumber();
    return n ? jsonPathToWrite().replace(/all questions\.json$/, `attempt ${n}.json`) : null;
  }

  // The attempt in the platform's import format. The quiz is named by its title: the server adds the hash from the saved quiz JSON.
  async function getAttemptJson(questions, ids) {
    const answers = {};
    questions.forEach((q) => {
      const chosen = q.answers.map((a, i) => (a.selected ? i : -1)).filter((i) => i >= 0);
      const multi = q.answers.filter((a) => a.correct).length > 1;
      if (q.number && chosen.length) answers[String(q.number)] = multi ? chosen : chosen.slice(0, 1);
    });
    const times = await attemptTimes(ids);
    const now = new Date().toISOString();
    if (!times) toast("Udemy's API did not give this attempt's dates: the file says it was taken now and took 0 seconds. Edit startedAt, finishedAt and timeUsedSeconds if you need them.");
    return JSON.stringify({
      format: 'quickquiz-attempts',
      version: 1,
      exportedAt: now,
      attempts: [{
        id: `udemy-${ids.attemptId}`,
        quiz: { title: lessonFileName().title },
        ...(times || { startedAt: now, finishedAt: now, timeUsedSeconds: 0 }),
        finishReason: 'submitted',
        answers,
        marked: await markedNumbers(),
        comments: {},
      }],
    }, null, 2) + '\n';
  }

  async function saveAttempt() {
    const ids = resultIds();
    const filePath = attemptName();
    if (!ids || !filePath) {
      toast.error('Could not find the attempt ("Attempt N" and the result id in the address) on this page. Try again once the results have loaded.');
      return;
    }
    const questions = await collectAllQuestions();
    if (!questions) return;
    // the server takes the quiz hash from NN-all questions.json: make sure it exists
    if (serverUp && !files.some((f) => f.kind === 'json' && f.state === 'ready')) await saveJson(questions);
    const text = await getAttemptJson(questions, ids);
    const copyAttempt = (why) => {
      const kept = keepOffline('quiz-attempt', filePath, text); // an offline copy in this browser, and the clipboard
      return navigator.clipboard.writeText(text)
        .then(() => toast.ok(why + 'Copied the attempt to the clipboard' + (kept ? ' and kept as an offline copy in this browser (see the panel).' : '.')))
        .catch((e) => toast.error('Could not copy text to clipboard: ' + e));
    };
    if (!serverUp) { copyAttempt(''); return; }
    try {
      const response = await fetch(`${SERVER}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-File-Path': encodeURIComponent(filePath), 'X-Mathesis-Kind': 'quiz-attempt' },
        body: text,
      });
      if (!response.ok) {
        const d = await response.json().catch(() => ({}));
        throw Object.assign(new Error(d.error || response.status + ' ' + response.statusText), { status: response.status });
      }
      const data = await response.json();
      console.log('[Mathesis] saved', data);
      refreshFiles();
      toast.ok('Attempt saved for the quiz platform! (' + data.path + ')' + (data.quiz === 'hash' ? ''
        : '\nNo saved quiz JSON with this title next to it, so the quiz is matched by title: import it first.'));
    } catch (error) {
      console.error('Error:', error);
      if (!error.status) { copyAttempt('Could not reach the Mathesis server. '); return; }
      const id = await reportFailure({ kind: 'quiz-attempt', path: filePath, status: error.status, error: String(error.message || error), body: text });
      toast.error('Could not send: ' + error + (id ? '\n\nError report: ' + id + ' (tell Claude this ID)' : ''));
    }
  }

  // Double Shift shows/hides the button (remembered per site). Any other key between the two presses cancels it.
  const HIDE_KEY = 'mathesis-button-hidden';
  const store = {
    get() { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch (e) { return false; } },
    set(hidden) { try { localStorage.setItem(HIDE_KEY, hidden ? '1' : '0'); } catch (e) { /* storage blocked: not remembered */ } },
  };
  const applyHidden = (hidden) => { panel.style.display = hidden ? 'none' : ''; };
  applyHidden(store.get());
  let lastShift = 0;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Shift') { lastShift = 0; return; }
    if (e.repeat) return;
    const now = Date.now();
    if (lastShift && now - lastShift < 400) {
      const hidden = panel.style.display !== 'none';
      applyHidden(hidden);
      store.set(hidden);
      lastShift = 0;
    } else {
      lastShift = now;
    }
  }, true);

  panel.append(head, saveEl, filesEl, statusEl, noteEl, tipEl);
  document.body.appendChild(panel);
  console.log('[Mathesis] Udemy button added');

  // First use on this site: a toast says the buttons can be toggled with a double Shift (shown once, then remembered).
  (function showFirstUseHint() {
    const HINT_KEY = 'mathesis-hint-shown';
    try { if (localStorage.getItem(HINT_KEY)) return; } catch (e) { return; } // storage blocked: never nag on every page
    if (panel.style.display === 'none') return;
    const toast = document.createElement('div');
    toast.id = 'mathesis-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = 'Mathesis: press Shift twice to hide or show this panel (or fold it with the – button).';
    toast.style.cssText = 'position:fixed;top:16px;right:56px;max-width:300px;z-index:2147483647;padding:12px 16px;' +
      'background:#202124;color:#fff;border-radius:6px;font:14px/1.4 sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.4);' +
      'cursor:pointer;transition:opacity .4s;';
    const close = () => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); };
    toast.addEventListener('click', close);
    (document.body || document.documentElement).appendChild(toast);
    setTimeout(close, 8000);
    try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* not remembered */ }
  })();

  // Udemy is a single-page app: re-check whenever the lesson changes.
  if (pageReady()) refreshFiles();
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      pageStart = Date.now();
      lastChecked = null;
      setLoading();
    }
    // The page type can change without a URL change (Udemy renders the quiz results after the page loads): the file this
    // page maps to changes then, so ask the server again instead of keeping the answer for the old file.
    try { if (lastChecked !== null && computePathToWrite() !== lastChecked) { lastChecked = null; setLoading(); } } catch (e) { /* still loading */ }
    if (lastChecked === null && pageReady()) refreshFiles();
    const root = document.body || document.documentElement; // the site may replace <body>: put the buttons back
    if (!panel.isConnected) root.appendChild(panel);
    renderRows(); // the page type (and so the rows) can change without a new answer from the server
    clampPos(); // the panel grows and shrinks with its state: keep it inside the window
  }, 1000);
})();
