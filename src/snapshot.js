import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadDashboard } from './dashboard.js';

const assetRoot = fileURLToPath(new URL('../dashboard/', import.meta.url));

export async function snapshotHtml(data) {
  const [html, css, model, app] = await Promise.all(['index.html', 'styles.css', 'model.js', 'app.js'].map(file => readFile(resolve(assetRoot, file), 'utf8')));
  const { token, job, ...report } = data;
  const json = JSON.stringify(report).replaceAll('<', '\\u003c');
  const script = `${model.replace(/^export /gm, '')}\n${app.replace(/^import .*?;\n/, '')}`.replace(/<\/script/gi, '<\\/script');
  return html
    .replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`)
    .replace('<script type="module" src="/app.js"></script>', '')
    .replace('class="brand" href="/"', 'class="brand" href="#main"')
    .replace('</body>', `<script type="application/json" id="snapshot-data">${json}</script>\n<script type="module">${script}</script>\n</body>`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'report-dir': { type: 'string', default: 'reports' }, output: { type: 'string', default: 'reports/dashboard.html' } } });
    const output = resolve(values.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, await snapshotHtml(await loadDashboard(resolve(values['report-dir']))), { mode: 0o600 });
    process.stdout.write(`Saved dashboard: ${output}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
