import { clean, permission } from './util.js';
import { incomplete, priority, sortRepositories, visibleRepositories } from './audit.js';

export function totals(report) {
  const repos = report.repositories;
  return {
    repositories: repos.length,
    alerts: repos.reduce((n, r) => n + (r.security.summary?.total ?? 0), 0),
    critical: repos.reduce((n, r) => n + (r.security.summary?.critical ?? 0), 0),
    high: repos.reduce((n, r) => n + (r.security.summary?.high ?? 0), 0),
    securityUnavailable: repos.filter(r => r.security.status !== 'checked').length,
    tooOutdatedRepos: repos.filter(r => r.freshness.summary.tooOutdated > 0).length,
    incomplete: repos.filter(incomplete).length,
    reused: repos.filter(r => r.reused).length,
  };
}

function table(headers, rows) {
  rows = rows.map(row => row.map(clean));
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index].length)));
  const line = row => row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd();
  return [line(headers), widths.map(width => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

export function inventoryTable(repositories) {
  return table(['REPOSITORY', 'VISIBILITY', 'ACCESS', 'LANGUAGE', 'STATE'], repositories.map(repo => [
    repo.full_name, repo.visibility ?? (repo.private ? 'private' : 'public'), permission(repo), repo.language ?? '-',
    [repo.archived ? 'archived' : 'active', repo.fork ? 'fork' : ''].filter(Boolean).join(', '),
  ]));
}

export function render(report, options) {
  const repositories = visibleRepositories(sortRepositories(report.repositories), options.only);
  if (options.format === 'json') return `${JSON.stringify({ ...report, repositories }, null, 2)}\n`;
  const headers = ['REPOSITORY', 'PRIORITY', 'ALERTS', 'CRIT', 'HIGH', 'MED', 'LOW', 'OUTDATED', 'SEVERE', 'DEPRECATED', 'CHECKED', 'UPDATE PRS', 'COVERAGE'];
  const rows = repositories.map(repo => [
    repo.full_name, priority(repo), repo.security.summary?.total ?? '?', repo.security.summary?.critical ?? '?',
    repo.security.summary?.high ?? '?', repo.security.summary?.medium ?? '?', repo.security.summary?.low ?? '?', repo.freshness.summary.outdated, repo.freshness.summary.tooOutdated,
    repo.freshness.summary.deprecated, `${repo.freshness.summary.checked}/${repo.freshness.summary.total}`,
    repo.updatePulls.status === 'checked' ? repo.updatePulls.items.length : '?',
    `${incomplete(repo) ? 'incomplete' : 'checked'}${repo.reused ? ' (cached)' : ''}`,
  ]);
  if (report.repositories.some(repo => repo.codeScanning)) {
    headers.push('CODE (CRIT/HIGH)');
    rows.forEach((row, index) => {
      const code = repositories[index].codeScanning;
      row.push(code?.summary ? `${code.summary.total} (${code.summary.critical}/${code.summary.high})` : '?');
    });
  }
  if (options.format === 'csv') {
    const cell = value => {
      value = clean(value);
      if (/^[=+@-]/.test(value)) value = `'${value}`;
      return `"${value.replaceAll('"', '""')}"`;
    };
    return [headers, ...rows].map(row => row.map(cell).join(',')).join('\n') + '\n';
  }
  const summary = totals(report);
  const caption = `${summary.repositories}/${report.selectedCount} repositories scanned (${report.discoveredCount} accessible). ${summary.alerts} known open Dependabot alerts: ${summary.critical} critical, ${summary.high} high. ${summary.tooOutdatedRepos} repositories have severely outdated dependencies.`;
  const caveat = `${summary.securityUnavailable} repositories have unavailable security counts; ${summary.incomplete} have incomplete coverage. ? means unavailable, not zero. ${summary.reused} results reused. Scan ${report.complete ? 'finished' : 'in progress'}.`;
  const body = options.format === 'markdown'
    ? [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.map(cell => clean(cell).replaceAll('|', '\\|')).join(' | ')} |`).join('\n')
    : table(headers, rows);
  const output = [caption, caveat, '', body || 'No repositories match this filter.'];
  for (const repo of repositories) {
    const important = repo.freshness.dependencies.filter(dep => dep.status === 'outdated' || dep.deprecated);
    if (!options.details && !important.length && !repo.security.summary?.critical) continue;
    output.push('', `${repo.full_name}${repo.archived ? ' [archived]' : ''}${repo.fork ? ' [fork]' : ''} — ${repo.url}`, `  Checked: ${repo.scannedAt}; freshness source: ${repo.freshness.source}.`);
    const shown = options.details ? repo.freshness.dependencies : important.slice(0, 5);
    for (const dep of shown) {
      output.push(`  ${clean(dep.name)} (${clean(dep.manager)}): ${clean(dep.requirement)} → ${clean(dep.latest ?? '?')} [${dep.status}${dep.tooOutdated ? ', SEVERE' : ''}${dep.deprecated ? ', deprecated' : ''}]${dep.comparisonBasis === 'range-best' ? ' highest allowed version; installed version unknown' : ''}`);
      if (options.details) output.push(`    ${dep.manifests.map(clean).join(', ')}; ${clean(dep.reason || dep.deprecatedReason || `major gap ${dep.majorGap ?? '-'}, update available for ${dep.lagDays ?? '?'} days`)}`);
    }
    if (!options.details && important.length > shown.length) output.push(`  … ${important.length - shown.length} more; use --details or the JSON report.`);
    for (const alert of repo.security.items.filter(alert => options.details || alert.severity === 'critical')) {
      output.push(`  ${clean(alert.severity.toUpperCase())} ${clean(alert.package)}: ${clean(alert.summary)}; patched: ${clean(alert.patchedVersion ?? 'not available')}; ${alert.url}`);
    }
    if (options.details) {
      output.push(`  Update PRs: ${repo.updatePulls.staleCount ?? 0} stale; last pushed ${repo.staleDays ?? '?'} days ago. Dependency comparisons using ranges: ${repo.freshness.summary.rangeOnly ?? 0}.`);
      for (const pull of repo.updatePulls.items) output.push(`  Update PR #${pull.number}: ${clean(pull.title)} — ${pull.url}`);
      for (const warning of repo.freshness.warnings) output.push(`  Coverage: ${clean(warning)}`);
      if (repo.freshness.note) output.push(`  Coverage: ${repo.freshness.note}`);
      if (repo.security.error) output.push(`  Alerts unavailable: ${clean(repo.security.error)}`);
      if (repo.updatePulls.error) output.push(`  Update PRs unavailable: ${clean(repo.updatePulls.error)}`);
      if (repo.codeScanning?.error) output.push(`  Code scanning unavailable: ${clean(repo.codeScanning.error)}`);
      for (const alert of repo.codeScanning?.items ?? []) output.push(`  Code scanning ${clean(alert.severity)}: ${clean(alert.description)} — ${alert.url}`);
    }
  }
  return output.join('\n') + '\n';
}
