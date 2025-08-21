// content.js
//
// toggle the sidebar panel

// content.js — toggle the sidebar panel and handle parser requests

console.log("[LeedzEx] Content script loaded at:", new Date().toISOString());

// Single message listener for all actions, with robust error handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[LeedzEx] content.js received message:", message);
  try {
    if (message.action === "toggleSidebar") {

      toggleSidebar();
      sendResponse({ ok: true });
      return true; // keep channel (harmless even if sync)
    }

    if (message.type === "leedz_parse_linkedin") {
      (async () => {
        try {
          if (!window.LinkedInParser) {
            throw new Error("LinkedInParser not loaded");
          }
          const p = new window.LinkedInParser();
          await p.waitUntilReady(); // wait until DOM ready in the page

          sendResponse({
            ok: true,
            data: {
              id:            null,
              name:          p.getValue("name"),
              org:           p.getValue("org"),
              title:         p.getValue("title"),
              location:      p.getValue("location"),
              phone:         null,
              www:           null,
              outreachCount: p.getValue("outreachCount"),
              lastContact:   null,
              notes:         null,
              linkedin:      p.getValue("profile"),
              on_x:          null
            }
          });
        } catch (e) {
          console.error("[LeedzEx] parse_linkedin error:", e);
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async response
    }

    // Unknown message
    console.log("[LeedzEx] content.js got message:", message);
    sendResponse({ ok: false, error: "Unknown message" });
    return true;
  } catch (e) {
    console.error("[LeedzEx] content.js listener error:", e);
    try { sendResponse({ ok: false, error: e.message }); } catch {}
    return true;
  }
});



function toggleSidebar () {
  const pane = document.getElementById('leedz-sidebar-container');

  if (pane) {
    // If sidebar exists, close it
    requestAnimationFrame(() => {
      pane.style.transform = 'translateX(100%)';
    });
    pane.addEventListener('transitionend', () => pane.remove(), { once: true });
  } else {
    // Create a completely isolated iframe
    const iframe = document.createElement('iframe');
    iframe.id = "leedz-sidebar-container";
    iframe.src = chrome.runtime.getURL("sidebar_new.html");
    
    // Style the iframe to be positioned as a sidebar
    Object.assign(iframe.style, {
      position: "fixed",
      top: "0",
      right: "0",
      width: "400px",
      height: "100vh",
      zIndex: "2147483647",
      border: "none",
      transform: "translateX(100%)",
      transition: "transform 0.4s ease",
      boxShadow: "-6px 0 18px rgba(0,0,0,0.2)"
    });
    
    // Append directly to body
    document.body.appendChild(iframe);
    
    // Animate it in
    requestAnimationFrame(() => {
      iframe.style.transform = "translateX(0)";
    });
  }
}
