// ==UserScript==
// @name         Mathesis: save Google Skills transcript
// @namespace    http://tampermonkey.net/
// @version      96.8d51e8c
// @updateURL    http://127.0.0.1:5000/userscript/mathesis.user.js
// @downloadURL  http://127.0.0.1:5000/userscript/mathesis.user.js
// @description  Adds a button that copies a Google Skills lesson transcript / lab instructions and sends them to the local Mathesis server (mathesis serve)
// @author       Your Name
// @match        https://partner.cloudskillsboost.google/*
// @match        https://www.skills.google/*
// @match        https://partner.skills.google/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Folder under the server's MATHESIS_ROOT (the server decides where that is on disk).
  const BASE_DIR = 'Google Skills';

  const normalizeName = (s) => (s || '').replace(/[:/]/g, '_').replace(/\s+/g, ' ').trim();

  // The page no longer uses shadow DOM for this data: everything is exposed as
  // JSON in attributes of <ql-contents-menu> (outline) and <ql-youtube-video> (transcript).
  function readJsonAttr(el, name) {
    const raw = el.getAttribute(name);
    if (raw) {
      try { return JSON.parse(raw); } catch (e) { console.warn(`Invalid JSON in ${name}`, e); }
    }
    return el[name] || null; // fallback to the property if set programmatically
  }

  // Breadcrumb: Home > Learning path > Course > Current activity
  function computePathToWrite() {
    const links = [...document.querySelectorAll('.breadcrumbs-container a')];
    const pathLink = links.find((a) => /\/paths\/\d+$/.test(a.getAttribute('href') || ''));
    const courseLink = links.find((a) => /\/course_templates\/\d+$/.test(a.getAttribute('href') || ''));
    const lastItem = document.querySelector('.breadcrumbs-container li:last-child');
    const menu = document.querySelector('ql-contents-menu');

    const learningPath = normalizeName(pathLink && pathLink.textContent);
    const course = normalizeName(courseLink && courseLink.textContent);
    const activity = normalizeName(
      (menu && menu.getAttribute('selectedcontenttitle')) || (lastItem && lastItem.textContent)
    );
    if (!learningPath || !course || !activity) {
      throw new Error(`Breadcrumb incomplete: [${learningPath}] [${course}] [${activity}]`);
    }

    return `${BASE_DIR}/${learningPath}/${course}/${lessonPrefix(menu)}${activity}.md`;
  }

  // Position of the current lesson in the course dropdown (all modules' activities in order),
  // 1-based and zero-padded so files sort correctly, e.g. "07-".
  function lessonPrefix(menu) {
    const modules = (menu && readJsonAttr(menu, 'modules')) || [];
    const lessons = modules.flatMap((m) => (m.steps || []).flatMap((st) => st.activities || []));
    const index = lessons.findIndex((a) => String(a.id) === String(menu && menu.getAttribute('selectedactivityid')));
    if (index === -1) throw new Error('Current lesson not found in the course dropdown');
    return String(index + 1).padStart(String(lessons.length).length, '0') + '-';
  }

  // Caption segments break mid-sentence, so join them into running text, split it
  // into sentences, and group sentences into readable paragraphs (~MAX_PARAGRAPH chars).
  const MAX_PARAGRAPH = 450;
  function formatTranscript(segments) {
    const text = segments
      .map((l) => l.text.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
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

  // A quiz page keeps its data in JSON attributes of <ql-quiz>: quizversion (questions and options, no answers)
  // and quizresponse (the learner's selections, choiceId per question once answered).
  const isQuiz = () => !!document.querySelector('ql-quiz');
  // A lab page (no video, lab instructions in the page): saved like a transcript, plus a gcloud/terraform guide made by the server
  const isLab = () => !isQuiz() && !isBundle() && !document.querySelector('ql-youtube-video') && !!document.querySelector('.lab-content-container');

  // "HTML bundle" lessons (documents) live in an iframe on another origin, so the page itself holds no text:
  // the server reads the lesson from the bundle URL, converts it to Markdown and summarizes it.
  const bundleSrc = () => {
    const frame = document.querySelector('ql-iframe[src*="storage.googleapis.com/cloud-training/"]');
    return frame ? frame.getAttribute('src') : null;
  };
  const isBundle = () => !isQuiz() && !!bundleSrc();

  function formatQuiz(version, response, title) {
    const items = (version && version.quizItems) || [];
    const answers = new Map(((response && response.itemResponses) || []).map((r) => [String(r.quizItemId), r]));
    const letter = (i) => String.fromCharCode(65 + i);
    const lines = [title ? `# ${title}` : '# Quiz', ''];
    const facts = [`${items.length} questions`, 'multiple choice'];
    if (version && version.passingPercentage) facts.push(`passing score ${parseFloat(version.passingPercentage)}%`);
    lines.push(`*${facts.join(' · ')}*`, '');
    items.forEach((item, n) => {
      const chosen = answers.get(String(item.id));
      lines.push(`## ${n + 1}. ${item.stem.trim()}`, '');
      (item.options || []).forEach((o, i) => {
        const picked = chosen && chosen.choiceId && String(chosen.choiceId) === String(o.id);
        lines.push(`- [${picked ? 'x' : ' '}] **${letter(i)}.** ${o.title.trim()}`);
      });
      lines.push('');
    });
    return lines.join('\n');
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

  function getQuiz() {
    const quiz = document.querySelector('ql-quiz');
    const version = readJsonAttr(quiz, 'quizversion');
    if (!version || !(version.quizItems || []).length) return RAW;
    const menu = document.querySelector('ql-contents-menu');
    const title = (menu && menu.getAttribute('selectedcontenttitle')) || 'Quiz';
    return formatQuiz(version, readJsonAttr(quiz, 'quizresponse'), title);
  }

  function getTranscript() {
    if (isQuiz()) return getQuiz();
    if (isBundle()) return bundleSrc();
    const video = document.querySelector('ql-youtube-video');
    if (video) {
      const transcript = readJsonAttr(video, 'transcript');
      if (Array.isArray(transcript) && transcript.length) {
        const menu = document.querySelector('ql-contents-menu');
        const title = menu && menu.getAttribute('selectedcontenttitle');
        const body = formatTranscript(transcript);
        return title ? `# ${title}\n\n${body}\n` : body + '\n';
      }
      return RAW;
    }
    const labInstructions = document.querySelector('.lab-content-container');
    return labInstructions ? labText(labInstructions) : RAW;
  }

  // innerText skips <ql-code-block> (commands, scripts, sample output) and <ql-variable> (Region, Zone ...): their text sits
  // where the page renders it from. So the text is read from a copy in which each is replaced by plain text.
  function labText(root) {
    const dedent = (code) => {
      const lines = code.replace(/\t/g, '  ').split('\n');
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length), Infinity);
      return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0).replace(/\s+$/, '')).join('\n');
    };
    const copy = root.cloneNode(true);
    copy.querySelectorAll('ql-code-block').forEach((block) => {
      let code = dedent(block.textContent || '');
      // {{{key | "Label"}}} is a lab value filled in by the page; the lab account's credentials are never copied
      // sample output ("Example output") only carries per-lab account/project ids: left out
      if (block.hasAttribute('output') || /\{\{\{\s*user_\d+\./.test(code) || !code) { block.remove(); return; }
      code = code.replace(/\{\{\{[^}|]*\|\s*"([^"]+)"\s*\}\}\}/g, '<$1>');
      const language = (block.getAttribute('language') || '').toLowerCase();
      const fence = '```' + (language && language !== 'cpp' && language !== 'plaintext' ? language : '') + '\n';
      const pre = document.createElement('pre');
      pre.textContent = fence + code + '\n```';
      block.replaceWith(pre);
    });
    copy.querySelectorAll('ql-variable').forEach((v) => {
      v.replaceWith(document.createTextNode(v.getAttribute('placeholder') || '<' + (v.getAttribute('key') || 'value') + '>'));
    });
    // innerText needs a rendered element; keep the copy off-screen and short-lived
    copy.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px;pointer-events:none;';
    document.body.appendChild(copy);
    try {
      return copy.innerText.replace(/\n{3,}/g, '\n\n').trim() + '\n';
    } finally {
      copy.remove();
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    #mathesis-panel {
      position: fixed; top: 72px; right: 10px; z-index: 2147483647;
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
    /* hover: light orange that fades in and out */
    #mathesis-panel .mx-cell button.mx { transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease; }
    #mathesis-panel .mx-cell button.mx:hover, #mathesis-panel .mx-cell button.mx.open:hover { background: #ffcc80; border-color: #ffcc80; color: #202124; filter: none; }
    #mathesis-panel .mx-cell button.mx.primary:hover { background: #a9c8fa; border-color: #a9c8fa; color: #14202f; }
    #mathesis-panel .mx-menu button { transition: background-color 0.25s ease, color 0.25s ease; }
    #mathesis-panel .mx-menu button:not([aria-disabled="true"]):hover, #mathesis-panel .mx-menu button:not([aria-disabled="true"]):focus-visible { background: rgba(255, 204, 128, 0.28); }
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

  const pageKind = () => (isQuiz() ? 'Quiz' : isBundle() ? 'Lesson' : isLab() ? 'Lab' : 'Transcript');
  const rowSpecs = () => {
    const kind = pageKind();
    const what = kind === 'Lab' ? ['Saves the lab instructions as a note, then writes a summary and a gcloud/Terraform lab guide in the background. Saving again overwrites them.',
                                   'Copies the lab instructions to the clipboard.']
      : kind === 'Quiz' ? ['Saves this quiz as a Markdown note. Saving again overwrites it.', 'Copies this quiz to the clipboard.']
      : kind === 'Lesson' ? ['Saves this lesson as a Markdown note and writes a summary in the background. Saving again overwrites it.', 'Copies the lesson link to the clipboard.']
      : ['Saves the transcript of this lesson as a Markdown note and writes a summary in the background. Saving again overwrites it.', 'Copies the transcript to the clipboard.'];
    return [{ label: kind, primary: true, kinds: ['lab-guide', 'summary', 'transcript'], save: saveFromPage,
              tipOn: what[0], tipOff: what[1] + ' The server is offline, so nothing is saved.' }];
  };
  const pagePath = () => computePathToWrite();

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
    try { computePathToWrite(); } catch (e) { return false; }
    return !!document.querySelector('ql-quiz, ql-youtube-video, .lab-content-container') || !!bundleSrc(); // page type known
  };

  // A failed save uploads the page and the failure to the server (POST /reports) and returns the report ID, or null
  // when even that is not possible (server unreachable). The ID lets the problem be inspected later with GET /reports/<id>.
  function reportFailure(info) {
    let version = null;
    try { version = GM_info.script.version; } catch (e) { /* not exposed with @grant none */ }
    return fetch('http://127.0.0.1:5000' + '/reports', {
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

  function saveFromPage() {
    let kind = isQuiz() ? 'quiz' : isBundle() ? 'bundle' : isLab() ? 'lab' : 'transcript';
    let text = getTranscript();
    let filePath;
    if (text === RAW) {
      kind = 'raw';
      text = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      filePath = rawPathToWrite();
    } else if (!text) {
      return;
    } else {
      try {
        filePath = computePathToWrite();
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

    fetch('http://127.0.0.1:5000/write', {
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
        console.log('Success:', data);
        refreshFiles();
        alert(kind === 'raw' ? 'No standard transcript found: the page HTML was saved as raw (' + data.path + ')'
          : kind === 'quiz' ? 'Quiz saved!'
          : kind === 'bundle' ? 'Lesson converted and saved!'
          : kind === 'lab' ? 'Lab saved! The summary and the gcloud/terraform guide are being written.'
          : 'Transcript sent successfully!');
      })
      .catch(async (error) => {
        console.error('Error:', error);
        if (!error.status) { copyOnly('Could not reach the Mathesis server. '); return; } // it went away since the last check
        const id = await reportFailure({ kind, path: filePath, status: error.status || null, error: String(error.message || error), body: text });
        alert('Could not send: ' + error + (id ? '\n\nError report: ' + id + ' (tell Claude this ID)' : ''));
      });
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
  (document.body || document.documentElement).appendChild(panel);
  console.log('[Mathesis] button added');

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

  // Check now, and again whenever the lesson changes (the site may navigate without a reload).
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
    // The site may replace <body> (the buttons vanish) and the lesson iframe appears after the page loads (the label changes)
    const root = document.body || document.documentElement;
    if (!panel.isConnected) root.appendChild(panel);
    clampPos(); // the panel grows and shrinks with its state: keep it inside the window
    renderRows(); // the page type (and so the label) can change without a new answer from the server
  }, 1000);
})();
