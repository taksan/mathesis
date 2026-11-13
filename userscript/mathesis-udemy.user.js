// ==UserScript==
// @name         Mathesis: save Udemy transcript
// @namespace    http://tampermonkey.net/
// @version      38.252f127
// @updateURL    http://127.0.0.1:5000/userscript/mathesis-udemy.user.js
// @downloadURL  http://127.0.0.1:5000/userscript/mathesis-udemy.user.js
// @description  Adds buttons that save a Udemy lesson transcript, or the incorrect and marked-for-review questions (or all questions) of a quiz result, to the local Mathesis server (mathesis serve)
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

  function computePathToWrite(allQuestions = false) {
    const { base } = lessonFileName();
    const suffix = !isQuizReview() ? '' : allQuestions ? ' - all questions' : ' - incorrect';
    return `${BASE_DIR}/${courseName()}/${base}${suffix}.md`;
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
  async function getAllQuestions() {
    const all = pills();
    const everything = all.find((p) => p.name === 'all');
    const previous = all.find((p) => p.input.checked);
    let questions, warning = '';
    try {
      if (everything && !(await selectPill(everything))) warning = `Could not show exactly the ${everything.count} questions; saved what is on the page. `;
      questions = statusLabels().map((l) => formatQuestion(parseQuestion(paneOf(l)), false, true));
    } finally {
      if (previous && !previous.input.checked) previous.label.click();
    }
    if (!questions.length) { alert('No questions found on this page'); return null; }
    if (warning) alert(warning.trim());
    const attempt = attemptLabel();
    return [`# ${lessonFileName().title}`, '', `*${[attempt, `${questions.length} questions`].filter(Boolean).join(' · ')}*`, '',
      questions.join('\n\n')].join('\n') + '\n';
  }

  // ---- button ----

  const style = document.createElement('style');
  style.textContent = `
    #copy-transcript-btn {
      position: fixed; top: 64px; right: 56px; z-index: 2147483647;
      padding: 10px 15px; background-color: #ff0000; color: white;
      border: none; border-radius: 5px; font-size: 14px; cursor: pointer;
    }
    #copy-transcript-btn:hover { filter: brightness(0.85); }
    #copy-transcript-btn.saved { background-color: #1e8e3e; }
    #copy-transcript-btn.unknown { background-color: #5f6368; }
    #open-obsidian-btn {
      position: fixed; top: 108px; right: 56px; z-index: 2147483647;
      padding: 10px 15px; background-color: #7c3aed; color: white;
      border: none; border-radius: 5px; font-size: 14px; cursor: pointer;
    }
    #open-obsidian-btn:hover { filter: brightness(0.85); }
    #copy-all-btn {
      position: fixed; top: 152px; right: 56px; z-index: 2147483647;
      padding: 10px 15px; background-color: #1a73e8; color: white;
      border: none; border-radius: 5px; font-size: 14px; cursor: pointer;
    }
    #copy-all-btn:hover { filter: brightness(0.85); }
    #copy-all-btn.saved { background-color: #1e8e3e; }
  `;
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.id = 'copy-transcript-btn';
  const LABEL = () => (isQuizReview() ? 'Copy Incorrect + To Review' : 'Copy Transcript');
  button.textContent = LABEL();


  // Second button, only while this lesson is saved: opens the summary (or the lesson) in Obsidian.
  // The server builds the obsidian:// link, so no local path lives in this script.
  const openButton = document.createElement('button');
  openButton.id = 'open-obsidian-btn';
  openButton.textContent = 'Open in Obsidian';
  openButton.style.display = 'none';
  let lessonSaved = false;

  // Third button, quiz results only: every question with its explanations, nothing marking the wrong ones.
  const allButton = document.createElement('button');
  allButton.id = 'copy-all-btn';
  const ALL_LABEL = 'Copy All Questions';
  allButton.textContent = ALL_LABEL;
  allButton.style.display = 'none';
  const syncOpenButton = () => {
    openButton.style.display = lessonSaved && button.style.display !== 'none' ? '' : 'none';
    allButton.style.display = isQuizReview() && button.style.display !== 'none' ? '' : 'none';
  };
  openButton.addEventListener('click', () => {
    let filePath;
    try { filePath = computePathToWrite(); } catch (e) { return; }
    fetch(`${SERVER}/status`, { headers: { 'X-File-Path': encodeURIComponent(filePath) } })
      .then((r) => r.json())
      .then((d) => {
        if (d.obsidian_uri) window.location.href = d.obsidian_uri;
        else alert('This lesson is not saved yet');
      })
      .catch((error) => alert('Could not reach the Mathesis server: ' + error));
  });

  function setButtonState(state, summaryDone) {
    lessonSaved = state === 'saved';
    syncOpenButton();
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
    fetch(`${SERVER}/status`, { headers: { 'X-File-Path': encodeURIComponent(filePath) } })
      .then((r) => r.json())
      .then((d) => { if (lastChecked === filePath) setButtonState(d.exists ? 'saved' : 'new', d.summary_exists); })
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
        if (kind === 'quiz-all') { allButton.classList.add('saved'); allButton.textContent = '✓ All questions saved (copy again)'; }
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
  button.addEventListener('click', () => copyLesson(false));
  allButton.addEventListener('click', () => copyLesson(true));

  // Double Shift shows/hides the button (remembered per site). Any other key between the two presses cancels it.
  const HIDE_KEY = 'mathesis-button-hidden';
  const store = {
    get() { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch (e) { return false; } },
    set(hidden) { try { localStorage.setItem(HIDE_KEY, hidden ? '1' : '0'); } catch (e) { /* storage blocked: not remembered */ } },
  };
  const applyHidden = (hidden) => { button.style.display = hidden ? 'none' : ''; syncOpenButton(); };
  applyHidden(store.get());
  let lastShift = 0;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Shift') { lastShift = 0; return; }
    if (e.repeat) return;
    const now = Date.now();
    if (lastShift && now - lastShift < 400) {
      const hidden = button.style.display !== 'none';
      applyHidden(hidden);
      store.set(hidden);
      lastShift = 0;
    } else {
      lastShift = now;
    }
  }, true);

  document.body.appendChild(button);
  document.body.appendChild(openButton);
  document.body.appendChild(allButton);
  console.log('[Mathesis] Udemy button added');

  // Udemy is a single-page app: re-check whenever the lesson changes.
  refreshStatus();
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastChecked = null;
      setButtonState('new');
      allButton.classList.remove('saved');
      allButton.textContent = ALL_LABEL;
    }
    syncOpenButton();
    if (lastChecked === null) refreshStatus();
    const root = document.body || document.documentElement; // the site may replace <body>: put the buttons back
    if (!button.isConnected) root.appendChild(button);
    if (!openButton.isConnected) root.appendChild(openButton);
    if (!allButton.isConnected) root.appendChild(allButton);
  }, 1000);
})();
