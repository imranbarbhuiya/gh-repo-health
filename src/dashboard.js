import { incomplete, priority } from './audit.js';
import { resolve } from 'node:path';
import { readJson } from './util.js';

export async function loadDashboard(reportDir) {
  const [inventory, latest, history] = await Promise.all([
    readJson(resolve(reportDir, 'inventory.json'), null),
    readJson(resolve(reportDir, 'latest.json'), null),
    readJson(resolve(reportDir, 'history.json'), null),
  ]);
  return dashboardData(inventory, latest, history);
}

export function mergeAudits(previous = [], incoming = []) {
  const repositories = new Map(previous.map(repo => [repo.full_name, repo]));
  for (const repo of incoming) {
    const old = repositories.get(repo.full_name);
    if (!old || Date.parse(repo.scannedAt) >= Date.parse(old.scannedAt)) repositories.set(repo.full_name, repo);
  }
  return [...repositories.values()];
}

export function dashboardData(inventory, latest, history) {
  const context = inventory ?? latest ?? history;
  const matching = value => value && value.host === context?.host && value.user === context?.user;
  const audits = mergeAudits(matching(history) ? history.repositories : [], matching(latest) ? latest.repositories : []);
  const auditMap = new Map(audits.map(repo => [repo.full_name, repo]));
  const sources = inventory?.repositories ?? audits;
  const repositories = sources.map(repo => {
    const audit = auditMap.get(repo.full_name) ?? null;
    return {
      name: repo.full_name, owner: typeof repo.owner === 'string' ? repo.owner : repo.owner.login,
      url: repo.html_url ?? repo.url, visibility: repo.visibility ?? (repo.private ? 'private' : 'public'),
      archived: repo.archived, fork: repo.fork, language: repo.language, permissions: repo.permissions,
      pushedAt: repo.pushed_at ?? repo.pushedAt, audit,
      needsReview: audit ? incomplete(audit) : true,
      priority: audit ? priority(audit) : 'UNSCANNED',
    };
  });
  const audited = repositories.filter(repo => repo.audit);
  const readable = audited.filter(repo => repo.audit.security.status === 'checked');
  const security = { total: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0, fixAvailable: 0 };
  for (const repo of readable) for (const key of Object.keys(security)) security[key] += repo.audit.security.summary[key] ?? 0;
  return {
    user: context?.user ?? null, host: context?.host ?? 'github.com',
    inventoryAt: inventory?.generatedAt ?? null,
    latestScanAt: matching(latest) ? latest.completedAt ?? latest.startedAt : null,
    settings: matching(latest) ? latest.settings : {},
    repositories,
    totals: {
      repositories: repositories.length, audited: audited.length, securityReadable: readable.length, security,
      criticalRepos: audited.filter(repo => repo.priority === 'CRITICAL').length,
      outdatedRepos: audited.filter(repo => repo.audit.freshness.summary.tooOutdated > 0).length,
      outdatedDependencies: audited.reduce((sum, repo) => sum + repo.audit.freshness.summary.outdated, 0),
      review: repositories.filter(repo => repo.needsReview).length,
      openPulls: audited.reduce((sum, repo) => sum + repo.audit.updatePulls.items.length, 0),
    },
  };
}
