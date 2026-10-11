import { basename } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import yarnLockfile from '@yarnpkg/lockfile';
import { mapLimit } from './util.js';

export const manifestNames = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.toml', 'Cargo.lock',
  'pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'requirements.in',
  'Pipfile', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'go.mod',
]);
const unsupportedNames = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'pubspec.yaml', 'mix.exs', 'Package.swift', 'bun.lockb']);

export function parseManifest(path, text) {
  const dependencies = [];
  const warnings = [];
  const file = basename(path);
  const add = (manager, name, requirement, basis = 'declared', relationship = 'direct', scope = 'runtime') => {
    dependencies.push({ manager, name, requirement: String(requirement ?? ''), basis, relationship, scope, manifests: [path], source: 'manifest' });
  };
  const python = (line, scope) => {
    line = line.trim().replace(/\s+#.*$/, '');
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('-')) {
      warnings.push(`${path}: included requirements, editable packages, and index options are not followed (${line.split(/\s/)[0]}).`);
      return;
    }
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]*\])?\s*(.*)$/);
    if (!match) { warnings.push(`${path}: unsupported Python requirement.`); return; }
    add('pip', match[1], match[2].split(';')[0].replace(/\s+--hash=.*$/, '').trim(), 'declared', 'direct', scope);
  };
  if (file === 'package.json') {
    const data = JSON.parse(text);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(data[section] ?? {})) {
        add('npm', name, version, 'declared', 'direct', section);
      }
    }
  } else if (file === 'bun.lock') {
    const errors = [];
    const data = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length || !data) throw new Error('Invalid Bun text lockfile.');
    const direct = new Set(Object.values(data.workspaces ?? {}).flatMap(workspace =>
      Object.keys({ ...workspace.dependencies, ...workspace.devDependencies, ...workspace.optionalDependencies }),
    ));
    for (const [location, item] of Object.entries(data.packages ?? {})) {
      if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
      const split = item[0].lastIndexOf('@');
      if (split <= 0 || !/^\d/.test(item[0].slice(split + 1))) continue;
      const name = item[0].slice(0, split);
      add('npm', name, item[0].slice(split + 1), 'resolved', direct.has(location) ? 'direct' : 'transitive');
    }
  } else if (file === 'pnpm-lock.yaml') {
    const data = parseYaml(text);
    const direct = new Set();
    for (const importer of Object.values(data.importers ?? { root: data })) {
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, spec] of Object.entries(importer[section] ?? {})) {
          const version = typeof spec === 'string' ? spec : spec.version;
          if (version) {
            const normalized = version.split('(')[0];
            const alias = spec.specifier?.match(/^npm:(@[^/]+\/[^@]+|[^@]+)@/);
            direct.add(alias ? `${alias[1]}@${normalized.replace(`${alias[1]}@`, '')}` : `${name}@${normalized}`);
          }
        }
      }
    }
    for (const [locator, item] of Object.entries(data.packages ?? {})) {
      const key = locator.replace(/^\//, '').split('(')[0];
      const split = key.lastIndexOf('@');
      const legacy = key.match(/^(.+)\/(\d[^/]*)$/);
      let name;
      let version;
      if (legacy) { name = legacy[1]; version = legacy[2].split('_')[0]; }
      else if (split > 0) { name = key.slice(0, split); version = key.slice(split + 1); }
      else { const slash = key.lastIndexOf('/'); name = key.slice(0, slash); version = key.slice(slash + 1).split('_')[0]; }
      name = item.name ?? name;
      version = item.version ?? version;
      if (!name || !/^\d/.test(version ?? '')) continue;
      add('npm', name, version, 'resolved', direct.has(`${name}@${version}`) ? 'direct' : 'transitive', item.dev ? 'development' : 'runtime');
    }
  } else if (file === 'yarn.lock') {
    let entries;
    const modern = /(?:^|\n)__metadata:/.test(text);
    if (modern) entries = parseYaml(text);
    else {
      const parsed = yarnLockfile.parse(text);
      if (parsed.type !== 'success') throw new Error('Unparseable or conflicted Yarn lockfile.');
      entries = parsed.object;
    }
    for (const [locator, item] of Object.entries(entries)) {
      if (locator === '__metadata' || !item.version) continue;
      if (modern && !item.resolution?.includes('@npm:')) continue;
      const selector = modern ? item.resolution.split('@npm:')[0] : locator.split(/,\s*/)[0];
      const separator = selector.indexOf('@', selector.startsWith('@') ? 1 : 0);
      const name = modern ? selector : selector.slice(0, separator);
      if (name) add('npm', name, item.version, 'resolved', 'unknown');
    }
  } else if (file === 'package-lock.json' || file === 'npm-shrinkwrap.json') {
    const data = JSON.parse(text);
    if (data.packages) {
      const direct = new Set(Object.entries(data.packages).filter(([location]) => !location.includes('node_modules/'))
        .flatMap(([, p]) => Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.optionalDependencies })));
      for (const [location, item] of Object.entries(data.packages)) {
        if (!location.includes('node_modules/') || !item.version || item.link) continue;
        const name = item.name ?? location.split('node_modules/').at(-1);
        add('npm', name, item.version, 'resolved', direct.has(name) && location === `node_modules/${name}` ? 'direct' : 'unknown', item.dev ? 'development' : 'runtime');
      }
    } else {
      const visit = (entries, depth = 0) => {
        for (const [name, item] of Object.entries(entries ?? {})) {
          if (item.version) add('npm', name, item.version, 'resolved', depth === 0 ? 'direct' : 'transitive', item.dev ? 'development' : 'runtime');
          visit(item.dependencies, depth + 1);
        }
      };
      visit(data.dependencies);
    }
  } else if (file === 'Pipfile.lock') {
    const data = JSON.parse(text);
    for (const section of ['default', 'develop']) {
      for (const [name, item] of Object.entries(data[section] ?? {})) {
        if (item.version) add('pip', name, item.version, 'resolved', 'unknown', section);
        else warnings.push(`${path}: ${name} has no registry version.`);
      }
    }
  } else if (file.startsWith('requirements')) {
    for (const line of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) python(line, file.includes('dev') ? 'development' : 'runtime');
  } else if (file === 'go.mod') {
    let inRequire = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (/^require\s*\(/.test(line)) { inRequire = true; continue; }
      if (line === ')') { inRequire = false; continue; }
      const match = (inRequire ? line : line.replace(/^require\s+/, '')).match(/^(\S+)\s+(v\S+)(?:\s|$)/);
      if (match) add('go', match[1], match[2], 'resolved', line.includes('// indirect') ? 'transitive' : 'direct');
      if (/^replace\s/.test(line)) warnings.push(`${path}: Go replace directives require manual verification.`);
    }
  } else {
    const data = parseToml(text);
    if (file === 'Cargo.lock') {
      for (const item of data.package ?? []) {
        if (item.source?.startsWith('registry+')) add('cargo', item.name, item.version, 'resolved', 'unknown');
      }
    } else if (file === 'Cargo.toml') {
      const sections = [data, ...Object.values(data.target ?? {}), data.workspace ?? {}];
      for (const container of sections) {
        for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
          for (const [name, spec] of Object.entries(container[section] ?? {})) {
            if (typeof spec === 'string') add('cargo', name, spec, 'declared', 'direct', section);
            else if (spec.version) add('cargo', spec.package ?? name, spec.version, 'declared', 'direct', section);
            else warnings.push(`${path}: ${name} is a workspace, path, or Git dependency.`);
          }
        }
      }
    } else if (file === 'poetry.lock' || file === 'uv.lock') {
      for (const item of data.package ?? []) {
        if (item.source?.type === 'git' || item.source?.editable || item.source?.virtual) continue;
        if (item.version) add('pip', item.name, item.version, 'resolved', 'unknown');
      }
    } else if (file === 'Pipfile') {
      for (const section of ['packages', 'dev-packages']) {
        for (const [name, spec] of Object.entries(data[section] ?? {})) {
          if (typeof spec === 'string') add('pip', name, spec, 'declared', 'direct', section);
          else if (spec.version) add('pip', name, spec.version, 'declared', 'direct', section);
          else warnings.push(`${path}: ${name} has no registry version.`);
        }
      }
    } else if (file === 'pyproject.toml') {
      for (const line of data.project?.dependencies ?? []) python(line, 'runtime');
      for (const group of Object.values(data.project?.['optional-dependencies'] ?? {})) for (const line of group) python(line, 'optional');
      for (const group of Object.values(data['dependency-groups'] ?? {})) {
        for (const line of group) {
          if (typeof line === 'string') python(line, 'development');
          else warnings.push(`${path}: dependency group includes are not expanded.`);
        }
      }
      const poetry = data.tool?.poetry;
      const groups = [poetry?.dependencies, poetry?.['dev-dependencies'], ...Object.values(poetry?.group ?? {}).map(group => group.dependencies)];
      for (const group of groups) {
        for (const [name, spec] of Object.entries(group ?? {})) {
          if (name === 'python') continue;
          const version = typeof spec === 'string' ? spec : spec.version;
          if (version) add('pip', name, version);
          else warnings.push(`${path}: ${name} has no registry version.`);
        }
      }
    }
  }
  return { dependencies, warnings };
}

export function mergeDependencies(dependencies) {
  const grouped = new Map();
  for (let dependency of dependencies) {
    const alias = dependency.manager?.toLowerCase() === 'npm' && dependency.requirement?.match(/^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/);
    if (alias) dependency = { ...dependency, declaredName: dependency.name, name: alias[1], requirement: alias[2] };
    const key = `${dependency.manager?.toLowerCase()}:${dependency.name}:${dependency.requirement}:${dependency.basis}`;
    const previous = grouped.get(key);
    if (previous) {
      previous.manifests = [...new Set([...previous.manifests, ...dependency.manifests])];
      if (dependency.relationship === 'direct') previous.relationship = 'direct';
    } else grouped.set(key, { ...dependency });
  }
  return [...grouped.values()];
}

export async function discoverDependencies(github, repo) {
  const warnings = [];
  let graphError;
  let graph = [];
  try { graph = await github.graph(repo); }
  catch (error) { graphError = error.message; }
  const dependencies = graph.flatMap(manifest => {
    if (!manifest.parseable || manifest.exceedsMaxSize || manifest.dependencies.length < manifest.dependenciesCount) {
      warnings.push(`GitHub could not fully parse ${manifest.filename}.`);
    }
    return manifest.dependencies.map(dependency => ({
      manager: dependency.packageManager, name: dependency.packageName, requirement: dependency.requirements,
      relationship: dependency.relationship, basis: 'github', manifests: [manifest.filename], source: 'github-dependency-graph',
    }));
  });
  if (dependencies.length && !warnings.length) return { dependencies: mergeDependencies(dependencies), source: 'github-dependency-graph', warnings, status: 'checked' };
  try {
    const tree = await github.tree(repo);
    if (tree.truncated) warnings.push('GitHub truncated the repository tree; some manifests may be missing.');
    const files = tree.tree.filter(entry => entry.type === 'blob' && !/(^|\/)(node_modules|vendor|\.git)\//.test(entry.path));
    for (const file of files) {
      if (unsupportedNames.has(basename(file.path)) || /\.(csproj|fsproj)$/.test(file.path)) warnings.push(`${file.path}: freshness requires a populated GitHub dependency graph for this ecosystem.`);
    }
    const manifests = files.filter(entry => manifestNames.has(basename(entry.path)));
    const parsed = await mapLimit(manifests, 2, async entry => {
      try {
        if (entry.size > 10 * 1024 * 1024) throw new Error('Manifest exceeds the 10 MB parsing limit.');
        return { path: entry.path, ...parseManifest(entry.path, await github.file(repo, entry)) };
      } catch (error) {
        return { path: entry.path, dependencies: [], warnings: [`${entry.path}: ${error.message}`] };
      }
    });
    for (const item of parsed) warnings.push(...item.warnings);
    const locks = [];
    for (const item of parsed) {
      if (!item.dependencies.some(d => d.basis === 'resolved')) continue;
      const directory = item.path.slice(0, -basename(item.path).length);
      locks.push({ directory, names: new Set(item.dependencies.filter(d => d.basis === 'resolved').map(d => `${d.manager}:${d.name}`)) });
    }
    for (const item of parsed) {
      const directory = item.path.slice(0, -basename(item.path).length);
      dependencies.push(...item.dependencies.filter(d => d.basis === 'resolved' ||
        !locks.some(lock => directory.startsWith(lock.directory) && lock.names.has(`${d.manager}:${d.name}`))));
    }
    if (graphError) warnings.push(`Dependency graph unavailable: ${graphError}`);
    return {
      dependencies: mergeDependencies(dependencies), source: 'manifest-fallback', warnings,
      status: dependencies.length ? 'partial' : warnings.length || manifests.length ? 'incomplete' : repo.size === 0 ? 'empty' : 'not-detected',
      note: 'Fallback compares supported manifests and lockfiles; transitive and ecosystem coverage may be incomplete. Ranges use the highest allowed release, not an installed version.',
    };
  } catch (error) {
    return { dependencies: mergeDependencies(dependencies), source: 'github-dependency-graph', warnings: [...warnings, graphError, error.message].filter(Boolean), status: 'unavailable' };
  }
}
