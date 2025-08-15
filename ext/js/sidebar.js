// sidebar.js — LeedzEx Sidebar Control Logic (Simplified for Debugging)




// Debug check to confirm script execution
// console.log('sidebar.js executing. Checking environment...');
// console.log('Document body:', document.body ? 'Present' : 'Missing');
// console.log('Chrome API available:', typeof chrome !== 'undefined' ? 'Yes' : 'No');

const STATE = {
  id: null,
  name: null,
  title: null,
  org: null,
  www: null,
  location: null,
  email: null,        // ← Single value instead of array
  phone: null,        // ← Single value instead of array

  linkedin: null,
  on_x: null,
  outreachCount: 0,
  createdAt: null,
  lastContact: null,
  notes: null,
  hasReplied: false,
  activeField: null,
  lastSelection: null,

};




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










/*
// DOM CONTENT LOADED
//
//
*/
document.addEventListener('DOMContentLoaded', () => {
  // log('DOMContentLoaded fired, initializing LeedzEx sidebar...');

  initButtons();

  reloadParsers();

});  // CLOSED the DOMContentLoaded listener




/*
// include ALL of the portal-specific checks
// i.e. LinkedIn, X, etc
*/
async function reloadParsers() {
  try {
    const isLinkedin = await checkForLinkedin();
    if (!isLinkedin) {
      log('No matching parsers found - showing empty form');
    }

  } catch (error) {
    logError('Error in reloadParsers:', error);
  }

  _updateFormFromState(); // show current state (empty form is fine)
}


function clearState() {
  STATE.id = null;
  STATE.name = null;
  STATE.title = null;
  STATE.org = null;
  STATE.www = null;
  STATE.location = null;
  STATE.email = null;        // ← Simple value, not array
  STATE.phone = null;        // ← Simple value, not array
  STATE.linkedin = null;
  STATE.on_x = null;
  STATE.outreachCount = 0;
  STATE.hasReplied = false;
  STATE.createdAt = null;
  STATE.lastContact = null;
  STATE.notes = null;
  STATE.activeField = null;
  STATE.lastSelection = null;
}




/**
 * GRAND UPDATE FUNCTION
 * @param {*} record 
 */
function sidebar_update( record ) {
      _copyFromRecord(record);
      _updateFormFromState();
}


/**
 * Copy data from a record object into the STATE
 * @param {Object} record 
 */
function _copyFromRecord(record) {
  STATE.id = record.id;
  STATE.name = denormalizeName(record.name);
  STATE.org = record.org || null; 
  STATE.location = record.location || null;
  STATE.title = record.title || null;
  STATE.www = record.www || null;
  STATE.email = record.email || null;         // ← Simple assignment
  STATE.phone = record.phone || null;         // ← Simple assignment
  STATE.outreachCount = record.outreachCount || 0;
  STATE.lastContact = record.lastContact || null;
  STATE.notes = record.notes || null;
  STATE.linkedin = record.linkedin || null;
  STATE.on_x = record.on_x || null;
  STATE.hasReplied = record.hasReplied || false;
}


// Populate form fields from a database record  
function _populateFromRecord(record) {
  _copyFromRecord(record);
  _updateOutreachCount();
  _updateFormFromState();
}





// Add function to update outreach count display
function _updateOutreachCount() {
  const outreachBtn = document.getElementById('outreachBtn');
  if (outreachBtn) {
    const countSpan = outreachBtn.querySelector('.outreach-count');
    if (countSpan) {
      countSpan.textContent = STATE.outreachCount || '0';
    }
  }
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
      _populateFromRecord(existingRecord);
    }

    // 3. Send message to content script to parse LinkedIn page
    // log('Requesting LinkedIn page parsing from content script');
    // 
    chrome.tabs.sendMessage(tabId, { type: 'leedz_parse_linkedin' }, (resp) => {
      if (resp?.ok) {
        // log('Received parsed LinkedIn data');
        // Merge data from parser with existing STATE
        _mergePageData( resp.data );
  
      } else {
        logError('Failed to parse LinkedIn page:', resp?.error || 'Unknown error');
      }
    });
}




//
// Merge data: Only update fields that are empty in the current STATE
//
function _mergePageData(parsedData) {
      
if (!STATE.name && parsedData.name) STATE.name = parsedData.name;
  if (!STATE.org && parsedData.org) STATE.org = parsedData.org;
  if (!STATE.title && parsedData.title) STATE.title = parsedData.title;
  if (!STATE.linkedin && parsedData.linkedin) STATE.linkedin = parsedData.linkedin;
  if (!STATE.on_x && parsedData.on_x) STATE.on_x = parsedData.on_x; 
  if (!STATE.www && parsedData.www) STATE.www = parsedData.www;
  if (!STATE.location && parsedData.location) STATE.location = parsedData.location;
  if (!STATE.email && parsedData.email) STATE.email = parsedData.email;     // ← Simplified
  if (!STATE.phone && parsedData.phone) STATE.phone = parsedData.phone;     // ← Simplified

  _updateFormFromState();
}





// Initialize buttons and their event listeners
//
function initButtons() {

  // Setup hasReplied button
  const hasRepliedBtn = document.getElementById('hasRepliedBtn');
  if (hasRepliedBtn) {
    hasRepliedBtn.addEventListener('click', () => {
      //log('Has Replied button clicked');
      hasReplied();
    });
  } else {
    log('Error: Has Replied button not found');
  }


  initOutreachButton();

  // Setup save button
  const saveBtn = document.getElementById('saveBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      // log('Save button clicked');
      saveData();
    });
  } else {
    log('Error: Save button not found');
  }


  



  // Setup clear button
  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      // log('Clear button clicked');
      clearForm();
    });
  } else {
    log('Error: Clear button not found');
  }

  // Setup reload button
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









// Function to update form inputs from STATE
function _updateFormFromState() {
  document.getElementById('name').value = STATE.name || '';
  document.getElementById('email').value = STATE.email || '';  // ← No more [0]
  
  _createNotes();
  
  const hasRepliedBtn = document.getElementById('hasRepliedBtn');
  if (hasRepliedBtn) {
    if (STATE.hasReplied) {
      hasRepliedBtn.classList.add('hasReplied');
    } else {
      hasRepliedBtn.classList.remove('hasReplied');
    }
  }
}


  

//  create the Notes section -- the key to the embedding context
//  excludes name and email while including
//  all the relevant data fields in a clean format.
function _createNotes() {
  const notes = [];
  
  if (STATE.org) notes.push(`org=${STATE.org}`);
  if (STATE.title) notes.push(`title=${STATE.title}`);
  if (STATE.www) notes.push(`www=${STATE.www}`);
  if (STATE.linkedin) notes.push(`linkedin=${STATE.linkedin}`);
  if (STATE.on_x) notes.push(`on_x=${STATE.on_x}`);
  if (STATE.location) notes.push(`location=${STATE.location}`);
  if (STATE.phone) notes.push(`phone=${STATE.phone}`);  // ← Simple value
  
  if (STATE.outreachCount > 0) notes.push(`outreachCount=${STATE.outreachCount}`);
  if (STATE.hasReplied) notes.push(`hasReplied=${STATE.hasReplied}`);


  // Format lastContact to be more readable
  if (STATE.lastContact) {
    const date = new Date(STATE.lastContact);

  // For format like "Aug 15, 2025 4:30 AM"
  const readable = date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric' 
    }) + ' ' + date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
    notes.push(`lastContact=${readable}`);
  }
  
  document.getElementById('notes').value = notes.join('\n');
}








// Function to clear all form fields and reset state
function clearForm() {
  clearState();
  
  // Only clear fields that exist in your simplified UI
  document.getElementById('name').value = '';
  document.getElementById('email').value = '';
  document.getElementById('notes').value = '';

  const hasReplied = document.getElementById('hasRepliedBtn');
  if (hasReplied) hasReplied.classList.remove('hasReplied');

  const outreachBtn = document.getElementById('outreachBtn');
  if (outreachBtn) {
    const countSpan = outreachBtn.querySelector('.outreach-count');
    if (countSpan) countSpan.textContent = '0';
  }
}






function initOutreachButton() {
  const outreachBtn = document.getElementById('outreachBtn');
  if (outreachBtn) {
    outreachBtn.addEventListener('click', () => {
      STATE.outreachCount++;
      STATE.lastContact = new Date().toISOString();
      
      // Find the count span fresh each time (in case DOM changed)
      const countSpan = outreachBtn.querySelector('.outreach-count');
      if (countSpan) {
        countSpan.textContent = STATE.outreachCount;
      } else {
        log('Warning: outreach-count span not found');
      }
      
      saveData();
    });
    
    // Initialize the display
    _updateOutreachCount();
  }
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
  saveData();
}
