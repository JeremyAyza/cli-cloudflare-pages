# Live Verification — Cloudflare Pages CLI v1

Date: 2026-10-21  
Target Test Project: `landing-studio`  
Scope: Verification against live Cloudflare Pages API according to spec §11 and Task 17.  
Security constraints: No tokens, no Account IDs, no secret variable values recorded.

---

## Pre-flight & Authentication

- [x] Interactive login completed via `node dist/cli.js login` with test account (label: `JeremyAyza`).
- [x] `whoami` verified (`status: active`, storage: `keyring`).

---

## Step 1: Project Inspection (`landing-studio`)

- Command: `node dist/cli.js projects show landing-studio --json`
- Git source: `github` (`JeremyAyza/landing-studio`), `productionDeploymentsEnabled: true`
- Preview deployment setting: `all` (previewIncludes: `["*"]`, watch paths: `["*"]`)
- Wrangler config hash: `none` (`wranglerManaged: false`)
- Recent deployments:
  - `8a4a27ee` (production, branch: `main`, commit: `d92ade3`, state: `success`, canonical)
  - `743d3f2c` (preview, branch: `docs/readme-2026`, commit: `6b9fdeb`, state: `success`)
  - `7ab43a00` (production, branch: `main`, commit: `0945cab`, state: `success`)

---

## Step 2: Dashboard URL Verification

- GitHub App URL: Verified HTTP 200 at `https://github.com/apps/cloudflare-workers-and-pages`.
- Section URLs evaluated on live dashboard:
  - Deployments (home): `https://dash.cloudflare.com/<account>/pages/view/landing-studio`
  - Custom domains: `https://dash.cloudflare.com/<account>/pages/view/landing-studio/domains`
  - Settings: `https://dash.cloudflare.com/<account>/pages/view/landing-studio/settings/production`
  - Environment variables: `https://dash.cloudflare.com/<account>/pages/view/landing-studio/settings/production#variables`
  - Builds: `https://dash.cloudflare.com/<account>/pages/view/landing-studio/settings/production#build`
- Confirmed routes in `SECTION_PATHS`:
  - `deployments`: `null` (falls back to project root URL)
  - `domains`: `'domains'`
  - `settings`: `'settings/production'`
  - `variables`: `'settings/production#variables'`
  - `builds`: `'settings/production#build'`

---

## Step 3: Environment Variable Mutations (Preview)

- [x] `env set landing-studio CF_PAGES_CHECK --env preview --plain --yes` (value masked as `te•••23 (14)`).
- [x] Check with `env list --json` that only `CF_PAGES_CHECK` was added/updated and others remained untouched.
- [x] `env set landing-studio CF_PAGES_CHECK --env preview --secret --yes` (diff rendered as `~ CF_PAGES_CHECK secret_text ... -> [secret — not readable]`).
- [x] Check with `env list --json` that `CF_PAGES_CHECK` is marked as secret (`readable: false`, masked: `null`).
- [x] `env unset landing-studio CF_PAGES_CHECK --env preview --yes`
- [x] Verify clean removal (`environments.preview: []`).

---

## Step 4: Deployment Retry (Preview)

- Target preview deployment: `743d3f2c` (`743d3f2c-428a-4086-a769-3008f783c7e1`, branch: `docs/readme-2026`).
- Command: `node dist/cli.js deployments retry landing-studio 743d3f2c --yes --wait --json`
- Result ID: `015ba75b` (`015ba75b-5d76-4c70-992c-6c6581922763`) — **Confirmed: Cloudflare generates a brand new deployment ID on retry**.
- Wait & Diagnostics verification: CLI accurately tracked state progression (`building` → `failure`), exited with code `7` (`deployment_failed`), and retrieved failure diagnostics (`Failed: unable to submit build job`).
- Logs verification: `deployments logs landing-studio 015ba75b --tail 50` successfully retrieved build failure logs from Cloudflare.

---

## Step 5: Production Rollback & Restoration

- Target rollback deployment: `7ab43a00` (`7ab43a00-9bf0-4e6f-8822-bed4cb0390e5`, commit `0945cab`).
- Rollback execution: `node dist/cli.js deployments rollback landing-studio --confirm landing-studio` — Succeeded with exit 0 and printed warning regarding future commits overriding rollback.
- Verification via `projects show`: Confirmed `data.production.id` switched to `7ab43a00` (canonical production updated). Also verified that diagnostics detected the failed preview branch deployment and generated a warning finding.
- Restoration to original production deployment: `node dist/cli.js deployments rollback landing-studio 8a4a27ee --confirm landing-studio` — Succeeded with exit 0.
- Verification via `projects show`: Confirmed `data.production.id` restored to `8a4a27ee` (`8a4a27ee-beaf-45e5-9ffb-1ef2a4b8504d`).

---

## Step 6: Additional Findings & Edge Cases

- Behavior with wrangler-managed project: `landing-studio` has `wranglerManaged: false`.
- Branch controls & diagnostics: Live testing demonstrated that `diagnose.ts` surfaces `latest_failed` warnings when a branch has a failed deployment, accurately directing to `cf-pages deployments logs`.

---

## Step 7: Read-only Verification on Primary Account / Failed Deployment Logs

- Failed deployment logs check: `node dist/cli.js deployments logs landing-studio 015ba75b --tail 50` successfully retrieved failure log timestamp and message (`Failed: unable to submit build job`).

---

## Summary & Adjustments Made

- [x] All 7 verification steps completed against real Cloudflare Pages API (`landing-studio`).
- [x] `SECTION_PATHS` updated in `src/providers/pages/dashboard.ts` with confirmed live routes (`settings/production`, `domains`, `settings/production#variables`, `settings/production#build`).
- [x] Unit and command tests in `tests/providers/pages/dashboard.test.ts` updated to validate confirmed section paths.
- [x] Full test suite, typecheck, lint, build, and package size re-verified.
