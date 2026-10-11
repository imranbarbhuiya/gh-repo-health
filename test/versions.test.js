import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDependency } from '../src/versions.js';

const options = { majorGap: 2, outdatedDays: 180 };
const now = Date.parse('2026-10-11T00:00:00Z');
const dependency = (requirement, manager = 'npm', basis = 'github') => ({ name: 'example', manager, requirement, basis, manifests: ['package.json'] });
const metadata = versions => ({ fetchedAt: '2026-10-11T00:00:00Z', source: 'https://api.deps.dev/example', versions });
const releases = metadata([
  { version: '1.0.0', publishedAt: '2024-01-01T00:00:00Z' },
  { version: '1.9.0', publishedAt: '2026-08-01T00:00:00Z' },
  { version: '3.0.0', isDefault: true, publishedAt: '2026-10-01T00:00:00Z' },
  { version: '4.0.0-beta.1', publishedAt: '2023-01-01T00:00:00Z' },
]);

test('flags major lag even when the latest release is recent', () => {
  const result = evaluateDependency(dependency('= 1.0.0'), releases, options, now);
  assert.equal(result.status, 'outdated');
  assert.equal(result.majorGap, 2);
  assert.equal(result.tooOutdated, true);
  assert.equal(result.lagDays, 71);
});

test('ranges compare the highest permitted version rather than the lower bound', () => {
  const result = evaluateDependency(dependency('^1.0.0'), releases, options, now);
  assert.equal(result.current, '1.9.0');
  assert.equal(result.comparisonBasis, 'range-best');
  assert.equal(result.status, 'outdated');
});

test('an allowing range does not claim an installed dependency is current', () => {
  const result = evaluateDependency(dependency('>=1'), releases, options, now);
  assert.equal(result.status, 'range-allows-latest');
  assert.equal(result.comparisonBasis, 'range-best');
});

test('age is how long a newer release has been available, not how old a package is', () => {
  const unchanged = metadata([{ version: '1.0.0', isDefault: true, publishedAt: '2015-01-01' }]);
  assert.equal(evaluateDependency(dependency('1.0.0'), unchanged, options, now).tooOutdated, false);
  const changed = metadata([
    { version: '1.0.0', publishedAt: '2020-01-01' },
    { version: '1.0.1', isDefault: true, publishedAt: '2025-01-01' },
  ]);
  assert.equal(evaluateDependency(dependency('1.0.0'), changed, options, now).tooOutdated, true);
});

test('never recommends a downgrade when a pinned version is ahead of the default', () => {
  const result = evaluateDependency(dependency('3.1.0'), releases, options, now);
  assert.equal(result.status, 'ahead');
  assert.equal(result.tooOutdated, false);
});

test('workspace and URL dependencies remain explicitly skipped', () => {
  for (const requirement of ['workspace:*', 'file:../package', 'github:owner/repo', 'https://example.com/a.tgz', 'catalog:']) {
    assert.equal(evaluateDependency(dependency(requirement), releases, options, now).status, 'skipped');
  }
});

test('version tags and unsupported ecosystems are not counted as current', () => {
  assert.equal(evaluateDependency(dependency('next'), releases, options, now).status, 'unsupported');
  assert.equal(evaluateDependency(dependency('1', 'actions'), null, options, now).status, 'unsupported');
});

test('deprecation is reported even when the version is current', () => {
  const data = metadata([{ version: '1.0.0', isDefault: true, isDeprecated: true, deprecatedReason: 'Use replacement' }]);
  const result = evaluateDependency(dependency('1.0.0'), data, options, now);
  assert.equal(result.deprecated, true);
  assert.equal(result.deprecatedReason, 'Use replacement');
});

test('Python supports epochs, post releases, and PEP 440 ranges', () => {
  const data = metadata([
    { version: '1!1.0', publishedAt: '2024-01-01' },
    { version: '1!1.0.post1', publishedAt: '2025-01-01' },
    { version: '1!2.0', isDefault: true, publishedAt: '2026-01-01' },
  ]);
  const result = evaluateDependency(dependency('>=1!1.0,<1!2', 'pip'), data, options, now);
  assert.equal(result.current, '1!1.0.post1');
  assert.equal(result.status, 'outdated');
  assert.equal(result.majorGap, 1);
});

test('Python dev0 is not accepted as a stable default', () => {
  const data = metadata([{ version: '2.0.dev0', isDefault: true }]);
  assert.equal(evaluateDependency(dependency('1.0', 'pip'), data, options, now).status, 'unsupported');
});

test('Cargo bare manifest requirements are caret ranges; locked versions are exact', () => {
  const data = metadata([{ version: '1.0.0' }, { version: '1.9.0', isDefault: true }]);
  assert.equal(evaluateDependency(dependency('1.0.0', 'cargo', 'declared'), data, options, now).status, 'range-allows-latest');
  assert.equal(evaluateDependency(dependency('1.0.0', 'cargo', 'resolved'), data, options, now).status, 'outdated');
});

test('nonstandard Maven versions remain unsupported instead of using lossy coercion', () => {
  const data = metadata([{ version: '2.0.Final', isDefault: true }]);
  assert.equal(evaluateDependency(dependency('1.0.Final', 'maven'), data, options, now).status, 'unsupported');
});

test('GitHub Cargo comma-separated requirements are comparable ranges', () => {
  const result = evaluateDependency(dependency('>= 1.0.0,< 2.0.0', 'RUST'), releases, options, now);
  assert.equal(result.current, '1.9.0');
  assert.equal(result.status, 'outdated');
});

test('npm latest is treated as an allowing declaration rather than a pinned version', () => {
  assert.equal(evaluateDependency(dependency('latest'), releases, options, now).status, 'range-allows-latest');
});
