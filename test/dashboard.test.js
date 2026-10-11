import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { dashboardData, loadDashboard } from '../src/dashboard.js';
import { snapshotHtml } from '../src/snapshot.js';
import { createDashboardServer, scanArguments } from '../src/server.js';
import { writeJson } from '../src/util.js';
import { filterRepositories, sortRepositories, repositoriesCsv } from '../dashboard/model.js';

const context = { host: 'github.com', user: 'owner' };
const repository = name => ({ full_name: `owner/${name}`, owner: { login: 'owner' }, html_url: `https://github.com/owner/${name}`, visibility: 'private', archived: false, fork: false, language: 'JavaScript', pushed_at: '2026-10-10' });
const audit = (name, options = {}) => ({
  ...repository(name), owner: 'owner', url: `https://github.com/owner/${name}`, scannedAt: '2026-10-10',
  security: { status: 'checked', items: [], summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0, fixAvailable: 0 } },
  freshness: { status: 'checked', source: 'github', dependencies: [], warnings: [], summary: { total: 0, checked: 0, outdated: 0, tooOutdated: 0, unknown: 0, rangeOnly: 0 } },
  updatePulls: { status: 'checked', items: [] }, ...options,
});
const inventory = { ...context, generatedAt: '2026-10-10', repositories: [repository('one'), repository('two'), repository('three')] };
const report = { ...context, repositories: [audit('one')] };
const filters = { search: '', owner: '', language: '', visibility: '', excludeArchived: false, view: 'all', tab: 'all' };

test('dashboard joins inventory and history, keeps freshest audit, and leaves unknown counts unknown', () => {
  const unknown = audit('two', { security: { status: 'unavailable', summary: null, items: [] } });
  const older = audit('one', { scannedAt: '2026-01-01' });
  const data = dashboardData(inventory, report, { ...context, repositories: [older, unknown, audit('removed')] });
  assert.equal(data.repositories.length, 3);
  assert.equal(data.repositories[0].audit.scannedAt, '2026-10-10');
  assert.equal(data.repositories[1].audit.security.summary, null);
  assert.equal(data.repositories[2].audit, null);
  assert.equal(data.repositories[2].priority, 'UNSCANNED');
  assert.equal(data.totals.audited, 2);
  assert.equal(data.totals.securityReadable, 1);
  assert.equal(data.totals.security.total, 0);
  assert.equal(data.totals.review, 2);
});

test('dashboard never combines audit results from a different account or host', () => {
  assert.equal(dashboardData(inventory, { ...report, user: 'other' }, { ...report, host: 'enterprise.example' }).totals.audited, 0);
  assert.equal(dashboardData(null, report, null).repositories[0].name, 'owner/one');
  assert.equal(dashboardData(null, null, null).totals.repositories, 0);
});

test('view filters, compound facets, and sorting use audited facts without treating unknown as zero', () => {
  const severe = audit('one', { freshness: { ...audit('one').freshness, summary: { ...audit('one').freshness.summary, outdated: 2, tooOutdated: 1 } } });
  const data = dashboardData(inventory, { ...report, repositories: [severe] }, null);
  assert.deepEqual(filterRepositories(data.repositories, { ...filters, view: 'outdated' }).map(repo => repo.name), ['owner/one']);
  assert.equal(filterRepositories(data.repositories, { ...filters, tab: 'unscanned' }).length, 2);
  assert.equal(filterRepositories(data.repositories, { ...filters, search: 'ONE', owner: 'owner', language: 'JavaScript', visibility: 'private' }).length, 1);
  assert.equal(filterRepositories(data.repositories, { ...filters, visibility: 'public' }).length, 0);
  assert.equal(sortRepositories(data.repositories, 'alerts', -1)[0].name, 'owner/one');
  assert.equal(sortRepositories(data.repositories, 'critical', -1)[0].name, 'owner/one');
});

test('CSV uses blank unavailable fields and neutralizes spreadsheet formulas', () => {
  const data = dashboardData(inventory, report, null);
  data.repositories[1].language = '=HYPERLINK("https://example.com")';
  const csv = repositoriesCsv(data.repositories);
  assert.match(csv, /"not-audited","","","","","","","","not-audited",""/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example.com""\)"/);
});

test('snapshot includes its assets, escapes embedded data, and removes the live session token', async () => {
  const data = { ...dashboardData(inventory, report, null), token: 'secret-token', job: { status: 'running' } };
  data.repositories[0].name = '</script><script>alert(1)</script>';
  const html = await snapshotHtml(data);
  assert.doesNotMatch(html, /secret-token|src="\/app.js"|href="\/styles.css"/);
  assert.match(html, /\\u003c\/script>/);
  assert.match(html, /<style>/);
  const embedded = html.match(/id="snapshot-data">(.*?)<\/script>/s)[1];
  assert.equal(JSON.parse(embedded).repositories[0].name, data.repositories[0].name);
  assert.equal(JSON.parse(embedded).job, undefined);
});

test('scan requests only accept current inventory selections and pass flags without a shell', () => {
  const data = dashboardData(inventory, report, null);
  const args = scanArguments({ action: 'scan', repos: ['owner/one', 'owner/one'], directOnly: true, codeScanning: true, resume: true }, data, '/tmp/reports');
  assert.equal(args.filter(arg => arg === '--repo').length, 1);
  assert.ok(args.includes('--direct-only') && args.includes('--code-scanning') && args.includes('--resume'));
  assert.throws(() => scanArguments({ action: 'scan', repos: ['--output'] }, data, '/tmp/reports'), /outside/);
  assert.throws(() => scanArguments({ action: 'scan', repos: [] }, data, '/tmp/reports'), /Select/);
  assert.throws(() => scanArguments({ action: 'delete' }, data, '/tmp/reports'), /Choose/);
});

test('HTTP dashboard restricts origin and host, serializes jobs, shows progress, and retains audit history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'repo-dashboard-'));
  await writeJson(join(directory, 'inventory.json'), inventory);
  await writeJson(join(directory, 'latest.json'), report);
  const children = [];
  const server = createDashboardServer({ reportDir: directory, launch: (exe, args) => {
    assert.equal(exe, process.execPath);
    assert.equal(args[1], 'scan');
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.kill = () => { child.emit('close', 130); return true; };
    children.push(child);
    return child;
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const data = await (await fetch(`${base}/api/data`)).json();
  const post = (path, body, token = data.token, origin = base) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': token, Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await post('/api/scan', { action: 'scan' }, 'bad')).status, 403);
  assert.equal((await post('/api/scan', { action: 'scan' }, data.token, 'https://evil.example')).status, 403);
  assert.equal((await post('/api/scan', { action: 'scan' }, data.token, 'invalid-origin')).status, 403);
  const hostStatus = await new Promise(resolve => { const req = httpRequest(`${base}/api/data`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); req.end(); });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(`${base}/src/cli.js`)).status, 404);
  assert.equal((await post('/api/scan', { action: 'scan', repos: ['absent/repo'] })).status, 400);
  const starts = await Promise.all([post('/api/scan', { action: 'scan', repos: ['owner/two'] }), post('/api/scan', { action: 'scan', repos: ['owner/two'] })]);
  assert.deepEqual(starts.map(response => response.status).sort(), [202, 409]);
  assert.equal(children.length, 1);
  children[0].stderr.write('[1/1] owner/two completed\n');
  assert.equal((await (await fetch(`${base}/api/data`)).json()).job.completed, 1);
  await writeJson(join(directory, 'latest.json'), { ...report, repositories: [audit('two')] });
  children[0].emit('close', 0);
  const final = await (await fetch(`${base}/api/data`)).json();
  assert.equal(final.job.status, 'completed');
  assert.equal(final.totals.audited, 2);
  assert.equal((await loadDashboard(directory)).totals.audited, 2);
  assert.equal(JSON.parse(await readFile(join(directory, 'history.json'), 'utf8')).repositories.length, 2);
  const html = await (await fetch(`${base}/api/snapshot`)).text();
  assert.doesNotMatch(html, new RegExp(data.token));
  assert.equal((await post('/api/scan', { action: 'scan', repos: ['owner/three'] })).status, 202);
  assert.equal((await post('/api/cancel', {})).status, 200);
  assert.equal((await (await fetch(`${base}/api/data`)).json()).job.status, 'cancelled');
});
