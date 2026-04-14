import {
  getSettings,
  getCachedPRs,
  getAllPRState,
  setPRState,
  clearPRState,
  getPopupPrefs,
  savePopupPrefs,
} from '../src/storage.js';
import { classifyPRs, relativeTime } from '../src/pr-classifier.js';

// ─── State ────────────────────────────────────────────────────────────────────

let settings = {};
let allPRState = {};
let classified = { incoming: [], muted: [], reviewed: [], myPRs: [] };
let activeTab = 'incoming';
// Popup-level toggle: 'direct' | 'teams'
let requestFilter = 'direct';
// Whether to hide draft PRs in the incoming tab
let ignoreDrafts = false;
// Currently open mute menu node_id
let openMuteMenuId = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  settings = await getSettings();

  if (!settings.pat || !settings.username) {
    showSetupNotice();
    return;
  }

  // Restore persisted popup prefs, falling back to settings defaults
  const savedPrefs = await getPopupPrefs();
  if (savedPrefs) {
    requestFilter = savedPrefs.requestFilter;
    ignoreDrafts = savedPrefs.ignoreDrafts;
  } else {
    requestFilter = settings.includeTeams ? 'teams' : 'direct';
    ignoreDrafts = false;
  }
  syncFilterUI();

  allPRState = await getAllPRState();
  const { raw, lastUpdated } = await getCachedPRs();
  renderAll(raw, lastUpdated);

  // Listen for storage changes (e.g. service worker updated cache)
  chrome.storage.onChanged.addListener(async (changes) => {
    if (changes.cachedPRs || changes.prState || changes.lastUpdated) {
      allPRState = await getAllPRState();
      const { raw, lastUpdated } = await getCachedPRs();
      renderAll(raw, lastUpdated);
    }
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderAll(raw, lastUpdated) {
  const effectiveSettings = {
    ...settings,
    includeTeams: requestFilter === 'teams',
  };
  classified = classifyPRs(raw, allPRState, effectiveSettings);

  // Apply draft filter to incoming only
  const displayedIncoming = ignoreDrafts
    ? classified.incoming.filter(pr => !pr.draft)
    : classified.incoming;

  renderList('incoming', displayedIncoming, renderIncomingCard);
  renderList('muted', classified.muted, renderMutedCard);
  renderList('reviewed', classified.reviewed, renderReviewedCard);
  renderList('myPRs', classified.myPRs, renderMyPRCard);

  updateCounts(displayedIncoming.length);
  updateToolbarBadge(displayedIncoming.length);
  updateLastUpdated(lastUpdated);
}

function renderList(tab, prs, cardFn) {
  const el = document.getElementById(`list-${tab}`);
  el.innerHTML = '';
  if (prs.length === 0) {
    el.innerHTML = `<div class="empty-state">No pull requests here</div>`;
    return;
  }
  for (const pr of prs) {
    el.appendChild(cardFn(pr));
  }
}

function updateCounts(incomingCount) {
  document.getElementById('count-incoming').textContent = incomingCount > 0 ? incomingCount : '';
  for (const tab of ['muted', 'reviewed', 'myPRs']) {
    const el = document.getElementById(`count-${tab}`);
    if (el) el.textContent = classified[tab].length > 0 ? classified[tab].length : '';
  }
}

function updateToolbarBadge(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#e5534b' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function updateLastUpdated(ts) {
  const el = document.getElementById('lastUpdated');
  if (!ts) { el.textContent = ''; return; }
  el.textContent = `Updated ${relativeTime(new Date(ts).toISOString())}`;
}

// ─── Card builders ────────────────────────────────────────────────────────────

/**
 * Build the shared card skeleton.
 * Returns { card, titleRow, statusRow, infoRow } so callers can inject extras.
 */
function buildBaseCard(pr) {
  const { repo } = parseRepoFromPR(pr);

  const card = document.createElement('div');
  card.className = 'pr-card';
  card.dataset.nodeId = pr.node_id;

  const body = document.createElement('div');
  body.className = 'pr-card-body';

  // ── Left column ───────────────────────────────────
  const left = document.createElement('div');
  left.className = 'pr-card-left';

  // Row 1: title (action buttons injected by callers)
  const titleRow = document.createElement('div');
  titleRow.className = 'pr-row-title';

  const titleLink = document.createElement('a');
  titleLink.className = 'pr-title';
  titleLink.href = safeHref(pr.html_url);
  titleLink.target = '_blank';
  titleLink.setAttribute('title', esc(pr.title));
  titleLink.textContent = pr.title;
  titleRow.appendChild(titleLink);
  left.appendChild(titleRow);

  // Row 2: status badges
  const statusRow = document.createElement('div');
  statusRow.className = 'pr-row-status';

  if (pr.draft) {
    statusRow.insertAdjacentHTML('beforeend', '<span class="badge badge-draft">Draft</span>');
  }

  const statusBadge = prStatusBadge(pr);
  if (statusBadge) statusRow.insertAdjacentHTML('beforeend', statusBadge);

  const conflictsBadge = prConflictsBadge(pr);
  if (conflictsBadge) statusRow.insertAdjacentHTML('beforeend', conflictsBadge);

  const reviewBadge = prReviewBadge(pr);
  if (reviewBadge) statusRow.insertAdjacentHTML('beforeend', reviewBadge);

  left.appendChild(statusRow);

  // Row 3: repo/diff info
  const infoRow = document.createElement('div');
  infoRow.className = 'pr-row-info';

  let infoHtml = `${esc(repo)} (#${pr.number})`;
  if (pr.additions != null) infoHtml += ` <span class="stat-add">+${pr.additions}</span>`;
  if (pr.deletions  != null) infoHtml += ` <span class="stat-del">-${pr.deletions}</span>`;
  if (pr.changed_files != null) infoHtml += ` <span>@ ${pr.changed_files}</span>`;
  infoRow.innerHTML = infoHtml;
  left.appendChild(infoRow);

  // ── Right column: author ──────────────────────────
  const right = document.createElement('div');
  right.className = 'pr-card-right';

  const avatar = document.createElement('img');
  avatar.className = 'pr-avatar';
  avatar.src = esc(pr.user?.avatar_url || '');
  avatar.alt = '';
  right.appendChild(avatar);

  const authorEl = document.createElement('span');
  authorEl.className = 'pr-author';
  authorEl.textContent = pr.user?.login || '';
  right.appendChild(authorEl);

  body.appendChild(left);
  body.appendChild(right);
  card.appendChild(body);

  return { card, titleRow, statusRow, infoRow };
}

function renderIncomingCard(pr) {
  const { card, titleRow } = buildBaseCard(pr);
  titleRow.appendChild(createMuteWrapper(pr.node_id));
  return card;
}

function renderMutedCard(pr) {
  const state = allPRState[pr.node_id] || {};
  const { card, titleRow, statusRow } = buildBaseCard(pr);

  const unmuteBtn = document.createElement('button');
  unmuteBtn.className = 'unmute-btn';
  unmuteBtn.textContent = 'Unmute';
  unmuteBtn.addEventListener('click', () => unmutePR(pr.node_id));
  titleRow.appendChild(unmuteBtn);

  const muteInfo = document.createElement('span');
  muteInfo.className = 'mute-label';
  muteInfo.textContent = '🔇 ' + muteLabel(state);
  statusRow.appendChild(muteInfo);

  return card;
}

function renderReviewedCard(pr) {
  const { card } = buildBaseCard(pr);
  return card;
}

function renderMyPRCard(pr) {
  const { card } = buildBaseCard(pr);
  return card;
}

// ─── Mute button / wrapper ───────────────────────────────────────────────────

function createMuteWrapper(nodeId) {
  const wrapper = document.createElement('div');
  wrapper.className = 'mute-wrapper';

  const btn = document.createElement('button');
  btn.className = 'mute-btn';
  btn.title = 'Mute';
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    <path d="M18.63 13A17.89 17.89 0 0 1 18 8"/>
    <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/>
    <path d="M18 8a6 6 0 0 0-9.33-5"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMuteMenu(nodeId, btn);
  });

  wrapper.appendChild(btn);
  return wrapper;
}

// ─── Mute menu (portal pattern) ──────────────────────────────────────────────

const MUTE_MENU_ID = 'portalMuteMenu';

function getOrCreateMuteMenuEl() {
  let el = document.getElementById(MUTE_MENU_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = MUTE_MENU_ID;
    el.className = 'mute-menu';
    el.innerHTML = `
      <button class="mute-menu-item" data-type="until_comment">Until author comments</button>
      <button class="mute-menu-item" data-type="until_update">Until author pushes</button>
      <div class="mute-menu-sep"></div>
      <button class="mute-menu-item" data-type="until_time_1">1 hour</button>
      <button class="mute-menu-item" data-type="until_time_24">24 hours</button>
      <div class="mute-menu-sep"></div>
      <button class="mute-menu-item" data-type="forever">Forever</button>
    `;
    document.body.appendChild(el);

    el.addEventListener('click', (e) => {
      const item = e.target.closest('.mute-menu-item');
      if (!item || !openMuteMenuId) return;
      const type = item.dataset.type;
      const nodeId = openMuteMenuId;
      closeMuteMenu();
      handleMuteSelection(nodeId, type);
    });
  }
  return el;
}

function toggleMuteMenu(nodeId, anchorBtn) {
  const menu = getOrCreateMuteMenuEl();

  if (openMuteMenuId === nodeId && menu.classList.contains('open')) {
    closeMuteMenu();
    return;
  }

  openMuteMenuId = nodeId;

  const rect = anchorBtn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.right = `${window.innerWidth - rect.right}px`;

  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow < 160) {
    menu.style.bottom = `${window.innerHeight - rect.top}px`;
    menu.style.top = 'auto';
  } else {
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.bottom = 'auto';
  }

  menu.classList.add('open');
}

function closeMuteMenu() {
  const menu = document.getElementById(MUTE_MENU_ID);
  if (menu) menu.classList.remove('open');
  openMuteMenuId = null;
}

document.addEventListener('click', (e) => {
  if (openMuteMenuId && !e.target.closest('.mute-btn') && !e.target.closest(`#${MUTE_MENU_ID}`)) {
    closeMuteMenu();
  }
});

// ─── Mute actions ─────────────────────────────────────────────────────────────

async function handleMuteSelection(nodeId, type) {
  if (type === 'until_time_1') {
    await applyMute(nodeId, 'until_time', 1);
  } else if (type === 'until_time_24') {
    await applyMute(nodeId, 'until_time', 24);
  } else {
    await applyMute(nodeId, type, null);
  }
}

async function applyMute(nodeId, type, hours) {
  const pr = findPRByNodeId(nodeId);
  if (!pr) return;

  const state = {
    muted: true,
    muteType: type,
    muteUntil: type === 'until_time' ? Date.now() + hours * 3600_000 : null,
    muteSnapshotCommentId: type === 'until_comment' ? (pr._latestAuthorCommentId ?? null) : null,
    muteSnapshotUpdatedAt: type === 'until_update' ? pr.updated_at : null,
  };

  await setPRState(nodeId, state);
  allPRState = await getAllPRState();

  const { raw, lastUpdated } = await getCachedPRs();
  renderAll(raw, lastUpdated);
}

async function unmutePR(nodeId) {
  await setPRState(nodeId, {
    muted: false,
    muteType: null,
    muteUntil: null,
    muteSnapshotCommentId: null,
    muteSnapshotUpdatedAt: null,
  });
  allPRState = await getAllPRState();
  const { raw, lastUpdated } = await getCachedPRs();
  renderAll(raw, lastUpdated);
}

function findPRByNodeId(nodeId) {
  return [
    ...classified.incoming,
    ...classified.muted,
    ...classified.reviewed,
    ...classified.myPRs,
  ].find(p => p.node_id === nodeId);
}

// ─── Tab switching ────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  closeMuteMenu();
}

// ─── Incoming filter checkboxes ──────────────────────────────────────────────

document.getElementById('includeTeamsChk').addEventListener('change', async (e) => {
  requestFilter = e.target.checked ? 'teams' : 'direct';
  await savePopupPrefs({ requestFilter, ignoreDrafts });
  allPRState = await getAllPRState();
  const { raw, lastUpdated } = await getCachedPRs();
  renderAll(raw, lastUpdated);
});

document.getElementById('includeDraftsChk').addEventListener('change', async (e) => {
  ignoreDrafts = !e.target.checked;
  await savePopupPrefs({ requestFilter, ignoreDrafts });
  allPRState = await getAllPRState();
  const { raw, lastUpdated } = await getCachedPRs();
  renderAll(raw, lastUpdated);
});

function syncFilterUI() {
  document.getElementById('includeTeamsChk').checked = (requestFilter === 'teams');
  document.getElementById('includeDraftsChk').checked = !ignoreDrafts;
}

// ─── Header buttons ───────────────────────────────────────────────────────────

document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' }, async () => {
    btn.classList.remove('spinning');
    allPRState = await getAllPRState();
    const { raw, lastUpdated } = await getCachedPRs();
    renderAll(raw, lastUpdated);
  });
});

document.getElementById('settingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ─── Setup notice ─────────────────────────────────────────────────────────────

function showSetupNotice() {
  document.querySelector('.tabs').style.display = 'none';
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  document.querySelector('footer').style.display = 'none';

  const notice = document.createElement('div');
  notice.className = 'setup-notice';
  notice.innerHTML = `
    <div>👋 Welcome to PR Monitor</div>
    <div>Configure your GitHub token to get started.</div>
    <a href="#" id="openSettingsLink">Open Settings →</a>
  `;
  document.body.insertBefore(notice, document.querySelector('footer'));
  document.getElementById('openSettingsLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeHref(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? esc(url) : '#';
  } catch {
    return '#';
  }
}

function parseRepoFromPR(pr) {
  const url = pr.repository_url || '';
  const match = url.match(/\/repos\/([^/]+)\/([^/]+)$/);
  if (!match) return { owner: '', repo: '' };
  return { owner: match[1], repo: match[2] };
}

function prStatusBadge(pr) {
  switch (pr._mergeableState) {
    case 'clean':                return '<span class="status-badge status-mergeable">Mergeable</span>';
    case 'unstable':             return '<span class="status-badge status-failed">Checks failed</span>';
    case 'blocked': case 'behind':
    case 'unknown':              return '<span class="status-badge status-pending">Checks pending</span>';
    default:                     return null; // dirty handled separately
  }
}

function prConflictsBadge(pr) {
  return pr._mergeableState === 'dirty'
    ? '<span class="status-badge status-failed">Conflicts</span>'
    : null;
}

function prReviewBadge(pr) {
  if (pr._mergeableState === 'clean') return null;
  if (pr._prReviewState === 'APPROVED') {
    return '<span class="status-badge status-approved">Approved</span>';
  }
  if (pr._prReviewState === 'CHANGES_REQUESTED') {
    return '<span class="status-badge status-changes">Changes Requested</span>';
  }
  return '<span class="status-badge status-unreviewed">Unreviewed</span>';
}

function muteLabel(state) {
  switch (state.muteType) {
    case 'until_comment': return 'Until next author comment';
    case 'until_update':  return 'Until any update by author';
    case 'until_time': {
      if (!state.muteUntil) return 'Muted';
      const h = Math.ceil((state.muteUntil - Date.now()) / 3600_000);
      return `Until ~${h}h from now`;
    }
    case 'forever': return 'Muted forever';
    default: return 'Muted';
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
