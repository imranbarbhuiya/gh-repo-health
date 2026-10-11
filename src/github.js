import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { clean } from './util.js';

const execute = promisify(execFile);
const dependencyFields = `nodes { packageName packageManager requirements relationship }
  pageInfo { hasNextPage endCursor }`;

export class GitHubError extends Error {
  constructor(message, status = 'unavailable') {
    super(message);
    this.status = status;
  }
}

export class GitHub {
  constructor(host = 'github.com', run = execute) {
    this.host = host;
    this.run = run;
    this.blocked = null;
  }

  async api(endpoint, { paginate = false, fields = {}, projection } = {}) {
    if (this.blocked) throw this.blocked;
    const args = ['api', '--hostname', this.host, endpoint];
    if (endpoint !== 'graphql') args.push('--method', 'GET', '-H', 'Accept: application/vnd.github+json');
    if (paginate) args.push('--paginate', ...(projection ? [] : ['--slurp']));
    if (projection) args.push('--jq', projection);
    for (const [name, value] of Object.entries(fields)) {
      if (value !== null && value !== undefined) args.push('-f', `${name}=${value}`);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { stdout } = await this.run('gh', args, {
          encoding: 'utf8', timeout: 90_000, maxBuffer: 128 * 1024 * 1024,
          env: { ...process.env, GH_PROMPT_DISABLED: '1' },
        });
        const data = projection
          ? stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
          : JSON.parse(stdout);
        if (data.errors?.length) throw new GitHubError(data.errors.map(e => clean(e.message)).join('; '));
        return paginate && !projection ? data.flat() : data;
      } catch (error) {
        if (error instanceof GitHubError) throw error;
        const message = clean(error.stderr || error.message).slice(0, 800);
        if (error.code === 'ENOENT') throw new GitHubError('GitHub CLI is missing. Install gh and run gh auth login.', 'authentication');
        if (/rate limit|abuse detection|HTTP 429/i.test(message)) {
          this.blocked = new GitHubError(`GitHub rate limit reached. Resume after it resets. ${message}`, 'rate-limited');
          throw this.blocked;
        }
        if (/HTTP 401|authentication|gh auth login/i.test(message)) {
          this.blocked = new GitHubError(`GitHub authentication failed. Run gh auth login --hostname ${this.host}. ${message}`, 'authentication');
          throw this.blocked;
        }
        if (attempt < 2 && /HTTP 50[234]|ETIMEDOUT|ECONNRESET|connection reset|unexpected end of JSON/i.test(message)) {
          await delay(1000 * 2 ** attempt);
          continue;
        }
        throw new GitHubError(message, /HTTP 403|HTTP 404/i.test(message) ? 'unavailable' : 'error');
      }
    }
  }

  async repositories() {
    return this.api('user/repos?affiliation=owner,collaborator,organization_member&visibility=all&per_page=100&sort=full_name', { paginate: true });
  }

  async graph(repo) {
    const [owner, name] = repo.full_name.split('/');
    const manifests = [];
    let cursor;
    do {
      const result = await this.api('graphql', {
        fields: {
          query: `query($owner:String!,$name:String!,$cursor:String) {
            repository(owner:$owner,name:$name) {
              dependencyGraphManifests(first:100,after:$cursor) {
                nodes { id filename parseable exceedsMaxSize dependenciesCount
                  dependencies(first:100) { ${dependencyFields} } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`, owner, name, cursor,
        },
      });
      const connection = result.data.repository?.dependencyGraphManifests;
      if (!connection) throw new GitHubError('Dependency graph is unavailable for this repository.');
      for (const manifest of connection.nodes) {
        const dependencies = [...manifest.dependencies.nodes];
        let page = manifest.dependencies.pageInfo;
        while (page.hasNextPage) {
          const next = await this.api('graphql', {
            fields: {
              query: `query($id:ID!,$cursor:String!) { node(id:$id) {
                ... on DependencyGraphManifest { dependencies(first:100,after:$cursor) { ${dependencyFields} } }
              } }`, id: manifest.id, cursor: page.endCursor,
            },
          });
          const batch = next.data.node?.dependencies;
          if (!batch) throw new GitHubError(`Dependency pagination failed for ${manifest.filename}.`);
          dependencies.push(...batch.nodes);
          page = batch.pageInfo;
        }
        manifests.push({ ...manifest, dependencies });
      }
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (cursor);
    return manifests;
  }

  async alerts(repo) {
    const alerts = await this.api(`repos/${repo.full_name}/dependabot/alerts?state=open&per_page=100`, { paginate: true });
    return alerts.map(alert => ({
      number: alert.number,
      severity: alert.security_vulnerability?.severity ?? alert.security_advisory?.severity ?? 'unknown',
      package: alert.dependency?.package?.name,
      ecosystem: alert.dependency?.package?.ecosystem,
      manifest: alert.dependency?.manifest_path,
      relationship: alert.dependency?.relationship ?? 'unknown',
      scope: alert.dependency?.scope,
      summary: alert.security_advisory?.summary,
      ghsa: alert.security_advisory?.ghsa_id,
      cve: alert.security_advisory?.cve_id,
      patchedVersion: alert.security_vulnerability?.first_patched_version?.identifier ?? null,
      createdAt: alert.created_at,
      url: alert.html_url,
    }));
  }

  async updatePulls(repo) {
    return this.api(`repos/${repo.full_name}/pulls?state=open&per_page=100`, {
      paginate: true,
      projection: '.[] | select(.user.login == "dependabot[bot]" or .user.login == "dependabot" or .user.login == "renovate[bot]" or .user.login == "renovate" or any(.labels[]?; .name == "dependencies")) | {number,title,url:.html_url,author:.user.login,createdAt:.created_at,draft}',
    });
  }

  async codeAlerts(repo) {
    return this.api(`repos/${repo.full_name}/code-scanning/alerts?state=open&per_page=100`, {
      paginate: true,
      projection: '.[] | {number,url:.html_url,severity:(.rule.security_severity_level // .rule.severity // "unknown"),description:.rule.description,createdAt:.created_at}',
    });
  }

  async tree(repo) {
    if (!repo.default_branch || repo.size === 0) return { tree: [], truncated: false };
    return this.api(`repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`);
  }

  async file(repo, entry) {
    const blob = await this.api(`repos/${repo.full_name}/git/blobs/${entry.sha}`);
    if (blob.encoding !== 'base64') throw new GitHubError(`Unsupported encoding for ${entry.path}.`);
    return Buffer.from(blob.content, 'base64').toString('utf8');
  }
}
