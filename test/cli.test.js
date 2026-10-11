import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('CLI scans all pages, checkpoints, applies policy before filtering, and resumes offline results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gh-repo-health-test-'));
  try {
    const fakeGh = `#!/usr/bin/env node
const endpoint = process.argv[5];
const repo = { full_name:'owner/app',owner:{login:'owner'},html_url:'https://github.com/owner/app',private:true,archived:false,fork:false,size:0,pushed_at:'2026-01-01',permissions:{push:true} };
let value;
if(endpoint==='user') value={login:'owner'};
else if(endpoint.startsWith('user/repos')) value=[[repo],[{...repo,full_name:'owner/second'}]];
else if(endpoint==='graphql') value={data:{repository:{dependencyGraphManifests:{nodes:[],pageInfo:{hasNextPage:false}}}}};
else if(endpoint.includes('/dependabot/alerts')) value=[[{number:1,dependency:{package:{name:'example',ecosystem:'npm'}},security_vulnerability:{severity:'critical',first_patched_version:{identifier:'2.0.0'}},html_url:'https://github.com/owner/app/security/dependabot/1'}]];
else if(endpoint.includes('/pulls')) { process.exit(0); }
else throw new Error(endpoint);
process.stdout.write(JSON.stringify(value));
`;
    await writeFile(join(directory, 'gh'), fakeGh, { mode: 0o700 });
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: directory, env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8' });
    const first = run(['scan', '--format', 'json', '--only', 'outdated', '--fail-on', 'critical']);
    assert.equal(first.status, 2, first.stderr);
    assert.equal(JSON.parse(first.stdout).repositories.length, 0);
    const report = JSON.parse(await readFile(join(directory, 'reports/latest.json'), 'utf8'));
    assert.equal(report.discoveredCount, 2);
    assert.equal(report.repositories.length, 2);
    assert.equal(report.repositories[0].security.summary.critical, 1);
    assert.equal(report.complete, true);
    assert.equal((await stat(join(directory, 'reports/latest.json'))).mode & 0o777, 0o600);
    const second = run(['scan', '--resume', '--format', 'json']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).repositories.every(repo => repo.reused), true);
    const offline = spawnSync(process.execPath, [cli, 'report', '--format', 'csv'], { cwd: directory, env: { ...process.env, PATH: '/nonexistent' }, encoding: 'utf8' });
    assert.equal(offline.status, 0, offline.stderr);
    assert.match(offline.stdout, /owner\/app/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
