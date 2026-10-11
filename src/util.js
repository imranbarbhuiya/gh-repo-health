import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function clean(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function mapLimit(items, concurrency, work) {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await work(items[index], index);
    }
  }));
  return result;
}

export function daysSince(date, now = Date.now()) {
  if (!date || !Number.isFinite(Date.parse(date))) return null;
  return Math.max(0, Math.floor((now - Date.parse(date)) / 86_400_000));
}

export function permission(repo) {
  return ['admin', 'maintain', 'push', 'triage', 'pull'].find(key => repo.permissions?.[key]) ?? 'unknown';
}
