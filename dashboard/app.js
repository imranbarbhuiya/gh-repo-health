import { filterRepositories, sortRepositories, repositoriesCsv } from './model.js';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = value => Number(value ?? 0).toLocaleString('en');
const date = value => value ? new Date(value).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not available';
const snapshot = document.getElementById('snapshot-data');
const state = {
  data: null, filters: { search: '', owner: '', language: '', visibility: '', excludeArchived: false, view: 'all', tab: 'all' },
  page: 1, pageSize: 40, sort: 'priority', direction: -1, dependencyTab: 'outdated', selected: null,
};
let toastTimer;
let timer;

function safeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : '#'; }
  catch { return '#'; }
}

function relative(value) {
  if (!value) return 'Unknown';
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86_400_000));
  if (days < 1) return 'Today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

function download(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Saved ${filename}`);
}

function visible() {
  return sortRepositories(filterRepositories(state.data?.repositories ?? [], state.filters), state.sort, state.direction);
}

function renderOverview() {
  const { totals, user, inventoryAt, latestScanAt } = state.data;
  $('account').textContent = user ?? 'No inventory yet';
  $('avatar').textContent = (user ?? 'GH').slice(0, 2).toUpperCase();
  $('mobile-view').value = state.filters.view;
  $('report-date').textContent = latestScanAt ? `Latest scan ${date(latestScanAt)}` : inventoryAt ? `Inventory ${date(inventoryAt)}` : 'Refresh inventory to get started';
  $('summary').innerHTML = [
    ['Accessible repositories', totals.repositories, 'Across owners and organizations', ''],
    ['Repositories audited', totals.audited, `${number(totals.repositories - totals.audited)} still need a scan`, 'metric-accent'],
    ['Known critical alerts', totals.security.critical, `${number(totals.securityReadable)} repositories have readable alerts`, totals.security.critical ? 'metric-critical' : ''],
    ['Severely outdated', totals.outdatedRepos, `${number(totals.outdatedDependencies)} outdated dependency entries`, ''],
  ].map(([label, value, note, style]) => `<div class="metric"><span>${label}</span><strong class="${style}">${number(value)}</strong><p>${note}</p></div>`).join('');
  const severity = ['critical', 'high', 'medium', 'low'];
  let offset = 0;
  const rectangles = severity.map(kind => {
    const width = totals.security.total ? totals.security[kind] / totals.security.total * 100 : 0;
    const rectangle = `<rect class="${kind}" x="${offset}" y="0" width="${width}" height="7"/>`;
    offset += width;
    return rectangle;
  }).join('');
  $('severity').innerHTML = `<div class="severity-values">${severity.map(kind => `<div class="severity-item ${kind}"><strong>${number(totals.security[kind])}</strong><span><i aria-hidden="true"></i>${kind[0].toUpperCase() + kind.slice(1)}</span></div>`).join('')}</div><svg class="severity-bar" viewBox="0 0 100 7" preserveAspectRatio="none" aria-hidden="true"><rect class="background" width="100" height="7"/>${rectangles}</svg><p class="insight-note">${number(totals.security.total)} known open alerts. Counts are readable for ${number(totals.securityReadable)} of ${number(totals.repositories)} repositories; ${number(totals.repositories - totals.securityReadable)} have unknown counts.${totals.security.unknown ? ` ${number(totals.security.unknown)} alerts have unknown severity.` : ''}</p>`;
  const percentage = totals.repositories ? totals.audited / totals.repositories * 100 : 0;
  const label = percentage > 0 && percentage < 10 ? percentage.toFixed(1) : Math.round(percentage);
  $('coverage-fraction').textContent = `${number(totals.audited)} / ${number(totals.repositories)} audited`;
  $('coverage').innerHTML = `<div class="coverage-content"><svg class="coverage-ring" viewBox="0 0 80 80" role="img" aria-label="${label}% of repositories audited"><circle cx="40" cy="40" r="32"/><circle class="audited" cx="40" cy="40" r="32" pathLength="100" stroke-dasharray="${percentage} 100"/><text x="40" y="46">${label}%</text></svg><div><strong>${totals.repositories - totals.audited ? `${number(totals.repositories - totals.audited)} repositories not yet audited` : totals.repositories ? 'Every repository has a saved audit' : 'No repository inventory yet'}</strong><p>${number(totals.review)} repositories need a coverage review.</p><button class="button subtle" id="inventory-refresh" ${snapshot ? 'disabled' : ''}>Refresh repository inventory</button></div></div>`;
  const navigation = [
    ['all', '◫', 'Repositories', totals.repositories], ['critical', '◇', 'Critical alerts', totals.criticalRepos],
    ['outdated', '↻', 'Outdated dependencies', totals.outdatedRepos], ['review', '◌', 'Coverage gaps', totals.review],
    ['pulls', '⑂', 'Update pull requests', totals.openPulls],
  ];
  $('navigation').innerHTML = navigation.map(([key, icon, label, count]) => `<button class="nav-button ${state.filters.view === key ? 'active' : ''}" data-view="${key}" ${state.filters.view === key ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}<span class="nav-count">${number(count)}</span></button>`).join('');
  renderJob();
}

function renderFacets() {
  for (const key of ['owner', 'language']) {
    const values = [...new Set(state.data.repositories.map(repo => repo[key] ?? 'Unspecified'))].sort((a, b) => a.localeCompare(b));
    $(key).innerHTML = `<option value="">All ${key === 'owner' ? 'owners' : 'languages'}</option>` + values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    $(key).value = state.filters[key];
  }
}

function renderRepositories() {
  const repositories = visible();
  const all = state.data.repositories;
  const categories = [
    ['all', 'All repositories', all.length],
    ['actionable', 'Needs attention', all.filter(repo => ['CRITICAL', 'HIGH', 'UPDATE'].includes(repo.priority)).length],
    ['unscanned', 'Not audited', all.filter(repo => !repo.audit).length],
    ['archived', 'Archived', all.filter(repo => repo.archived).length],
  ];
  $('tabs').innerHTML = categories.map(([key, label, count]) => `<button class="tab ${state.filters.tab === key ? 'active' : ''}" data-tab="${key}" aria-pressed="${state.filters.tab === key}">${label}<span>${number(count)}</span></button>`).join('');
  const descriptions = { all: 'Your accessible repository inventory', critical: 'Repositories with known critical alerts', outdated: 'Repositories with dependencies beyond your severe thresholds', review: 'Missing or incomplete audit coverage', pulls: 'Repositories with open dependency update pull requests' };
  $('list-description').textContent = descriptions[state.filters.view];
  const pages = Math.max(1, Math.ceil(repositories.length / state.pageSize));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * state.pageSize;
  const focusName = document.activeElement?.dataset.repo;
  $('rows').innerHTML = repositories.slice(start, start + state.pageSize).map(repo => {
    const audit = repo.audit;
    const security = audit?.security.summary;
    const critical = security?.critical ?? null;
    return `<tr><td><button class="repo-name" data-repo="${escapeHtml(repo.name)}">${escapeHtml(repo.name)}</button><div class="repo-subline">${repo.language ? `<span><i class="language-dot" aria-hidden="true"></i>${escapeHtml(repo.language)}</span>` : ''}<span>${escapeHtml(repo.visibility)}</span>${repo.archived ? '<span class="repo-tag">Archived</span>' : ''}${repo.fork ? '<span class="repo-tag">Fork</span>' : ''}</div></td><td><span class="badge ${repo.priority.toLowerCase()}">${({ UNSCANNED: 'Not audited', CRITICAL: 'Critical', HIGH: 'High', UPDATE: 'Update', REVIEW: 'Review', CLEAR: 'Clear' })[repo.priority]}</span></td><td>${security ? `<span class="numeric ${security.total ? '' : 'zero'}">${number(security.total)}</span>${security.high ? `<div class="secondary-line">${number(security.high)} high</div>` : ''}` : '<span class="unavailable" title="Alerts are unavailable or have not been checked" aria-label="Alerts unavailable">—</span>'}</td><td>${critical !== null ? `<span class="numeric ${critical ? 'critical' : 'zero'}">${number(critical)}</span>` : '<span class="unavailable" aria-label="Critical count unavailable">—</span>'}</td><td>${audit ? `<span class="${audit.freshness.summary.outdated ? 'dep-count' : 'unavailable'}">${number(audit.freshness.summary.outdated)} outdated</span><div class="secondary-line">${number(audit.freshness.summary.tooOutdated)} severe</div>` : '<span class="unavailable" aria-label="Dependencies not checked">—</span>'}</td><td><span class="badge ${audit ? repo.needsReview ? 'review' : 'clear' : 'unscanned'}">${audit ? repo.needsReview ? 'Partial' : 'Checked' : 'Not audited'}</span></td><td><span title="${escapeHtml(date(repo.pushedAt))}">${escapeHtml(relative(repo.pushedAt))}</span></td><td><a class="repo-open" href="${escapeHtml(safeUrl(repo.url))}" target="_blank" rel="noreferrer" aria-label="Open ${escapeHtml(repo.name)} on GitHub">↗</a></td></tr>`;
  }).join('');
  if (focusName) [...document.querySelectorAll('[data-repo]')].find(button => button.dataset.repo === focusName)?.focus();
  $('empty').hidden = repositories.length > 0;
  $('page-summary').textContent = repositories.length ? `${number(start + 1)}–${number(Math.min(start + state.pageSize, repositories.length))} of ${number(repositories.length)} repositories` : '0 repositories';
  $('page-number').textContent = `${state.page} / ${pages}`;
  $('previous').disabled = state.page === 1;
  $('next').disabled = state.page === pages;
  $('export-csv').disabled = !repositories.length;
  $('visible-count').textContent = `${number(repositories.length)} repositories`;
  $('all-count').textContent = `${number(all.length)} repositories`;
  for (const button of document.querySelectorAll('[data-sort]')) {
    const sorted = button.dataset.sort === state.sort;
    button.querySelector('span').textContent = sorted ? state.direction === 1 ? '↑' : '↓' : '↕';
    button.closest('th').setAttribute('aria-sort', sorted ? state.direction === 1 ? 'ascending' : 'descending' : 'none');
  }
}

function renderJob() {
  const job = state.data.job;
  $('job').hidden = !job;
  if (!job) return;
  const running = ['running', 'stopping'].includes(job.status);
  const title = ({ running: job.action === 'inventory' ? 'Refreshing repository inventory' : 'Repository scan in progress', stopping: 'Stopping after active checks finish', completed: 'Scan completed', cancelled: 'Scan stopped; progress saved', failed: 'Scan could not finish' })[job.status];
  $('job').innerHTML = `<div><strong>${title}${job.total ? ` · ${number(job.completed)} / ${number(job.total)}` : ''}</strong><p>${escapeHtml(job.error || job.lastMessage)}</p>${running && job.total ? `<progress max="${job.total}" value="${job.completed}" aria-label="Repositories audited"></progress>` : ''}</div>${running ? `<button class="button" id="stop-scan" ${job.status === 'stopping' ? 'disabled' : ''}>Stop scan</button>` : ''}`;
  $('scan-open').disabled = running || Boolean(snapshot);
}

function dependencyRows(audit) {
  let dependencies = audit.freshness.dependencies;
  if (state.dependencyTab === 'outdated') dependencies = dependencies.filter(dep => dep.status === 'outdated' || dep.deprecated);
  if (state.dependencyTab === 'unverified') dependencies = dependencies.filter(dep => ['unsupported', 'unavailable', 'skipped', 'range-allows-latest'].includes(dep.status));
  dependencies = [...dependencies].sort((a, b) => Number(Boolean(b.tooOutdated)) - Number(Boolean(a.tooOutdated)) || a.name.localeCompare(b.name));
  if (!dependencies.length) return '<p class="insight-note">No dependency entries match this category.</p>';
  return `<div class="table-scroll"><table class="detail-table"><thead><tr><th>Package</th><th>Recorded / allowed</th><th>Latest</th><th>Status</th></tr></thead><tbody>${dependencies.map(dep => `<tr><td><strong>${escapeHtml(dep.name)}</strong>${dep.declaredName ? `<div class="dep-file">Alias: ${escapeHtml(dep.declaredName)}</div>` : ''}<div class="dep-file">${escapeHtml(dep.manager)} · ${escapeHtml(dep.relationship ?? 'unknown')}<br>${dep.manifests.map(escapeHtml).join('<br>')}</div></td><td><code>${escapeHtml(dep.requirement)}</code>${dep.comparisonBasis === 'range-best' ? `<div class="dep-file">Highest allowed: ${escapeHtml(dep.current)}<br>Installed version unknown</div>` : ''}</td><td><code>${escapeHtml(dep.latest ?? '—')}</code></td><td><span class="dep-status ${dep.status}">${escapeHtml(dep.status.replaceAll('-', ' '))}</span>${dep.tooOutdated ? '<div><span class="badge high">Severe</span></div>' : ''}${dep.deprecated ? '<div><span class="badge high">Deprecated</span></div>' : ''}<div class="dep-reason">${escapeHtml(dep.reason || dep.deprecatedReason || (dep.lagDays !== null && dep.lagDays !== undefined ? `Update available ${dep.lagDays}d · ${dep.majorGap} major versions behind` : ''))}</div></td></tr>`).join('')}</tbody></table></div>`;
}

function renderDetail() {
  const repo = state.data.repositories.find(item => item.name === state.selected);
  if (!repo) return;
  const audit = repo.audit;
  const section = (title, content) => `<section class="detail-section"><h3>${title}</h3>${content}</section>`;
  let content = '';
  if (!audit) content = '<div class="empty-state"><h3>This repository has not been audited</h3><p>Run a scan to check dependencies and retrieve GitHub security alerts.</p></div>';
  else {
    const security = audit.security.summary;
    content = `<div class="detail-summary"><div><strong>${security ? number(security.total) : '—'}</strong><span>Open Dependabot alerts</span></div><div><strong>${number(audit.freshness.summary.tooOutdated)}</strong><span>Severely outdated entries</span></div><div><strong>${audit.updatePulls.status === 'checked' ? number(audit.updatePulls.items.length) : '—'}</strong><span>Update pull requests</span></div></div>`;
    const alerts = audit.security.status !== 'checked'
      ? `<div class="coverage-error">${escapeHtml(audit.security.error || 'GitHub alert counts are unavailable. This is not a zero count.')}</div>`
      : audit.security.items.length
        ? audit.security.items.map(alert => `<article class="alert-item"><span class="badge ${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}</span><h4>${escapeHtml(alert.summary)}</h4><p>${escapeHtml(alert.package)} · ${escapeHtml(alert.manifest)}<br>Patched version: ${escapeHtml(alert.patchedVersion ?? 'No fix reported')}<br>${escapeHtml(alert.cve ?? alert.ghsa ?? '')}</p><a href="${escapeHtml(safeUrl(alert.url))}" target="_blank" rel="noreferrer">View GitHub alert ↗</a></article>`).join('')
        : '<p>GitHub reported no open Dependabot alerts at the time of this scan.</p>';
    content += section('Vulnerability alerts', alerts);
    content += section(`Dependencies (${number(audit.freshness.summary.total)})`, `<div class="detail-tabs">${[['outdated', 'Outdated & deprecated'], ['all', 'All entries'], ['unverified', 'Unverified']].map(([key, label]) => `<button class="tab ${state.dependencyTab === key ? 'active' : ''}" data-dependency-tab="${key}" aria-pressed="${state.dependencyTab === key}">${label}</button>`).join('')}</div><div id="dependency-rows">${dependencyRows(audit)}</div>`);
    const pulls = audit.updatePulls.items.map(pull => `<article class="alert-item"><h4>#${pull.number} ${escapeHtml(pull.title)}</h4><p>${escapeHtml(pull.author)} · Opened ${escapeHtml(relative(pull.createdAt))}${pull.draft ? ' · Draft' : ''}</p><a href="${escapeHtml(safeUrl(pull.url))}" target="_blank" rel="noreferrer">View update pull request ↗</a></article>`).join('') || `<p>${audit.updatePulls.status === 'checked' ? 'No open dependency update pull requests were found.' : escapeHtml(audit.updatePulls.error)}</p>`;
    content += section('Update pull requests', pulls);
    if (audit.codeScanning) content += section('Code scanning', audit.codeScanning.status !== 'checked' ? `<div class="coverage-error">${escapeHtml(audit.codeScanning.error)}</div>` : audit.codeScanning.items.map(alert => `<article class="alert-item"><span class="badge ${escapeHtml(alert.severity)}">${escapeHtml(alert.severity)}</span><h4>${escapeHtml(alert.description)}</h4><a href="${escapeHtml(safeUrl(alert.url))}" target="_blank" rel="noreferrer">View code scanning alert ↗</a></article>`).join('') || '<p>No open code scanning alerts reported.</p>');
    const warnings = [...audit.freshness.warnings];
    if (audit.freshness.note) warnings.unshift(audit.freshness.note);
    content += section('Coverage & scan details', `<p>Saved ${escapeHtml(date(audit.scannedAt))}${audit.reused ? ' · Cached result' : ''}<br>Source: ${escapeHtml(audit.freshness.source)}<br>${number(audit.freshness.summary.checked)} of ${number(audit.freshness.summary.total)} dependency entries compared; ${number(audit.freshness.summary.rangeOnly)} comparisons use declared ranges.</p>${warnings.map(warning => `<div class="coverage-error">${escapeHtml(warning)}</div>`).join('')}`);
  }
  $('detail-content').innerHTML = `<div class="dialog-heading"><div><h2 id="detail-title">${escapeHtml(repo.name)}</h2><div class="detail-meta"><span>${escapeHtml(repo.visibility)}</span><span>${escapeHtml(repo.language ?? 'Language unspecified')}</span>${repo.archived ? '<span>Archived</span>' : ''}<span>Last activity ${escapeHtml(relative(repo.pushedAt))}</span></div></div><button class="button icon-button" data-close="detail" aria-label="Close repository details">×</button></div><div class="detail-body"><div class="detail-actions"><a class="button" href="${escapeHtml(safeUrl(repo.url))}" target="_blank" rel="noreferrer">Open on GitHub ↗</a>${!snapshot ? '<button class="button primary" id="scan-repository">Scan this repository</button>' : ''}</div>${content}</div>`;
}

async function requestAction(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': state.data.token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not finish.');
  await load();
}

async function load() {
  try {
    if (snapshot) state.data = JSON.parse(snapshot.textContent);
    else {
      const response = await fetch('/api/data');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      state.data = data;
    }
    $('error').hidden = true;
    renderOverview();
    renderFacets();
    renderRepositories();
  } catch (error) {
    $('error').textContent = `Could not load reports: ${error.message}`;
    $('error').hidden = false;
  }
  if (!snapshot) {
    clearTimeout(timer);
    timer = setTimeout(load, ['running', 'stopping'].includes(state.data?.job?.status) ? 2000 : 60_000);
  }
}

function reset() {
  state.filters = { search: '', owner: '', language: '', visibility: '', excludeArchived: false, view: 'all', tab: 'all' };
  state.page = 1;
  for (const key of ['search', 'owner', 'language', 'visibility']) $(key).value = '';
  $('exclude-archived').checked = false;
  renderOverview();
  renderRepositories();
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || !state.data) return;
  try {
    if (button.dataset.close) $(button.dataset.close).close();
    if (button.dataset.view) { state.filters.view = button.dataset.view; state.filters.tab = 'all'; state.page = 1; renderOverview(); renderRepositories(); }
    if (button.dataset.tab) { state.filters.tab = button.dataset.tab; state.page = 1; renderRepositories(); }
    if (button.dataset.sort) { state.direction = state.sort === button.dataset.sort ? -state.direction : button.dataset.sort === 'name' ? 1 : -1; state.sort = button.dataset.sort; renderRepositories(); }
    if (button.dataset.repo) { state.selected = button.dataset.repo; state.dependencyTab = 'outdated'; renderDetail(); $('detail').showModal(); }
    if (button.dataset.dependencyTab) { state.dependencyTab = button.dataset.dependencyTab; $('dependency-rows').innerHTML = dependencyRows(state.data.repositories.find(repo => repo.name === state.selected).audit); for (const tab of document.querySelectorAll('[data-dependency-tab]')) { tab.classList.toggle('active', tab.dataset.dependencyTab === state.dependencyTab); tab.setAttribute('aria-pressed', tab.dataset.dependencyTab === state.dependencyTab); } }
    if (button.id === 'refresh') await load();
    if (button.id === 'reset' || button.id === 'empty-reset') reset();
    if (button.id === 'previous') { state.page--; renderRepositories(); }
    if (button.id === 'next') { state.page++; renderRepositories(); }
    if (button.id === 'export-csv') download(repositoriesCsv(visible()), 'text/csv;charset=utf-8', 'repository-health.csv');
    if (button.id === 'export-json') { const { token, job, ...report } = state.data; download(JSON.stringify(report, null, 2), 'application/json', 'repository-health.json'); }
    if (button.id === 'export-html') { const response = await fetch('/api/snapshot'); if (!response.ok) throw new Error('Could not save the HTML report.'); download(await response.text(), 'text/html;charset=utf-8', 'repository-health.html'); }
    if (button.id === 'inventory-refresh') await requestAction('/api/scan', { action: 'inventory' });
    if (button.id === 'scan-open') { if (!visible().length) document.querySelector('input[name="scope"][value="all"]').checked = true; $('scan-dialog').showModal(); }
    if (button.id === 'scan-repository') { await requestAction('/api/scan', { action: 'scan', repos: [state.selected] }); $('detail').close(); }
    if (button.id === 'stop-scan') await requestAction('/api/cancel');
  } catch (error) { toast(error.message); }
});

$('search').addEventListener('input', event => { state.filters.search = event.target.value; state.page = 1; renderRepositories(); });
$('mobile-view').addEventListener('change', event => { state.filters.view = event.target.value; state.filters.tab = 'all'; state.page = 1; renderOverview(); renderRepositories(); });
for (const key of ['owner', 'language', 'visibility']) $(key).addEventListener('change', event => { state.filters[key] = event.target.value; state.page = 1; renderRepositories(); });
$('exclude-archived').addEventListener('change', event => { state.filters.excludeArchived = event.target.checked; state.page = 1; renderRepositories(); });
$('scan-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('scan-submit').disabled = true;
  try {
    const scope = new FormData(event.target).get('scope');
    const body = { action: 'scan', directOnly: $('direct-only').checked, codeScanning: $('code-scanning').checked, resume: $('resume').checked };
    if (scope === 'visible') body.repos = visible().map(repo => repo.name);
    await requestAction('/api/scan', body);
    $('scan-dialog').close();
  } catch (error) { toast(error.message); }
  finally { $('scan-submit').disabled = false; }
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('detail').open && !$('scan-dialog').open) { event.preventDefault(); $('search').focus(); }
});
for (const id of ['detail', 'scan-dialog']) $(id).addEventListener('click', event => { if (event.target === $(id)) { const rect = $(id).getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $(id).close(); } });
if (snapshot) { $('scan-open').hidden = true; $('refresh').hidden = true; $('export-html').hidden = true; $('snapshot-label').hidden = false; document.querySelector('.sidebar-note p').textContent = 'An offline copy of your saved audit. Search, filter, and export this report.'; }
load();
