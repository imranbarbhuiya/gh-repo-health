import test from 'node:test';
import assert from 'node:assert/strict';
import { failsPolicy, priority, selectRepositories, summarizeAlerts, visibleRepositories } from '../src/audit.js';
import { render } from '../src/report.js';
import { parseOptions } from '../src/cli.js';

const repo = {
  full_name: 'owner/app', url: 'https://github.com/owner/app', scannedAt: '2026-10-11',
  security: { status: 'unavailable', summary: null, items: [], error: 'HTTP 403' },
  freshness: { status: 'checked', source: 'github-dependency-graph', warnings: [], dependencies: [], summary: { total: 0, checked: 0, outdated: 0, tooOutdated: 0, deprecated: 0, unknown: 0 } },
  updatePulls: { status: 'checked', items: [] },
};
const report = { repositories: [repo], discoveredCount: 1, selectedCount: 1, complete: true };

test('alert counts represent open alert instances and include unknown severity', () => {
  const summary = summarizeAlerts([{ severity: 'critical', ghsa: 'same', patchedVersion: '2' }, { severity: 'critical', ghsa: 'same' }, { severity: 'new-value' }]);
  assert.equal(summary.total, 3);
  assert.equal(summary.critical, 2);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.fixAvailable, 1);
});

test('inaccessible security stays visibly unknown in reports and policy', () => {
  const output = render(report, { format: 'table', only: 'all' });
  assert.match(output, /\?/);
  assert.match(output, /unavailable, not zero/);
  assert.equal(priority(repo), 'REVIEW');
  assert.equal(failsPolicy([repo], ['critical']), false);
  assert.equal(failsPolicy([repo], ['incomplete']), true);
});

test('CI policy evaluates data independently of the display filter', () => {
  const critical = { ...repo, security: { status: 'checked', items: [], summary: { total: 1, critical: 1, high: 0 } } };
  assert.equal(visibleRepositories([critical], 'outdated').length, 0);
  assert.equal(failsPolicy([critical], ['critical']), true);
});

test('critical code scanning also earns critical priority', () => {
  assert.equal(priority({ ...repo, codeScanning: { status: 'checked', summary: { critical: 1 } } }), 'CRITICAL');
});

test('CSV protects formula-like values', () => {
  const output = render({ ...report, repositories: [{ ...repo, full_name: '=HYPERLINK("evil")' }] }, { format: 'csv' });
  assert.match(output, /"'=HYPERLINK\(""evil""\)"/);
});

test('repository selection includes archives and forks by default and ignores case', () => {
  const repos = [{ full_name: 'Owner/App', owner: { login: 'Owner' }, archived: true, fork: true }];
  assert.equal(selectRepositories(repos, {}).length, 1);
  assert.equal(selectRepositories(repos, { repo: ['owner/app'] }).length, 1);
  assert.equal(selectRepositories(repos, { excludeForks: true }).length, 0);
  assert.throws(() => selectRepositories(repos, { repo: ['owner/missing'] }), /not found/);
});

test('CLI rejects bad thresholds and unrecognized options before network calls', () => {
  for (const args of [['--major-gap', '0'], ['--concurrency', '100'], ['--cache-hours', '-1'], ['--fail-on', 'whatever'], ['--format', 'html'], ['--unknown']]) {
    assert.throws(() => parseOptions(args));
  }
  const { options } = parseOptions(['scan', '--repo', 'owner/app', '--repo', 'org/other', '--resume']);
  assert.equal(options.repo.length, 2);
  assert.equal(options.resume, true);
});
