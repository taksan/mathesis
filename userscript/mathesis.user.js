// ==UserScript==
// @name         Mathesis: save Google Skills transcript
// @namespace    http://tampermonkey.net/
// @version      150.094181d
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

  // Goes to the server for the frontmatter of the Markdown file (the server adds the file type and the hash itself).
  function metaHeader() {
    const course = [...document.querySelectorAll('.breadcrumbs-container a')].find((a) => /\/course_templates\/\d+$/.test(a.getAttribute('href') || ''));
    const menu = document.querySelector('ql-contents-menu');
    const lastItem = document.querySelector('.breadcrumbs-container li:last-child');
    const meta = {
      course: normalizeName(course && course.textContent),
      lesson: normalizeName((menu && menu.getAttribute('selectedcontenttitle')) || (lastItem && lastItem.textContent)),
      url: location.href,
    };
    return encodeURIComponent(JSON.stringify(meta));
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
    if (e.button !== 0 || e.target.closest('#mathesis-fold, .mx-quick')) return;
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
    if (e.target.closest('#mathesis-fold, .mx-quick')) return;
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
    return [{ chip: kind.toLowerCase(), kinds: ['transcript'], save: saveFromPage,
              tipOn: what[0], tipOff: what[1] + ' The server is offline: an offline copy is kept in this browser, and nothing reaches your notes.' }];
  };
  const pagePath = () => computePathToWrite();
  const pageKey = pagePath;
  const transcriptName = () => (isLab() ? 'full instructions' : 'transcript');

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
  quick.addEventListener('click', () => { if (quickSpec) quickSpec.save(); });
  tipOn(quick, () => (quickSpec ? `${serverUp ? 'Save' : 'Copy'} · ${quickSpec.chip}. ${serverUp ? quickSpec.tipOn : quickSpec.tipOff}` : ''));
  function updateQuick(specs) {
    quickSpec = specs[0] || null;
    quick.style.display = quickSpec ? '' : 'none';
    quick.textContent = '';
    if (!quickSpec) return;
    quick.insertAdjacentHTML('beforeend', serverUp ? ICON_SAVE : ICONS.copy);
    if (serverUp && files.some((f) => f.state === 'pending')) { // a summary / lab guide is being written: a spinner instead of the dot
      const spin = document.createElement('span');
      spin.className = 'mx-spin mx-quick-spin';
      quick.append(spin);
    } else if (serverUp && files.some((f) => quickSpec.kinds.includes(f.kind) && f.state === 'ready')) { // a small green dot: that file exists
      const dot = document.createElement('span');
      dot.className = 'mx-saved';
      quick.append(dot);
    }
    quick.setAttribute('aria-label', `${serverUp ? 'Save' : 'Copy'} ${quickSpec.chip}`);
  }

  const displayName = (f) => ({
    incorrect: `to review · attempt ${f.attempt || 1}`, all: 'all questions', json: 'all questions (json)',
    'lab-guide': 'lab guide', summary: 'summary', transcript: transcriptName(),
  }[f.kind] || f.label.toLowerCase());
  const via = (f) => (f.opener === 'obsidian' ? 'Obsidian' : 'your text editor');

  // ---- offline copies: with the server down, a save also keeps the text in this site's browser storage ----
  // They are copies, not files in your notes: copy their content, download them, or send them
  // to the server once it is back. Stored per site (localStorage), one key per file.
  const OFF = 'mathesis-offline:';
  const offlineKinds = { 'quiz-review': 'incorrect', 'quiz-all': 'all', 'quiz-json': 'json', transcript: 'transcript', bundle: 'transcript', lab: 'transcript', quiz: 'transcript' };
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
        if (confirm('The file in your notes was changed after it was saved (your notes?). Sending this copy will overwrite those changes. Overwrite them?')) return uploadOffline(e, 'yes');
        if (confirm('Keep the text of that file as it is and only update its metadata (frontmatter)?')) return uploadOffline(e, 'metadata');
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
    const key = JSON.stringify([serverUp, files, specs.map((s) => s.chip), offline.map((e) => [e.path, e.savedAt])]);
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

  const scriptInfo = () => { // what this script makes of the page (for the AI): kind, path, chips; nothing is changed
    const o = {};
    try { o.version = GM_info.script.version; } catch (e) { /* not exposed with @grant none */ }
    o.kind = isQuiz() ? 'quiz' : isBundle() ? 'bundle' : isLab() ? 'lab' : document.querySelector('ql-youtube-video') ? 'video' : 'other';
    try { o.path = pagePath(); } catch (e) { o.pathError = String((e && e.message) || e); }
    try { o.chips = rowSpecs().map((s) => s.chip); } catch (e) { o.chipsError = String((e && e.message) || e); }
    return o;
  };
  const scriptParse = (clip) => { // the text the save button would send, or why it fails (reading only: nothing is clicked)
    const out = scriptInfo();
    try {
      const t = getTranscript();
      out.result = t === RAW ? 'RAW: nothing recognisable, so the whole page HTML would be saved' : { chars: String(t).length, text: clip(String(t), 4000) };
    } catch (e) { out.error = String((e && e.stack) || e); }
    return out;
  };

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
        toast.error('Could not compute file path: ' + e.message);
        return;
      }
    }

    const copyOnly = (why) => {
      const kept = keepOffline(kind, filePath, text); // an offline copy in this browser, and the clipboard
      return navigator.clipboard.writeText(text)
        .then(() => toast.ok(why + 'Copied to the clipboard' + (kept ? ' and kept as an offline copy in this browser (see the panel).' : '.')))
        .catch((error) => toast.error('Could not copy text to clipboard: ' + error));
    };
    if (!serverUp) { copyOnly(''); return; } // no server: nothing is sent

    if (files.some((f) => f.state === 'pending')) { toast('Generation in progress… wait for it to finish.'); return; } // a summary / lab guide is still being written: do nothing

    const send = (overwrite) => fetch('http://127.0.0.1:5000/write', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-File-Path': encodeURIComponent(filePath), 'X-Mathesis-Kind': kind, 'X-Mathesis-Meta': metaHeader(),
                 ...(overwrite ? { 'X-Mathesis-Overwrite': overwrite } : {}) },
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
        if (confirm('The file was changed after it was saved (your notes?). Saving will overwrite those changes. Overwrite them?')) return send('yes');
        if (confirm('Keep your text as it is and only update the metadata (frontmatter) of the file?')) return send('metadata');
        throw Object.assign(new Error('cancelled'), { cancelled: true }); // declined: nothing is saved, and it is not an error
      });
    send(false)
      .then((data) => {
        console.log('Success:', data);
        refreshFiles();
        if (data.metadata_only) {
          toast('Only the metadata (frontmatter) was updated. Your text is untouched.');
          return;
        }
        if (data.kept) { // a file with your own text and no metadata: the server only added the metadata
          toast('This file already existed without metadata, so it was not overwritten: only the metadata (frontmatter) was added, and your text is untouched.');
          return;
        }
        toast.ok(kind === 'raw' ? 'No standard transcript found: the page HTML was saved as raw (' + data.path + ')'
          : kind === 'quiz' ? 'Quiz saved!'
          : kind === 'bundle' ? 'Lesson converted and saved!'
          : kind === 'lab' ? 'Lab saved! The summary and the gcloud/terraform guide are being written.'
          : 'Transcript sent successfully!');
      })
      .catch(async (error) => {
        if (error.cancelled) return;
        if (error.code === 'pending') { toast('Generation in progress… wait for it to finish.'); return; } // another tab started it
        console.error('Error:', error);
        if (!error.status) { copyOnly('Could not reach the Mathesis server. '); return; } // it went away since the last check
        const id = await reportFailure({ kind, path: filePath, status: error.status || null, error: String(error.message || error), body: text });
        toast.error('Could not send: ' + error + (id ? '\n\nError report: ' + id + ' (tell Claude this ID)' : ''));
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

  panel.append(head, saveEl, filesEl, statusEl, noteEl, tipEl);
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
