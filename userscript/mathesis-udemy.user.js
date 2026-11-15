// ==UserScript==
// @name         Mathesis: save Udemy transcript
// @namespace    http://tampermonkey.net/
// @version      106.41cc4e3
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

  // Goes to the server for the frontmatter of the Markdown file (the server adds the file type and the hash itself).
  function metaHeader() {
    let meta = { url: location.href };
    try { meta = { course: courseName(), lesson: lessonFileName().title, url: location.href }; } catch (e) { /* page still loading */ }
    return encodeURIComponent(JSON.stringify(meta));
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
    #mathesis-panel.folded { width: auto; padding: 0; }
    #mathesis-panel.folded #mathesis-head { margin: 0; border-bottom: 0; border-radius: 11px; }
    #mathesis-panel.folded > :not(#mathesis-head) { display: none; }
    #mathesis-panel button.mx { width: 100%; padding: 8px 12px; border-radius: 8px; cursor: pointer; text-align: center; }
    #mathesis-panel button.mx:focus-visible, #mathesis-fold:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    #mathesis-panel button.primary { background: #8ab4f8; color: #14202f; border: 1px solid #8ab4f8; font-weight: 600; }
    #mathesis-panel button.primary:hover { filter: brightness(1.08); }
    #mathesis-panel button.ghost { background: transparent; color: #e8eaed; border: 1px solid #46536a; }
    #mathesis-panel button.ghost:hover { background: rgba(255, 255, 255, 0.08); filter: none; }
    #mathesis-panel button.ghost.saved { border-color: #34a853; color: #81c995; }
    #mathesis-rows { display: grid; grid-template-columns: max-content 66px; gap: 6px; }
    #mathesis-rows:empty { display: none; }
    #mathesis-panel.loading #mathesis-rows { display: none; }
    .mx-cell { position: relative; min-width: 0; }
    #mathesis-panel .mx-cell button.mx { width: 100%; height: 36px; padding: 0 16px; white-space: nowrap; }
    #mathesis-panel .mx-cell button.mx.open { padding: 0 6px; background: transparent; color: #8ee0d6; border: 1px solid #5fb7ae; }
    #mathesis-panel .mx-cell button.mx.open:hover { background: rgba(11, 154, 147, 0.15); }
    /* hover: the panel's blue, fading in and out */
    #mathesis-panel .mx-cell button.mx { transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease; }
    #mathesis-panel .mx-cell button.mx:hover, #mathesis-panel .mx-cell button.mx.open:hover { background: #8ab4f8; border-color: #8ab4f8; color: #14202f; filter: none; }
    #mathesis-panel .mx-cell button.mx.primary:hover { background: #a9c8fa; border-color: #a9c8fa; color: #14202f; }
    #mathesis-panel .mx-menu button { transition: background-color 0.25s ease, color 0.25s ease; }
    #mathesis-panel .mx-menu button:not([aria-disabled="true"]):hover, #mathesis-panel .mx-menu button:not([aria-disabled="true"]):focus-visible { background: rgba(138, 180, 248, 0.28); }
    @media (prefers-reduced-motion: reduce) { #mathesis-panel .mx-cell button.mx, #mathesis-panel .mx-menu button { transition: none; } }
    #mathesis-tip { position: absolute; top: 0; width: 230px; max-width: 40vw; padding: 7px 9px; background: #121821; color: #e6ebf2;
      border: 1px solid #46536a; border-radius: 6px; font-size: 12px; line-height: 1.4; pointer-events: none; opacity: 0;
      transition: opacity 0.15s; z-index: 3; text-align: left; white-space: normal; }
    #mathesis-tip.show { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { #mathesis-tip { transition: none; } }
    .mx-badge { position: absolute; top: -5px; right: -5px; width: 15px; height: 15px; border-radius: 50%; background: #252e3b;
      display: flex; align-items: center; justify-content: center; pointer-events: none; }
    .mx-badge.warn { background: #f28b82; color: #202124; font: 700 10px/1 system-ui, sans-serif; }
    .mx-spin { display: inline-block; flex: none; width: 11px; height: 11px; border: 2px solid #46536a; border-top-color: #7fe0d9;
      border-radius: 50%; animation: mathesis-spin 0.8s linear infinite; vertical-align: middle; }
    @media (prefers-reduced-motion: reduce) { .mx-spin { animation: none; } }
    .mx-menu { position: absolute; right: 0; top: 100%; margin-top: 4px; min-width: 200px; padding: 4px; z-index: 4;
      background: #1d2531; border: 1px solid #46536a; border-radius: 8px; }
    .mx-menu[hidden] { display: none !important; }
    #mathesis-panel .mx-menu button { display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%;
      padding: 6px 8px; background: transparent; border: 0; border-radius: 5px; color: #e8eaed; text-align: left; cursor: pointer; }
    #mathesis-panel .mx-menu button:hover, #mathesis-panel .mx-menu button:focus-visible { background: #3c4043; outline: none; }
    #mathesis-panel .mx-menu button[aria-disabled="true"] { color: #8a8f94; cursor: default; }
    #mathesis-panel .mx-menu button[aria-disabled="true"]:hover { background: transparent; }
    .mx-via { color: #9aa0a6; font-size: 11px; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
    .mx-via.fail { color: #f28b82; }
    #mathesis-status:empty, #mathesis-note:empty { display: none; }
    #mathesis-note { color: #bdc1c6; font-size: 12px; max-width: 280px; }
    #mathesis-retry { background: none; border: 0; padding: 0; color: #8ab4f8; text-decoration: underline; cursor: pointer; font-size: 12px; }
    #mathesis-retry[disabled] { color: #9aa0a6; text-decoration: none; cursor: default; }
    #mathesis-dialog { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.5); }
    #mathesis-dialog .box { width: min(400px, 90vw); box-sizing: border-box; padding: 18px; display: flex; flex-direction: column; gap: 10px;
      background: #252e3b; color: #e6ebf2; border: 1px solid #3b4658; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    #mathesis-dialog .box * { box-sizing: border-box; font: inherit; }
    #mathesis-dialog .sub { color: #9aa0a6; font-size: 13px; }
    #mathesis-dialog button { width: 100%; padding: 9px 12px; border-radius: 8px; cursor: pointer; text-align: center; overflow-wrap: anywhere;
      background: transparent; color: #e8eaed; border: 1px solid #46536a; }
    #mathesis-dialog button:hover { background: rgba(255, 255, 255, 0.08); }
    #mathesis-dialog button.primary { background: #8ab4f8; color: #202124; border-color: #8ab4f8; font-weight: 600; }
    #mathesis-dialog button.primary:hover { filter: brightness(1.08); }
    #mathesis-dialog button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
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


  const rowSpecs = () => (isQuizReview() ? [
    { label: 'to Review', primary: true, kinds: ['incorrect'], save: () => copyLesson(false),
      tipOn: 'Saves the questions you got wrong or marked, with explanations, as NN-incorrect.md. Saving again asks whether to overwrite or keep both as another attempt.',
      tipOff: 'Copies the questions you got wrong or marked, with explanations, to the clipboard. The server is offline, so nothing is saved.' },
    { label: 'all as JSON', kinds: ['json'], save: saveJson,
      tipOn: 'Saves every question as a JSON file (options, correct answers, explanations) for other tools. Overwrites the previous file.',
      tipOff: 'Copies every question as JSON to the clipboard. The server is offline, so nothing is saved.' },
    { label: 'all questions', kinds: ['all'], save: () => copyLesson(true),
      tipOn: 'Saves every question with its explanations as NN-all questions.md, a clean copy of the whole test. Overwrites the previous file.',
      tipOff: 'Copies every question with its explanations to the clipboard. The server is offline, so nothing is saved.' },
  ] : [
    { label: 'Transcript', primary: true, kinds: ['summary', 'transcript'], save: () => copyLesson(false),
      tipOn: 'Saves the transcript of this lesson as a Markdown note and writes a summary in the background. Saving again overwrites it.',
      tipOff: 'Copies the transcript to the clipboard. The server is offline, so nothing is saved.' },
  ]);
  const pagePath = () => computePathToWrite(false); // quiz results: the review file; the server finds its siblings and attempts
  const statusOf = (filePath) => fetch(`${SERVER}/status`, { headers: { 'X-File-Path': encodeURIComponent(filePath) } }).then((r) => r.json());

  // ---- rows: one per kind of file, Save on the left, Open on the right (only once that file exists) ----
  // `rowSpecs()` and `pagePath()` come from the page type (below). The server (GET /files) says what exists, what is still
  // being written (summary, lab guide) and which program opens each file, so this script never guesses a file name.
  let serverUp = true;        // false: the buttons say "Copy" and only copy to the clipboard; nothing is sent
  const verb = () => (serverUp ? 'Save' : 'Copy');
  let files = [];             // answer of GET /files for this page
  let lastChecked = null, pollTimer = null, noteTimer = null, renderKey = '';
  const rowsEl = document.createElement('div');
  rowsEl.id = 'mathesis-rows';
  const noteEl = document.createElement('div');
  noteEl.id = 'mathesis-note';
  noteEl.setAttribute('role', 'status');
  const say = (message) => {
    noteEl.textContent = message;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { noteEl.textContent = ''; }, 8000);
  };
  const closeMenus = () => {
    rowsEl.querySelectorAll('.mx-menu').forEach((m) => { m.hidden = true; });
    rowsEl.querySelectorAll('[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  };
  document.addEventListener('click', closeMenus);

  // One tooltip per panel, shown beside it (so it never covers a button): on the left, or on the right when the panel
  // has been dragged to the left half of the window. It follows the hovered or focused button's row.
  const tipEl = document.createElement('div');
  tipEl.id = 'mathesis-tip';
  tipEl.setAttribute('aria-hidden', 'true');
  function withTip(cell, button, text) {
    button.setAttribute('aria-label', button.textContent + '. ' + text);
    cell.dataset.tip = text;
    cell.append(button);
  }
  function showTip(cell) {
    if (!cell || !cell.dataset.tip) return;
    const p = panel.getBoundingClientRect(), c = cell.getBoundingClientRect();
    tipEl.textContent = cell.dataset.tip;
    tipEl.style.top = Math.max(0, c.top - p.top - 1) + 'px';
    const onRight = p.left + p.width / 2 < viewW() / 2;
    tipEl.style.left = onRight ? 'calc(100% + 10px)' : 'auto';
    tipEl.style.right = onRight ? 'auto' : 'calc(100% + 10px)';
    tipEl.classList.add('show');
  }
  const hideTip = () => tipEl.classList.remove('show');
  rowsEl.addEventListener('mouseover', (e) => showTip(e.target.closest('.mx-cell')));
  rowsEl.addEventListener('focusin', (e) => showTip(e.target.closest('.mx-cell')));
  rowsEl.addEventListener('mouseout', hideTip);
  rowsEl.addEventListener('focusout', hideTip);

  const NAMES = { incorrect: 'the review', all: 'all questions', json: 'the JSON file', summary: 'the summary', transcript: 'the transcript', 'lab-guide': 'the lab guide' };
  const nameOf = (f) => NAMES[f.kind] || f.label.toLowerCase();

  async function openFile(f) {
    if (f.state === 'pending') return;
    if (f.state === 'failed') { say(`The ${nameOf(f).replace(/^the /, '')} was not written (${f.error || 'see the server log'}). Save again to retry.`); return; }
    if (f.opener === 'obsidian' && f.obsidian_uri) { window.location.href = f.obsidian_uri; return; }
    try { // a program on the server machine opens it (the text editor)
      const r = await fetch(`${SERVER}/open`, { method: 'POST', headers: { 'X-File-Path': encodeURIComponent(f.path) } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.status + ' ' + r.statusText);
    } catch (e) {
      navigator.clipboard.writeText(f.path).catch(() => {});
      say(`Could not open it: ${e.message}. The path was copied.`);
    }
  }

  function renderRows() {
    const specs = rowSpecs();
    const key = JSON.stringify([serverUp, files, specs.map((s) => s.label)]);
    if (key === renderKey) return;
    renderKey = key;
    hideTip();
    rowsEl.textContent = '';
    for (const spec of specs) {
      const left = document.createElement('div');
      left.className = 'mx-cell l';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'mx ' + (spec.primary ? 'primary' : 'ghost');
      save.textContent = `${verb()} ${spec.label}`;
      save.addEventListener('click', spec.save);
      withTip(left, save, serverUp ? spec.tipOn : spec.tipOff);
      const right = document.createElement('div');
      right.className = 'mx-cell r';
      const items = serverUp ? files.filter((f) => spec.kinds.includes(f.kind)) : [];
      if (items.length) {
        const many = items.length > 1;
        const waiting = items.some((f) => f.state === 'pending');
        const failed = items.filter((f) => f.state === 'failed');
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'mx open';
        open.textContent = many ? 'Open ▾' : 'Open';
        const via = (f) => (f.opener === 'obsidian' ? 'Obsidian' : 'your text editor');
        withTip(right, open, many ? 'Choose what to open.' + (waiting ? ' Greyed-out documents are still being written.' : '')
          + failed.map((f) => ` Warning: the ${nameOf(f).replace(/^the /, '')} was not written (${f.error || 'see the server log'}).`).join('')
          : `Opens ${nameOf(items[0])} in ${via(items[0])}.`);
        if (waiting || failed.length) { // a spinner while something is being written; a red ! when a document could not be written
          const badge = document.createElement('span');
          badge.className = 'mx-badge' + (waiting ? '' : ' warn');
          if (waiting) badge.innerHTML = '<span class="mx-spin"></span>'; else badge.textContent = '!';
          right.append(badge);
        }
        if (!many) {
          open.addEventListener('click', () => openFile(items[0]));
        } else {
          open.setAttribute('aria-haspopup', 'menu');
          open.setAttribute('aria-expanded', 'false');
          const menu = document.createElement('div');
          menu.className = 'mx-menu';
          menu.hidden = true;
          menu.setAttribute('role', 'menu');
          for (const f of items) {
            const item = document.createElement('button');
            item.type = 'button';
            item.setAttribute('role', 'menuitem');
            const name = document.createElement('span');
            name.textContent = f.label + (f.attempt && f === items[0] ? ' (newest)' : '');
            const side = document.createElement('span');
            side.className = 'mx-via';
            if (f.state === 'pending') {
              item.setAttribute('aria-disabled', 'true');
              side.innerHTML = 'writing… <span class="mx-spin"></span>';
            } else if (f.state === 'failed') {
              side.classList.add('fail');
              side.textContent = 'failed';
              item.title = f.error || '';
            } else {
              side.textContent = via(f).replace('your text editor', 'editor');
            }
            item.append(name, side);
            item.addEventListener('click', () => { closeMenus(); openFile(f); });
            menu.append(item);
          }
          open.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasHidden = menu.hidden;
            closeMenus();
            menu.hidden = !wasHidden;
            open.setAttribute('aria-expanded', String(wasHidden));
            if (wasHidden) menu.querySelector('button').focus();
          });
          menu.addEventListener('keydown', (e) => {
            const all = [...menu.querySelectorAll('button')];
            const i = all.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length].focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length].focus(); }
            else if (e.key === 'Escape') { closeMenus(); open.focus(); }
          });
          right.append(menu);
        }
      }
      rowsEl.append(left, right);
    }
  }

  // Server offline: the only status text there is, with a retry link just after it.
  function showStatus(offline, again) {
    statusEl.textContent = '';
    if (!offline) return;
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
      if (Date.now() - pageStart > SETTLE_MS) settle(true, []);
      return;
    }
    lastChecked = filePath;
    return fetch(`${SERVER}/files`, { headers: { 'X-File-Path': encodeURIComponent(filePath) } })
      .then((r) => r.json())
      .then((d) => { if (lastChecked === filePath) { wasOffline = false; settle(true, d.files || []); } })
      .catch(() => {
        // The server may just be busy or restarting (or the request was cut by a navigation): show it, then check again
        if (lastChecked !== filePath) return;
        settle(false, [], retry || wasOffline);
        wasOffline = true;
        setTimeout(() => { if (lastChecked === filePath) lastChecked = null; }, 3000); // the 1 s timer below retries
      });
  }

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

  // Saving the Incorrect + To Review file when it is already saved: ask whether to overwrite it or keep it and save this one
  // as another attempt ("NN-incorrect (attempt 2).md"). Resolves to 'overwrite', 'keep' or 'cancel'.
  function askOverwriteOrKeep(existingName, newName, modified) {
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
      sub.textContent = (modified ? 'You changed it after it was saved (your notes?): overwriting will lose those changes. ' : '')
        + 'Overwrite it, or keep it and save this one as another attempt?';
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

  // "Udemy/Course/02-incorrect.md" -> "Udemy/Course/02-incorrect (attempt 3).md"
  const withAttempt = (path, n) => path.replace(/(\.[a-z]+)$/i, ` (attempt ${n})$1`);

  // The path to save a quiz result to: the given one when it is free, otherwise whatever the person chooses.
  // Returns null when they cancel. The new attempt number is the page's ("Attempt 2"), or the next free one.
  async function chooseTarget(path) {
    let exists, modified = false;
    try { const st = await statusOf(path); exists = st.exists; modified = !!st.modified; } catch (e) { return { path }; } // server unreachable: the save itself reports it
    if (!exists) return { path };
    const shown = parseInt((attemptLabel().match(/\d+/) || [])[0], 10);
    let candidate;
    for (let n = shown >= 2 ? shown : 2; n < 100; n++) {
      candidate = withAttempt(path, n);
      try { if (!(await statusOf(candidate)).exists) break; } catch (e) { break; }
    }
    const choice = await askOverwriteOrKeep(path.split('/').pop(), candidate.split('/').pop(), modified);
    return choice === 'cancel' ? null : choice === 'keep' ? { path: candidate } : { path, overwrite: true }; // asked, so the server need not ask again
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

    const copyOnly = (why) => navigator.clipboard.writeText(text)
      .then(() => alert(why + 'Copied to the clipboard.'))
      .catch((error) => alert('Could not copy text to clipboard: ' + error));
    if (!serverUp) { copyOnly(''); return; } // no server: nothing is sent

    let confirmed = false; // true once the person agreed to overwrite a file they had changed
    // Incorrect + To Review depends on the attempt, so saving it again asks: overwrite, or keep both as another attempt.
    // "All questions" (Markdown and JSON) is the same whatever the attempt, so it is simply overwritten.
    if (kind === 'quiz-review') {
      const target = await chooseTarget(filePath);
      if (!target) return;
      filePath = target.path;
      confirmed = !!target.overwrite;
    }

    const send = (overwrite) => fetch(`${SERVER}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-File-Path': encodeURIComponent(filePath), 'X-Mathesis-Kind': kind, 'X-Mathesis-Meta': metaHeader(),
                 ...(overwrite ? { 'X-Mathesis-Overwrite': 'yes' } : {}) },
      body: text,
    })
      .then((response) => {
        if (!response.ok) { // show the server's reason (it answers {"error": "...", "code": "..."})
          return response.json().catch(() => ({})).then((d) => { throw Object.assign(new Error(d.error || response.status + ' ' + response.statusText), { status: response.status, code: d.code }); });
        }
        return response.json();
      })
      .catch((error) => {
        // the file has notes in it (its body no longer matches the hash in its frontmatter): ask, then save over them
        if (error.code !== 'modified') throw error;
        if (confirm('The file was changed after it was saved (your notes?). Saving will overwrite those changes. Overwrite them?')) return send(true);
        throw Object.assign(new Error('cancelled'), { cancelled: true }); // declined: nothing is saved, and it is not an error
      });
    send(confirmed)
      .then((data) => {
        console.log('[Mathesis] saved', data);
        refreshFiles();
        if (data.kept) { // a file with your own text and no metadata: the server only added the metadata
          alert('This file already existed without metadata, so it was not overwritten: only the metadata (frontmatter) was added, and your text is untouched.');
          return;
        }
        alert(kind === 'raw' ? 'No standard transcript found: the page HTML was saved as raw (' + data.path + ')'
          : kind === 'quiz-review' ? 'Incorrect and to-review questions saved!'
          : kind === 'quiz-all' ? 'All questions saved!' : 'Transcript sent successfully!');
      })
      .catch(async (error) => {
        if (error.cancelled) return;
        console.error('Error:', error);
        if (!error.status) { copyOnly('Could not reach the Mathesis server. '); return; } // it went away since the last check
        const id = await reportFailure({ kind, path: filePath, status: error.status || null, error: String(error.message || error), body: text });
        alert('Could not send: ' + error + (id ? '\n\nError report: ' + id + ' (tell Claude this ID)' : ''));
      });
  }
  async function saveJson() {
    const text = await getQuizJson();
    if (!text) return;
    if (!serverUp) { // no server: the JSON goes to the clipboard
      navigator.clipboard.writeText(text).then(() => alert('Copied the JSON to the clipboard.'))
        .catch((error) => alert('Could not copy text to clipboard: ' + error));
      return;
    }
    let filePath;
    try {
      filePath = jsonPathToWrite();
    } catch (e) {
      console.error(e);
      alert('Could not compute file path: ' + e.message);
      return;
    }
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
      alert('All questions saved as JSON! (' + data.path + ')');
    } catch (error) {
      console.error('Error:', error);
      if (!error.status) { // it went away since the last check: keep the work on the clipboard
        navigator.clipboard.writeText(text).then(() => alert('Could not reach the Mathesis server. Copied the JSON to the clipboard.'))
          .catch((e) => alert('Could not reach the Mathesis server, and could not copy: ' + e));
        return;
      }
      const id = await reportFailure({ kind: 'quiz-json', path: filePath, status: error.status, error: String(error.message || error), body: text });
      alert('Could not send: ' + error + (id ? '\n\nError report: ' + id + ' (tell Claude this ID)' : ''));
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

  panel.append(head, rowsEl, statusEl, noteEl, tipEl);
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
