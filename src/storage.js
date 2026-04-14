// Default settings
const DEFAULTS = {
  settings: {
    pat: '',
    githubHost: 'github.com',
    teams: [],
    pollIntervalMinutes: 5,
    username: '',
    includeTeams: false,
  },
  prState: {},
  cachedPRs: { raw: [] },
  lastUpdated: null,
};

export async function getSettings() {
  const result = await chrome.storage.local.get('settings');
  return { ...DEFAULTS.settings, ...(result.settings || {}) };
}

export async function saveSettings(settings) {
  const current = await getSettings();
  await chrome.storage.local.set({ settings: { ...current, ...settings } });
}

export async function getPRState(prNodeId) {
  const result = await chrome.storage.local.get('prState');
  const prState = result.prState || {};
  return prState[prNodeId] || null;
}

export async function getAllPRState() {
  const result = await chrome.storage.local.get('prState');
  return result.prState || {};
}

export async function setPRState(prNodeId, state) {
  const result = await chrome.storage.local.get('prState');
  const prState = result.prState || {};
  prState[prNodeId] = { ...(prState[prNodeId] || {}), ...state };
  await chrome.storage.local.set({ prState });
}

export async function clearPRState(prNodeId) {
  const result = await chrome.storage.local.get('prState');
  const prState = result.prState || {};
  delete prState[prNodeId];
  await chrome.storage.local.set({ prState });
}

// Prune state entries for PRs that are no longer in the raw cache
export async function pruneStaleState(activeNodeIds) {
  const result = await chrome.storage.local.get('prState');
  const prState = result.prState || {};
  const activeSet = new Set(activeNodeIds);
  for (const id of Object.keys(prState)) {
    if (!activeSet.has(id)) {
      delete prState[id];
    }
  }
  await chrome.storage.local.set({ prState });
}

export async function getPopupPrefs() {
  const result = await chrome.storage.local.get('popupPrefs');
  return result.popupPrefs || null; // null = not yet saved; caller applies defaults
}

export async function savePopupPrefs(prefs) {
  await chrome.storage.local.set({ popupPrefs: prefs });
}

export async function getCachedPRs() {
  const result = await chrome.storage.local.get(['cachedPRs', 'lastUpdated']);
  return {
    raw: (result.cachedPRs || DEFAULTS.cachedPRs).raw,
    lastUpdated: result.lastUpdated || null,
  };
}

export async function setCachedPRs(raw) {
  await chrome.storage.local.set({
    cachedPRs: { raw },
    lastUpdated: Date.now(),
  });
}
