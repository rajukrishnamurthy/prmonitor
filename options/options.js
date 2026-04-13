import { getSettings, saveSettings } from '../src/storage.js';
import { GitHubClient } from '../src/github-api.js';

const $ = id => document.getElementById(id);

async function load() {
  const settings = await getSettings();

  $('githubHost').value = settings.githubHost || 'github.com';
  $('pat').value = settings.pat || '';
  $('includeTeams').checked = settings.includeTeams || false;
  $('teams').value = (settings.teams || []).join(', ');

  const interval = String(settings.pollIntervalMinutes || 5);
  const radio = document.querySelector(`input[name="pollInterval"][value="${interval}"]`);
  if (radio) radio.checked = true;

  updateTeamsVisibility();
  updateTokenLink();
}

function updateTeamsVisibility() {
  $('teamsField').classList.toggle('visible', $('includeTeams').checked);
}

function updateTokenLink() {
  const host = ($('githubHost').value || 'github.com').trim();
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
    result.textContent = 'Enter a token first.';
    result.className = 'test-result error';
    return;
  }

  try {
    const client = new GitHubClient({ pat, githubHost: host });
    const user = await client.getUser();
    result.textContent = `✓ Authenticated as ${user.login}`;
    result.className = 'test-result ok';
    // Cache the username
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

  const pat = $('pat').value.trim();
  const githubHost = ($('githubHost').value.trim()) || 'github.com';
  const includeTeams = $('includeTeams').checked;
  const teamsRaw = $('teams').value;
  const teams = teamsRaw.split(',').map(t => t.trim()).filter(Boolean);
  const pollRadio = document.querySelector('input[name="pollInterval"]:checked');
  const pollIntervalMinutes = pollRadio ? parseInt(pollRadio.value, 10) : 5;

  await saveSettings({ pat, githubHost, includeTeams, teams, pollIntervalMinutes });

  // Notify service worker to re-register alarm
  chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' });

  status.textContent = 'Saved!';
  status.className = 'save-status ok';
  setTimeout(() => { status.textContent = ''; }, 2000);
});

load();
