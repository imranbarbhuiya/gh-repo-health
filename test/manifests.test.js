import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverDependencies, mergeDependencies, parseManifest } from '../src/manifests.js';

test('JavaScript manifests retain dependency scopes', () => {
  const { dependencies } = parseManifest('apps/web/package.json', JSON.stringify({ dependencies: { react: '^19' }, devDependencies: { eslint: '9.0.0' }, peerDependencies: { vue: '^3' } }));
  assert.equal(dependencies.length, 3);
  assert.equal(dependencies[1].scope, 'devDependencies');
  assert.deepEqual(dependencies[0].manifests, ['apps/web/package.json']);
});

test('npm lockfiles preserve multiple installed versions and scopes', () => {
  const { dependencies } = parseManifest('package-lock.json', JSON.stringify({ packages: {
    '': { name: 'app', dependencies: { react: '^18' } },
    'node_modules/react': { version: '18.0.0' },
    'node_modules/something/node_modules/react': { version: '17.0.0', dev: true },
    'node_modules/internal': { link: true, resolved: 'packages/internal' },
  } }));
  assert.equal(dependencies.length, 2);
  assert.deepEqual(dependencies.map(d => d.requirement), ['18.0.0', '17.0.0']);
  assert.equal(dependencies[1].scope, 'development');
});

test('Python markers, extras and hashes do not alter package identity', () => {
  const parsed = parseManifest('requirements.txt', 'requests[security]==2.30.0 ; python_version >= "3.8"\nflask==2.0.0 --hash=sha256:abc\n-r other.txt\n');
  assert.equal(parsed.dependencies[0].name, 'requests');
  assert.equal(parsed.dependencies[0].requirement, '==2.30.0');
  assert.equal(parsed.dependencies[1].requirement, '==2.0.0');
  assert.equal(parsed.warnings.length, 1);
});

test('pyproject reads PEP 621 and development groups', () => {
  const parsed = parseManifest('pyproject.toml', '[project]\ndependencies=["requests>=2,<3"]\n[dependency-groups]\ndev=["pytest>=8", {include-group="lint"}]\n');
  assert.deepEqual(parsed.dependencies.map(d => d.name), ['requests', 'pytest']);
  assert.equal(parsed.warnings.length, 1);
});

test('Cargo rename and target dependencies are discovered', () => {
  const parsed = parseManifest('Cargo.toml', '[dependencies]\nrenamed={package="serde",version="1"}\n[target."cfg(unix)".dependencies]\nlibc="0.2"\n');
  assert.deepEqual(parsed.dependencies.map(d => d.name), ['serde', 'libc']);
});

test('Go single and block requirements retain indirect relationships', () => {
  const parsed = parseManifest('go.mod', 'module example.com/app\ngo 1.25\nrequire example.com/a v1.0.0\nrequire (\nexample.com/b v2.0.0 // indirect\n)\nreplace example.com/a => ../a\n');
  assert.equal(parsed.dependencies.length, 2);
  assert.equal(parsed.dependencies[1].relationship, 'transitive');
  assert.equal(parsed.warnings.length, 1);
});

test('dependency counts deduplicate repeated manifests without losing locations', () => {
  const parsed = parseManifest('package.json', '{"dependencies":{"react":"18.0.0"}}').dependencies;
  const merged = mergeDependencies([...parsed, { ...parsed[0], manifests: ['other/package.json'] }]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].manifests, ['package.json', 'other/package.json']);
});

test('fallback prefers same-directory lockfile versions over declared ranges', async () => {
  const files = { a: '{"dependencies":{"react":"^18"}}', b: '{"packages":{"":{"dependencies":{"react":"^18"}},"node_modules/react":{"version":"18.1.0"}}}' };
  const github = {
    graph: async () => [],
    tree: async () => ({ tree: [{ path: 'package.json', sha: 'a', type: 'blob' }, { path: 'package-lock.json', sha: 'b', type: 'blob' }], truncated: false }),
    file: async (_, entry) => files[entry.sha],
  };
  const result = await discoverDependencies(github, { size: 1 });
  assert.equal(result.dependencies.length, 1);
  assert.equal(result.dependencies[0].requirement, '18.1.0');
  assert.equal(result.status, 'partial');
});

test('truncation and unsupported manifests remain visible as incomplete coverage', async () => {
  const github = { graph: async () => [], tree: async () => ({ tree: [{ path: 'pom.xml', type: 'blob' }], truncated: true }) };
  const result = await discoverDependencies(github, { size: 1 });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.warnings.length, 2);
});

test('empty graph is not evidence that a nonempty repo has no dependencies', async () => {
  const github = { graph: async () => [], tree: async () => ({ tree: [], truncated: false }) };
  assert.equal((await discoverDependencies(github, { size: 1 })).status, 'not-detected');
  assert.equal((await discoverDependencies(github, { size: 0 })).status, 'empty');
});

test('Bun text lockfiles handle comments, trailing commas, and scoped packages', () => {
  const text = `{
    // committed lockfile
    "workspaces":{"":{"dependencies":{"@scope/pkg":"^1"}}},
    "packages":{"@scope/pkg":["@scope/pkg@1.0.0","",{},"sha"],"extra":["extra@2.0.0","",{}],},
  }`;
  const result = parseManifest('bun.lock', text);
  assert.equal(result.dependencies[0].name, '@scope/pkg');
  assert.equal(result.dependencies[0].relationship, 'direct');
  assert.equal(result.dependencies[1].relationship, 'transitive');
  assert.equal(result.dependencies[0].basis, 'resolved');
});

test('pnpm lockfile parsing supports modern and legacy scoped locators', () => {
  const modern = parseManifest('pnpm-lock.yaml', `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@scope/pkg': {specifier: ^1, version: 1.0.0(peer@2.0.0)}
packages:
  '@scope/pkg@1.0.0': {resolution: {integrity: sha}}
  'other@2.0.0': {resolution: {integrity: sha}}
`);
  assert.equal(modern.dependencies[0].relationship, 'direct');
  assert.equal(modern.dependencies[1].relationship, 'transitive');
  const legacy = parseManifest('pnpm-lock.yaml', "packages:\n  /@scope/pkg/1.0.0_peer@2.0.0: {resolution: {integrity: sha}}\n");
  assert.equal(legacy.dependencies[0].name, '@scope/pkg');
  assert.equal(legacy.dependencies[0].requirement, '1.0.0');
});

test('classic and modern Yarn locks preserve registry package versions', () => {
  const classic = parseManifest('yarn.lock', '# yarn lockfile v1\n\nreact@^18:\n  version "18.1.0"\n  resolved "https://registry.yarnpkg.com/react/-/react-18.1.0.tgz"\n');
  assert.equal(classic.dependencies[0].name, 'react');
  assert.equal(classic.dependencies[0].requirement, '18.1.0');
  const modern = parseManifest('yarn.lock', '__metadata:\n  version: 8\n"@scope/pkg@npm:^1":\n  version: 1.0.0\n  resolution: "@scope/pkg@npm:1.0.0"\n');
  assert.equal(modern.dependencies[0].name, '@scope/pkg');
  assert.equal(modern.dependencies[0].requirement, '1.0.0');
});

test('npm aliases query the real package while retaining their declared name', () => {
  const result = mergeDependencies([{ manager: 'NPM', name: 'compat', requirement: 'npm:@scope/real@^2', basis: 'declared', manifests: ['package.json'] }]);
  assert.equal(result[0].name, '@scope/real');
  assert.equal(result[0].declaredName, 'compat');
  assert.equal(result[0].requirement, '^2');
});
