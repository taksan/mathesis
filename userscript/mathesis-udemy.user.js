// ==UserScript==
// @name         Mathesis: save Udemy transcript
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Adds a button that saves the transcript of a Udemy lesson to the local Mathesis server (mathesis serve)
// @match        https://www.udemy.com/course/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Files land in <BASE_DIR>/<course>/<NN-lesson>.md (the server only accepts paths under MATHESIS_ROOT).
  const BASE_DIR = '/home/takeuchi/projects/obsidian-takvault/_study_roadmap/Udemy';
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

  // Udemy titles the lessons "12. Title" in the curriculum; keep that number, zero-padded to the course size.
  function lessonFileName() {
    const item = currentItem();
    if (!item) throw new Error('Current lesson not found in the curriculum sidebar');
    const title = item.innerText.trim();
    const m = title.match(/^(\d+)\.\s*(.*)$/s);
    const total = document.querySelectorAll("[data-purpose='item-title']").length;
    const width = Math.max(String(total).length, m ? m[1].length : 0, 2);
    const prefix = m ? m[1].padStart(width, '0') + '-' : '';
    return { title: m ? m[2].trim() : title, file: `${prefix}${normalizeName(m ? m[2] : title)}.md` };
  }

  function computePathToWrite() {
    return `${BASE_DIR}/${courseName()}/${lessonFileName().file}`;
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
    const lines = await readTranscriptLines();
    const body = formatTranscript(lines);
    if (!body) {
      alert('Transcript not found (is this a video lesson with a transcript?)');
      return null;
    }
    return `# ${lessonFileName().title}\n\n${body}\n`;
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
  button.textContent = 'Copy Transcript';

  function setButtonState(state, summaryDone) {
    button.classList.toggle('saved', state === 'saved');
    button.classList.toggle('unknown', state === 'unknown');
    button.textContent =
      state === 'saved' ? `✓ Saved${summaryDone ? ' + summary' : ''} (copy again)` :
      state === 'unknown' ? 'Copy Transcript (server offline)' :
      'Copy Transcript';
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
    const transcription = await getTranscript();
    if (!transcription) return;

    navigator.clipboard.writeText(transcription).catch((error) => alert('Could not copy text to clipboard: ' + error));

    fetch(`${SERVER}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-File-Path': filePath, 'X-Mathesis-Kind': 'transcript' },
      body: transcription,
    })
      .then((response) => {
        if (!response.ok) throw new Error('Network response was not ok ' + response.statusText);
        return response.json();
      })
      .then((data) => {
        console.log('[Mathesis] saved', data);
        setButtonState('saved', false);
        alert('Transcript sent successfully!');
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
