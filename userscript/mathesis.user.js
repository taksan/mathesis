// ==UserScript==
// @name         Mathesis: save Google Skills transcript
// @namespace    http://tampermonkey.net/
// @version      32.ae6a9ad
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
    return labInstructions ? labInstructions.innerText : RAW;
  }

  const style = document.createElement('style');
  style.textContent = `
    #copy-transcript-btn {
      position: fixed;
      /* header is 64px tall with the profile avatar at its right edge; sit just below it */
      top: 72px;
      right: 10px;
      z-index: 2147483647;
      padding: 10px 15px;
      background-color: #ff0000;
      color: white;
      border: none;
      border-radius: 5px;
      font-size: 14px;
      cursor: pointer;
    }
    #copy-transcript-btn:hover { filter: brightness(0.85); }
    #copy-transcript-btn.saved { background-color: #1e8e3e; }
    #copy-transcript-btn.unknown { background-color: #5f6368; }
    #open-obsidian-btn {
      position: fixed; top: 116px; right: 10px; z-index: 2147483647;
      padding: 10px 15px; background-color: #7c3aed; color: white;
      border: none; border-radius: 5px; font-size: 14px; cursor: pointer;
    }
    #open-obsidian-btn:hover { filter: brightness(0.85); }
  `;
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.id = 'copy-transcript-btn';
  const LABEL = () => (isQuiz() ? 'Copy Quiz' : isBundle() ? 'Copy Lesson' : isLab() ? 'Copy Lab' : 'Copy Transcript');
  button.textContent = LABEL();

  // Show whether this lesson was already saved (green) or not (red); grey = server unreachable.

  // Second button, only while this lesson is saved: opens the summary (or the lesson) in Obsidian.
  // The server builds the obsidian:// link, so no local path lives in this script.
  const openButton = document.createElement('button');
  openButton.id = 'open-obsidian-btn';
  openButton.textContent = 'Open in Obsidian';
  openButton.style.display = 'none';
  let lessonSaved = false;
  const syncOpenButton = () => {
    openButton.style.display = lessonSaved && button.style.display !== 'none' ? '' : 'none';
  };
  openButton.addEventListener('click', () => {
    let filePath;
    try { filePath = computePathToWrite(); } catch (e) { return; }
    fetch('http://127.0.0.1:5000/status', { headers: { 'X-File-Path': encodeURIComponent(filePath) } })
      .then((r) => r.json())
      .then((d) => {
        if (d.obsidian_uri) window.location.href = d.obsidian_uri;
        else alert('This lesson is not saved yet');
      })
      .catch((error) => alert('Could not reach the Mathesis server: ' + error));
  });

  let current = { state: 'new', summaryDone: false };
  function setButtonState(state, summaryDone) {
    current = { state, summaryDone };
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
    try {
      filePath = computePathToWrite();
    } catch (e) {
      return; // page still loading; the interval below will retry
    }
    lastChecked = filePath;
    fetch('http://127.0.0.1:5000/status', { headers: { 'X-File-Path': encodeURIComponent(filePath) } })
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

  (document.body || document.documentElement).appendChild(button);
  (document.body || document.documentElement).appendChild(openButton);
  console.log('[Mathesis] button added');

  // Check now, and again whenever the lesson changes (the site may navigate without a reload).
  refreshStatus();
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastChecked = null;
      setButtonState('new');
    }
    if (lastChecked === null) refreshStatus();
    // The site may replace <body> (the buttons vanish) and the lesson iframe appears after the page loads (the label changes)
    const root = document.body || document.documentElement;
    if (!button.isConnected) root.appendChild(button);
    if (!openButton.isConnected) root.appendChild(openButton);
    const label = LABEL();
    if (current.state === 'new' && button.textContent !== label) setButtonState('new');
  }, 1000);
})();
