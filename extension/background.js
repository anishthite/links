async function enableActionSidePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

chrome.runtime.onInstalled.addListener(() => {
  enableActionSidePanel().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  enableActionSidePanel().catch(console.error);
});
