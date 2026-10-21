# SDD ledger — plan: docs/superpowers/plans/2026-10-21-cf-pages-cli-v1.md

Spec: docs/superpowers/specs/2026-10-21-cloudflare-pages-cli-design.md
Branch: feat/cli-v1 (main = fa18b33, docs only). Merge base: fa18b33.

## Pre-flight scan

| Tasks | Shared file / interface | Producer → consumer | Finding |
|---|---|---|---|
| T1/T2 | tests/setup.ts | T1 creates empty, T2 fills msw server | consistent |
| T2/T3 | IO, GlobalFlags, fakeIO | T2 → T3 | consistent (fakeIO listed in T2 produces) |
| T2/T5/T15 | src/core/context.ts | T2 base; T5 adds openKeyring; T15 adds openUrl | consistent (additive) |
| T2/T5/T15 | tests/helpers/run.ts | T2 base; T5 keyring+loggedIn; T15 opened[] | consistent |
| T3/T4 | Settings type | T3 → T4 ConfigFile | consistent |
| T4/T5 | readConfig, appendAudit | T4 → T5 session | consistent; T4 `settings` cmd predates Session → uses createOutput/readGlobalFlags directly |
| T5/T6 | src/core/session.ts | T5 base; T6 adds client() | consistent |
| T6/T7/T8 | ApiClient | T6 → T7 PagesApi, T8 login (manual ApiClient before creds stored) | consistent |
| T7/T9/T10/T15 | PagesApi, dashboard URLs | T7 → T9, T10, T15 | consistent |
| T9/T10/T11/T12/T15 | deploymentState, collectDeployments, resolveDeploymentRef, findRollbackTarget, currentProductionDeployment, waitForDeployment | T9 → consumers | consistent |
| T10/T11/T12/T14 | deploymentView, isWranglerManaged | T10 → T11, T12, T14 | consistent |
| T11/T12 | src/commands/deployments.ts, formatLogLines | T11 → T12 | consistent |
| T13/T14 | env planning fns | T13 → T14 | consistent |
| T1/T13 | describeMasked, SECRET_PLACEHOLDER | T1 → T13 | consistent |
| T16 | package build | all | gap: no proof the published tarball runs standalone → fixed (see ruling 3) |

| Task | Self-consistency |
|---|---|
| T1 | DEFECT: mask test s(40) expected 'abcd•••DEFG (40)' but s(40) ends 'ABCD' → fixed. DEFECT: Step 1 `git init` already done → fixed. Other mask/redact/time vectors checked by hand: correct. |
| T2 | help/exit-code block matches test string; header example '…9abcdef' = last 7 of ACCT; ok |
| T3 | messages in tests match exact copy; ok |
| T4 | test message matches exact copy; ok |
| T5 | ok |
| T6 | backoff 500/1000 matches test; ok |
| T7 | ok |
| T8 | answer order (label, acct, token) matches flow; guidance contains 'Cloudflare Pages · Edit'; ok |
| T9–T15 | tests consistent with produced signatures; ok |
| T16 | ok after ruling 3 |
| T17 | requires user login + permission for each mutation → security-sensitive stop before T17 |

## Rulings
- Ruling 1: git repo initialised by controller (main=docs commit fa18b33, work on feat/cli-v1); Task 1 skips `git init` — fresh empty repo, branch protects main — cost if wrong: none (user can rename branch).
- Ruling 2: fixed Task 1 mask test expectation to 'abcd•••ABCD (40)' — arithmetic error in plan; spec rule is 4+4 — cost if wrong: none.
- Ruling 3: added tarball smoke (pack → install in empty dir → `npx cf-pages --help` 0, `whoami` 3) to Task 16 and CI — Global Constraint says runtime deps are bundled; without this a bundling mistake would only surface after publish — cost if wrong: a few seconds of CI.
- Ruling 4: LICENSE copyright holder = "cf-pages contributors" — author's legal name unknown and Global Constraints forbid team names in the repo — cost if wrong: user edits one line.
- Ruling 5: Task 17 (live verification) is a security-sensitive stop: controller will pause and ask the user to log in and approve mutations before dispatching it — spec §11 requires user permission per mutation.
- Ruling 6: if TypeScript 7 (native) breaks `tsc --noEmit` or tool compatibility, implementer may pin latest typescript@6 and note it — plan's TS choice is a convenience, spec only requires TypeScript — cost if wrong: none functional.

## Progress
- Task 1: dispatched (BASE 8e6b977, implementer sonnet)
- Task 1: review 1 → Needs fixes (1 Important: stale package-lock.json root name/version/license + runtime dependencies block)
- Task 1: minor (deferred): redact "registered secrets" test uses cf-shaped token so registry path untested by that case (plan-mandated test; longest-first test covers it)
- Task 1: minor (deferred): time.test.ts lacks exact boundary cases 60s/60m/24h/30d
- Task 1: minor (deferred): biome.json lacks !coverage ignore
- Task 1: minor (deferred): Bearer redaction is case-sensitive (brief-mandated) — note for HTTP debug logging
- Task 1: fix round 1/5 (1 addressed, 0 open — stale lockfile; commits e26ddcc..f4370d0)
- Task 1: complete (commits 8e6b977..f4370d0, review clean)
- Task 2: dispatched (BASE f4370d0, implementer sonnet)
- Ruling 7: bare `cf-pages` with no args prints help to stdout and exits 0 — common CLI convention, spec silent — cost if wrong: trivial change
- Task 2: implementer DONE_WITH_CONCERNS (14ee380); concerns: msw3 onUnhandledFrame, tsdown fixedExtension:false + 'external' deprecated warning, paint reads process.env
- Task 2: review 1 → Needs fixes (2 Important, both partly plan-mandated: commander usage errors echo token-shaped argv unredacted; paint reads process.env)
- Ruling 8: main redacts message/hint/details of EVERY CliError via ctx.redactor before rendering (not only non-CliError) — spec "token never printed" outranks plan's narrower wording — cost if wrong: none (redaction of non-secrets is a no-op)
- Ruling 9: signature change readGlobalFlags(cmd, env) — effective `color` = flag && !env.NO_COLOR && env.TERM !== 'dumb'; paint uses only flags.color + stream TTY — keeps core injectable via Context per spec layering — cost if wrong: later briefs must pass env (carry to Task 4/5 dispatches)
- Task 2: minor (deferred): flagsFromArgv duplicates GlobalFlags defaults (move beside readGlobalFlags)
- Task 2: minor (deferred): unexpected errors lack hint (suggest "Re-run with --debug")
- Task 2: minor (deferred): harness "unhandled requests fail" test only asserts rejects.toThrow()
- Task 2: minor (deferred): --debug stack assertion weak (toContain('at '))
- Task 2: minor (deferred): tests/helpers/cf.ts readBody empty catch
- Task 2: minor (deferred): header() after data() silently dropped in JSON mode
- Task 2: minor (deferred): tsdown `external` deprecated → deps.neverBundle (verify in Task 16 tarball smoke)
- Task 2: minor (deferred): disclaimer may wrap in <60-col terminals
- Task 2: fix round 1/5 (2 addressed, 0 open — redact all CliErrors; color from injected env; commits 14ee380..783d964)
- Task 2: complete (commits f4370d0..783d964, review clean)
- Task 2: minor (deferred): redactDeep has no cycle guard and flattens non-plain objects in details
- Task 2: minor (deferred): Output.note/warn text is not redacted — later tasks interpolating user input there must pass ctx.redactor
- Task 3: dispatched (BASE 783d964, implementer sonnet)
- Task 3: implementer DONE (b4a3906)
- Ruling 10: preview-level mutations also accept a matching `--confirm <project>` (in addition to --yes); a non-matching --confirm is still usage error — stronger flag must satisfy weaker level; agents may always pass --confirm — cost if wrong: none (still explicit consent)
- Ruling 11: typed project name compared exactly (no trim) — strictness is the point — cost if wrong: user retypes
- Task 3: complete (commits 783d964..e2acf7a, review clean)
- Task 3: minor (deferred): confirmFlagMatches name reads as predicate but throws
- Task 3: minor (deferred): details {level, project} built 4x in confirm.ts
- Task 3: minor (deferred): tty loop inside one test (use it.each)
- Task 3: minor (deferred): untested branches (productionRequiresTty on preview; mismatched --confirm + productionRequiresTty no TTY; preview --no-input + --confirm)
- Task 3: minor (deferred → carried into Task 4): --yes/--confirm help text in main.ts outdated after Ruling 10; productionRequiresTty hint should name the settings command
- Task 3: minor (deferred): preview prompt doubles punctuation if action ends with '.'/'?' — callers pass actions without trailing punctuation
- Task 4: dispatched (BASE e2acf7a, implementer sonnet)
- Task 4: implementer DONE (ab5d535); concerns: settings set not audited (credentialSource required), extra --dry-run on settings set, readConfig rejects wrong shape/version
- Task 4: complete (commits e2acf7a..ab5d535, review clean)
- Task 4: minor (deferred): vacuous unwritable-dir test in config.test.ts (rm-on-failure path uncovered)
- Task 4: minor (deferred): pre-existing dir/audit.log/tmp modes not tightened (mkdir/appendFile mode only on create; tmp opened without 'wx')
- Task 4: minor (deferred): bad-version message doesn't say version 1 expected; delete hint tells agents how to reset settings
- Task 4: minor (deferred): store.ts doc comment vs copied extra fields; rm in catch can mask error; posixOnly/tmp setup duplicated in tests
- Task 4: note (README, Task 16): CF_PAGES_CONFIG_DIR lets a process point at another config (productionRequiresTty off) — inherent to "careless not hostile" threat model; document it
- Ruling 12: AuditEntry.credentialSource becomes optional; `settings set` writes an audit line (command 'settings set', keys ['productionRequiresTty'], result) — disabling a protection is security-relevant and spec §6.2 audits mutations — cost if wrong: one extra log line
- Ruling 13: tests must never touch the real OS keychain; openKeyringStore is tested only with a mocked '@napi-rs/keyring' module — writing to the user's keychain from tests is a side effect outside the repo — cost if wrong: real keyring integration verified only in Task 17
- Task 5: dispatched (BASE ab5d535, implementer sonnet)
- Task 5: implementer DONE_WITH_CONCERNS (fdc7545)
- Ruling 14: with env-var credentials, label = profile label only when profile.accountId === CF_PAGES_ACCOUNT_ID, else 'environment' — showing a stored label for a different account would name the wrong account (spec §4.1 header must identify the account) — cost if wrong: one-line change
- Task 5: complete (commits ab5d535..fdc7545, review clean)
- Task 5: minor (deferred, SECURITY — triage before merge): file-store corrupt() attaches JSON.parse SyntaxError as cause; V8 message can quote credentials.json content (token fragment) — not rendered today
- Task 5: minor (deferred): file-store non-ENOENT read errors rethrown raw (no hint)
- Task 5: minor (deferred, SECURITY): private-file tmp opened with 'w' + predictable pid name (use 'wx'); existing dir mode not tightened
- Task 5: minor (deferred): env-var credentials fail if config.json corrupt
- Task 5: minor (deferred): Session.audit may trigger credential resolution (late header/keychain open)
- Task 5: minor (deferred): keychain read twice (probe + get) per command — possible double macOS prompt
- Task 5: minor (deferred): empty stored token accepted as valid
- Task 5: minor (deferred): weak tests (stored-token redaction uses cf-prefixed token; out.note unasserted; throwing constructor untested)
- Task 5: minor (deferred): expiry warning inclusive at exactly 7 days (spec says "menos de 7")
- Task 6: dispatched (BASE fdc7545, implementer sonnet)
- Task 6: implementer DONE (98bf284) after rate-limit resume; extra guard rejects header-invalid token as auth_invalid
- Task 6: review 1 → Needs fixes (1 Important: ADR written in Spanish, spec §7.2 requires English docs)
- Ruling 15: APPLIED_HINT (plan-mandated text) becomes "The request may or may not have been applied. Check the current state (`cf-pages deployments list <project>` or `cf-pages env list <project>`) before retrying." — v1 PATCHes are env changes, which deployments list doesn't show; spec requires hints to say what to try — cost if wrong: string change; tests pinning the old text updated
- Ruling 16: ApiClient rejects path segments '.' / '..' (raw or percent-encoded) with CliError('usage') before sending — single choke point; prevents misrouted requests from user-supplied ids — cost if wrong: none (no valid Cloudflare id is '.' or '..')
- Task 6: minor (deferred): retry-after HTTP-date not parsed; 5xx retry-after ignored
- Task 6: minor (deferred): throwing debug callback misclassifies response
- Task 6: minor (deferred): transportReason drops inner message when no code
- Task 6: minor (deferred): readOnly vs mutation decided twice
- Task 6: minor (deferred): test gaps (429→5xx mutation sequence, redirect refused, stalled body, weak token-guard leak assertions)
- Task 6: minor (deferred): maxRetries 0 wording; path with '?' + query double '?'; 2xx empty body → api_error (verify DELETE in Task 17)
- Task 6: verify in Task 17: Cloudflare may answer bad tokens with 400 (6003/6111) or 403 (10000) instead of 401 → check mapping/hints live
- Task 6: fix round 1/5 (3 addressed, 0 open — English ADR, ruling-15 hint, ruling-16 dot segments; commits 98bf284..229965b)
- Task 6: complete (commits fdc7545..229965b, review clean)
- Task 6: minor (deferred): tab/newline inside a path segment ('.\t.') collapses to '..' after URL parsing — reject control chars in segments
- Task 7: dispatched (BASE 3d694c0, implementer sonnet)
- Task 7: implementer DONE (baa7beb); note: build_config type lacks web_analytics_token (Task 10 test uses cast), makeDeployment latest_stage/stages independent
- Task 7: complete (commits 3d694c0..baa7beb, review clean)
- Task 7: minor (deferred): list methods assume result is an array (null → TypeError exit 1); add ?? []
- Task 7: minor (deferred): dashboard unverified-section test mirrors implementation; SECTION_PATHS mutable export
- Task 7: minor (deferred): makeDeployment({id}) leaves short_id/url at defaults
- Task 7: minor (deferred): patchEnvVars accepts empty patch (caller short-circuits); weak fixture no-shared-state test; build_config type lacks web_analytics_token
- Task 8: dispatched (BASE baa7beb, implementer sonnet)
- Task 8: implementer DONE (2be42db)
- Ruling 17: `login --token-stdin` with a TTY stdin → usage error (exit 2) before reading; message points to plain `cf-pages login` for the hidden prompt — typing into a TTY stdin echoes the token on screen (spec: token never shown) — cost if wrong: none
- Ruling 18: whoami --json `storage` is the stable enum 'keyring' | 'file' (plus `insecure: true` when file); human output keeps "file (insecure)" — JSON is a machine contract for agents — cost if wrong: one field
- Task 8: minor (deferred): non-TTY login with saved profile returns exit 5 (replace confirm) before the exit-3 "needs a person" check, and opens keyring first
- Task 6: FLAKE (deferred, must fix before merge): 'POST 429 retry-after 2 → retried once and succeeds' failed once under full-suite load (seen during Task 8)
- Task 8: review 1 → Needs fixes (2 Important: unknown-option/excess-arg usage errors echo unprefixed token values; profile-write rollback only covers first login)
- Task 8: minor (deferred): logout with no profile doesn't clean orphaned token; agent check order (exit 5/keyring before "needs a person"); registerSecret splits words; label control/bidi chars; env note when one var set; stray word message; over-claiming tests; auth.ts 546 lines; dry-run lacks write-permission note
- Task 8: fix round 1/5 (2 addressed, 0 open — argv values never echoed; full login rollback; commits 031a55e..2c42e2f)
- Task 8: complete (commits baa7beb..2c42e2f, review clean)
- Task 8: minor (deferred, SECURITY): glued short option `-zSECRET` echoed in unknown-option error; unknown-command keeps plain words ≤25 chars (short alnum secret could echo)
- PAUSED before Task 9 at user request (handoff to another machine)
