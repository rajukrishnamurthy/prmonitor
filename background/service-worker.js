import { GitHubClient, parseRepo } from '../src/github-api.js';
import {
  getSettings,
  getAllPRState,
  setPRState,
  setCachedPRs,
  pruneStaleState,
} from '../src/storage.js';

const ALARM_NAME = 'poll';

// ─── Install / startup ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await registerAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await registerAlarm();
});

async function registerAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clearAll();
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.1,  // first poll shortly after startup
    periodInMinutes: settings.pollIntervalMinutes || 5,
  });
}

// ─── Alarm handler ───────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await pollGitHub();
  }
});

// ─── Message handler (from popup) ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FORCE_REFRESH') {
    pollGitHub().then(() => sendResponse({ ok: true })).catch((err) => {
      sendResponse({ ok: false, error: err.message });
    });
    return true; // keep channel open for async response
  }

  if (message.type === 'SETTINGS_CHANGED') {
    registerAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ─── Core poll logic ─────────────────────────────────────────────────────────

async function pollGitHub() {
  const settings = await getSettings();
  if (!settings.pat || !settings.username) {
    updateBadge(0);
    return;
  }

  const client = new GitHubClient({ pat: settings.pat, githubHost: settings.githubHost });

  let directRequests, teamRequests, commentedPRs, myPRs;
  try {
    ({ directRequests, teamRequests, commentedPRs, myPRs } = await client.fetchAll({
      username: settings.username,
      teams: settings.teams || [],
      includeTeams: settings.includeTeams || false,
    }));
  } catch (err) {
    console.error('[PR Monitor] Poll failed:', err);
    return;
  }

  // Build a deduplicated map: nodeId → pr (with source flags).
  // Insertion order determines which object "wins" for deduplication;
  // flags are merged onto whichever object is already in the map.

  const prMap = new Map();

  for (const pr of myPRs) {
    pr._isMyPR = true;
    pr._isDirectRequest = false;
    pr._isTeamRequest = false;
    pr._wasCommenter = false;
    prMap.set(pr.node_id, pr);
  }

  // commentedPRs: user reviewed/commented but is no longer in requested_reviewers.
  // These feed the Reviewed tab directly without needing enrichment to detect it.
  for (const pr of commentedPRs) {
    const existing = prMap.get(pr.node_id);
    if (existing) {
      existing._wasCommenter = true;
    } else {
      pr._wasCommenter = true;
      pr._isDirectRequest = false;
      pr._isTeamRequest = false;
      pr._isMyPR = false;
      prMap.set(pr.node_id, pr);
    }
  }

  for (const pr of teamRequests) {
    const existing = prMap.get(pr.node_id);
    if (existing) {
      existing._isTeamRequest = true;
    } else {
      pr._isTeamRequest = true;
      pr._isDirectRequest = false;
      pr._isMyPR = false;
      pr._wasCommenter = false;
      prMap.set(pr.node_id, pr);
    }
  }

  for (const pr of directRequests) {
    const existing = prMap.get(pr.node_id);
    if (existing) {
      existing._isDirectRequest = true;
    } else {
      pr._isDirectRequest = true;
      pr._isTeamRequest = false;
      pr._isMyPR = false;
      pr._wasCommenter = false;
      prMap.set(pr.node_id, pr);
    }
  }

  const allPRs = [...prMap.values()];

  // Enrich each non-mine PR with review status and mute data
  const allState = await getAllPRState();
  const enriched = await Promise.all(allPRs.map(pr => enrichPR(pr, client, settings.username, allState)));

  // Prune state for PRs no longer visible
  await pruneStaleState(enriched.map(p => p.node_id));

  await setCachedPRs(enriched);

  // Badge = count of incoming (direct or team) non-muted PRs
  const incomingCount = enriched.filter(pr => {
    if (pr._isMyPR) return false;
    if (pr._userReviewed && !pr._reviewRerequested) return false;
    const state = allState[pr.node_id] || {};
    if (state.muted) return false;
    return pr._isDirectRequest || pr._isTeamRequest;
  }).length;

  updateBadge(incomingCount);
}

async function enrichPR(pr, client, username, allState) {
  const { owner, repo } = parseRepo(pr);
  const num = pr.number;

  // Fetch reviews and (for mute-until-comment) comments in parallel
  const state = allState[pr.node_id] || {};
  const needsComments = state.muteType === 'until_comment';

  const [reviews, comments, requestedReviewers] = await Promise.all([
    pr._isMyPR ? Promise.resolve([]) : client.getReviews(owner, repo, num).catch(() => []),
    needsComments ? client.getIssueComments(owner, repo, num).catch(() => []) : Promise.resolve(null),
    pr._isMyPR ? Promise.resolve({ users: [], teams: [] }) : client.getRequestedReviewers(owner, repo, num).catch(() => ({ users: [], teams: [] })),
  ]);

  // Override _isDirectRequest with ground truth: user must be explicitly in the
  // users[] list. review-requested:@me also matches team memberships, so the
  // search query alone cannot distinguish direct vs team requests.
  pr._isDirectRequest = requestedReviewers.users.some(
    u => u.login?.toLowerCase() === username.toLowerCase()
  );

  // Did the user submit a non-dismissed review?
  const userReviews = reviews.filter(
    r => r.user?.login?.toLowerCase() === username.toLowerCase() && r.state !== 'DISMISSED'
  );
  pr._userReviewed = userReviews.length > 0;

  // Re-request: user reviewed AND is now back in requested_reviewers
  pr._reviewRerequested = pr._userReviewed && pr._isDirectRequest;

  // Latest author comment ID for mute-until-comment expiry
  if (comments) {
    const authorComments = comments.filter(
      c => c.user?.login?.toLowerCase() === pr.user?.login?.toLowerCase()
    );
    pr._latestAuthorCommentId = authorComments.length > 0
      ? Math.max(...authorComments.map(c => c.id))
      : null;
  } else {
    pr._latestAuthorCommentId = null;
  }

  return pr;
}

function updateBadge(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#e5534b' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}
