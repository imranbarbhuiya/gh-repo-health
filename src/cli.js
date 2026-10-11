#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { GitHub } from './github.js';
import { Registry } from './registry.js';
import { auditRepository, failsPolicy, selectRepositories } from './audit.js';
import { inventoryTable, render } from './report.js';
import { clean, mapLimit, readJson, writeJson } from './util.js';

const help = `gh-repo-health — dependency and security inventory using your gh login

Usage:
  gh-repo-health list [options]
  gh-repo-health scan [options]              Default command
  gh-repo-health report [reports/latest.json] [options]

Examples:
  gh-repo-health list
  gh-repo-health scan --only outdated
  gh-repo-health scan --owner YOUR_LOGIN --exclude-forks --details
  gh-repo-health scan --repo owner/name --repo org/another --code-scanning
  gh-repo-health scan --resume --fail-on critical,incomplete
  gh-repo-health report --only critical --format markdown --output critical.md

Selection:
  --repo OWNER/NAME          Repeat to select specific repositories
  --owner LOGIN             Select an owner or organization
  --visibility TYPE         public, private, or internal
  --exclude-archived         Default includes archived repositories
  --exclude-forks            Default includes forks
  --limit N                 Explicitly limit the scan; default scans all

Audit:
  --major-gap N             Severe when this many major versions behind (2)
  --outdated-days N         Severe when a newer release has existed this long (180)
  --stale-pr-days N         Mark update PRs stale after this age (30)
  --direct-only             Exclude known transitive dependencies; keep unknown relationships
  --code-scanning            Also fetch GitHub code scanning alerts
  --concurrency N           Parallel repositories, 1–8 (2)
  --registry-concurrency N  Parallel metadata lookups per repository, 1–16 (6)
  --cache-hours N           Metadata and resume freshness in hours (24); 0 disables
  --resume                  Reuse successful recent results with matching settings/push date
  --host HOST               GitHub hostname (GH_HOST or github.com)

Reports:
  --only FILTER             all, actionable, critical, outdated, incomplete (all)
                            outdated selects SEVERELY outdated repositories
  --format FORMAT           table, json, csv, markdown (table)
  --details                 Include all dependencies, alerts, update PRs, and coverage errors
  --output FILE             Export selected output; otherwise print to stdout
  --report-dir DIRECTORY    Inventory, checkpoint, and metadata cache folder (reports)
  --fail-on RULES           Exit 2 on critical, high, outdated, incomplete (comma separated)
                            Evaluates the entire scan, independent of --only
  --help                    Show help

Exit codes: 0 completed; 1 command/authentication/scan interruption; 2 policy failed.
The tool reads GitHub data and public package metadata. It never installs repo
dependencies, executes repo code, opens PRs, or modifies GitHub settings.
`;

export function parseOptions(args) {
  const definitions = {
    repo: { type: 'string', multiple: true }, owner: { type: 'string' }, visibility: { type: 'string' },
    'exclude-archived': { type: 'boolean' }, 'exclude-forks': { type: 'boolean' }, limit: { type: 'string' },
    'major-gap': { type: 'string', default: '2' }, 'outdated-days': { type: 'string', default: '180' },
    'stale-pr-days': { type: 'string', default: '30' }, 'direct-only': { type: 'boolean' },
    'code-scanning': { type: 'boolean' }, concurrency: { type: 'string', default: '2' },
    'registry-concurrency': { type: 'string', default: '6' }, 'cache-hours': { type: 'string', default: '24' },
    resume: { type: 'boolean' }, host: { type: 'string', default: process.env.GH_HOST ?? 'github.com' },
    only: { type: 'string', default: 'all' }, format: { type: 'string', default: 'table' },
    details: { type: 'boolean' }, output: { type: 'string' },
    'report-dir': { type: 'string', default: 'reports' }, 'fail-on': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  };
  const { values, positionals } = parseArgs({ args, options: definitions, allowPositionals: true, strict: true });
  const command = positionals[0] ?? 'scan';
  if (!['scan', 'list', 'report'].includes(command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  if (positionals.length > (command === 'report' ? 2 : 1)) throw new Error('Unexpected positional arguments. Use --help.');
  const options = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value]));
  for (const [key, minimum, maximum] of [
    ['majorGap', 1, Infinity], ['outdatedDays', 1, Infinity], ['stalePrDays', 1, Infinity],
    ['concurrency', 1, 8], ['registryConcurrency', 1, 16], ['limit', 1, Infinity],
  ]) {
    if (options[key] === undefined) continue;
    options[key] = Number(options[key]);
    if (!Number.isSafeInteger(options[key]) || options[key] < minimum || options[key] > maximum) throw new Error(`Invalid --${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)} value.`);
  }
  options.cacheHours = Number(options.cacheHours);
  if (!Number.isFinite(options.cacheHours) || options.cacheHours < 0) throw new Error('--cache-hours must be a nonnegative number.');
  if (!['table', 'json', 'csv', 'markdown'].includes(options.format)) throw new Error('Invalid --format.');
  if (!['all', 'actionable', 'critical', 'outdated', 'incomplete'].includes(options.only)) throw new Error('Invalid --only.');
  if (options.visibility && !['public', 'private', 'internal'].includes(options.visibility)) throw new Error('Invalid --visibility.');
  if (!/^[a-zA-Z0-9.-]+$/.test(options.host)) throw new Error('Invalid GitHub hostname.');
  for (const repo of options.repo ?? []) if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Invalid repository name: ${clean(repo)}.`);
  options.failOn = options.failOn ? options.failOn.split(',') : [];
  if (options.failOn.some(rule => !['critical', 'high', 'outdated', 'incomplete'].includes(rule))) throw new Error('Invalid --fail-on rule.');
  options.reportDir = resolve(options.reportDir);
  return { command, file: positionals[1], options };
}

async function emit(content, output) {
  if (output) {
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o600 });
    process.stderr.write(`Saved ${path}\n`);
  } else process.stdout.write(content);
}

function normalizedRepo(repo) {
  return {
    full_name: repo.full_name, owner: { login: repo.owner.login }, html_url: repo.html_url,
    visibility: repo.visibility, private: repo.private, permissions: repo.permissions,
    language: repo.language, archived: repo.archived, fork: repo.fork,
    default_branch: repo.default_branch, pushed_at: repo.pushed_at, size: repo.size,
  };
}

export async function main(args = process.argv.slice(2)) {
  const { command, file, options } = parseOptions(args);
  if (options.help) { process.stdout.write(help); return 0; }
  const reportPath = resolve(options.reportDir, 'latest.json');
  if (command === 'report') {
    const report = await readJson(resolve(file ?? reportPath), null);
    if (!report || report.schemaVersion !== 1 || !Array.isArray(report.repositories)) throw new Error('No valid report found. Run scan first.');
    await emit(render(report, options), options.output);
    return !report.complete ? 1 : failsPolicy(report.repositories, options.failOn) ? 2 : 0;
  }
  const github = new GitHub(options.host);
  const identity = await github.api('user');
  process.stderr.write(`Discovering repositories for ${clean(identity.login)} on ${options.host}…\n`);
  const inventory = (await github.repositories()).map(normalizedRepo);
  const selected = selectRepositories(inventory, options);
  await writeJson(resolve(options.reportDir, 'inventory.json'), {
    schemaVersion: 1, generatedAt: new Date().toISOString(), host: options.host, user: identity.login,
    discoveredCount: inventory.length, selectedCount: selected.length, repositories: inventory,
  });
  process.stderr.write(`Found ${inventory.length} accessible repositories; selected ${selected.length}.\n`);
  if (command === 'list') {
    if (options.format !== 'table' && options.format !== 'json') throw new Error('list supports --format table or json. Use scan/report for CSV and Markdown.');
    await emit(options.format === 'json' ? `${JSON.stringify(selected, null, 2)}\n` : `${inventoryTable(selected)}\n`, options.output);
    return 0;
  }
  const cachePath = resolve(options.reportDir, 'metadata-cache.json');
  const cache = await readJson(cachePath, {});
  const registry = new Registry(cache, options);
  const settings = {
    majorGap: options.majorGap, outdatedDays: options.outdatedDays, stalePrDays: options.stalePrDays,
    directOnly: options.directOnly === true, codeScanning: options.codeScanning === true,
  };
  const previous = options.resume ? await readJson(reportPath, null) : null;
  const compatible = previous?.schemaVersion === 1 && previous.host === options.host && previous.user === identity.login && JSON.stringify(previous.settings) === JSON.stringify(settings);
  const saved = new Map(compatible ? previous.repositories.map(repo => [repo.full_name, repo]) : []);
  const report = {
    schemaVersion: 1, host: options.host, user: identity.login, startedAt: new Date().toISOString(),
    completedAt: null, complete: false, discoveredCount: inventory.length, selectedCount: selected.length,
    settings, repositories: [],
  };
  let writing = Promise.resolve();
  let stopping = false;
  const onInterrupt = () => { stopping = true; process.stderr.write('Stopping after active repository checks; checkpoint will be saved.\n'); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  const results = new Array(selected.length);
  const checkpoint = () => {
    const snapshot = { ...report, repositories: results.filter(Boolean) };
    writing = writing.then(() => writeJson(reportPath, snapshot));
    return writing;
  };
  await checkpoint();
  try {
    await mapLimit(selected, options.concurrency, async (repo, index) => {
      if (stopping || github.blocked) return;
      const reused = saved.get(repo.full_name);
      const reusable = reused && reused.security.status === 'checked' && reused.updatePulls.status === 'checked' &&
        !reused.freshness.dependencies.some(dep => dep.status === 'unavailable') &&
        (!options.codeScanning || reused.codeScanning?.status === 'checked') &&
        !['error', 'unavailable'].includes(reused.freshness.status) &&
        reused.pushedAt === repo.pushed_at && Date.now() - Date.parse(reused.scannedAt) < options.cacheHours * 3_600_000;
      results[index] = reusable ? { ...reused, reused: true } : await auditRepository(repo, github, registry, options);
      await checkpoint();
      process.stderr.write(`[${results.filter(Boolean).length}/${selected.length}] ${clean(repo.full_name)}: ${results[index].priority}${reusable ? ' (cached)' : ''}\n`);
    });
    report.repositories = results.filter(Boolean);
    report.complete = !stopping && !github.blocked && report.repositories.length === selected.length;
    report.completedAt = report.complete ? new Date().toISOString() : null;
    if (github.blocked) report.interruption = github.blocked.message;
    await writing;
    await writeJson(cachePath, registry.cache);
    await writeJson(reportPath, report);
    await emit(render(report, options), options.output);
    process.stderr.write(`Full JSON report: ${reportPath}\n`);
    if (github.blocked) process.stderr.write(`${github.blocked.message}\n`);
    return !report.complete ? 1 : failsPolicy(report.repositories, options.failOn) ? 2 : 0;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`Error: ${clean(error.message)}\n`);
    process.exitCode = 1;
  });
}
