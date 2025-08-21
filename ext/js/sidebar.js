// sidebar.js — LeedzEx Sidebar Control Logic (Simplified for Debugging)


// Enhanced logging function to output to both console and UI
function log(...args) {
  console.log(...args); // This will call the overridden version which already calls updateDebugOutput
}

// Separate function for error logging with different styling
function logError(...args) {
  console.error(...args); // This will call the overridden version which already calls updateDebugOutput
}



// Helper function to update the debug output element
function updateDebugOutput(...args) {
  const isError = args.length > 0 && args[args.length - 1] === true;
  if (isError) {
    args.pop(); // Remove the error flag
  }
  
  try {
    const debugOutput = document.getElementById('debug-output');
    if (debugOutput) {
      const now = new Date().toLocaleTimeString();
      const message = args.map(a => {
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a);
          } catch (e) {
            return String(a);
          }
        }
        return String(a);
      }).join(' ');
      
      const style = isError ? 'color: #ff5555;' : '';
      debugOutput.innerHTML += `<div style="${style}">[${now}] ${message}</div>`;
      debugOutput.scrollTop = debugOutput.scrollHeight;
    }
  } catch (e) {
    console.error('UI log failed', e);
  }
}






// Override console methods to display logs in the footer
const originalConsoleLog = console.log;
console.log = function(...args) {
  originalConsoleLog.apply(console, args);
  updateDebugOutput(...args);
};

const originalConsoleError = console.error;
console.error = function(...args) {
  originalConsoleError.apply(console, args);
  updateDebugOutput(...args, true);
};




// Listen for log messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "leedz_log") {
    console.log("Received log from background:", message.args);
    updateDebugOutput(...(message.args || ["No message"]));
    sendResponse({received: true});
    return true;
  }
  if (message.type === "leedz_error") {
    console.error("Received error from background:", message.args);
    updateDebugOutput(...(message.args || ["No error message"]), true);
    sendResponse({received: true});
    return true;
  }
  return false;
});







/**
 * 
 * @param {*} record 
 */
function refresh(record) {
  copyFromRecord(record);
  updateOutreachCount();
  updateFormFromState();
}






/*
// DOM CONTENT LOADED
//
//
*/
document.addEventListener('DOMContentLoaded', () => {

  initButtons();  
  reloadParsers();

});  // CLOSED the DOMContentLoaded listener




/*
// include ALL of the portal-specific checks
// i.e. LinkedIn, X, etc
*/
async function reloadParsers() {
  
  try {
    await checkForLinkedin();
  } catch (error) {
    logError('Error in reloadParsers:', error);
  }

  updateFormFromState();
}






/*
// is this a linkedin page?
// query the url to find out
*/
function checkForLinkedin() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'leedz_get_tab_url' }, async ({ url, tabId }) => {
      if (!url || !tabId) {
        log('Cannot auto-detect page data');
        resolve(false);
        return;
      }
      
      try {
        // Check if LinkedInParser exists
        if (! window.LinkedInParser) {
          log('LinkedInParser not available');
          resolve(false);
          return;
        }
        
        const isLinkedin = window.LinkedInParser.isLinkedinProfileUrl(url);
        if (!isLinkedin) {
          log('Not a LinkedIn profile page');
          resolve(false);
        } else {
          log('LinkedIn profile page detected');
          await parseLinkedin(url, tabId);
          resolve(true);
        }
      } catch (error) {
        logError('Error checking LinkedIn:', error);
        resolve(false);
      }
    });
  });
}


/*
It queries the database for an existing record matching the LinkedIn URL
It populates the form with any existing data
It requests the content script to parse the LinkedIn page for additional data
*/
async function parseLinkedin( url, tabId ) {

    // 1. Query DB by LinkedIn URL  
    const linkedinProfile = url.replace(/^https?:\/\/(www\.)?/, '');
    const existingRecord = await findData({ linkedin: linkedinProfile });

    // 2. If found, use it to populate the form
    if (existingRecord) {
      log('Found existing record for: ' + linkedinProfile);
      refresh(existingRecord);
    }


    // 3. Send message to content script to parse LinkedIn page
    // log('Requesting LinkedIn page parsing from content script');
    // 
    chrome.tabs.sendMessage(tabId, { type: 'leedz_parse_linkedin' }, (resp) => {
      if (resp?.ok) {
        // log('Received parsed LinkedIn data');
        // Merge data from parser with existing STATE
        mergePageData( resp.data );
  
      } else {
        logError('Failed to parse LinkedIn page:', resp?.error || 'Unknown error');
      }
    });
}







// Add function to update outreach count display
function updateOutreachCount() {
  const outreachBtn = document.getElementById('outreachBtn');
  if (outreachBtn) {
    const countSpan = outreachBtn.querySelector('.outreach-count');
    if (countSpan) {
      countSpan.textContent = STATE.outreachCount || '0';
    }
  }
}






// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOMContentLoaded fired, initializing sidebar...');
  
  // Initialize tabs first
  initTabs();
  
  initButtons();
  
  log('Sidebar initialized');
});




// Function to read form values into STATE before saving
function readFormIntoState() {
  // Read the basic fields
  STATE.name = document.getElementById('name').value || null;
  STATE.email = document.getElementById('email').value || null;
  
  // Read notes field and parse key=value pairs
  const notesValue = document.getElementById('notes').value || '';
  
  // Clear existing parsed fields first
  STATE.title = null;
  STATE.org = null;
  STATE.www = null;
  STATE.location = null;
  STATE.phone = null;
  STATE.linkedin = null;
  STATE.on_x = null;
  
  // Parse key=value pairs from notes to populate other STATE fields
  if (notesValue) {
    // Split by spaces, but be more careful about parsing
    const parts = notesValue.split(/\s+/);
    let cleanNotes = '';
    
    parts.forEach(part => {
      if (part.includes('=')) {
        const equalIndex = part.indexOf('=');
        const key = part.substring(0, equalIndex);
        const value = part.substring(equalIndex + 1);
        
        if (key && value && STATE.hasOwnProperty(key)) {
          // Clean the value - remove newlines and extra whitespace
          const cleanValue = value.replace(/\n/g, ' ').replace(/\r/g, '').trim();
          
          // Convert string values to appropriate types
          if (key === 'outreachCount') {
            STATE[key] = parseInt(cleanValue) || 0;
          } else if (key === 'hasReplied') {
            STATE[key] = cleanValue === 'true';
          } else if (key === 'notes') {
            // Handle notes specially - don't overwrite, append
            cleanNotes += (cleanNotes ? ' ' : '') + cleanValue;
          } else {
            STATE[key] = cleanValue;
          }
        }
      } else if (part && !part.includes('=')) {
        // This is loose text that should go in notes
        cleanNotes += (cleanNotes ? ' ' : '') + part;
      }
    });
    
    // Set the clean notes
    STATE.notes = cleanNotes || null;
  } else {
    STATE.notes = null;
  }
  
  // Additional cleanup for specific fields
  if (STATE.linkedin) {
    // Clean up linkedin URLs - remove protocol, www, and any trailing junk
    STATE.linkedin = STATE.linkedin
      .replace(/^https?:\/\/(www\.)?/, '')
      .replace(/\/$/, '') // Remove trailing slash
      .split(/[\s\n\r]/)[0] //
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\s/g, '#');
  }
}



// Function to format STATE data as key=value pairs for notes field
function formatStateAsKeyValuePairs() {
  const pairs = [];
  
  // Add all non-null/non-empty values as key=value pairs
  if (STATE.title) pairs.push(`title=${STATE.title}`);
  if (STATE.org) pairs.push(`org=${STATE.org}`);
  if (STATE.www) pairs.push(`www=${STATE.www}`);
  if (STATE.location) pairs.push(`location=${STATE.location}`);
  if (STATE.phone) pairs.push(`phone=${STATE.phone}`);
  if (STATE.linkedin) pairs.push(`linkedin=${STATE.linkedin}`);
  if (STATE.on_x) pairs.push(`on_x=${STATE.on_x}`);
  if (STATE.outreachCount > 0) pairs.push(`outreachCount=${STATE.outreachCount}`);
  if (STATE.lastContact) pairs.push(`lastContact=${STATE.lastContact}`);
  if (STATE.hasReplied) pairs.push(`hasReplied=${STATE.hasReplied}`);
  
  // Add existing notes if any
  if (STATE.notes && !STATE.notes.includes('=')) {
    pairs.push(`notes=${STATE.notes}`);
  }
  
  return pairs.join(' ');
}


//
// convert 'scott#gross' into 'Scott Gross'
function deNormalizeName(rawName) {
  if (!rawName) return '';
  return rawName.replace(/#/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}



// Function to update form inputs from STATE
function updateFormFromState() {
  // Fill name and email in their labeled form boxes

  const displayName = deNormalizeName(STATE.name);

  document.getElementById('name').value = displayName;
  document.getElementById('email').value = STATE.email || '';
  
  // Format everything else as key=value pairs in notes
  document.getElementById('notes').value = formatStateAsKeyValuePairs();
  
  // Update hasReplied button if it exists
  const hasRepliedBtn = document.getElementById('hasRepliedBtn');
  if (hasRepliedBtn) {
    if (STATE.hasReplied) {
      hasRepliedBtn.classList.add('hasReplied');
    } else {
      hasRepliedBtn.classList.remove('hasReplied');
    }
  }
}









// Function to clear all form fields and reset state
function clearForm() {
  // log('Clearing all form fields');
  
  clearState();
  // Clear all input fields
  document.getElementById('name').value = '';

  document.getElementById('notes').value = '';

  document.getElementById('email').value = '';

  // Clear the hasReplied button
  const hasReplied = document.getElementById('hasRepliedBtn');
  if (hasReplied) hasReplied.classList.remove('hasReplied');

  // Clear the outreach count
  const outreachBtn = document.getElementById('outreachBtn');
  const countSpan = outreachBtn.querySelector('.outreach-count');
  countSpan.textContent = '0';
  // log('Form cleared successfully');
}







// indicate that the user being viewed has replied to outreach
//
function hasReplied() {
  STATE.hasReplied = true;

  const hasRepliedBtn = document.getElementById('hasRepliedBtn');

  if (hasRepliedBtn) {
      if (STATE.hasReplied) {
          hasRepliedBtn.classList.add('hasReplied');
      } else {
          hasRepliedBtn.classList.remove('hasReplied');
      }
  }
  readFormIntoState();
  saveData();
}

// Tab system functionality
function initTabs() {
  const meTab = document.getElementById('me_tab');
  const themTab = document.getElementById('them_tab'); 
  const whyTab = document.getElementById('why_tab');

  if (meTab) {
    meTab.addEventListener('click', (event) => {
      event.preventDefault();
      switchToTab('me_tab');
    });
  }

  if (themTab) {
    themTab.addEventListener('click', (event) => {
      event.preventDefault();
      switchToTab('them_tab');
    });
  }

  if (whyTab) {
    whyTab.addEventListener('click', (event) => {
      event.preventDefault();
      switchToTab('why_tab');
    });
  }

  // Set default active tab
  switchToTab('them_tab');
}

function switchToTab(activeTabId) {
  // Remove active class from all tabs and add 'behind'
  const allTabs = document.querySelectorAll('.tab');
  const allContent = document.querySelectorAll('.tab-content');
  const formSection = document.querySelector('.leedz-form-section');
  
  allTabs.forEach(tab => {
    tab.classList.remove('active');
    tab.classList.add('behind');
  });
  
  allContent.forEach(content => {
    content.classList.remove('active');
  });

  // Add active class to selected tab and content
  const activeTab = document.getElementById(activeTabId);
  const activeContent = document.getElementById(activeTabId + '_content');
  
  if (activeTab) {
    activeTab.classList.add('active');
    activeTab.classList.remove('behind');
  }
  
  if (activeContent) {
    activeContent.classList.add('active');
  }


  // Change form background based on active tab - pastel versions with 0.25 opacity
  if (formSection) {
    switch(activeTabId) {
      case 'me_tab':
        formSection.style.backgroundColor = 'rgba(120,120,120, 0.3)'; // 
        break;
      case 'them_tab':
        formSection.style.backgroundColor = 'rgba(100, 149, 237, 0.3)'; // 
        break;
      case 'why_tab':
        formSection.style.backgroundColor = 'rgba(34, 139, 34, 0.3)'; // 
        break;
    }
  }
}




// Initialize buttons and their event listeners
//
function initButtons() {
  initHasRepliedButton();
  initOutreachButton();
  initSaveButton();
  initClearButton();
  initReloadButton();
  initFileUpload();
  initAdditionalButtons();
}





// Initialize button functions
function initSaveButton() {
  const saveBtn = document.getElementById('saveBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      // log('Save button clicked');
      readFormIntoState();
      saveData();
    });
  } else {
    log('Error: Save button not found');
  }
}

function initClearButton() {
  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      // log('Clear button clicked');
      clearForm();
    });
  } else {
    log('Error: Clear button not found');
  }
}

function initReloadButton() {
  const reloadBtn = document.getElementById('reloadBtn');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      // log('Reload button clicked');
      clearForm();
      reloadParsers();
    });
  } else {
    log('Error: Reload button not found');
  }
}

function initHasRepliedButton() {
  const hasRepliedBtn = document.getElementById('hasRepliedBtn');
  if (hasRepliedBtn) {
    hasRepliedBtn.addEventListener('click', () => {
      //log('Has Replied button clicked');
      hasReplied();
    });
  } else {
    log('Error: Has Replied button not found');
  }
}

function initOutreachButton() {
  const outreachBtn = document.getElementById('outreachBtn');
  if (outreachBtn) {
    const countSpan = outreachBtn.querySelector('.outreach-count');
    if (countSpan) countSpan.textContent = '0';
    
    outreachBtn.addEventListener('click', () => {
      STATE.outreachCount++;
      STATE.lastContact = new Date().toISOString();
      
      // Find the count span fresh each time
      const countSpan = outreachBtn.querySelector('.outreach-count');
      if (countSpan) {
        countSpan.textContent = STATE.outreachCount;
      }
      
      readFormIntoState();
      saveData();
    });
  }
}

// Initialize file upload functionality
function initFileUpload() {
  const fileInput = document.getElementById('resume_upload');
  const fileButton = document.querySelector('.file-upload-button');
  const fileStatus = document.getElementById('file-status');

  if (fileInput && fileButton) {
    fileInput.addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (file) {
        fileStatus.textContent = `Selected: ${file.name}`;
        fileStatus.style.color = 'green';
        log('File selected:', file.name);
      } else {
        fileStatus.textContent = '';
      }
    });

    fileButton.addEventListener('click', () => {
      fileInput.click();
    });
  }
}

// Initialize additional save buttons
function initAdditionalButtons() {
  // Me tab save button
  const saveMeBtn = document.getElementById('saveMeBtn');
  if (saveMeBtn) {
    saveMeBtn.addEventListener('click', () => {
      const meNotes = document.getElementById('me_notes').value;
      const fileInput = document.getElementById('resume_upload');
      const file = fileInput.files[0];
      
      log('Saving Me tab data:', { notes: meNotes, file: file ? file.name : 'none' });
      // TODO: Implement actual save functionality for Me tab
    });
  }

  // Why tab save button
  const saveWhyBtn = document.getElementById('saveWhyBtn');
  if (saveWhyBtn) {
    saveWhyBtn.addEventListener('click', () => {
      const triggerNotes = document.getElementById('trigger_notes').value;
      
      log('Saving Why tab data:', { trigger: triggerNotes });
      // TODO: Implement actual save functionality for Why tab
    });
  }
}
