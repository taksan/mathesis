// ==UserScript==
// @name         Mathesis: save Google Skills transcript
// @namespace    http://tampermonkey.net/
// @version      68.9e5d98d
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
  `;
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.id = 'copy-transcript-btn';
  button.type = 'button';
  button.className = 'mx primary';
  const LABEL = () => (isQuiz() ? 'Copy Quiz' : isBundle() ? 'Copy Lesson' : isLab() ? 'Copy Lab' : 'Copy Transcript');
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

  // Show whether this lesson was already saved (green) or not (red); grey = server unreachable.

  // Second button, only while this lesson is saved: opens the summary (or the lesson) in Obsidian.
  // The server builds the obsidian:// link, so no local path lives in this script.
  const openButton = document.createElement('button');
  openButton.id = 'open-obsidian-btn';
  openButton.type = 'button';
  openButton.className = 'mx ghost';
  openButton.textContent = 'Open in Obsidian';
  openButton.style.display = 'none';
  let lessonSaved = false;
  const syncOpenButton = () => {
    openButton.style.display = lessonSaved && panel.style.display !== 'none' ? '' : 'none';
  };
  openButton.addEventListener('click', () => {
    let filePath;
    try { filePath = computePathToWrite(); } catch (e) { return; }
    fetch('http://127.0.0.1:5000/status', { headers: { 'X-File-Path': encodeURIComponent(filePath) } })
      .then((r) => r.json())
      .then((d) => {
        if (d.obsidian_uri) window.location.href = d.obsidian_uri;
        else if (d.exists) { // Obsidian is not installed: the server opens the file in a text editor
          return fetch('http://127.0.0.1:5000/open', { method: 'POST', headers: { 'X-File-Path': encodeURIComponent(filePath) } })
            .then((r) => r.json().then((j) => { if (!r.ok) alert(j.error || 'Could not open the file'); }));
        } else alert('This lesson is not saved yet');
      })
      .catch((error) => alert('Could not reach the Mathesis server: ' + error));
  });

  let current = { state: 'new', summaryDone: false };
  function setButtonState(state, summaryDone) {
    panel.classList.remove('loading');
    current = { state, summaryDone };
    lessonSaved = state === 'saved';
    syncOpenButton();
    panel.classList.toggle('saved', state === 'saved');
    panel.classList.toggle('unknown', state === 'unknown');
    button.textContent = state === 'saved' ? 'Copy again' : LABEL();
    statusEl.textContent = state === 'saved' ? `Saved${summaryDone ? ' · summary ready' : ''}` :
      state === 'unknown' ? 'Server offline' : 'Not saved yet';
  }

  const pageReady = () => {
    if (Date.now() - pageStart > SETTLE_MS) return true;
    try { computePathToWrite(); } catch (e) { return false; }
    return !!document.querySelector('ql-quiz, ql-youtube-video, .lab-content-container') || !!bundleSrc(); // page type known
  };

  let lastChecked = null;
  function refreshStatus() {
    let filePath;
    try {
      filePath = computePathToWrite();
    } catch (e) { // page still loading; the interval below will retry
      if (Date.now() - pageStart > SETTLE_MS) setButtonState('new');
      return;
    }
    lastChecked = filePath;
    fetch('http://127.0.0.1:5000/status', { headers: { 'X-File-Path': encodeURIComponent(filePath) } })
      .then((r) => r.json())
      .then((d) => {
        openButton.textContent = d.opener === 'editor' ? 'Open in editor' : 'Open in Obsidian';
        if (lastChecked === filePath) setButtonState(d.exists ? 'saved' : 'new', d.summary_exists);
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

  button.addEventListener('click', () => {
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

    if (kind !== 'bundle') { // for a bundle the body is only the lesson URL; the server writes the Markdown
      navigator.clipboard.writeText(text)
        .then(() => console.log('Text copied'))
        .catch((error) => alert('Could not copy text to clipboard: ' + error));
    }

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
        if (kind !== 'raw') setButtonState('saved', false);
        alert(kind === 'raw' ? 'No standard transcript found: the page HTML was saved as raw (' + data.path + ')'
          : kind === 'quiz' ? 'Quiz saved!'
          : kind === 'bundle' ? 'Lesson converted and saved!'
          : kind === 'lab' ? 'Lab saved! The summary and the gcloud/terraform guide are being written.'
          : 'Transcript sent successfully!');
      })
      .catch(async (error) => {
        console.error('Error:', error);
        const id = await reportFailure({ kind, path: filePath, status: error.status || null, error: String(error.message || error), body: text });
        alert('Could not send: ' + error + (id ? '\n\nError report: ' + id + ' (tell Claude this ID)' : ''));
      });
  });

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

  panel.append(head, button, statusEl, openButton);
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
  if (pageReady()) refreshStatus();
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
    if (lastChecked === null && pageReady()) refreshStatus();
    // The site may replace <body> (the buttons vanish) and the lesson iframe appears after the page loads (the label changes)
    const root = document.body || document.documentElement;
    if (!panel.isConnected) root.appendChild(panel);
    clampPos(); // the panel grows and shrinks with its state: keep it inside the window
    const label = LABEL();
    if (current.state === 'new' && !panel.classList.contains('loading') && button.textContent !== label) setButtonState('new');
  }, 1000);
})();
