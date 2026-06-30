import { DEFAULT_APP_URL, buildCreatePayload, isSavableUrl, linksApiUrl, normalizeAppUrl } from './shared.js';

const form = document.querySelector('#save-form');
const appUrlInput = document.querySelector('#app-url');
const tabTitle = document.querySelector('#tab-title');
const tabUrlInput = document.querySelector('#tab-url');
const noteInput = document.querySelector('#note');
const tagsInput = document.querySelector('#tags');
const saveButton = document.querySelector('#save');
const refreshButton = document.querySelector('#refresh-tab');
const status = document.querySelector('#status');

let activeTab = null;

function setStatus(message, type = '') {
  status.textContent = message;
  status.dataset.type = type;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

function renderTab(tab) {
  activeTab = tab;
  const url = tab?.url || '';
  tabTitle.textContent = tab?.title || 'No active tab found';
  tabUrlInput.value = url;
  saveButton.disabled = !isSavableUrl(url);
  if (!url) setStatus('Open a web page, then refresh the tab.', 'error');
  else if (!isSavableUrl(url)) setStatus('Only http:// and https:// tabs can be saved.', 'error');
  else setStatus('');
}

async function refreshActiveTab() {
  renderTab(await getActiveTab());
}

async function loadSettings() {
  const saved = await chrome.storage.sync.get({ appUrl: DEFAULT_APP_URL, tags: '' });
  appUrlInput.value = normalizeAppUrl(saved.appUrl);
  tagsInput.value = saved.tags || '';
}

async function saveSettings() {
  const appUrl = normalizeAppUrl(appUrlInput.value);
  appUrlInput.value = appUrl;
  await chrome.storage.sync.set({ appUrl, tags: tagsInput.value.trim() });
}

async function saveLink() {
  await saveSettings();
  const payload = buildCreatePayload({
    url: activeTab?.url || tabUrlInput.value,
    note: noteInput.value,
    tagsText: tagsInput.value,
  });
  const res = await fetch(linksApiUrl(appUrlInput.value), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Save failed (${res.status})`);
  noteInput.value = '';
  setStatus(body.duplicate ? 'Already saved — opened the existing link note.' : 'Saved.', 'success');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  setStatus('Saving…', 'busy');
  try {
    await saveLink();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    saveButton.disabled = !isSavableUrl(activeTab?.url || tabUrlInput.value);
  }
});

refreshButton.addEventListener('click', () => {
  refreshActiveTab().catch((error) => setStatus(String(error), 'error'));
});

appUrlInput.addEventListener('change', () => {
  saveSettings().catch((error) => setStatus(error instanceof Error ? error.message : String(error), 'error'));
});

tagsInput.addEventListener('change', () => {
  chrome.storage.sync.set({ tags: tagsInput.value.trim() }).catch(console.error);
});

await loadSettings().catch((error) => setStatus(error instanceof Error ? error.message : String(error), 'error'));
await refreshActiveTab().catch((error) => setStatus(error instanceof Error ? error.message : String(error), 'error'));
