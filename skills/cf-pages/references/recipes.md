# cf-pages diagnosis recipes

All commands use `--json --no-input`; they are left out below for readability. Every change follows the
steps in SKILL.md: dry run, show, explicit approval for that change, then run it.

## 1. "I pushed but I don't see my changes"

1. Find out which commit should be live. Ask the person, or use your own tools in their repository:
   `git log -1 --format=%H <branch>` (and `git status` / `git log origin/<branch>` to make sure it was
   pushed). The CLI has no access to GitHub or the local repository.
2. `cf-pages projects show <project> --expect <sha> --branch <branch>`
   - `expect_found`: a deployment exists. Check its state in the message:
     - `success`: the deploy is live. The cause is probably cache, the wrong URL (preview deployments get
       their own `*.pages.dev` alias, see `aliases`), or a custom domain issue (`domains[].status`).
     - `queued` / `building`: it is still running; check again shortly.
     - `failure`: go to recipe 2.
   - `expect_missing`: Cloudflare never built that commit. Read the other findings for the reason:
     - `production_deployments_disabled`, `preview_deployments_disabled`, `preview_branches_filtered`:
       automatic deploys are switched off for that branch. Changing that is done in the dashboard
       (`cf-pages dashboard <project> --section builds`). A manual redeploy still works.
     - `watch_paths`: the commit touched no watched path (`git.pathIncludes` / `git.pathExcludes`).
       Compare with `git show --stat <sha>`.
     - `skipped` with `commit_message`: the commit message contains a skip flag such as `[skip ci]`.
     - No explanation: the GitHub ↔ Cloudflare integration probably missed the push. The `hint` links
       the GitHub app in case it needs reconnecting.
3. `cf-pages deployments list <project> --branch <branch> --limit 5` to see what did deploy recently.
4. If a build is missing, propose `cf-pages deployments redeploy <project> --branch <branch>`. It builds
   the current head of the branch. Production branch means production level (`--confirm <project>`).

## 2. "Why did my deployment or preview fail?"

1. Find the deployment: the person's link or short id, or the newest one of the branch:
   `cf-pages deployments list <project> --branch <branch> --limit 5`.
2. `cf-pages deployments logs <project> <deployment> --tail 100`
   If the error starts earlier, save the full log and search it:
   `cf-pages deployments logs <project> <deployment> --output build.log`, then read only the relevant part.
3. Identify the stage and the first real error. Frequent causes:
   - Lockfile out of date or mismatched (`bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`):
     the install step fails with a frozen-lockfile error.
   - Node or package manager version: compare with `NODE_VERSION` in `cf-pages env list <project>`,
     `.nvmrc`, `.node-version` or `engines`, and with `build.imageVersion` from `projects show`.
   - Missing variable: the build reads a variable that is not set in that environment. Compare the
     environments with `cf-pages env list <project>`.
   - Wrong build command or output directory: compare `build.command` / `build.outputDir` from
     `projects show` with the repository's scripts. Build settings change in the dashboard
     (`--section builds`).
   - Cloudflare-side errors such as `unable to submit build job`: not caused by the code; a retry may help.
4. Check the cause against the repository with your own tools (`git log`, `git diff`, reading files).
5. Propose the fix to the person. After they push it, the new commit deploys by itself (check with
   recipe 1). If nothing in the repo needs to change (a variable was added, or a Cloudflare error),
   propose `cf-pages deployments retry <project> <deployment>` (it creates a new deployment id) or a
   `redeploy` of the branch.

## 3. "Change variable X"

1. Confirm the project, the key and the environment with the person. If they did not name an
   environment, ask; production and preview are separate.
2. `cf-pages env list <project>` to see whether the key exists in each environment, its type, and
   whether the project is `wranglerManaged` (`projects show`).
3. Decide how the value reaches the CLI (SKILL.md, "Environment variables"). For a secret, prefer that
   the person runs the command themselves.
4. Dry run, for example:
   `printf '%s' '<value>' | cf-pages env set <project> <KEY> --env preview --plain --dry-run`
   Show the person the `changes` (action, type, `becomesReadable`, `overwritesSecret`) and stderr warnings.
5. After approval, the same command without `--dry-run`, plus `--yes` (preview) or
   `--confirm <project>` (production or wrangler-managed).
6. The change applies on the next deployment. Offer a redeploy of the affected branch, and ask for that
   approval separately.

Deleting: `cf-pages env unset <project> <KEY...> --env <env>` with the same steps. Copying values between
environments is not possible for secrets (they cannot be read); the person has to provide them.

## 4. "Undo the last production deploy"

1. `cf-pages projects show <project>`: `production` is what serves the site now.
2. `cf-pages deployments rollback <project> --dry-run`: `data.target` is where production would go back
   to (the previous successful production deployment). To pick another one, list them with
   `cf-pages deployments list <project> --env production --limit 10` and pass its id.
3. Show "from → to" (short id, commit, date) and say that the next push to the production branch will
   deploy over the rollback. Ask for approval.
4. `cf-pages deployments rollback <project> [<deployment>] --confirm <project>`.
5. Confirm with `cf-pages projects show <project>` that `production.id` changed.

## 5. "Retry a failed preview"

1. `cf-pages deployments list <project> --env preview --branch <branch> --limit 5` and pick the failed one.
2. `cf-pages deployments retry <project> <deployment> --dry-run`, show it, ask for approval.
3. `cf-pages deployments retry <project> <deployment> --yes`; poll the new id with
   `deployments show` (or use `--wait` if your commands can run for up to 20 minutes).
4. On failure, recipe 2 with the new deployment id.
