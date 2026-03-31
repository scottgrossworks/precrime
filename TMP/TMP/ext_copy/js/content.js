// content.js
//
// Receives request → finds iframe → sends DOM back into iframe
// makes sure the response goes directly into the iframe running sidebar.js.
const MAX_CHARS = 3000;

let ACTIVE = false;




chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "leedz_open_sidebar") {
    ACTIVE = true;
    console.log("[LeedzEx] Extension activated.");
    return true;
  }

  if (message.type === "leedz_close_sidebar") {
    ACTIVE = false;
    console.log("[LeedzEx] Extension closed.");
    return true;
  }


  if (message.type === "leedz_request_dom") {
    const bodyText = document.body.innerText || "";
    const title = document.title || "";

    const responseData = {
      type: "leedz_dom_data",
      title,
      bodyText: bodyText.slice(0, MAX_CHARS)
    };

    sendResponse(responseData); // end back directly
    return true; 

  } else {
    console.error("[LeedzEx] content.js > Message received unknown type: ", message.type);
    return true;
  }
  // should never reach here
  return false;
});



//This code will:
//
// Listen for text selections on the page (but only when your extension is active)
// Send selected text to your sidebar via the messaging system
// Apply visual highlighting to the selected text
// Add the necessary CSS for highlighting directly to the page
// This approach integrates with your existing code that sets ACTIVE when the sidebar is opened/closed, ensuring selections are only processed when your extension is active.

document.addEventListener('mouseup', () => {
  console.log("content.js mouse-up handler ACTIVE=" + ACTIVE);
  if (!ACTIVE) return;

  const selection = window.getSelection().toString().trim();
  if (!selection || selection.length < 4) return;

  // Ask sidebar if a field is active before sending highlight
  chrome.runtime.sendMessage({ type: "leedz_check_active_field" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (!response?.activeField) {
      console.log("[LeedzEx] No active field in sidebar; ignoring highlight.");
      return;
    }

    // Now it's safe to send highlight
    chrome.runtime.sendMessage({
      type: "leedz_update_selection",
      selection: selection
    });

    // Apply visual highlight in page DOM
    try {
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const span = document.createElement("span");
        span.className = "leedz-highlighted";
        range.surroundContents(span);
      }
    } catch (e) {
      console.warn("[LeedzEx] Could not apply highlight:", e);
    }
  });
});