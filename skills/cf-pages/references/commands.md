# cf-pages command reference

Every command below accepts the global flags. Put them anywhere after `cf-pages`.

| Flag | Meaning |
|---|---|
| `--json` | One JSON document on stdout, for success and for errors. |
| `--no-input` | Never prompt; fail with `confirmation_required` (or `usage`) when input would be needed. |
| `--dry-run` | On changes: read the current state, show what would happen, change nothing. |
| `-y`, `--yes` | Approves a preview-level change. Never enough for production. |
| `--confirm <project>` | Approves any change; must equal the project name exactly. |
| `--debug` | Redacted request diagnostics on stderr. |
| `--no-color` | Plain output. |

Placeholders: `<project>` is the Pages project name. `<deployment>` is a full deployment id, the
8-character `shortId`, or `latest`. `<env>` is `production` or `preview`.

## JSON envelope

```json
{ "ok": true, "account": { "label": "Acme", "accountId": "..." }, "data": {} }
{ "ok": false, "error": { "code": "not_found", "message": "...", "hint": "...", "details": {} } }
```

`account` is present once the CLI has resolved credentials. `hint` and `details` are optional.

### Error codes

| Code | Exit | Meaning |
|---|---|---|
| `usage` | 2 | Wrong arguments or flags, or a value the CLI refuses. |
| `auth_required` | 3 | No login. The person must run `cf-pages login`. |
| `auth_invalid` | 3 | The token was rejected, expired, or only one of the `CF_PAGES_*` variables is set. |
| `permission_denied` | 3 | The token lacks a permission (usually *Cloudflare Pages · Edit*). |
| `keyring_unavailable` | 3 | No OS keychain; the person must choose another storage when logging in. |
| `not_found` | 4 | Project, deployment or variable not found. |
| `confirmation_required` | 5 | A change needs approval that was not given (flag missing, or `productionRequiresTty`). |
| `cancelled` | 5 | The person declined at a prompt. |
| `api_error` | 6 | Cloudflare returned an error, or `--wait` timed out after 20 minutes. |
| `rate_limited` | 6 | Too many requests (1200 per 5 minutes per token). Wait about 5 minutes. |
| `verification_failed` | 6 | After a variable change, Cloudflare reports a different state than planned. |
| `deployment_failed` | 7 | With `--wait`, the deployment ended in failure. `details`: `{ deploymentId, state, logTail }`. |
| `unexpected` | 1 | Bug or unknown failure. |

## View models

**DeploymentView**

```text
id, shortId, environment ('production'|'preview'), branch,
commit { hash, shortHash, message },
state ('queued'|'building'|'success'|'failure'|'canceled'|'skipped'),
skipReason (string|null), createdOn (ISO 8601), url, aliases[], dashboardUrl
```

**EnvVarView**

```text
key, type ('plain_text'|'secret_text'), readable (false for secrets),
masked (string|null), length (number|null), value (only with --reveal)
```

Masking: 24 or more characters show the first 4 and last 4 (`sk_l•••9io2 (40)`); 12 to 23 show 2 and 2;
fewer than 12 are fully hidden. Secrets are never readable.

**PlanItemView** (variable changes)

```text
key, action ('create'|'update'|'delete'|'unchanged'), type,
fromType, becomesReadable, overwritesSecret   (only when action is 'update')
```

## Auth and settings

### `cf-pages whoami`
`data`: `{ label, accountId, tokenType ('user'|'account'|'unknown'), source ('keyring'|'file'|'env'), storage ('keyring'|'file'|null), insecure?, expiresOn, status }`.
`status` is `active` when Cloudflare accepts the token. A warning on stderr means it expires within 7 days.

### `cf-pages login` / `cf-pages logout`
Only the person runs these, in their own terminal. Never run them yourself.

### `cf-pages settings get [productionRequiresTty]`
Read-only. `productionRequiresTty: true` means production changes are only accepted from an interactive
terminal. `settings set` only works at an interactive terminal; never try it.

## Projects

### `cf-pages projects list`
`data`: array of `{ name, subdomain, domains[], productionBranch, repo ('owner/name'|null), production (DeploymentView|null), dashboardUrl }`.
`repo: null` means a Direct Upload project (no Git source).

### `cf-pages projects show <project> [--expect <sha> [--branch <b>]]`
`data`:

```text
name, subdomain, productionBranch, repo, dashboardUrl, production (DeploymentView|null),
git { provider, repo, productionDeploymentsEnabled, previewSetting ('all'|'none'|'custom'),
      previewIncludes[], previewExcludes[], pathIncludes[], pathExcludes[] } | null,
build { command, outputDir, rootDir, imageVersion },
wranglerManaged, domains [{ name, status, error? }],
latestByBranch (DeploymentView[], newest first, up to 10),
findings [{ level ('info'|'warning'), code, message, hint? }]
```

`--expect <sha>` (7 to 40 hex characters) looks for a deployment of that commit among the 25 most
recent deployments; `--branch` narrows it (default: production branch).

| Finding code | Meaning |
|---|---|
| `no_git_source` | Direct Upload project: pushes never deploy it, and `redeploy` is not available. |
| `production_deployments_disabled` | Pushes to the production branch do not deploy automatically. |
| `preview_deployments_disabled` | No branch gets preview deployments. |
| `preview_branches_filtered` | Only branches matching the include/exclude rules get previews. |
| `watch_paths` | Commits that touch none of the watched paths do not deploy (not reported for the default include `*`). |
| `wrangler_config_managed` | A wrangler config file may own the settings; variable changes may be overwritten. |
| `skipped` | A recent deployment was skipped; the message gives the reason. |
| `latest_failed` | The newest deployment failed; `hint` is the logs command. |
| `expect_found` | A deployment exists for the `--expect` commit; the message gives its state. |
| `expect_missing` | No deployment for that commit; `hint` proposes `redeploy` and the GitHub app link. |

Skip reasons: `commit_message` (`[skip ci]`, `[CF-Pages-Skip]` and similar), `preview_deployments_disabled`,
`production_deployments_disabled`, `path_config` (watch paths), `branch_config` (branch controls),
`superseded_queued_build` (a newer push for the same branch replaced it in the queue).

## Deployments

### `cf-pages deployments list <project> [--env <env>] [--branch <b>] [--limit <n>]`
`data`: `DeploymentView[]`, newest first. `--branch` is an exact match. Without `--limit` it can return up
to 200 items, so always pass one.

### `cf-pages deployments show <project> <deployment>`
`data`: `DeploymentView`.

### `cf-pages deployments logs <project> [<deployment>] [--branch <b>] [--tail <n>] [--output <file>]`
Default deployment: the newest one (of `--branch` when given).
`data`: `{ deploymentId, total, lines[] }`, each line prefixed with its timestamp.
With `--output <file>`: the log is written to the file and `data` is `{ deploymentId, total, savedTo, lineCount }`.

### `cf-pages deployments redeploy <project> [--branch <b>] [--wait]` (change)
Builds the head of the branch (default: production branch). Production branch → production level;
any other branch → preview level. Fails with `usage` on Direct Upload projects.
`--dry-run` `data`: `{ dryRun: true, action: 'redeploy', project, branch, environment }`.
`data`: `DeploymentView` of the new deployment (final state with `--wait`).

### `cf-pages deployments retry <project> <deployment> [--wait]` (change)
Level follows the environment of the deployment. Cloudflare creates a deployment with a **new** id.
`--dry-run` `data`: `{ dryRun: true, action: 'retry', project, environment, target: DeploymentView }`.
`data`: `DeploymentView` of the new deployment.

### `cf-pages deployments rollback <project> [<deployment>]` (change, always production level)
Without `<deployment>`: the newest successful production deployment older than the current one.
`--dry-run` `data`: `{ dryRun: true, action: 'rollback', project, environment: 'production', target: DeploymentView }`.
`data`: `DeploymentView` now serving production. The next push to the production branch deploys over it.

### `--wait`
Polls every 5 seconds, prints state changes on stderr, gives up after 20 minutes (`api_error`). A failed
build ends with `deployment_failed` (exit 7) and the last 15 log lines in `error.details.logTail`.

## Environment variables

### `cf-pages env list <project> [--env <env>]`
`data`: `{ project, environments: { production?: EnvVarView[], preview?: EnvVarView[] }, dashboardUrl }`.
Without `--env` both environments are listed, which shows differences between them.

### `cf-pages env get <project> <KEY> --env <env> [--reveal]`
`data`: `EnvVarView` (masked). With `--reveal`, it includes `value`; only for `plain_text`, and the read
is recorded in the local audit log. Use it only when the person asks for that variable.

### `cf-pages env set <project> <KEY> --env <env> [--plain|--secret] [--redeploy [--branch <b>]]` (change)
### `cf-pages env set <project> --env <env> --from-file <path> [--plain|--secret] [--redeploy [--branch <b>]]` (change)
- With `<KEY>` and no terminal, the value is read from stdin (one trailing newline is removed). Empty
  values are refused.
- `--from-file` reads a dotenv file; only the keys in the file are sent.
- New keys need `--plain` or `--secret`; existing keys keep their type unless one is given.
- Only changed keys are sent; an identical plain value is `unchanged` and nothing is sent.
- After sending, the CLI reads the project again and fails with `verification_failed` if the result differs.
- Level: production for `--env production`, or for any environment when the project is wrangler-managed;
  otherwise preview.
- `data`: `{ project, env, changes: PlanItemView[], applied, dryRun?, redeploy?: DeploymentView }`.

### `cf-pages env unset <project> <KEY...> --env <env> [--redeploy [--branch <b>]]` (change)
Deletes the keys (each sent as `null`). Unknown keys fail with `not_found` before anything is sent.
`data`: same shape as `env set`, with `action: 'delete'`.

## Dashboard links

### `cf-pages dashboard <project> [<deployment>] [--section <s>] [--open]`
`data`: `{ url }`. Sections: `deployments`, `settings`, `domains`, `variables`, `builds`. `--open` only
works at an interactive terminal; otherwise give the URL to the person.
