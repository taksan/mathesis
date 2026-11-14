// ==UserScript==
// @name         Mathesis: save Udemy transcript
// @namespace    http://tampermonkey.net/
// @version      72.52c99f9
// @updateURL    http://127.0.0.1:5000/userscript/mathesis-udemy.user.js
// @downloadURL  http://127.0.0.1:5000/userscript/mathesis-udemy.user.js
// @description  Adds buttons that save a Udemy lesson transcript, or the incorrect and marked-for-review questions (or all questions, as Markdown or JSON) of a quiz result, to the local Mathesis server (mathesis serve)
// @match        https://www.udemy.com/course/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Files land in <BASE_DIR>/<course>/<NN-lesson>.md under the server's MATHESIS_ROOT (where that is on disk is the server's business).
  const BASE_DIR = 'Udemy';
  const SERVER = 'http://127.0.0.1:5000';

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

  // The JSON copy of a quiz's questions sits next to the Markdown one: "NN-all questions.json".
  const jsonPathToWrite = () => computePathToWrite(true).replace(/\.md$/, '.json');

  function computePathToWrite(allQuestions = false) {
    const { base, prefix } = lessonFileName();
    // Quiz results: the folder already names the course and the tests are numbered, so the file is just "NN-incorrect.md"
    // (or "NN-all questions.md"), not "NN-<verbose quiz title> - incorrect.md".
    if (isQuizReview()) return `${BASE_DIR}/${courseName()}/${prefix}${allQuestions ? 'all questions' : 'incorrect'}.md`;
    return `${BASE_DIR}/${courseName()}/${base}.md`;
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
      case 'pre': return '\n\n```\n' + n.textContent.trim() + '\n```\n\n';
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
    if (!wrong.length && !toReview.length) { alert('No incorrect or marked-and-correct questions in this attempt'); return null; }
    if (warning) alert(warning.trim());
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
    if (!questions.length) { alert('No questions found on this page'); return null; }
    if (warning) alert(warning.trim());
    return questions;
  }

  async function getAllQuestions() {
    const questions = await collectAllQuestions();
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

  async function getQuizJson() {
    const questions = await collectAllQuestions();
    if (!questions) return null;
    const limit = examTimeLimit();
    return JSON.stringify({
      title: lessonFileName().title,
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
      width: 208px; box-sizing: border-box; padding: 10px; display: flex; flex-direction: column; gap: 8px;
      background: #202124; color: #e8eaed; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    #mathesis-panel * { box-sizing: border-box; font: inherit; }
    #mathesis-head { display: flex; align-items: center; gap: 8px; }
    #mathesis-dot { width: 9px; height: 9px; border-radius: 50%; background: #f9ab00; flex: none; }
    #mathesis-panel.saved #mathesis-dot { background: #34a853; }
    #mathesis-panel.unknown #mathesis-dot { background: #9aa0a6; }
    #mathesis-title { flex: 1; font-weight: 600; letter-spacing: 0.02em; }
    #mathesis-fold { background: none; border: none; color: #9aa0a6; cursor: pointer; padding: 0 4px; font-size: 16px; line-height: 1; }
    #mathesis-fold:hover { color: #e8eaed; }
    #mathesis-status { color: #9aa0a6; font-size: 12px; margin-top: -2px; }
    #mathesis-spinner { display: none; width: 12px; height: 12px; flex: none; border: 2px solid #5f6368; border-top-color: #8ab4f8;
      border-radius: 50%; animation: mathesis-spin 0.8s linear infinite; }
    @keyframes mathesis-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { #mathesis-spinner { animation-duration: 2.4s; } }
    /* while the page is still being analysed: spinner and text only, no buttons */
    #mathesis-panel.loading #mathesis-spinner { display: block; }
    #mathesis-panel.loading #mathesis-dot { display: none; }
    #mathesis-panel.loading button.mx { display: none !important; }
    #mathesis-panel.loading #mathesis-status { color: #e8eaed; font-size: 13px; margin-top: 0; }
    #mathesis-panel.folded { width: auto; padding: 8px 10px; }
    #mathesis-panel.folded > :not(#mathesis-head) { display: none; }
    #mathesis-panel button.mx { width: 100%; padding: 8px 12px; border-radius: 8px; cursor: pointer; text-align: center; }
    #mathesis-panel button.mx:focus-visible, #mathesis-fold:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    #mathesis-panel button.primary { background: #8ab4f8; color: #202124; border: 1px solid #8ab4f8; font-weight: 600; }
    #mathesis-panel button.primary:hover { filter: brightness(1.08); }
    #mathesis-panel.saved button.primary { background: transparent; color: #e8eaed; border-color: #5f6368; font-weight: 500; }
    #mathesis-panel button.ghost { background: transparent; color: #e8eaed; border: 1px solid #5f6368; }
    #mathesis-panel button.ghost:hover, #mathesis-panel.saved button.primary:hover { background: rgba(255, 255, 255, 0.08); filter: none; }
    #mathesis-panel button.ghost.saved { border-color: #34a853; color: #81c995; }
    #mathesis-dialog { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.5); }
    #mathesis-dialog .box { width: min(400px, 90vw); box-sizing: border-box; padding: 18px; display: flex; flex-direction: column; gap: 10px;
      background: #202124; color: #e8eaed; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    #mathesis-dialog .box * { box-sizing: border-box; font: inherit; }
    #mathesis-dialog .sub { color: #9aa0a6; font-size: 13px; }
    #mathesis-dialog button { width: 100%; padding: 9px 12px; border-radius: 8px; cursor: pointer; text-align: center; overflow-wrap: anywhere;
      background: transparent; color: #e8eaed; border: 1px solid #5f6368; }
    #mathesis-dialog button:hover { background: rgba(255, 255, 255, 0.08); }
    #mathesis-dialog button.primary { background: #8ab4f8; color: #202124; border-color: #8ab4f8; font-weight: 600; }
    #mathesis-dialog button.primary:hover { filter: brightness(1.08); }
    #mathesis-dialog button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
  `;
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.id = 'copy-transcript-btn';
  button.type = 'button';
  button.className = 'mx primary';
  const LABEL = () => (isQuizReview() ? 'Copy Incorrect + To Review' : 'Copy Transcript');
  button.textContent = LABEL();

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
  const fold = document.createElement('button');
  fold.id = 'mathesis-fold';
  fold.type = 'button';
  const spinner = document.createElement('span');
  spinner.id = 'mathesis-spinner';
  head.append(dot, spinner, title, fold);
  const statusEl = document.createElement('div');
  statusEl.id = 'mathesis-status';
  statusEl.setAttribute('role', 'status');
  const FOLD_KEY = 'mathesis-panel-folded';
  const setFolded = (folded, remember) => {
    panel.classList.toggle('folded', folded);
    fold.textContent = folded ? '+' : '–';
    fold.title = fold.ariaLabel = folded ? 'Expand' : 'Collapse';
    if (remember) { try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0'); } catch (e) { /* not remembered */ } }
  };
  fold.addEventListener('click', () => setFolded(!panel.classList.contains('folded'), true));
  // a click on the folded pill expands it (on the header, which owns the drag: the click is not retargeted to the title)
  head.addEventListener('click', (e) => { if (!moved && e.target !== fold && panel.classList.contains('folded')) setFolded(false, true); });
  let startFolded = false;
  try { startFolded = localStorage.getItem(FOLD_KEY) === '1'; } catch (e) { /* storage blocked */ }
  setFolded(startFolded, false);

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
    try { localStorage.setItem(POS_KEY, JSON.stringify({ top: Math.round(r.top), right: Math.round(viewW() - r.right) })); } catch (e) { /* not remembered */ }
  };
  try {
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (pos && Number.isFinite(pos.top) && Number.isFinite(pos.right)) { panel.style.top = pos.top + 'px'; panel.style.right = pos.right + 'px'; }
  } catch (e) { /* storage blocked or bad value: default position */ }
  let drag = null, moved = false;
  head.title = 'Drag to move · double-click to reset';
  head.style.cssText += 'cursor:grab;user-select:none;touch-action:none;';
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target === fold) return;
    const r = panel.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, top: r.top, right: viewW() - r.right };
    moved = false;
    head.setPointerCapture(e.pointerId);
    head.style.cursor = 'grabbing';
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag
    moved = true;
    panel.style.right = drag.right - dx + 'px';
    panel.style.top = drag.top + dy + 'px';
    clampPos();
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    head.style.cursor = 'grab';
    try { head.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    if (moved) savePos();
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);
  head.addEventListener('dblclick', (e) => {
    if (e.target === fold) return;
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


  // Second button, only while this lesson is saved: opens the summary (or the lesson) in Obsidian.
  // The server builds the obsidian:// link, so no local path lives in this script.
  const openButton = document.createElement('button');
  openButton.id = 'open-obsidian-btn';
  openButton.type = 'button';
  openButton.className = 'mx ghost';
  openButton.textContent = 'Open in Obsidian';
  openButton.style.display = 'none';
  let lessonSaved = false;

  // Third button, quiz results only: every question with its explanations, nothing marking the wrong ones.
  const allButton = document.createElement('button');
  allButton.id = 'copy-all-btn';
  allButton.type = 'button';
  allButton.className = 'mx ghost';
  const ALL_LABEL = 'Copy all questions';
  allButton.textContent = ALL_LABEL;
  allButton.style.display = 'none';
  // Fourth button, quiz results only: the same questions as a JSON file (see schema/quiz-questions.schema.json).
  const jsonButton = document.createElement('button');
  jsonButton.id = 'save-json-btn';
  jsonButton.type = 'button';
  jsonButton.className = 'mx ghost';
  const JSON_LABEL = 'Save all as JSON';
  jsonButton.textContent = JSON_LABEL;
  jsonButton.style.display = 'none';
  let jsonSaved = false;
  const syncOpenButton = () => {
    openButton.style.display = lessonSaved && panel.style.display !== 'none' ? '' : 'none';
    const review = isQuizReview() && panel.style.display !== 'none';
    allButton.style.display = review ? '' : 'none';
    jsonButton.style.display = review ? '' : 'none';
  };
  const statusOf = (filePath) => fetch(`${SERVER}/status`, { headers: { 'X-File-Path': encodeURIComponent(filePath) } }).then((r) => r.json());
  openButton.addEventListener('click', () => {
    let filePath, paths;
    try { paths = isQuizReview() ? [computePathToWrite(false), computePathToWrite(true)] : [computePathToWrite()]; } catch (e) { return; }
    // the first of this page's files that is saved (quiz results: incorrect first, then all questions)
    Promise.all(paths.map((p) => statusOf(p))).then((all) => {
      const i = all.findIndex((d) => d.exists);
      filePath = paths[i < 0 ? 0 : i];
      return all[i < 0 ? 0 : i];
    })
      .then((d) => {
        if (d.obsidian_uri) window.location.href = d.obsidian_uri;
        else if (d.exists) { // Obsidian is not installed: the server opens the file in a text editor
          return fetch(`${SERVER}/open`, { method: 'POST', headers: { 'X-File-Path': encodeURIComponent(filePath) } })
            .then((r) => r.json().then((j) => { if (!r.ok) alert(j.error || 'Could not open the file'); }));
        } else alert('This lesson is not saved yet');
      })
      .catch((error) => alert('Could not reach the Mathesis server: ' + error));
  });

  // Quiz results have two files (incorrect + to review, all questions): each button knows its own, and the panel
  // is "saved" when either exists.
  let allSaved = false, lastState = 'new', lastSummary = false;
  function setButtonState(state, summaryDone) {
    panel.classList.remove('loading');
    lastState = state; lastSummary = summaryDone;
    const review = isQuizReview();
    const anySaved = state === 'saved' || (review && allSaved);
    lessonSaved = anySaved;
    syncOpenButton();
    panel.classList.toggle('saved', anySaved);
    panel.classList.toggle('unknown', state === 'unknown');
    button.textContent = state === 'saved' ? 'Copy again' : LABEL();
    allButton.classList.toggle('saved', review && allSaved);
    allButton.textContent = review && allSaved ? '✓ All questions saved' : ALL_LABEL;
    jsonButton.classList.toggle('saved', review && jsonSaved);
    jsonButton.textContent = review && jsonSaved ? '✓ JSON saved' : JSON_LABEL;
    statusEl.textContent = state === 'unknown' ? 'Server offline' :
      review ? `Incorrect: ${state === 'saved' ? 'saved' : 'not saved'} · All: ${allSaved ? 'saved' : 'not saved'}` :
      state === 'saved' ? `Saved${summaryDone ? ' · summary ready' : ''}` : 'Not saved yet';
  }

  const pageReady = () => {
    if (Date.now() - pageStart > SETTLE_MS) return true;
    try { computePathToWrite(); } catch (e) { return false; } // the sidebar has not rendered the current item yet
    return !/\/result\//.test(location.pathname) || isQuizReview(); // a results URL waits for its questions
  };

  let lastChecked = null;
  function refreshStatus() {
    let filePath;
    try { filePath = computePathToWrite(); } catch (e) { // page still loading; retried below
      if (Date.now() - pageStart > SETTLE_MS) setButtonState('new');
      return;
    }
    lastChecked = filePath;
    const review = isQuizReview();
    Promise.all([statusOf(filePath), review ? statusOf(computePathToWrite(true)) : null, review ? statusOf(jsonPathToWrite()) : null])
      .then(([d, all, json]) => {
        if (lastChecked !== filePath) return;
        openButton.textContent = d.opener === 'editor' ? 'Open in editor' : 'Open in Obsidian';
        allSaved = !!(all && all.exists);
        jsonSaved = !!(json && json.exists);
        setButtonState(d.exists ? 'saved' : 'new', d.summary_exists);
      })
      .catch(() => {
        // The server may just be busy or restarting (or the request was cut by a navigation): show it, then check again
        if (lastChecked !== filePath) return;
        setButtonState('unknown');
        setTimeout(() => { if (lastChecked === filePath) lastChecked = null; }, 3000); // the 1 s timer below retries
      });
  }

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

  // Saving a quiz result that is already saved: ask whether to overwrite it or keep it and save this one as another
  // attempt ("NN-all questions (attempt 2).md"). Resolves to 'overwrite', 'keep' or 'cancel'.
  function askOverwriteOrKeep(existingName, newName) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'mathesis-dialog';
      const box = document.createElement('div');
      box.className = 'box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const heading = document.createElement('div');
      heading.textContent = `“${existingName}” is already saved.`;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = 'Overwrite it, or keep it and save this one as another attempt?';
      const choose = (value) => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(value); };
      const make = (label, value, cls) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls || '';
        b.textContent = label;
        b.addEventListener('click', () => choose(value));
        return b;
      };
      const keep = make(`Keep both: save as “${newName}”`, 'keep', 'primary');
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); choose('cancel'); } };
      document.addEventListener('keydown', onKey, true);
      box.append(heading, sub, keep, make('Overwrite', 'overwrite'), make('Cancel', 'cancel'));
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      keep.focus();
    });
  }

  // "Udemy/Course/02-all questions.md" -> "Udemy/Course/02-all questions (attempt 3).md"
  const withAttempt = (path, n) => path.replace(/(\.[a-z]+)$/i, ` (attempt ${n})$1`);

  // The path to save a quiz result to: the given one when it is free, otherwise whatever the person chooses.
  // Returns null when they cancel. The new attempt number is the page's ("Attempt 2"), or the next free one.
  async function chooseTarget(path) {
    let exists;
    try { exists = (await statusOf(path)).exists; } catch (e) { return path; } // server unreachable: the save itself reports it
    if (!exists) return path;
    const shown = parseInt((attemptLabel().match(/\d+/) || [])[0], 10);
    let candidate;
    for (let n = shown >= 2 ? shown : 2; n < 100; n++) {
      candidate = withAttempt(path, n);
      try { if (!(await statusOf(candidate)).exists) break; } catch (e) { break; }
    }
    const choice = await askOverwriteOrKeep(path.split('/').pop(), candidate.split('/').pop());
    return choice === 'cancel' ? null : choice === 'keep' ? candidate : path;
  }

  async function copyLesson(allQuestions = false) {
    let kind = isQuizReview() ? (allQuestions ? 'quiz-all' : 'quiz-review') : 'transcript';
    let text = allQuestions ? await getAllQuestions() : await getTranscript();
    let filePath;
    if (text === RAW) {
      kind = 'raw';
      text = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      filePath = rawPathToWrite();
    } else if (!text) {
      return;
    } else {
      try {
        filePath = computePathToWrite(allQuestions);
      } catch (e) {
        console.error(e);
        alert('Could not compute file path: ' + e.message);
        return;
      }
    }

    if (isQuizReview() && kind !== 'raw') { // a quiz saved a second time: overwrite, or keep both as another attempt
      filePath = await chooseTarget(filePath);
      if (!filePath) return;
    }

    navigator.clipboard.writeText(text).catch((error) => alert('Could not copy text to clipboard: ' + error));

    fetch(`${SERVER}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-File-Path': encodeURIComponent(filePath), 'X-Mathesis-Kind': kind },
      body: text,
    })
      .then((response) => {
        if (!response.ok) { // show the server's reason (it answers {"error": "..."})
          return response.json().catch(() => ({})).then((d) => { throw Object.assign(new Error(d.error || response.status + ' ' + response.statusText), { status: response.status }); });
        }
        return response.json();
      })
      .then((data) => {
        console.log('[Mathesis] saved', data);
        if (kind === 'quiz-all') { allSaved = true; setButtonState(lastState, lastSummary); }
        else if (kind !== 'raw') setButtonState('saved', false);
        alert(kind === 'raw' ? 'No standard transcript found: the page HTML was saved as raw (' + data.path + ')'
          : kind === 'quiz-review' ? 'Incorrect and to-review questions saved!'
          : kind === 'quiz-all' ? 'All questions saved!' : 'Transcript sent successfully!');
      })
      .catch(async (error) => {
        console.error('Error:', error);
        const id = await reportFailure({ kind, path: filePath, status: error.status || null, error: String(error.message || error), body: text });
        alert('Could not send: ' + error + (id ? '\n\nError report: ' + id + ' (tell Claude this ID)' : ''));
      });
  }
  // Offline fallback: the browser saves the file instead.
  function downloadFile(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function saveJson() {
    const text = await getQuizJson();
    if (!text) return;
    let filePath;
    try {
      filePath = jsonPathToWrite();
    } catch (e) {
      console.error(e);
      alert('Could not compute file path: ' + e.message);
      return;
    }
    filePath = await chooseTarget(filePath);
    if (!filePath) return;
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
      jsonSaved = true;
      setButtonState(lastState, lastSummary);
      alert('All questions saved as JSON! (' + data.path + ')');
    } catch (error) {
      console.error('Error:', error);
      if (!error.status) { // the server could not be reached: keep the work, let the browser save the file
        downloadFile(filePath.split('/').pop(), text);
        alert('Could not reach the Mathesis server (' + error + '): the JSON file was downloaded instead.');
        return;
      }
      const id = await reportFailure({ kind: 'quiz-json', path: filePath, status: error.status, error: String(error.message || error), body: text });
      alert('Could not send: ' + error + (id ? '\n\nError report: ' + id + ' (tell Claude this ID)' : ''));
    }
  }
  button.addEventListener('click', () => copyLesson(false));
  allButton.addEventListener('click', () => copyLesson(true));
  jsonButton.addEventListener('click', saveJson);

  // Double Shift shows/hides the button (remembered per site). Any other key between the two presses cancels it.
  const HIDE_KEY = 'mathesis-button-hidden';
  const store = {
    get() { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch (e) { return false; } },
    set(hidden) { try { localStorage.setItem(HIDE_KEY, hidden ? '1' : '0'); } catch (e) { /* storage blocked: not remembered */ } },
  };
  const applyHidden = (hidden) => { panel.style.display = hidden ? 'none' : ''; syncOpenButton(); };
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

  panel.append(head, button, statusEl, allButton, jsonButton, openButton);
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
  if (pageReady()) refreshStatus();
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      pageStart = Date.now();
      lastChecked = null;
      allSaved = false;
      setLoading();
    }
    syncOpenButton();
    // The page type can change without a URL change (Udemy renders the quiz results after the page loads): the file this
    // page maps to changes then, so ask the server again instead of keeping the answer for the old file.
    try { if (lastChecked !== null && computePathToWrite() !== lastChecked) { lastChecked = null; setLoading(); } } catch (e) { /* still loading */ }
    if (lastChecked === null && pageReady()) refreshStatus();
    const root = document.body || document.documentElement; // the site may replace <body>: put the buttons back
    if (!panel.isConnected) root.appendChild(panel);
    clampPos(); // the panel grows and shrinks with its state: keep it inside the window
  }, 1000);
})();
