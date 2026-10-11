# gh-repo-health

Find the repositories that need dependency and security maintenance using your existing GitHub CLI login.

```sh
npm ci --ignore-scripts
npm start -- list
npm start -- scan
npm run dashboard
```

Requires GitHub CLI (`gh`) and Node.js 22.11–22.x or 24.10+. Authenticate with `gh auth login` if needed. No extra token file is required. Run commands from this project directory so reports stay together. You can also run `./src/cli.js scan`; `npm install -g .` installs the `gh-repo-health` command if you want it on your PATH.

The default scan includes every repository returned by GitHub for your account: owned repositories, collaborator repositories, and organization/team repositories. It includes private repositories, archives, and forks and follows every page rather than using GitHub search's result cap. “Accessible” means explicitly accessible through the active token; it does not enumerate every public repository on GitHub. Fine-grained token restrictions and organization SSO can limit discovery.

## What it shows

- Open Dependabot alert totals, critical/high/medium/low counts, available fixes, affected packages, manifests, advisory links, and alert age.
- Outdated dependencies, latest default stable releases, major version gaps, how long a newer release has existed, and deprecated packages.
- Repositories sorted by critical alerts, high alerts, and dependency maintenance needs.
- Dependabot/Renovate update PRs, dependency-labelled PRs, stale PR counts, and repository inactivity.
- Optional code scanning alert counts and severity details with `--code-scanning`.
- Explicit unavailable/incomplete results, per-package failure reasons, and source/timestamp information.
- JSON, CSV, Markdown, and terminal reports; owner/repository/visibility filters; caching; resumable scans; and CI exit policies.
- A local dashboard with search, sortable columns, severity/coverage views, repository details, scan controls, and an offline HTML export.

GitHub vulnerability counts are **open alert instances**, not unique advisory IDs. A single advisory affecting several manifests can create several alerts. Code scanning counts are separate from Dependabot counts. `?` means alerts are disabled, permissions are insufficient, or a request failed. It never means zero.

## Local dashboard

With [Portless](https://github.com/vercel-labs/portless) installed, run this from the project directory:

```sh
npm run dashboard
```

Open the URL printed by Portless, normally `https://gh-repo-health.localhost`. The server honors Portless's assigned `PORT`, binds to loopback, and reads `reports/`. `REPORT_DIR=/absolute/path/to/reports npm run dashboard` selects another report directory. Stop it with Ctrl+C in its terminal. `npm run dev` is the underlying server command used by Portless.

The dashboard joins the complete repository inventory with saved audits. Repositories without a scan are labelled **Not audited**; unknown alert counts display **—**. Search names, owners, and languages; filter by visibility, owner, language, archives, critical alerts, severely outdated dependencies, coverage gaps, or update PRs. Click a repository name for package versions, alert details, patch information, source coverage, and GitHub links.

**Run scan** lets you scan the entire inventory or all repositories matching the current view, across every page. A repository's detail panel can start a scan of just that repository. Scan controls include direct dependencies, code scanning, and reuse of recent results. Progress updates while the scan runs; **Stop scan** preserves completed results. Only one scan runs at a time. Dashboard scans retain older repositories' results in `reports/history.json`, so a later small scan does not erase earlier dashboard coverage. Counts can therefore come from different timestamps; check each repository's saved scan date. Alert totals and Critical columns are Dependabot counts; optional code scanning appears separately in repository details and affects priority.

**Export CSV** exports the current view, including every matching page. **Export JSON** exports the entire dashboard dataset. **Save HTML** creates a single file with all inventory and audit data, styles, and interactive search/filter/detail controls. It works offline with no server or external assets; scanning is available in the live dashboard.

Generate the same HTML file from the command line:

```sh
npm run snapshot
npm run snapshot -- --report-dir reports --output reports/repository-health.html
```

Exports can contain private repository names and alert details. Reports and CLI-generated HTML files are created with owner-only file permissions. The dashboard uses your existing `gh` login; browser responses contain no GitHub token. The local scan endpoints require a per-session token and a matching Origin header, and invoke the scanner directly without a shell.

## scriptc compatibility

[scriptc](https://github.com/vercel-labs/scriptc) compiles JavaScript/TypeScript to native executables; it does not supply a dashboard or UI framework. Version **0.2.8** was checked against this scanner with `coverage src/cli.js --dynamic --print diagnostics`. The unmodified source stops at preflight on missing dependency declarations and an inferred CLI option type. A scratch copy with real dependency declarations and a numeric conversion proceeds to compile analysis: **375 static, 159 dynamic, and 62 failed statements out of 596**. Blockers include the scanner's `util.promisify` call, `parseArgs` config types, filesystem write options, and several inferred JSON/container operations. These are specific to this program and version, not claims that every use of those APIs is unsupported.

The scanner and dashboard run on Node; a scriptc native executable is not included. Recheck compiler coverage before attempting a future native port. Dynamic mode still has [compatibility limits](https://scriptc.dev/docs/limitations); obtaining a binary would require a port and separate runtime validation.

## Find repositories to work on

```sh
# List all accessible repositories with visibility and your access level
npm start -- list

# Scan every accessible repository and display severely outdated repositories
npm start -- scan --only outdated

# Scan your own active, non-fork repositories
npm start -- scan --owner YOUR_LOGIN --exclude-archived --exclude-forks

# Inspect every dependency and vulnerability in selected repositories
npm start -- scan --repo owner/name --repo org/another --details

# Request code scanning alerts as well
npm start -- scan --code-scanning

# Scan a small, explicitly limited sample
npm start -- scan --limit 5
```

`--only` changes the displayed/exported selection. The complete scan is always saved to `reports/latest.json`. `--limit` limits the actual work and the report records selected versus discovered repository counts.

## Define “too outdated”

By default a dependency is severe when it is at least **two major versions behind** OR a newer stable version has been available for **180 days**. These thresholds are signals for review, not assertions that every upgrade is compatible or necessary.

```sh
npm start -- scan --major-gap 1 --outdated-days 90
```

Age is measured from the earliest non-deprecated stable release newer than the comparison version, up to the registry's default stable release. An old package with no newer release is not outdated merely because it is old. Versions ahead of the registry default are shown as `ahead` and do not trigger a downgrade suggestion. Zero-major breaking changes can be detected by the age threshold; they are not counted as major-version gaps.

Exact pins and lockfile entries are compared as recorded. A declared range is compared using the **highest published stable version it allows**, avoiding false alarms from its lower bound. `range-allows-latest` means the declaration permits the latest version; the installed version is unknown. Ranges that exclude the latest version are reported as outdated constraints. Dependency totals count distinct ecosystem/package/requirement/basis entries, merging their manifest locations. They can include several versions of the same package.

## Coverage

The scanner reads the default branch through `gh api` and paginates both dependency manifests and dependency entries in GitHub's dependency graph. It checks public package metadata through [deps.dev's API](https://docs.deps.dev/api/v3/), which may lag the registry. Default stable release metadata is cached for 24 hours; use `--cache-hours 0` to fetch fresh metadata.

| Ecosystem | GitHub dependency graph | Manifest fallback when the graph is missing or incomplete |
| --- | --- | --- |
| npm / Bun / pnpm / Yarn | Exact versions and semver ranges | `package.json`, npm lockfiles v1+, `bun.lock` text files, pnpm locks, classic/modern Yarn locks |
| Python / PyPI | PEP 440 versions and ranges | `requirements.txt`, `requirements-dev.txt`, `requirements.in`, `pyproject.toml`, Pipfile, Pipfile.lock, Poetry/uv locks |
| Rust / Cargo | Exact versions and semver ranges | Cargo.toml and Cargo.lock |
| Go modules | Exact semver versions | go.mod |
| RubyGems / Maven / NuGet | Exact versions compatible with strict semver; simple 1/2/3-part numeric versions for these ecosystems | Requires populated GitHub dependency graph |
| Other ecosystems | Explicitly unsupported | Known unsupported manifest files are flagged |

Fallback parsing checks nested manifests and workspaces and prefers matching lockfile packages over declarations. It always reports partial coverage because it does not recreate each package manager's resolver. Binary Bun locks, arbitrary Python includes, Poetry-specific caret/tilde syntax, dynamic build configuration, private registries, non-semver Maven/Ruby/NuGet versions, Git/local packages, and unsupported ecosystems can remain unverified. No detected manifest in a nonempty repository means `not-detected`, not proof of zero dependencies. GitHub graph data is a snapshot and can itself omit unsupported files.

`--direct-only` drops dependencies explicitly identified as transitive. It keeps unknown relationships so incomplete graph/lockfile metadata cannot silently hide dependencies. Default scans include development dependencies. Reports list manifest paths and scopes for context.

## Permissions

All GitHub requests use your existing `gh` credentials. The tool does not change repository settings or token permissions. Dependabot alert access can require the `security_events` scope for OAuth/classic PATs, or the fine-grained **Dependabot alerts: read** permission, plus appropriate repository access. Public-only access can use `public_repo`. Code scanning requires its own access and may be unavailable on private repositories without the relevant feature enabled. Follow your organization's SSO policy where applicable.

The scanner preserves GitHub's error message. Do not assume that a CLI suggestion to add a scope will enable a repository feature: disabled alerts must be enabled separately by someone with the required access.

## Save and reuse reports

```sh
# Produce a CSV of the full scan
npm start -- scan --format csv --output reports/health.csv

# Reformat an existing report with no GitHub or registry requests
npm start -- report --only critical --format markdown --details --output reports/critical.md
npm start -- report reports/latest.json --only incomplete --details

# Continue after interruption, or reuse recent successful results
npm start -- scan --resume
```

`reports/inventory.json` contains the complete discovered inventory. `reports/latest.json` is checkpointed atomically after each repository. `reports/metadata-cache.json` stores package metadata. Progress goes to stderr, leaving JSON/CSV stdout usable in pipelines. Created report files use owner-only permissions and the reports directory is ignored by Git.

Resume requires the same account, host, audit settings, unchanged repository push date, and a result younger than `--cache-hours`. Failed security/PR requests and failed package lookups are retried. Successful results can still have documented partial coverage. Reused results retain their original timestamps and are marked cached; alerts may have changed without a push, so omit `--resume` for a fresh security scan.

The scanner stops launching GitHub work after a rate-limit/authentication failure and saves the partial report. Ctrl-C stops after active checks finish and saves the checkpoint. Requests have timeouts and limited retries. Adjust `--concurrency` (default 2) and `--registry-concurrency` (default 6 per repository) for larger accounts. Use separate `--report-dir` directories for simultaneous scans to avoid overwriting one another's checkpoint.

Package names are sent to the public deps.dev service for metadata lookup. GitHub credentials are never sent to that service. Reports can contain private repository and package names, so choose their storage/sharing location accordingly. The tool does not clone repositories, install audited dependencies, or execute audited repository code.

## CI and exit codes

```sh
npm start -- scan --fail-on critical,high,incomplete
npm start -- report --fail-on outdated
```

| Exit | Meaning |
| --- | --- |
| 0 | Selected scan completed; requested policies passed |
| 1 | Command/authentication failure or interrupted/incomplete scan execution |
| 2 | A requested critical/high/severe-outdated/incomplete-coverage policy failed |

Coverage can be incomplete even when scan execution finishes. `--fail-on incomplete` makes that a failing policy. Policies evaluate all repositories in the saved scan regardless of display filters. `high` includes critical alerts, and `outdated` uses the severe thresholds.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

Tests cover pagination, permission failures, rate limits, manifest/lockfile parsing, version comparison, cache reuse, report safety, CI policies, and an end-to-end CLI run using a simulated `gh` executable.

API references: [repository discovery](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user), [Dependabot alerts and permissions](https://docs.github.com/en/rest/dependabot/alerts), [dependency graph](https://docs.github.com/en/graphql/reference/dependency-graph), [GitHub CLI API](https://cli.github.com/manual/gh_api).
