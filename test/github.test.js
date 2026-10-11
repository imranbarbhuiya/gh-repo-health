import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.js';

test('inventory requests all affiliations and all pages without a search cap', async () => {
  let received;
  const github = new GitHub('github.com', async (command, args) => {
    received = { command, args };
    return { stdout: JSON.stringify([[{ full_name: 'a/one' }], [{ full_name: 'org/two' }]]) };
  });
  assert.equal((await github.repositories()).length, 2);
  assert.equal(received.command, 'gh');
  assert.ok(received.args.some(arg => arg.includes('owner,collaborator,organization_member')));
  assert.ok(received.args.includes('--paginate'));
  assert.ok(received.args.includes('--slurp'));
});

test('graph paginates both manifests and dependencies', async () => {
  const calls = [];
  const github = new GitHub();
  github.api = async (_, { fields }) => {
    calls.push(fields);
    if (fields.id) return { data: { node: { dependencies: { nodes: [{ packageName: 'second' }], pageInfo: { hasNextPage: false } } } } };
    if (fields.cursor) return { data: { repository: { dependencyGraphManifests: { nodes: [], pageInfo: { hasNextPage: false } } } } };
    return { data: { repository: { dependencyGraphManifests: {
      nodes: [{ id: 'manifest-1', filename: 'package.json', dependencies: { nodes: [{ packageName: 'first' }], pageInfo: { hasNextPage: true, endCursor: 'dependency-next' } } }],
      pageInfo: { hasNextPage: true, endCursor: 'manifest-next' },
    } } } };
  };
  const result = await github.graph({ full_name: 'owner/repo' });
  assert.equal(result[0].dependencies.length, 2);
  assert.equal(calls[1].cursor, 'dependency-next');
  assert.equal(calls[2].cursor, 'manifest-next');
});

test('security denial is unavailable, not zero', async () => {
  const github = new GitHub('github.com', async () => { throw Object.assign(new Error('denied'), { stderr: 'gh: Resource not accessible (HTTP 403)' }); });
  await assert.rejects(github.alerts({ full_name: 'owner/repo' }), error => error.status === 'unavailable');
});

test('rate limit stops later requests instead of hammering GitHub', async () => {
  let calls = 0;
  const github = new GitHub('github.com', async () => { calls++; throw Object.assign(new Error('limit'), { stderr: 'gh: API rate limit exceeded (HTTP 403)' }); });
  await assert.rejects(github.api('user'), error => error.status === 'rate-limited');
  await assert.rejects(github.api('user/repos'), error => error.status === 'rate-limited');
  assert.equal(calls, 1);
});

test('update PR projection parses newline JSON across pages', async () => {
  const github = new GitHub('github.com', async (_, args) => {
    assert.ok(args.includes('--paginate'));
    assert.ok(!args.includes('--slurp'));
    return { stdout: '{"number":1,"title":"Update a"}\n{"number":2,"title":"Update b"}\n' };
  });
  assert.equal((await github.updatePulls({ full_name: 'owner/repo' })).length, 2);
});
