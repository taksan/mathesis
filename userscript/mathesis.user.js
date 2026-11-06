// ==UserScript==
// @name         Mathesis: save Google Skills transcript
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Adds a button that copies a Google Skills lesson transcript / lab instructions and sends them to the local Mathesis server (mathesis serve)
// @author       Your Name
// @match        https://partner.cloudskillsboost.google/*
// @match        https://www.skills.google/*
// @match        https://partner.skills.google/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

//  const BASE_DIR = '/home/takeuchi/Private/Documents/TakVault/_study_roadmap/Google ML Certification';
  const BASE_DIR = '/home/takeuchi/projects/obsidian-takvault/_study_roadmap/Google Skills';

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

  function getQuiz() {
    const quiz = document.querySelector('ql-quiz');
    const version = readJsonAttr(quiz, 'quizversion');
    if (!version || !(version.quizItems || []).length) {
      alert('Quiz questions not found');
      return null;
    }
    const menu = document.querySelector('ql-contents-menu');
    const title = (menu && menu.getAttribute('selectedcontenttitle')) || 'Quiz';
    return formatQuiz(version, readJsonAttr(quiz, 'quizresponse'), title);
  }

  function getTranscript() {
    if (isQuiz()) return getQuiz();
    const video = document.querySelector('ql-youtube-video');
    if (video) {
      const transcript = readJsonAttr(video, 'transcript');
      if (Array.isArray(transcript) && transcript.length) {
        const menu = document.querySelector('ql-contents-menu');
        const title = menu && menu.getAttribute('selectedcontenttitle');
        const body = formatTranscript(transcript);
        return title ? `# ${title}\n\n${body}\n` : body + '\n';
      }
      alert('Video transcript not found');
      return null;
    }
    const labInstructions = document.querySelector('.lab-content-container');
    if (labInstructions) return labInstructions.innerText;
    alert('Nothing found');
    return null;
  }

  const style = document.createElement('style');
  style.textContent = `
    #copy-transcript-btn {
      position: fixed;
      /* header is 64px tall with the profile avatar at its right edge; sit just below it */
      top: 72px;
      right: 10px;
      z-index: 1000;
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
  `;
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.id = 'copy-transcript-btn';
  const LABEL = () => (isQuiz() ? 'Copy Quiz' : 'Copy Transcript');
  button.textContent = LABEL();

  // Show whether this lesson was already saved (green) or not (red); grey = server unreachable.
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
    try {
      filePath = computePathToWrite();
    } catch (e) {
      return; // page still loading; the interval below will retry
    }
    lastChecked = filePath;
    fetch('http://127.0.0.1:5000/status', { headers: { 'X-File-Path': filePath } })
      .then((r) => r.json())
      .then((d) => { if (lastChecked === filePath) setButtonState(d.exists ? 'saved' : 'new', d.summary_exists); })
      .catch(() => setButtonState('unknown'));
  }

  button.addEventListener('click', () => {
    const transcription = getTranscript();
    if (!transcription) return;

    navigator.clipboard.writeText(transcription)
      .then(() => console.log('Text copied'))
      .catch((error) => alert('Could not copy text to clipboard: ' + error));

    let filePath;
    try {
      filePath = computePathToWrite();
    } catch (e) {
      console.error(e);
      alert('Could not compute file path: ' + e.message);
      return;
    }

    fetch('http://127.0.0.1:5000/write', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-File-Path': filePath,
        'X-Mathesis-Kind': isQuiz() ? 'quiz' : 'transcript',
      },
      body: transcription,
    })
      .then((response) => {
        if (!response.ok) throw new Error('Network response was not ok ' + response.statusText);
        return response.json();
      })
      .then((data) => {
        console.log('Success:', data);
        setButtonState('saved', false);
        alert(isQuiz() ? 'Quiz saved!' : 'Transcript sent successfully!');
      })
      .catch((error) => {
        console.error('Error:', error);
        alert('Could not send transcript: ' + error);
      });
  });

  (document.body || document.documentElement).appendChild(button);
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
  }, 1000);
})();
