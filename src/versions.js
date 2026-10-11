import semver from 'semver';
import * as pep440 from '@renovatebot/pep440';
import { daysSince } from './util.js';
import { packageKey } from './registry.js';

function normalize(version, system) {
  const value = version.trim().replace(/^v/, '');
  if (system === 'PYPI') return pep440.valid(value) ? value : null;
  if (system === 'NPM' || system === 'GO' || system === 'CARGO') return semver.valid(value);
  if (/^\d+(?:\.\d+){0,2}$/.test(value)) return value.split('.').concat(['0', '0']).slice(0, 3).join('.');
  return semver.valid(value);
}

function compare(a, b, system) {
  return system === 'PYPI' ? pep440.compare(a, b) : semver.compare(a, b);
}

function stable(version, system) {
  if (system === 'PYPI') {
    const parsed = pep440.parse(version);
    return parsed.pre === null && parsed.dev === null;
  }
  return semver.prerelease(version) === null;
}

export function evaluateDependency(dependency, metadata, options, now = Date.now()) {
  const result = { ...dependency, status: 'unsupported', reason: null, current: null, latest: null, majorGap: null, lagDays: null, tooOutdated: false, deprecated: false };
  const key = packageKey(dependency.manager, dependency.name);
  if (!key) return { ...result, reason: `Unsupported registry ecosystem: ${dependency.manager ?? 'unknown'}.` };
  const system = key.system;
  let requirement = dependency.requirement?.trim() ?? '';
  if (system === 'NPM' && requirement === 'latest') requirement = '*';
  if (system === 'CARGO' || (system === 'NPM' && dependency.basis === 'github')) requirement = requirement.replace(/,\s*/g, ' ');
  if (/^(?:workspace:|file:|link:|git(?:\+|:)|https?:|github:|catalog:|path:)/i.test(requirement) || requirement.includes(' @ ')) {
    return { ...result, status: 'skipped', reason: 'Local, workspace, Git, URL, or catalog dependency; no registry version comparison.' };
  }
  if (!metadata) return result;
  result.metadataFetchedAt = metadata.fetchedAt;
  result.metadataSource = metadata.source;
  const versions = metadata.versions.map(entry => ({ ...entry, normalized: normalize(entry.version, system) })).filter(entry => entry.normalized);
  const latest = versions.find(entry => entry.isDefault && stable(entry.normalized, system));
  if (!latest) return { ...result, reason: 'Registry has no supported stable default version.' };
  result.latest = latest.version;
  let exact = requirement.replace(/^(?:==|=)\s*/, '');
  let current = normalize(exact, system);
  let basis = 'exact';
  const cargoRange = system === 'CARGO' && dependency.basis === 'declared';
  if (cargoRange && /^\d/.test(requirement)) requirement = `^${requirement}`;
  if (cargoRange || !current) {
    let matching;
    if (system === 'NPM' || system === 'CARGO') {
      if (!semver.validRange(requirement)) return { ...result, reason: 'Version tag or unsupported version constraint.' };
      matching = versions.filter(entry => stable(entry.normalized, system) && semver.satisfies(entry.normalized, requirement));
    } else if (system === 'PYPI') {
      try {
        if (!requirement || requirement === '*') matching = versions.filter(entry => stable(entry.normalized, system));
        else if (!pep440.validRange(requirement)) return { ...result, reason: 'Unsupported Python version constraint.' };
        else matching = versions.filter(entry => stable(entry.normalized, system) && pep440.satisfies(entry.normalized, requirement));
      } catch {
        return { ...result, reason: 'Unsupported Python version constraint.' };
      }
    } else {
      return { ...result, reason: 'Only exact versions are currently compared in this ecosystem.' };
    }
    const best = matching.sort((a, b) => compare(b.normalized, a.normalized, system))[0];
    if (!best) return { ...result, reason: 'No published stable version matches the constraint.' };
    current = best.normalized;
    exact = best.version;
    basis = 'range-best';
  }
  result.current = exact;
  result.comparisonBasis = basis;
  const ordering = compare(current, latest.normalized, system);
  result.status = ordering < 0 ? 'outdated' : ordering > 0 ? 'ahead' : basis === 'range-best' ? 'range-allows-latest' : 'current';
  const currentRelease = versions.find(entry => compare(entry.normalized, current, system) === 0);
  result.deprecated = currentRelease?.isDeprecated === true;
  result.deprecatedReason = currentRelease?.deprecatedReason ?? null;
  if (ordering < 0) {
    const oldMajor = system === 'PYPI' ? pep440.parse(current).release[0] : semver.major(current);
    const newMajor = system === 'PYPI' ? pep440.parse(latest.normalized).release[0] : semver.major(latest.normalized);
    result.majorGap = Math.max(0, newMajor - oldMajor);
    const newerReleases = versions.filter(entry =>
      entry.publishedAt && stable(entry.normalized, system) && !entry.isDeprecated &&
      compare(entry.normalized, current, system) > 0 && compare(entry.normalized, latest.normalized, system) <= 0,
    ).sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
    result.lagDays = daysSince(newerReleases[0]?.publishedAt, now);
    result.tooOutdated = result.majorGap >= options.majorGap || (result.lagDays !== null && result.lagDays >= options.outdatedDays);
  }
  return result;
}
