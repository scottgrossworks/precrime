// background.js — LeedzEx scoped sidebar control with tab-specific sidebar state and runtime content injection

const enabledTabs = new Set(); // Tracks tabs where sidebar was explicitly opened by the user

// Handle icon click to open sidebar (and inject content.js) for current tab
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;

  // Dynamically inject content.js into the current tab
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["js/content.js"]
  }, () => {
    // After injection, enable and open the sidebar for this tab
    chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: "sidebar.html",
      enabled: true
    }, () => {
      chrome.sidePanel.open({ tabId: tab.id });
      enabledTabs.add(tab.id); // Mark this tab as explicitly enabled
      console.log("[LeedzEx] Sidebar opened for tab", tab.id);
    });
  });
});

// When the user switches tabs, show or hide the sidebar depending on whether the tab is tracked
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (enabledTabs.has(tabId)) {
    chrome.sidePanel.setOptions({
      tabId,
      path: "sidebar.html",
      enabled: true
    });
    chrome.sidePanel.open({ tabId });
    console.log("[LeedzEx] Sidebar re-opened for tracked tab", tabId);
  } else {
    chrome.sidePanel.setOptions({
      tabId,
      enabled: false
    });
    console.log("[LeedzEx] Sidebar hidden on untracked tab", tabId);
  }
});

// Cleanup: when a tab is closed, remove it from the enabled list
chrome.tabs.onRemoved.addListener((tabId) => {
  enabledTabs.delete(tabId);
});

// On tab creation (e.g. new tab or redirected navigation), explicitly disable the sidebar unless it's already tracked
chrome.tabs.onCreated.addListener((tab) => {
  if (!tab?.id || enabledTabs.has(tab.id)) return;

  chrome.sidePanel.setOptions({
    tabId: tab.id,
    enabled: false
  });
  console.log("[LeedzEx] Sidebar disabled for new tab:", tab.id);
});

// Handle internal message routing between content and sidebar

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Relay request from sidebar to content script to extract DOM
  if (message.type === "leedz_request_dom") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, { type: "leedz_request_dom" }, sendResponse);
    });
    return true; // Required for async response
  }

  // Relay DOM text selection to the sidebar from content
  if (message.type === "leedz_selection") {
    chrome.runtime.sendMessage({
      type: "leedz_update_selection",
      selection: message.selection
    });
  }
});
