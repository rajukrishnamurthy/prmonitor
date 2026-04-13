/**
 * Check whether a mute entry has expired.
 * Returns true if the mute is still active (not expired).
 */
export function isMuteActive(state, pr) {
  if (!state || !state.muted) return false;

  const { muteType, muteUntil, muteSnapshotCommentId, muteSnapshotUpdatedAt } = state;

  switch (muteType) {
    case 'forever':
      return true;

    case 'until_time':
      return muteUntil != null && Date.now() < muteUntil;

    case 'until_comment':
      // Resurface if PR now has a newer author comment than the snapshot
      if (muteSnapshotCommentId == null) return true;
      // latestAuthorCommentId is enriched onto pr during polling
      if (pr._latestAuthorCommentId == null) return true;
      return pr._latestAuthorCommentId <= muteSnapshotCommentId;

    case 'until_update':
      // Resurface if PR's updated_at has changed since snapshot
      if (muteSnapshotUpdatedAt == null) return true;
      return pr.updated_at === muteSnapshotUpdatedAt;

    default:
      return false;
  }
}

/**
 * Classify a flat list of enriched PR objects into tabs.
 *
 * Each PR must have these extra fields attached by the service worker:
 *   pr._isDirectRequest    — boolean
 *   pr._isTeamRequest      — boolean
 *   pr._isMyPR             — boolean
 *   pr._userReviewed       — boolean (user submitted at least one non-dismissed review)
 *   pr._reviewRerequested  — boolean (user is in requested_reviewers after having reviewed)
 *   pr._latestAuthorCommentId — number|null (for mute expiry)
 *
 * @param {Array}  prs        Enriched PR objects
 * @param {Object} allState   Map of nodeId → prState from storage
 * @param {Object} settings   User settings (includeTeams, teams, username)
 * @returns {{ incoming, muted, reviewed, myPRs }}
 */
export function classifyPRs(prs, allState, settings) {
  const incoming = [];
  const muted = [];
  const reviewed = [];
  const myPRs = [];

  for (const pr of prs) {
    const state = allState[pr.node_id] || {};
    const muteActive = isMuteActive(state, pr);

    // --- Muted and still active ---
    if (muteActive) {
      muted.push(pr);
      continue;
    }

    // --- My own PR ---
    if (pr._isMyPR) {
      myPRs.push(pr);
      continue;
    }

    // --- Already reviewed ---
    // _wasCommenter: PR came from the commenter:USER search — user interacted
    // but is no longer in requested_reviewers, so it belongs in Reviewed.
    // _userReviewed: enrichment confirmed the user submitted a formal review.
    // In both cases, if the author re-requested (_reviewRerequested), it moves
    // back to Incoming.
    if (pr._wasCommenter || state.reviewed || pr._userReviewed) {
      if (pr._reviewRerequested) {
        incoming.push(pr);
      } else {
        reviewed.push(pr);
      }
      continue;
    }

    // --- Incoming (direct or team) ---
    if (pr._isDirectRequest) {
      incoming.push(pr);
      continue;
    }

    if (settings.includeTeams && pr._isTeamRequest) {
      incoming.push(pr);
      continue;
    }
  }

  return { incoming, muted, reviewed, myPRs };
}

/**
 * Relative time string, e.g. "3d ago", "5h ago", "just now"
 */
export function relativeTime(dateString) {
  const ms = Date.now() - new Date(dateString).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
