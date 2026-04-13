import { getSettings, saveSettings } from '../src/storage.js';
import { GitHubClient } from '../src/github-api.js';

const $ = id => document.getElementById(id);

// Strict hostname validation — bare hostnames only, no paths, ports, or query strings.
// Accepts: "github.com", "github.mycompany.com"
// Rejects: "github.com/path", "github.com:8080", "evil.com?x=1"
function isValidHostname(host) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9\-.]{0,251}[a-zA-Z0-9])?$/.test(host)
    && !host.includes('..');
}

// Track whether the user has an existing token (to decide save behaviour)
let tokenAlreadySaved = false;

async function load() {
  const settings = await getSettings();

  $('githubHost').value = settings.githubHost || 'github.com';
  $('includeTeams').checked = settings.includeTeams || false;
  $('teams').value = (settings.teams || []).join(', ');

  const interval = String(settings.pollIntervalMinutes || 5);
  const radio = document.querySelector(`input[name="pollInterval"][value="${interval}"]`);
  if (radio) radio.checked = true;

  // Show "token saved" indicator without ever putting the raw token into the DOM
  if (settings.pat) {
    tokenAlreadySaved = true;
    showPatSaved();
  } else {
    tokenAlreadySaved = false;
    showPatEntry();
  }

  updateTeamsVisibility();
  updateTokenLink();
}

function showPatSaved() {
  $('patSaved').classList.remove('hidden');
  $('patEntry').style.display = 'none';
  $('pat').value = '';
}

function showPatEntry() {
  $('patSaved').classList.add('hidden');
  $('patEntry').style.display = 'flex';
  $('pat').focus();
}

$('replacePatBtn').addEventListener('click', () => {
  tokenAlreadySaved = false; // user is replacing — require new value on save
  showPatEntry();
});

function updateTeamsVisibility() {
  $('teamsField').classList.toggle('visible', $('includeTeams').checked);
}

function updateTokenLink() {
  const host = ($('githubHost').value || 'github.com').trim();
  if (!isValidHostname(host)) return;
  const base = host === 'github.com' ? 'https://github.com' : `https://${host}`;
  $('tokenLink').href = `${base}/settings/tokens/new?scopes=repo,read:org&description=PR+Monitor`;
}

$('includeTeams').addEventListener('change', updateTeamsVisibility);
$('githubHost').addEventListener('input', updateTokenLink);

$('togglePat').addEventListener('click', () => {
  const input = $('pat');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  $('togglePat').textContent = showing ? 'Show' : 'Hide';
});

$('testBtn').addEventListener('click', async () => {
  const result = $('testResult');
  result.className = 'test-result';
  result.textContent = 'Testing…';

  const pat = $('pat').value.trim();
  const host = $('githubHost').value.trim() || 'github.com';

  if (!pat) {
    result.textContent = tokenAlreadySaved
      ? 'Click Replace to enter a new token, or test with the saved token by saving first.'
      : 'Enter a token first.';
    result.className = 'test-result error';
    return;
  }

  if (!isValidHostname(host)) {
    result.textContent = '✗ Invalid GitHub host — enter a bare hostname (e.g. github.mycompany.com)';
    result.className = 'test-result error';
    return;
  }

  try {
    const client = new GitHubClient({ pat, githubHost: host });
    const user = await client.getUser();
    result.textContent = `✓ Authenticated as ${user.login}`;
    result.className = 'test-result ok';
    // Cache the username only — do not save the PAT here; let the user explicitly click Save
    await saveSettings({ username: user.login });
  } catch (err) {
    result.textContent = `✗ ${err.message}`;
    result.className = 'test-result error';
  }
});

$('saveBtn').addEventListener('click', async () => {
  const status = $('saveStatus');
  status.className = 'save-status';
  status.textContent = '';

  const githubHost = ($('githubHost').value.trim()) || 'github.com';

  if (!isValidHostname(githubHost)) {
    status.textContent = 'Invalid GitHub host — enter a bare hostname only.';
    status.className = 'save-status error';
    return;
  }

  const includeTeams = $('includeTeams').checked;
  const teamsRaw = $('teams').value;
  const teams = teamsRaw.split(',').map(t => t.trim()).filter(Boolean);
  const pollRadio = document.querySelector('input[name="pollInterval"]:checked');
  const pollIntervalMinutes = pollRadio ? parseInt(pollRadio.value, 10) : 5;

  const update = { githubHost, includeTeams, teams, pollIntervalMinutes };

  // Only update the PAT if the user typed a new one
  const newPat = $('pat').value.trim();
  if (newPat) {
    update.pat = newPat;
  } else if (!tokenAlreadySaved) {
    status.textContent = 'Please enter a Personal Access Token.';
    status.className = 'save-status error';
    return;
  }
  // If tokenAlreadySaved and newPat is empty, existing token is preserved via merge in saveSettings

  await saveSettings(update);

  // Notify service worker to re-register alarm with new interval
  chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' });

  // Reload to refresh saved state (hides the entry field, shows saved indicator)
  await load();

  status.textContent = 'Saved!';
  status.className = 'save-status ok';
  setTimeout(() => { status.textContent = ''; }, 2000);
});

load();
