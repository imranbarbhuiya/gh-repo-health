import { discoverDependencies } from './manifests.js';
import { evaluateDependency } from './versions.js';
import { daysSince, mapLimit } from './util.js';

export function summarizeAlerts(alerts) {
  const counts = { total: alerts.length, critical: 0, high: 0, medium: 0, low: 0, unknown: 0, fixAvailable: 0, oldestDays: null };
  for (const alert of alerts) {
    const severity = ['critical', 'high', 'medium', 'low'].includes(alert.severity) ? alert.severity : 'unknown';
    counts[severity]++;
    if (alert.patchedVersion) counts.fixAvailable++;
    const age = daysSince(alert.createdAt);
    if (age !== null) counts.oldestDays = Math.max(counts.oldestDays ?? 0, age);
  }
  return counts;
}

export function summarizeDependencies(dependencies) {
  return {
    total: dependencies.length,
    checked: dependencies.filter(d => ['current', 'outdated', 'ahead', 'range-allows-latest'].includes(d.status)).length,
    outdated: dependencies.filter(d => d.status === 'outdated').length,
    tooOutdated: dependencies.filter(d => d.tooOutdated).length,
    deprecated: dependencies.filter(d => d.deprecated).length,
    rangeOnly: dependencies.filter(d => d.comparisonBasis === 'range-best').length,
    skipped: dependencies.filter(d => d.status === 'skipped').length,
    unknown: dependencies.filter(d => ['unsupported', 'unavailable'].includes(d.status)).length,
  };
}

export function incomplete(repo) {
  return repo.security?.status !== 'checked' ||
    !['checked', 'empty'].includes(repo.freshness?.status) ||
    repo.freshness?.summary?.unknown > 0 ||
    repo.updatePulls?.status !== 'checked' ||
    (repo.codeScanning && repo.codeScanning.status !== 'checked');
}

export function priority(repo) {
  const security = repo.security.summary;
  const freshness = repo.freshness.summary;
  if (security?.critical || repo.codeScanning?.summary?.critical) return 'CRITICAL';
  if (security?.high || repo.codeScanning?.summary?.critical || repo.codeScanning?.summary?.high) return 'HIGH';
  if (security?.total || freshness.outdated || freshness.deprecated) return 'UPDATE';
  return incomplete(repo) ? 'REVIEW' : 'CLEAR';
}

export function sortRepositories(repos) {
  return [...repos].sort((a, b) => {
    for (const getter of [
      r => r.security?.summary?.critical ?? 0,
      r => r.security?.summary?.high ?? 0,
      r => r.codeScanning?.summary?.critical ?? 0,
      r => r.security?.summary?.total ?? 0,
      r => r.freshness?.summary?.tooOutdated ?? 0,
      r => r.freshness?.summary?.deprecated ?? 0,
      r => r.freshness?.summary?.outdated ?? 0,
    ]) {
      const difference = getter(b) - getter(a);
      if (difference) return difference;
    }
    return a.full_name.localeCompare(b.full_name);
  });
}

export function selectRepositories(repositories, options) {
  const names = new Set((options.repo ?? []).map(name => name.toLowerCase()));
  const filtered = repositories.filter(repo =>
    (!names.size || names.has(repo.full_name.toLowerCase())) &&
    (!options.owner || repo.owner.login.toLowerCase() === options.owner.toLowerCase()) &&
    (!options.excludeArchived || !repo.archived) &&
    (!options.excludeForks || !repo.fork) &&
    (!options.visibility || repo.visibility === options.visibility || (options.visibility === 'private' && repo.private)),
  );
  for (const name of names) if (!filtered.some(repo => repo.full_name.toLowerCase() === name)) throw new Error(`${name} was not found in the selected repositories. Check access and filters.`);
  return options.limit ? filtered.slice(0, options.limit) : filtered;
}

export function visibleRepositories(repositories, only = 'all') {
  return repositories.filter(repo => {
    if (only === 'critical') return repo.security?.summary?.critical > 0 || repo.codeScanning?.summary?.critical > 0;
    if (only === 'outdated') return repo.freshness?.summary?.tooOutdated > 0;
    if (only === 'incomplete') return incomplete(repo);
    if (only === 'actionable') return priority(repo) !== 'CLEAR';
    return true;
  });
}

export function failsPolicy(repos, policy = []) {
  return repos.some(repo => policy.some(rule => {
    if (rule === 'critical') return repo.security?.summary?.critical > 0 || repo.codeScanning?.summary?.critical > 0;
    if (rule === 'high') return (repo.security?.summary?.critical ?? 0) + (repo.security?.summary?.high ?? 0) + (repo.codeScanning?.summary?.critical ?? 0) + (repo.codeScanning?.summary?.high ?? 0) > 0;
    if (rule === 'outdated') return repo.freshness?.summary?.tooOutdated > 0;
    return rule === 'incomplete' && incomplete(repo);
  }));
}

async function capture(work) {
  try { return { status: 'checked', items: await work(), error: null }; }
  catch (error) { return { status: error.status ?? 'error', items: [], error: error.message }; }
}

export async function auditRepository(repo, github, registry, options) {
  const [security, discovered, updatePulls, codeScanning] = await Promise.all([
    capture(() => github.alerts(repo)),
    discoverDependencies(github, repo),
    capture(() => github.updatePulls(repo)),
    options.codeScanning ? capture(() => github.codeAlerts(repo)) : null,
  ]);
  const selected = discovered.dependencies.filter(d => !options.directOnly || d.relationship !== 'transitive');
  const dependencies = await mapLimit(selected, options.registryConcurrency, async dependency => {
    try {
      const preliminary = evaluateDependency(dependency, null, options);
      if (preliminary.status === 'skipped' || preliminary.reason) return preliminary;
      return evaluateDependency(dependency, await registry.get(dependency.manager, dependency.name), options);
    }
    catch (error) { return { ...dependency, status: 'unavailable', reason: error.message, tooOutdated: false, deprecated: false }; }
  });
  const result = {
    full_name: repo.full_name, url: repo.html_url, owner: repo.owner.login,
    visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
    archived: repo.archived, fork: repo.fork, language: repo.language,
    permissions: repo.permissions, pushedAt: repo.pushed_at,
    staleDays: daysSince(repo.pushed_at), scannedAt: new Date().toISOString(), reused: false,
    security: { ...security, summary: security.status === 'checked' ? summarizeAlerts(security.items) : null },
    freshness: { ...discovered, dependencies, summary: summarizeDependencies(dependencies) },
    updatePulls: { ...updatePulls, staleCount: updatePulls.items.filter(pull => daysSince(pull.createdAt) >= options.stalePrDays).length },
    ...(codeScanning ? { codeScanning: { ...codeScanning, summary: codeScanning.status === 'checked' ? summarizeAlerts(codeScanning.items) : null } } : {}),
  };
  result.priority = priority(result);
  return result;
}
