# JSON Output Contract

When invoked with `--json`, `cf-pages` writes exactly one JSON document to stdout, and diagnostics/account headers to stderr.

## Success Envelope

```json
{
  "ok": true,
  "data": { ... }
}
```

## Error Envelope

```json
{
  "ok": false,
  "error": {
    "code": "not_found",
    "message": "Resource not found",
    "hint": "What to do next",
    "details": { ... }
  }
}
```

## View Models

### `ProjectSummaryView`
- `name`: string
- `subdomain`: string
- `domains`: string[]
- `productionBranch`: string
- `repo`: string | null
- `production`: `DeploymentView` | null
- `dashboardUrl`: string

### `DeploymentView`
- `id`: string
- `shortId`: string
- `environment`: `'production' | 'preview'`
- `branch`: string
- `commit`: `{ hash, shortHash, message }`
- `state`: `'queued' | 'building' | 'success' | 'failure' | 'canceled' | 'skipped'`
- `skipReason`: string | null
- `createdOn`: ISO 8601 string
- `url`: string
- `aliases`: string[]
- `dashboardUrl`: string

### `EnvVarView`
- `key`: string
- `type`: `'plain_text' | 'secret_text'`
- `readable`: boolean
- `masked`: string | null
- `length`: number | null
- `value`: string (present ONLY if explicitly revealed with `--reveal`)
