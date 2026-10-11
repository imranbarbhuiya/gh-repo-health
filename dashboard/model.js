export function filterRepositories(repositories, filters) {
  const query = filters.search.trim().toLowerCase();
  return repositories.filter(repo => {
    const audit = repo.audit;
    if (query && !`${repo.name} ${repo.owner} ${repo.language ?? ''}`.toLowerCase().includes(query)) return false;
    if (filters.owner && repo.owner !== filters.owner) return false;
    if (filters.language && (repo.language ?? 'Unspecified') !== filters.language) return false;
    if (filters.visibility && repo.visibility !== filters.visibility) return false;
    if (filters.excludeArchived && repo.archived) return false;
    if (filters.view === 'critical' && repo.priority !== 'CRITICAL') return false;
    if (filters.view === 'outdated' && !(audit?.freshness.summary.tooOutdated > 0)) return false;
    if (filters.view === 'review' && !repo.needsReview) return false;
    if (filters.view === 'pulls' && !audit?.updatePulls.items.length) return false;
    if (filters.tab === 'actionable' && !['CRITICAL', 'HIGH', 'UPDATE'].includes(repo.priority)) return false;
    if (filters.tab === 'unscanned' && audit) return false;
    if (filters.tab === 'archived' && !repo.archived) return false;
    return true;
  });
}

export function sortRepositories(repositories, column, direction) {
  const getter = {
    name: repo => repo.name.toLowerCase(),
    alerts: repo => repo.audit?.security.summary?.total ?? -1,
    critical: repo => repo.audit?.security.summary?.critical ?? -1,
    outdated: repo => repo.audit?.freshness.summary.tooOutdated ?? -1,
    pushed: repo => Date.parse(repo.pushedAt) || 0,
    priority: repo => ({ CRITICAL: 5, HIGH: 4, UPDATE: 3, REVIEW: 2, CLEAR: 1, UNSCANNED: 0 })[repo.priority],
  }[column];
  return [...repositories].sort((a, b) => {
    const left = getter(a);
    const right = getter(b);
    const order = typeof left === 'string' ? left.localeCompare(right) : left - right;
    return order * direction || a.name.localeCompare(b.name);
  });
}

export function repositoriesCsv(repositories) {
  const rows = [['Repository', 'Visibility', 'Language', 'Archived', 'Fork', 'Priority', 'Audited at', 'Alerts status', 'Open alerts', 'Critical', 'High', 'Medium', 'Low', 'Outdated', 'Severely outdated', 'Coverage', 'Update PRs']];
  for (const repo of repositories) {
    const audit = repo.audit;
    rows.push([
      repo.name, repo.visibility, repo.language ?? '', repo.archived, repo.fork, repo.priority,
      audit?.scannedAt ?? '', audit?.security.status ?? 'not-audited', audit?.security.summary?.total ?? '',
      audit?.security.summary?.critical ?? '', audit?.security.summary?.high ?? '',
      audit?.security.summary?.medium ?? '', audit?.security.summary?.low ?? '',
      audit?.freshness.summary.outdated ?? '', audit?.freshness.summary.tooOutdated ?? '',
      audit ? repo.needsReview ? 'incomplete' : 'checked' : 'not-audited',
      audit?.updatePulls.status === 'checked' ? audit.updatePulls.items.length : '',
    ]);
  }
  return rows.map(row => row.map(value => {
    let text = String(value);
    if (/^[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
}
