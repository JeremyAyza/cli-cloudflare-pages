# 0001. A thin HTTP client of our own on top of `fetch`

- Status: accepted
- Date: 2026-10-21
- Design context: sections 6.4 and 7.3 of `docs/superpowers/specs/2026-10-21-cloudflare-pages-cli-design.md`

## Context

Every call to Cloudflare has to go through a single module. The design offered two ways to build it (section 7.3):

- (a) use the official `cloudflare` SDK v7.3.0, bundling only the part that is used;
- (b) write a thin client of our own on top of `fetch`.

The facts that weigh on the decision:

- The official SDK takes up about **71 MB unpacked**. The published package must stay **under 3 MB** so that `npx cf-pages` starts quickly.
- We need our own control over **retries**. Retrying a `POST`, `PATCH` or `DELETE` after a 5xx or a timeout can duplicate a deployment or repeat a change that was in fact applied. The SDK's automatic retries do not tell reads and mutations apart the way this project requires (Review Focus 1).
- We need our own control over **redaction**. With `--debug` only the method, path, status and duration are printed, never headers or bodies, and every line goes through the `Redactor`.
- Every failure has to become a `CliError` with its exit code (3 auth, 4 not found, 6 API) and a hint about what to try next.
- v1 uses only about **12 endpoints**, all with the same response envelope (`success`, `errors`, `result`, `result_info`).

## Decision

A thin client of our own on top of Node's global `fetch` (Node >= 22.12), in `src/core/http/client.ts`, with no runtime dependencies.

- Auth with `Authorization: Bearer <token>` and `User-Agent: cf-pages/<version>`.
- One timeout per attempt with `AbortSignal.timeout` (30 s by default), which also covers reading the response body.
- Retries:
  - `GET` is repeated on a 5xx, a network error or a timeout, up to 2 times, waiting `500 * 2 ** attempt` ms.
  - Any method is repeated on a 429 whose `retry-after` is at most 10 s (without `retry-after` it waits 1 s), because a 429 means the request was rejected without doing anything. With a `retry-after` above 10 s it fails right away with `rate_limited`.
  - `POST`, `PATCH` and `DELETE` are **never** repeated after a 5xx, a network error or a timeout. They fail with `api_error` and a hint to check the current state (`cf-pages deployments list <project>` or `cf-pages env list <project>`) before retrying.
- Error mapping: 401 -> `auth_invalid`, 403 -> `permission_denied` (the hint names the permission and the tokens page), 404 -> `not_found`, 429 -> `rate_limited`, any other failure -> `api_error`. A `200` with `success: false` is also `api_error`, with Cloudflare's `[code] text` message.
- `ApiError` exposes `status` and `cfErrors`, so domain services can react to specific Cloudflare codes.
- A body that is not JSON (for example an HTML 502) produces a clean `api_error` with the status in the message, never a parse failure.
- Redirects are refused: the API does not use them, and the token must not follow one to another host.
- Paths containing a `.` or `..` segment, raw or percent-encoded, are rejected with a `usage` error before anything is sent, so a name such as `..` cannot make a request address a different endpoint.
- The token, the user agent, `sleep` and the `debug` callback are injected. `Session.client()` builds the client once, with the resolved credentials.

## Consequences

- The package keeps zero runtime dependencies and its size does not depend on the SDK.
- The safe-retry policy lives in one place and has its own tests (msw), including the ones that prove a mutation is not duplicated.
- Endpoints and their types are maintained by hand. If Cloudflare changes a field, the matching view model has to be updated; the msw tests and the check against a real account (section 11) are the safety net.
- We do not inherit future SDK improvements (for example new endpoints). v1 does not need them.
- If the CLI ever grows to cover many more endpoints, this decision can be revisited and option (a) adopted.

## Measurement

The bundle size and the unpacked package size are measured in Task 16 and added here.

_Pending: bundle size will be measured in Task 16._
