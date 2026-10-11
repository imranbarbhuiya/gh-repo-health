import { setTimeout as delay } from 'node:timers/promises';

const systems = {
  npm: 'NPM', pip: 'PYPI', pypi: 'PYPI', cargo: 'CARGO', rust: 'CARGO',
  go: 'GO', gomod: 'GO', maven: 'MAVEN', nuget: 'NUGET', rubygems: 'RUBYGEMS',
};

export function packageKey(manager, name) {
  const system = systems[manager?.toLowerCase()];
  if (!system) return null;
  if (system === 'PYPI') name = name.toLowerCase().replace(/[-_.]+/g, '-');
  if (system === 'NUGET') name = name.toLowerCase();
  return { system, name, key: `${system}:${name}` };
}

export class Registry {
  constructor(cache = {}, { cacheHours = 24, fetcher = fetch } = {}) {
    this.cache = cache;
    this.cacheHours = cacheHours;
    this.fetcher = fetcher;
    this.pending = new Map();
  }

  async get(manager, name) {
    const key = packageKey(manager, name);
    if (!key) return null;
    const saved = this.cache[key.key];
    if (saved && Date.now() - Date.parse(saved.fetchedAt) < this.cacheHours * 3_600_000) return saved.data;
    if (!this.pending.has(key.key)) this.pending.set(key.key, this.load(key));
    return this.pending.get(key.key);
  }

  async load(key) {
    const url = `https://api.deps.dev/v3/systems/${key.system}/packages/${encodeURIComponent(key.name)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.fetcher(url, {
          signal: AbortSignal.timeout(20_000),
          headers: { Accept: 'application/json', 'User-Agent': 'gh-repo-health/1.0' },
        });
        if (!response.ok) {
          if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
            await delay(1000 * 2 ** attempt);
            continue;
          }
          throw new Error(`Package metadata unavailable (HTTP ${response.status}); package may be private or absent from deps.dev.`);
        }
        const body = await response.json();
        if (!Array.isArray(body.versions)) throw new Error('Invalid package metadata response.');
        const data = {
          source: url,
          fetchedAt: new Date().toISOString(),
          versions: body.versions.map(v => ({
            version: v.versionKey.version, publishedAt: v.publishedAt ?? null,
            isDefault: v.isDefault === true, isDeprecated: v.isDeprecated === true,
            deprecatedReason: v.deprecatedReason ?? null,
          })),
        };
        this.cache[key.key] = { fetchedAt: data.fetchedAt, data };
        return data;
      } catch (error) {
        if (attempt < 2 && /fetch failed|timeout|network/i.test(error.message)) {
          await delay(1000 * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }
  }
}
