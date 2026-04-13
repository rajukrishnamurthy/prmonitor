# PR Monitor

A Chrome/Brave extension for monitoring GitHub pull requests. Tracks incoming review requests, muted PRs, PRs you've already reviewed, and your own open PRs — all in one popup.

## Features

- **Incoming** — PRs where you've been requested as a reviewer, with a toggle between direct requests only vs. team requests
- **Muted** — PRs you've silenced, with flexible expiry options (until next author comment, until any update, for X hours, or forever)
- **Reviewed** — Open PRs you've already reviewed; resurface automatically if the author re-requests your review
- **Mine** — Your own open PRs with review status
- Badge count on the extension icon showing pending incoming PRs
- Background polling every 5 minutes (configurable)
- Supports both github.com and GitHub Enterprise

## Installation (Developer Mode)

### Prerequisites
- Chrome or Brave browser
- A GitHub Personal Access Token with `repo` and `read:org` scopes

### Steps

1. **Clone the repository**
   ```bash
   git clone git@github.com:rajukrishnamurthy/prmonitor.git
   cd prmonitor
   ```

2. **Load the extension**
   - Open Chrome/Brave and navigate to `chrome://extensions` (or `brave://extensions`)
   - Enable **Developer mode** using the toggle in the top-right corner
   - Click **Load unpacked**
   - Select the `prmonitor` directory (the one containing `manifest.json`)

3. **Create a GitHub Personal Access Token**
   - Go to [GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)](https://github.com/settings/tokens/new?scopes=repo,read:org&description=PR+Monitor)
   - Select scopes: `repo` and `read:org`
   - Copy the generated token

4. **Configure the extension**
   - Click the PR Monitor icon in your browser toolbar
   - Click the ⚙ gear icon (or right-click the extension icon → *Options*)
   - Paste your Personal Access Token
   - If using GitHub Enterprise, change the **GitHub Host** field (e.g. `github.mycompany.com`)
   - Click **Test connection** — you should see your GitHub username confirmed
   - Optionally add team slugs (e.g. `myorg/platform, myorg/backend`) for team-based review filtering
   - Click **Save settings**

5. **Start using it**
   - The extension will poll GitHub within a few seconds of saving
   - The badge on the icon shows your incoming PR count
   - Click the icon to open the popup

## Updating

After pulling new changes:
1. Go to `chrome://extensions` (or `brave://extensions`)
2. Find PR Monitor and click the **↻ refresh** icon

No rebuild step is needed — the extension runs directly from source.

## Team Filter Setup

The **Include teams** toggle in the Incoming tab filters PRs where one of your configured teams was requested for review.

To set up teams:
1. Open Settings (⚙)
2. Enable **Include team review requests**
3. Enter team slugs as `org/team-slug`, comma-separated:
   ```
   myorg/platform, myorg/backend-reviewers
   ```
   > Use the team's *slug* (from the URL `github.com/orgs/myorg/teams/platform`), not its display name.

## Mute Options

Each incoming PR has a **Mute ▾** dropdown with four options:

| Option | Behavior |
|--------|----------|
| Until next comment from author | Resurfaces when the PR author posts a new comment |
| Until any update by author | Resurfaces when the author pushes commits or comments |
| For X hours… | Resurfaces after a specified number of hours |
| Forever | Stays muted until you manually unmute it |

Muted PRs appear in the **Muted** tab where they can be unmuted at any time.

## Permissions

| Permission | Why |
|------------|-----|
| `storage` | Saves settings, mute state, and cached PR data locally |
| `alarms` | Schedules background polling |
| `notifications` | Reserved for future desktop notifications |
| `https://api.github.com/*` | GitHub.com API access |
| `https://*/api/v3/*` | GitHub Enterprise API access |
