import {
  getSettings,
  getCachedPRs,
  getAllPRState,
  setPRState,
  clearPRState,
} from '../src/storage.js';
import { classifyPRs, relativeTime } from '../src/pr-classifier.js';

// ─── State ────────────────────────────────────────────────────────────────────

let settings = {};
let allPRState = {};
let classified = { incoming: [], muted: [], reviewed: [], myPRs: [] };
let activeTab = 'incoming';
// Popup-level toggle: 'direct' | 'teams'
let requestFilter = 'direct';
// Pending mute action waiting for hours input
let pendingMutePR = null;
// Currently open mute menu node_id
let openMuteMenuId = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  settings = await getSettings();

  if (!settings.pat || !settings.username) {
    showSetupNotice();
    return;
  }

  // Default filter matches settings
  requestFilter = settings.includeTeams ? 'teams' : 'direct';
  syncFilterPills();

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
  // Apply popup-level filter on top of stored settings
  const effectiveSettings = {
    ...settings,
    includeTeams: requestFilter === 'teams',
  };
  classified = classifyPRs(raw, allPRState, effectiveSettings);

  renderList('incoming', classified.incoming, renderIncomingCard);
  renderList('muted', classified.muted, renderMutedCard);
  renderList('reviewed', classified.reviewed, renderReviewedCard);
  renderList('myPRs', classified.myPRs, renderMyPRCard);

  updateCounts();
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

function updateCounts() {
  for (const [tab, list] of Object.entries(classified)) {
    const el = document.getElementById(`count-${tab}`);
    if (el) el.textContent = list.length > 0 ? list.length : '';
  }
}

function updateLastUpdated(ts) {
  const el = document.getElementById('lastUpdated');
  if (!ts) { el.textContent = ''; return; }
  el.textContent = `Updated ${relativeTime(new Date(ts).toISOString())}`;
}

// ─── Card builders ────────────────────────────────────────────────────────────

function buildBaseCard(pr) {
  const { owner, repo } = parseRepoFromPR(pr);
  const card = document.createElement('div');
  card.className = 'pr-card';
  card.dataset.nodeId = pr.node_id;

  const isDraft = pr.draft;
  const ciDot = ciStatusDot(pr);

  card.innerHTML = `
    <div class="pr-card-top">
      <img class="pr-avatar" src="${esc(pr.user?.avatar_url || '')}" alt="${esc(pr.user?.login || '')}" />
      <div class="pr-main">
        <div class="pr-repo">${esc(owner)}/${esc(repo)} #${pr.number}</div>
        <a class="pr-title" href="${safeHref(pr.html_url)}" target="_blank" title="${esc(pr.title)}">${esc(pr.title)}</a>
        <div class="pr-meta">
          <span>${esc(pr.user?.login || '')}</span>
          <span>•</span>
          <span>${relativeTime(pr.updated_at)}</span>
          ${isDraft ? '<span class="badge badge-draft">Draft</span>' : ''}
          ${ciDot}
        </div>
      </div>
    </div>
  `;
  return card;
}

function renderIncomingCard(pr) {
  const card = buildBaseCard(pr);
  const actions = document.createElement('div');
  actions.className = 'pr-card-actions';

  const muteWrapper = document.createElement('div');
  muteWrapper.className = 'mute-wrapper';

  const muteBtn = document.createElement('button');
  muteBtn.className = 'mute-btn';
  muteBtn.innerHTML = 'Mute <span style="font-size:10px">▾</span>';
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMuteMenu(pr.node_id, muteBtn);
  });

  muteWrapper.appendChild(muteBtn);
  actions.appendChild(muteWrapper);
  card.appendChild(actions);
  return card;
}

function renderMutedCard(pr) {
  const card = buildBaseCard(pr);
  const state = allPRState[pr.node_id] || {};
  const actions = document.createElement('div');
  actions.className = 'pr-card-actions';

  const label = document.createElement('span');
  label.className = 'mute-label';
  label.textContent = '🔇 ' + muteLabel(state);

  const unmuteBtn = document.createElement('button');
  unmuteBtn.className = 'unmute-btn';
  unmuteBtn.textContent = 'Unmute';
  unmuteBtn.addEventListener('click', () => unmutePR(pr.node_id));

  actions.appendChild(label);
  actions.appendChild(unmuteBtn);
  card.appendChild(actions);
  return card;
}

function renderReviewedCard(pr) {
  const card = buildBaseCard(pr);
  return card;
}

function renderMyPRCard(pr) {
  const card = buildBaseCard(pr);

  // Append review status info
  const metaEl = card.querySelector('.pr-meta');
  if (metaEl) {
    const reviewStatus = myPRReviewStatus(pr);
    if (reviewStatus) {
      metaEl.insertAdjacentHTML('beforeend', `<span>•</span>${reviewStatus}`);
    }
  }

  return card;
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
      <button class="mute-menu-item" data-type="until_comment">Until next comment from author</button>
      <button class="mute-menu-item" data-type="until_update">Until any update by author</button>
      <button class="mute-menu-item" data-type="until_time">For X hours…</button>
      <button class="mute-menu-item" data-type="forever">Forever</button>
    `;
    document.body.appendChild(el);

    el.addEventListener('click', (e) => {
      const item = e.target.closest('.mute-menu-item');
      if (!item || !openMuteMenuId) return;
      const type = item.dataset.type;
      const nodeId = openMuteMenuId; // capture before closeMuteMenu clears it
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

  // Position relative to viewport
  const rect = anchorBtn.getBoundingClientRect();
  const bodyRect = document.body.getBoundingClientRect();

  menu.style.position = 'fixed';
  menu.style.right = `${window.innerWidth - rect.right}px`;

  // Open upward if near bottom, downward otherwise
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow < 150) {
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

// Close menu on outside click
document.addEventListener('click', (e) => {
  if (openMuteMenuId && !e.target.closest('.mute-btn') && !e.target.closest(`#${MUTE_MENU_ID}`)) {
    closeMuteMenu();
  }
});

// ─── Mute actions ─────────────────────────────────────────────────────────────

async function handleMuteSelection(nodeId, type) {
  if (type === 'until_time') {
    pendingMutePR = nodeId;
    showMuteDialog();
    return;
  }
  await applyMute(nodeId, type, null);
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

// ─── Mute hours dialog ────────────────────────────────────────────────────────

function showMuteDialog() {
  document.getElementById('muteDialog').classList.remove('hidden');
  document.getElementById('muteHours').focus();
}

function hideMuteDialog() {
  document.getElementById('muteDialog').classList.add('hidden');
  pendingMutePR = null;
}

document.getElementById('muteCancelBtn').addEventListener('click', hideMuteDialog);

document.getElementById('muteConfirmBtn').addEventListener('click', async () => {
  const hours = parseInt(document.getElementById('muteHours').value, 10);
  if (!hours || hours < 1) return;
  hideMuteDialog();
  if (pendingMutePR) {
    await applyMute(pendingMutePR, 'until_time', hours);
    pendingMutePR = null;
  }
});

document.getElementById('muteHours').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('muteConfirmBtn').click();
  if (e.key === 'Escape') hideMuteDialog();
});

// ─── Tab switching ────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    switchTab(tab);
  });
});

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  closeMuteMenu();
}

// ─── Incoming filter pills ────────────────────────────────────────────────────

document.querySelectorAll('#requestFilter .pill').forEach(pill => {
  pill.addEventListener('click', async () => {
    requestFilter = pill.dataset.value;
    syncFilterPills();
    allPRState = await getAllPRState();
    const { raw, lastUpdated } = await getCachedPRs();
    renderAll(raw, lastUpdated);
  });
});

function syncFilterPills() {
  document.querySelectorAll('#requestFilter .pill').forEach(p => {
    p.classList.toggle('active', p.dataset.value === requestFilter);
  });
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

// Only allow https: URLs in href attributes — blocks javascript: and data: URIs.
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

function ciStatusDot(pr) {
  // GitHub search results don't include CI status directly;
  // we store it as _ciStatus if enriched by service worker
  const status = pr._ciStatus;
  if (!status) return '<span class="ci-dot ci-none" title="No CI info"></span>';
  if (status === 'success') return '<span class="ci-dot ci-pass" title="CI passing"></span>';
  if (status === 'failure' || status === 'error') return '<span class="ci-dot ci-fail" title="CI failing"></span>';
  return '<span class="ci-dot ci-pending" title="CI pending"></span>';
}

function muteLabel(state) {
  switch (state.muteType) {
    case 'until_comment': return 'Until next author comment';
    case 'until_update': return 'Until any update by author';
    case 'until_time': {
      if (!state.muteUntil) return 'Muted';
      const h = Math.ceil((state.muteUntil - Date.now()) / 3600_000);
      return `Until ~${h}h from now`;
    }
    case 'forever': return 'Muted forever';
    default: return 'Muted';
  }
}

function myPRReviewStatus(pr) {
  // PR review status is stored on the enriched object
  if (!pr._reviewStatus) return null;
  switch (pr._reviewStatus) {
    case 'APPROVED':
      return '<span class="review-badge approved">✓ Approved</span>';
    case 'CHANGES_REQUESTED':
      return '<span class="review-badge changes">⚠ Changes requested</span>';
    default:
      return `<span class="review-badge pending">${pr._pendingReviewers ?? 0} reviewers pending</span>`;
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
