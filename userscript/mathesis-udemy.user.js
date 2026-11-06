// ==UserScript==
// @name         Mathesis: save Udemy transcript
// @namespace    http://tampermonkey.net/
// @version      7.25bdd9b
// @updateURL    http://127.0.0.1:5000/userscript/mathesis-udemy.user.js
// @downloadURL  http://127.0.0.1:5000/userscript/mathesis-udemy.user.js
// @description  Adds a button that saves a Udemy lesson transcript, or the incorrect questions of a quiz result, to the local Mathesis server (mathesis serve)
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
    return { title: name, base: `${prefix}${normalizeName(name)}` };
  }

  function computePathToWrite() {
    const { base } = lessonFileName();
    return `${BASE_DIR}/${courseName()}/${base}${isQuizReview() ? ' - incorrect' : ''}.md`;
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
    if (!body) {
      alert('Transcript not found (is this a video lesson with a transcript?)');
      return null;
    }
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

  // The page only renders the questions of the selected pill, so select "incorrect", wait, and restore it afterwards.
  async function withIncorrectPill(fn) {
    const all = pills();
    const incorrect = all.find((p) => p.name === 'incorrect');
    if (!incorrect) return fn(null);
    if (!incorrect.count) { alert('No incorrect questions in this attempt'); return null; }
    const previous = all.find((p) => p.input.checked);
    const switching = previous !== incorrect;
    if (switching) incorrect.label.click();
    for (let i = 0; i < 30; i++) { // up to ~4.5s for React to re-render
      const labels = statusLabels();
      if (labels.length === incorrect.count && labels.every((l) => /incorrect/i.test(l.textContent))) break;
      await sleep(150);
    }
    try {
      return fn(incorrect.count);
    } finally {
      if (switching && previous) previous.label.click();
    }
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
      answers,
    };
  }

  function formatQuestion(q) {
    const lines = [`## Question ${q.number}`, ''];
    if (q.domain) lines.push(`*Domain: ${q.domain}*`, '');
    lines.push(q.stem, '');
    for (const a of q.answers) {
      const note = a.selected && a.correct ? ' *(your answer, correct)*' : a.selected ? ' *(your answer)*' : a.correct ? ' *(correct answer)*' : '';
      lines.push(`- [${a.selected ? 'x' : ' '}] ${a.correct ? '✅' : a.selected ? '❌' : ''} ${a.text}${note}`.replace(/\] {2}/, '] '));
    }
    lines.push('');
    const shown = q.answers.filter((a) => (a.correct || a.selected) && a.explanation);
    const others = q.answers.filter((a) => !(a.correct || a.selected) && a.explanation);
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

  async function getReview() {
    return withIncorrectPill((expected) => {
      const wrong = statusLabels().filter((l) => /^incorrect$/i.test(l.textContent.trim()));
      if (!wrong.length) { alert('No incorrect questions found'); return null; }
      if (expected != null && wrong.length !== expected) {
        alert(`Expected ${expected} incorrect questions but found ${wrong.length}; saving what is on the page.`);
      }
      const total = (pills().find((p) => p.name === 'all') || {}).count;
      const facts = [attemptLabel(), `${wrong.length} incorrect${total ? ` of ${total}` : ''} questions`].filter(Boolean);
      const questions = wrong.map((l) => formatQuestion(parseQuestion(paneOf(l))));
      return [`# ${lessonFileName().title} - incorrect questions`, '', `*${facts.join(' · ')}*`, '', questions.join('\n\n')].join('\n') + '\n';
    });
  }

  // ---- button ----

  const style = document.createElement('style');
  style.textContent = `
    #copy-transcript-btn {
      position: fixed; top: 64px; right: 56px; z-index: 1000;
      padding: 10px 15px; background-color: #ff0000; color: white;
      border: none; border-radius: 5px; font-size: 14px; cursor: pointer;
    }
    #copy-transcript-btn:hover { filter: brightness(0.85); }
    #copy-transcript-btn.saved { background-color: #1e8e3e; }
    #copy-transcript-btn.unknown { background-color: #5f6368; }
  `;
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.id = 'copy-transcript-btn';
  const LABEL = () => (isQuizReview() ? 'Copy Incorrect Questions' : 'Copy Transcript');
  button.textContent = LABEL();

  function setButtonState(state, summaryDone) {
    button.classList.toggle('saved', state === 'saved');
    button.classList.toggle('unknown', state === 'unknown');
    button.textContent =
      state === 'saved' ? `✓ Saved${summaryDone ? ' + summary' : ''} (copy again)` :
      state === 'unknown' ? `${LABEL()} (server offline)` :
      LABEL();
  }

  let lastChecked = null;
  function refreshStatus() {
    let filePath;
    try { filePath = computePathToWrite(); } catch (e) { return; } // page still loading; retried below
    lastChecked = filePath;
    fetch(`${SERVER}/status`, { headers: { 'X-File-Path': filePath } })
      .then((r) => r.json())
      .then((d) => { if (lastChecked === filePath) setButtonState(d.exists ? 'saved' : 'new', d.summary_exists); })
      .catch(() => setButtonState('unknown'));
  }

  button.addEventListener('click', async () => {
    let filePath;
    try {
      filePath = computePathToWrite();
    } catch (e) {
      console.error(e);
      alert('Could not compute file path: ' + e.message);
      return;
    }
    const kind = isQuizReview() ? 'quiz-review' : 'transcript';
    const transcription = await getTranscript();
    if (!transcription) return;

    navigator.clipboard.writeText(transcription).catch((error) => alert('Could not copy text to clipboard: ' + error));

    fetch(`${SERVER}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-File-Path': filePath, 'X-Mathesis-Kind': kind },
      body: transcription,
    })
      .then((response) => {
        if (!response.ok) throw new Error('Network response was not ok ' + response.statusText);
        return response.json();
      })
      .then((data) => {
        console.log('[Mathesis] saved', data);
        setButtonState('saved', false);
        alert(kind === 'quiz-review' ? 'Incorrect questions saved!' : 'Transcript sent successfully!');
      })
      .catch((error) => {
        console.error('Error:', error);
        alert('Could not send transcript: ' + error);
      });
  });

  document.body.appendChild(button);
  console.log('[Mathesis] Udemy button added');

  // Udemy is a single-page app: re-check whenever the lesson changes.
  refreshStatus();
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastChecked = null;
      setButtonState('new');
    }
    if (lastChecked === null) refreshStatus();
  }, 1000);
})();
