import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry, packageKey } from '../src/registry.js';

test('scoped package URLs are encoded and metadata lookups are shared', async () => {
  let calls = 0;
  const registry = new Registry({}, { fetcher: async url => {
    calls++;
    assert.equal(url, 'https://api.deps.dev/v3/systems/NPM/packages/%40scope%2Fname');
    return { ok: true, json: async () => ({ versions: [{ versionKey: { version: '1.0.0' }, isDefault: true }] }) };
  } });
  const [a, b] = await Promise.all([registry.get('npm', '@scope/name'), registry.get('npm', '@scope/name')]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.versions[0].version, '1.0.0');
});

test('fresh metadata cache avoids requests and failures do not become zero versions', async () => {
  const data = { versions: [{ version: '1.0.0', isDefault: true }] };
  const registry = new Registry({ 'NPM:example': { fetchedAt: new Date().toISOString(), data } }, { fetcher: async () => { throw new Error('unexpected network call'); } });
  assert.equal(await registry.get('npm', 'example'), data);
  const absent = new Registry({}, { fetcher: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(absent.get('npm', 'private-package'), /private or absent/);
  assert.deepEqual(absent.cache, {});
});

test('ecosystem package names are normalized without lossy Go path changes', () => {
  assert.equal(packageKey('pip', 'My.Package_name').name, 'my-package-name');
  assert.equal(packageKey('nuget', 'Newtonsoft.Json').name, 'newtonsoft.json');
  assert.equal(packageKey('go', 'example.com/Foo/v2').name, 'example.com/Foo/v2');
  assert.equal(packageKey('actions', 'actions/checkout'), null);
});
