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

function toggleSidebar() {

  // Check if sidebar already exists
  const existingSidebar = document.getElementById("leedz-ex-sidebar");
  if (existingSidebar) {
    existingSidebar.remove();
    console.log("[LeedzEx] Sidebar removed");
    return;
  }

  // Create iframe sidebar
  const iframe = document.createElement("iframe");
  iframe.id = "leedz-ex-sidebar";
  iframe.src = chrome.runtime.getURL("sidebar_new.html");
  // console.log("[LeedzEx] Iframe created:", iframe);

  iframe.style.cssText = `
    position: fixed !important;
    top: 0 !important;
    right: 0 !important;
    width: 420px !important;
    height: 100vh !important;
    z-index: 2147483647 !important;
    border: none !important;
    background: white !important;
    box-shadow: -6px 0 18px rgba(0,0,0,0.2) !important;
  `;

  document.body.appendChild(iframe);
  console.log("[LeedzEx] Sidebar appended to DOM");
}
