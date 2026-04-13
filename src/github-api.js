export class GitHubClient {
  constructor({ pat, githubHost = 'github.com' }) {
    this.pat = pat;
    this.host = githubHost;
    this.baseUrl = githubHost === 'github.com'
      ? 'https://api.github.com'
      : `https://${githubHost}/api/v3`;
  }

  async _fetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.pat}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  // Get the authenticated user
  async getUser() {
    return this._fetch('/user');
  }

  // Search for PRs using GitHub search API. Returns items array (up to 100).
  async searchPRs(query) {
    const encoded = encodeURIComponent(query);
    const data = await this._fetch(`/search/issues?q=${encoded}&per_page=100`);
    return data.items || [];
  }

  // Get all reviews on a PR. Returns array of review objects.
  async getReviews(owner, repo, pullNumber) {
    return this._fetch(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews?per_page=100`);
  }

  // Get issue comments on a PR (regular comments, not review comments).
  async getIssueComments(owner, repo, issueNumber) {
    return this._fetch(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`);
  }

  // Get requested reviewers for a PR (to detect re-requests).
  async getRequestedReviewers(owner, repo, pullNumber) {
    return this._fetch(`/repos/${owner}/${repo}/pulls/${pullNumber}/requested_reviewers`);
  }

  // Fetch all PRs needed for the extension in parallel.
  // Returns { directRequests, teamRequests, myPRs }
  async fetchAll({ username, teams = [], includeTeams = false }) {
    const promises = [
      this.searchPRs(`is:pr is:open review-requested:${username}`),
      this.searchPRs(`is:pr is:open author:${username}`),
    ];

    const teamQueries = includeTeams && teams.length > 0
      ? teams.map(team => this.searchPRs(`is:pr is:open team-review-requested:${team}`))
      : [];

    const [directRequests, myPRs, ...teamResults] = await Promise.all([
      ...promises,
      ...teamQueries,
    ]);

    // Deduplicate team results by PR node_id
    const teamMap = new Map();
    for (const items of teamResults) {
      for (const pr of items) {
        teamMap.set(pr.node_id, pr);
      }
    }

    return {
      directRequests,
      teamRequests: [...teamMap.values()],
      myPRs,
    };
  }
}

// Parse owner and repo from a PR's repository_url field.
// e.g. "https://api.github.com/repos/acme/payments" → { owner: "acme", repo: "payments" }
export function parseRepo(pr) {
  const url = pr.repository_url || '';
  const match = url.match(/\/repos\/([^/]+)\/([^/]+)$/);
  if (!match) return { owner: '', repo: '' };
  return { owner: match[1], repo: match[2] };
}

// Pull number from the PR's html_url since search results don't always include pull_number directly
export function getPullNumber(pr) {
  return pr.number;
}
