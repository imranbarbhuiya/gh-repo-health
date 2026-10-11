import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clean, writeJson } from './util.js';
import { loadDashboard } from './dashboard.js';
import { snapshotHtml } from './snapshot.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/model.js', ['model.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const assetRoot = fileURLToPath(new URL('../dashboard/', import.meta.url));
const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

export function scanArguments(body, data, reportDir) {
  if (!body || !['scan', 'inventory'].includes(body.action)) throw new Error('Choose scan or inventory.');
  const args = [cliPath, body.action === 'inventory' ? 'list' : 'scan', '--report-dir', reportDir, '--host', data.host];
  if (body.action === 'inventory') return args;
  if (body.repos !== undefined) {
    if (!Array.isArray(body.repos) || !body.repos.length || body.repos.length > 2000) throw new Error('Select at least one repository.');
    const allowed = new Set(data.repositories.map(repo => repo.name));
    for (const name of [...new Set(body.repos)]) {
      if (typeof name !== 'string' || !allowed.has(name)) throw new Error('A selected repository is outside the current inventory. Refresh the inventory.');
      args.push('--repo', name);
    }
  }
  if (body.directOnly === true) args.push('--direct-only');
  if (body.codeScanning === true) args.push('--code-scanning');
  if (body.resume === true) args.push('--resume');
  return args;
}

export function createDashboardServer({ reportDir, publicUrl, launch = spawn } = {}) {
  reportDir = resolve(reportDir ?? 'reports');
  const token = randomBytes(32).toString('hex');
  let child = null;
  let starting = false;
  let job = null;
  let saving = Promise.resolve();
  const saveHistory = async () => {
    const data = await loadDashboard(reportDir);
    await writeJson(resolve(reportDir, 'history.json'), {
      schemaVersion: 1, host: data.host, user: data.user,
      repositories: data.repositories.filter(repo => repo.audit).map(repo => repo.audit),
    });
  };
  const send = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host = request.headers.host;
    const configured = publicUrl ? new URL(publicUrl).host : null;
    const address = server.address();
    const allowed = new Set([configured, `localhost:${address?.port}`, `127.0.0.1:${address?.port}`, `[::1]:${address?.port}`]);
    if (!allowed.has(host)) return send(response, 403, { error: 'This dashboard only accepts its local address.' });
    try {
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/api/data') {
        await saving;
        return send(response, 200, { ...(await loadDashboard(reportDir)), job, token });
      }
      if (request.method === 'GET' && url.pathname === '/api/snapshot') {
        await saving;
        const html = await snapshotHtml(await loadDashboard(reportDir));
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return response.end(html);
      }
      if (request.method === 'POST' && ['/api/scan', '/api/cancel'].includes(url.pathname)) {
        const origin = request.headers.origin;
        const parsedOrigin = URL.parse(origin ?? '');
        const sameOrigin = parsedOrigin && parsedOrigin.host === host && ['http:', 'https:'].includes(parsedOrigin.protocol);
        if (!sameOrigin || request.headers['x-dashboard-token'] !== token) return send(response, 403, { error: 'Reload this dashboard before starting a scan.' });
        if (url.pathname === '/api/cancel') {
          if (child) { job.status = 'stopping'; child.kill('SIGINT'); }
          return send(response, 200, { job });
        }
        if (child || starting) return send(response, 409, { error: 'A scan is already running.' });
        starting = true;
        try {
          let text = '';
          for await (const chunk of request) {
            text += chunk;
            if (Buffer.byteLength(text) > 256 * 1024) return send(response, 413, { error: 'Scan selection is too large.' });
          }
          let body;
          try { body = JSON.parse(text); }
          catch { return send(response, 400, { error: 'Invalid scan request.' }); }
          await saving;
          const data = await loadDashboard(reportDir);
          let args;
          try { args = scanArguments(body, data, reportDir); }
          catch (error) { return send(response, 400, { error: error.message }); }
          await saveHistory();
          job = {
            action: body.action, status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
            completed: 0, total: body.action === 'inventory' ? 0 : body.repos ? new Set(body.repos).size : data.repositories.length,
            lastMessage: body.action === 'inventory' ? 'Refreshing repository access…' : 'Discovering repositories…', error: null,
          };
          child = launch(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
          let buffer = '';
          child.stderr.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              job.lastMessage = clean(line).slice(0, 1000);
              const progress = line.match(/^\[(\d+)\/(\d+)\]/);
              if (progress) { job.completed = Number(progress[1]); job.total = Number(progress[2]); }
            }
          });
          child.once('error', error => { job.error = clean(error.message); });
          child.once('close', code => {
            const stopped = job.status === 'stopping';
            job.status = stopped ? 'cancelled' : code === 0 || code === 2 ? 'completed' : 'failed';
            job.finishedAt = new Date().toISOString();
            if (job.status === 'failed') job.error = job.error ?? job.lastMessage;
            child = null;
            saving = saveHistory().catch(error => { job.error = clean(error.message); job.status = 'failed'; });
          });
          return send(response, 202, { job });
        } finally { starting = false; }
      }
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': type });
        response.end(await readFile(resolve(assetRoot, file)));
        return;
      }
      return send(response, 404, { error: 'Not found.' });
    } catch (error) {
      if (!response.headersSent) send(response, 500, { error: clean(error.message) });
      else response.end();
    }
  });
  server.on('close', () => { if (child) child.kill('SIGINT'); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('Start the dashboard with npm run dashboard (Portless assigns its port).\n');
    process.exitCode = 1;
  } else {
    const server = createDashboardServer({ reportDir: process.env.REPORT_DIR, publicUrl: process.env.PORTLESS_URL });
    server.listen(port, '127.0.0.1', () => process.stdout.write(`Repository dashboard: ${process.env.PORTLESS_URL ?? `http://127.0.0.1:${port}`}\nReports: ${resolve(process.env.REPORT_DIR ?? 'reports')}\n`));
    server.once('error', error => { process.stderr.write(`${clean(error.message)}\n`); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  }
}
