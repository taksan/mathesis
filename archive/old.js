// ==UserScript==
// @name         Copy cloudskillsboost Transcript
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Adds a button to copy YouTube video transcripts to clipboard
// @author       Your Name
// @match        https://partner.cloudskillsboost.google/*
// @grant        GM_download
// @require      https://code.jquery.com/jquery-3.7.1.slim.min.js
// ==/UserScript==

(function() {
    'use strict';
  
  	function computePathToWrite() {
      let outline = document.querySelector("ql-youtube-video").shadowRoot
      let normalizeName = (s) => s.replaceAll(/[:/]/g,'_')
      let course = normalizeName($("#course_name").text())
      let module = normalizeName($("#module_name").text())
      let activity = normalizeName($(outline).find(".activity.active > .activity-title").text().replace("play_circle","").trim())
              
      // find the order of the module to use as a the module name
      let allModules = $(outline).find(".module h2").map((_, e) => normalizeName(e.innerText)).toArray()
      let moduleNumber = allModules.indexOf(module)

      // find the order of the activity within the active module to find the activity number
      let activities = $(outline).find(".module.active .activity  > .activity-title").map((_,e) => normalizeName($(e).text().replace("play_circle","").trim())).toArray()
      let activityNumber = activities.indexOf(activity)

      return `/home/takeuchi/Private/Documents/TakVault/_study_roadmap/Google ML Certification/${course}/${moduleNumber}-${module}/${activityNumber}-${activity}.md`
    }
  
    function getLessonTranscript(videoElement) {
      let transcriptElement = videoElement.shadowRoot.querySelector(".transcript");
      if (!transcriptElement) {
        alert("Video transcript not found")
        return
      }
      return transcriptElement.innerText
    }
  
  	function getTranscript() {
      const videoElement = document.querySelector("ql-youtube-video");
      if (videoElement && videoElement.shadowRoot) {
        return getLessonTranscript(videoElement)
      }
      const labInstructions = document.querySelector(".lab-content-container")
      if (labInstructions) {
        return labInstructions.innerText
      }
      alert("nothing found")
      return null
    }

    // Add custom styles for the 
  
  
    const style = document.createElement('style');
    style.type = 'text/css';
    style.innerHTML = `
        #copy-transcript-btn {
            position: fixed;
            top: 116px;
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
        #copy-transcript-btn:hover {
            background-color: #cc0000;
        }
    `;
    document.head.appendChild(style);

    // Create the button to copy the transcript
    const button = document.createElement('button');
    button.id = 'copy-transcript-btn';
    button.innerText = 'Copy Transcript';

    // Function to copy transcript to clipboard
    button.addEventListener('click', () => {
      	const transcription = getTranscript()
        if (!transcription)
          return
        
        let queryPrompt = ""
              

        navigator.clipboard.writeText(queryPrompt + transcription)
          .then(() => {
          console.log("Text copied");
        })
          .catch(error => {
          alert('Could not copy text to clipboard: ' + error);
        });

      ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


      let filePath=computePathToWrite()


      // Send the request to write the transcript
      fetch('http://127.0.0.1:5000/write', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'X-File-Path': filePath
        },
        body: queryPrompt + transcription
      })
        .then(response => {
        if (!response.ok) {
          throw new Error('Network response was not ok ' + response.statusText);
        }
        return response.json();
      })
        .then(data => {
        console.log('Success:', data);
        alert('Transcript sent successfully!');
      })
        .catch(error => {
        console.error('Error:', error);
        alert('Could not send transcript: ' + error);
      });
      
    });

    // Append the button to the body
    document.body.appendChild(button);
})();

