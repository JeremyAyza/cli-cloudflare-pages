# cf-pages

> **Unofficial. Not affiliated with or endorsed by Cloudflare.**

A safe, agent-friendly command-line interface for managing Cloudflare Pages projects connected to Git: deployments, build logs, rollbacks, and masked environment variables.

---

## What It Solves

`cf-pages` addresses three core operational needs:
1. **Inspecting and diagnosing Git-connected Pages projects:** Find out why a push did not deploy, whether build watch paths or branch filters are active, or why a build failed.
2. **Deploy lifecycle management:** View history, fetch build logs, trigger redeploys on demand, retry failed builds, or instantly rollback production to an earlier stable state.
3. **Safe environment variable management:** Read masked variables side-by-side, inspect diffs before applying changes, prevent accidental secret exposures, and import `.env` files safely.

---

## Installation

Run directly with `npx`:
```bash
npx cf-pages --help
```

Or install globally:
```bash
npm install -g cf-pages
```

---

## Authentication & Storage

Create an API token at https://dash.cloudflare.com/profile/api-tokens (or an account-owned token under Manage Account → Account API Tokens) with the permission:
`Account · Cloudflare Pages · Edit`

Then log in:
```bash
cf-pages login
```

- **Credential Storage:** By default, credentials are encrypted and stored in your operating system's native keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).
- **Headless / CI environments:**
  - For headless systems without a desktop keyring, you can use:

    ```bash
    cf-pages login --insecure-storage
    ```

    This stores credentials in a user-only `0600` file (`credentials.json`).
  - Or set environment variables:

    ```bash
    export CF_PAGES_API_TOKEN="your-api-token"
    export CF_PAGES_ACCOUNT_ID="your-account-id"
    ```

---

## Commands

### Auth & Settings

- `cf-pages login [--label <name>] [--account-id <id>] [--token-stdin] [--insecure-storage]`
- `cf-pages logout`
- `cf-pages whoami [--json]`
- `cf-pages settings get [key]`
- `cf-pages settings set <key> <value>` (interactive only)

### Projects

- `cf-pages projects list`: List all projects in the account.
- `cf-pages projects show <project> [--expect <sha>] [--branch <branch>]`: Detailed view, diagnostics, watch paths, and latest deployments by branch.

### Deployments

- `cf-pages deployments list <project> [--env production|preview] [--branch <name>] [--limit <n>]`
- `cf-pages deployments show <project> <deployment>`
- `cf-pages deployments logs <project> [<deployment>] [--tail <n>] [--output <file>]`
- `cf-pages deployments redeploy <project> [--branch <name>] [--wait]`
- `cf-pages deployments retry <project> <deployment> [--wait]`
- `cf-pages deployments rollback <project> [<deployment>]`

### Environment Variables

- `cf-pages env list <project> [--env production|preview]`
- `cf-pages env get <project> <key> --env <env> [--reveal]`
- `cf-pages env set <project> [key] --env <env> [--secret | --plain] [--from-file <path>] [--redeploy]`
- `cf-pages env unset <project> <keys...> --env <env> [--redeploy]`

### Dashboard Deep Links

- `cf-pages dashboard <project> [deployment] [--section <section>] [--open]`

---

## Security Model

1. **Tokens Never Printed:** Tokens and secrets are scrubbed by an automatic redactor across all output, error messages, and logs.
2. **Confirmation Levels:**
   - **Preview mutations:** Can be approved with `-y` / `--yes`.
   - **Production mutations:** Require explicit project name confirmation via `--confirm <project>` or an interactive terminal prompt.
   - **Wrangler Override:** If a project is detected to be managed by a `wrangler` config file, preview changes escalate to production confirmation levels.
3. **Audit Log:** All mutation and sensitive reveal operations are recorded locally in `audit.log` (mode `0600`).
4. **Masking Rules:**
   - Secret values are displayed as `[secret — not readable]`.
   - Plain text values: length ≥ 24 chars shows 4 + `•••` + 4; 12–23 shows 2 + `•••` + 2; < 12 shows `•••••`.

---

## Agent Usage & Exit Codes

All commands support `--json` for single-document machine-readable JSON output on stdout. Diagnostics and account headers are written to stderr.

### Exit Codes

- `0`: Success
- `1`: Unexpected internal error
- `2`: Invalid CLI usage
- `3`: Authentication required or invalid
- `4`: Resource not found (project, deployment, variable)
- `5`: Confirmation required or cancelled
- `6`: Cloudflare API error or verification mismatch
- `7`: Deployment finished in failure (`--wait`)

---

## Why cf-pages?

- **Wrangler** is designed for direct asset uploading from disk, but cannot trigger Git redeploys, inspect pipeline diagnostics, or safely diff environment variables without risking secret deletion.
- **The official Cloudflare CLI (`cf`)** covers broad Cloudflare features but has limited support for Pages pipeline diagnostics, rollback safety, and masked environment variable management.

---

## License

MIT © cf-pages contributors
