# cf-pages CLI v1 — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publicar en npm `cf-pages`, un CLI no oficial, seguro y apto para agentes que gestiona proyectos de Cloudflare Pages conectados a Git: login, proyectos con diagnóstico, deploys (logs, redeploy, retry, rollback) y variables de entorno ocultas con diff y confirmación.

**Architecture:** TypeScript ESM empaquetado con tsdown en un solo `dist/cli.js`. Tres capas:
- `src/core/`: no sabe nada de Pages. Contiene errores, salida, IO y prompts, confirmaciones, configuración, credenciales, cliente HTTP y auditoría.
- `src/providers/pages/`: tipos de la API, endpoints, lógica de deploys, diagnóstico y planes de variables.
- `src/commands/`: comandos commander finos.

Cada comando corre con un `Context` inyectable (IO, entorno, reloj, llavero), y las pruebas lo ejecutan de punta a punta con msw.

**Tech Stack:** Node >=22.12, TypeScript 7, commander 15 + @commander-js/extra-typings, @inquirer/prompts 8, node:util `styleText`/`parseEnv`, @napi-rs/keyring 2 (opcional), tsdown, vitest 5, msw 3, Biome 2.

**Spec:** [docs/superpowers/specs/2026-10-21-cloudflare-pages-cli-design.md](../specs/2026-10-21-cloudflare-pages-cli-design.md). Léelo junto a este plan. Las secciones citadas (§) son de ese documento.

**Fuera de este plan:** la Agent Skill (fase 2 del spec, §9). Tendrá su propio plan cuando el CLI esté estable, porque depende de los nombres y el JSON definitivos.

## Global Constraints

- Paquete y binario: `cf-pages`. Variables de entorno: `CF_PAGES_API_TOKEN`, `CF_PAGES_ACCOUNT_ID` y `CF_PAGES_CONFIG_DIR`, esta última solo para sobrescribir el directorio de configuración. Servicio del llavero: `cf-pages`, cuenta `default`.
- `"engines": { "node": ">=22.12" }`, `"type": "module"`, TypeScript `strict` + `noUncheckedIndexedAccess`.
- Sin `dependencies` en tiempo de ejecución. commander e inquirer van en `devDependencies` y dentro del bundle. Solo `optionalDependencies: { "@napi-rs/keyring": "^2.1.2" }`, marcado como `external` en tsdown.
- Tamaño del paquete desempaquetado: **< 3 MB**.
- Único host de red: `https://api.cloudflare.com/client/v4`. Sin telemetría.
- Todo texto visible en **inglés**. `--help`, README y la descripción de npm incluyen exactamente: `Unofficial. Not affiliated with or endorsed by Cloudflare.`
- Códigos de salida: 0 éxito, 1 inesperado, 2 uso, 3 auth, 4 no encontrado, 5 confirmación requerida/cancelado, 6 error de API, 7 deploy fallido.
- `--json`: **un único** documento en stdout. Éxito: `{ "ok": true, "account"?: {...}, "data": ... }`. Error: `{ "ok": false, "error": { "code", "message", "hint"?, "details"? } }`. Diagnósticos y la cabecera de cuenta van a stderr.
- **Nunca se emiten objetos crudos de la API.** Toda salida pasa por *view models* explícitos, que excluyen `env_vars` (también las copias que trae cada deploy) y `build_config.web_analytics_token`.
- El token nunca se imprime. Ni el token ni los valores de variables se aceptan como argumentos.
- Regla de ocultamiento (§5.4): ≥24 caracteres → 4 + `•••` + 4; de 12 a 23 → 2 + `•••` + 2; <12 → `•••••`; siempre seguido de ` (longitud)`; los secretos se muestran como `[secret — not readable]`.
- Solo hay prompts si stdin **y** stderr son TTY y no se pasó `--no-input`. Los prompts se dibujan en stderr.
- Directorio de configuración con permisos 0700 y archivos con 0600. Las aserciones de permisos se saltan en `win32`.
- Ningún nombre del equipo del autor en `src/` ni en `tests/` (nada de apprunn, rctm, casamarket…). En los ejemplos se usan `my-site`, `example-org` y `Acme`.
- Mensajes de error: qué pasó, qué se esperaba y qué probar (en `hint`).

## Review Focus

1. **Mutaciones reintentadas tras un 5xx o timeout podrían duplicar deploys o cambios.**
   - POST, PATCH y DELETE solo se reintentan ante un 429 con `retry-after` ≤ 10 s.
   - Ante 5xx o timeout terminan con `api_error` y una pista para comprobar con `deployments list`.
   - Prueba: Task 6.
2. **`echo "v" | cf-pages env set …` guardaría un `\n` final.**
   - Se quita exactamente un `\n` o `\r\n` final del stdin.
   - Prueba: Task 14.
3. **Ramas con `/` (por ejemplo `refactor/web-docs`).**
   - Los segmentos de ruta van con `encodeURIComponent`.
   - La rama va sin codificar en el multipart.
   - El filtro de rama es por coincidencia exacta: `refactor/web-docs` no debe coincidir con `refactor/web-docs-2`.
   - Pruebas: Tasks 7, 9 y 11.
4. **Proyectos con `env_vars: null` o sin `deployment_configs.preview`** (habitual en proyectos nuevos).
   - Se tratan como un mapa vacío, sin fallar.
   - Prueba: Task 13.
5. **`--json` de `projects show` o `deployments show` filtrando valores** de `env_vars` (las copias de cada deploy) o `web_analytics_token`.
   - Los view models los excluyen.
   - Pruebas: Tasks 10 y 11.

---

### Task 1: Scaffold del repo + utilidades de formato

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsdown.config.ts`, `vitest.config.ts`, `biome.json`, `.gitignore`, `.nvmrc` (`22`), `LICENSE` (MIT, titular: el autor del repo)
- Create: `src/core/mask.ts`, `src/core/redact.ts`, `src/core/time.ts`
- Test: `tests/core/mask.test.ts`, `tests/core/redact.test.ts`, `tests/core/time.test.ts`

**Interfaces:**
- Produces:
  - `maskValue(value: string): string`
  - `describeMasked(value: string): string`: devuelve `"<mask> (<len>)"`, o `"(empty)"` si el valor está vacío.
  - `SECRET_PLACEHOLDER = '[secret — not readable]'`
  - `interface Redactor { add(secret: string): void; apply(text: string): string }`
  - `createRedactor(): Redactor`
  - `relativeTime(iso: string, now: Date): string`

- [ ] **Step 1: Inicializar el proyecto.** El repo git ya existe: `main` tiene el spec y el plan, y el trabajo va en la rama `feat/cli-v1`. No se ejecuta `git init`.

```bash
cd /Users/desarrollo/Documents/Proyectos/cli-cloudflare-pages
npm init -y
npm i -D typescript@^7.0.2 tsdown@^0.23.1 vitest@^5.0.5 msw@^3.0.3 @biomejs/biome@^2.6.2 @types/node@^22 commander@^15.0.0 @commander-js/extra-typings@^15.0.0 @inquirer/prompts@^8.7.4
npm i -O @napi-rs/keyring@^2.1.2
```

Configuración de los archivos:
- **`package.json`**:
  - `name: "cf-pages"`, `version: "0.1.0"`, `type: "module"`.
  - `description: "Safe, agent-friendly CLI for Cloudflare Pages: deployments, build logs, rollbacks and env vars. Unofficial. Not affiliated with or endorsed by Cloudflare."`
  - `bin: { "cf-pages": "dist/cli.js" }`, `files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"]`, `engines`, `license: "MIT"`.
  - Scripts: `build: tsdown`, `typecheck: tsc --noEmit`, `lint: biome check .`, `test: vitest run`, `prepublishOnly: npm run typecheck && npm test && npm run build`.
- **`tsconfig.json`**: `target ES2023`, `module preserve`, `moduleResolution bundler`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `resolveJsonModule`, `types ["node"]`, `include ["src","tests"]`.
- **`tsdown.config.ts`**: `entry: ['src/cli.ts']`, `format: 'esm'`, `platform: 'node'`, `target: 'node22'`, `dts: false`, `external: ['@napi-rs/keyring']`.
- **`vitest.config.ts`**: `setupFiles: ['tests/setup.ts']`. Se crea `tests/setup.ts` vacío y la Task 2 lo rellena.
- **`.gitignore`**: `node_modules`, `dist`, `*.tgz`, `coverage`.

- [ ] **Step 2: Escribir las pruebas que fallan**

```ts
// tests/core/mask.test.ts
const s = (n: number) => 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'.slice(0, n);
it('24+ chars: 4 + ••• + 4', () => expect(maskValue(s(24))).toBe('abcd•••uvwx'));
it('23 chars: 2 + ••• + 2', () => expect(maskValue(s(23))).toBe('ab•••vw'));
it('12 chars: 2 + ••• + 2', () => expect(maskValue(s(12))).toBe('ab•••kl'));
it('11 chars: fully hidden', () => expect(maskValue(s(11))).toBe('•••••'));
it('describe adds length', () => expect(describeMasked(s(40))).toBe('abcd•••ABCD (40)'));
it('empty value', () => expect(describeMasked('')).toBe('(empty)'));
it('counts code points, never splits emoji', () =>
  expect(describeMasked('🔑'.repeat(24))).toBe('🔑🔑🔑🔑•••🔑🔑🔑🔑 (24)'));

// tests/core/redact.test.ts
it('redacts registered secrets', () => { const r = createRedactor(); r.add('cfat_abcdefgh12345678');
  expect(r.apply('token cfat_abcdefgh12345678 failed')).toBe('token [redacted] failed'); });
it('redacts bearer headers and cf token shapes even if unregistered', () =>
  expect(createRedactor().apply('Authorization: Bearer xyz123 / cfut_zzzzzzzzzz')).toBe('Authorization: Bearer [redacted] / [redacted]'));
it('ignores secrets shorter than 4 chars', () => { const r = createRedactor(); r.add('1'); expect(r.apply('v1.2')).toBe('v1.2'); });

// tests/core/time.test.ts
const now = new Date('2026-10-21T12:00:00Z');
it.each([['2026-10-21T11:59:30Z','just now'],['2026-10-21T11:55:00Z','5m ago'],['2026-10-20T19:00:00Z','17h ago'],
  ['2026-10-18T12:00:00Z','3d ago'],['2026-09-01T00:00:00Z','2026-09-01'],['2026-10-22T00:00:00Z','just now']])
  ('%s → %s', (iso, out) => expect(relativeTime(iso, now)).toBe(out));
```

- [ ] **Step 3: Ejecutar y ver que fallan** — `npx vitest run tests/core` → FAIL (los módulos no existen).

- [ ] **Step 4: Implementar** `src/core/mask.ts`, `redact.ts` y `time.ts`.
  - Ocultamiento: se trabaja con `[...value]` para contar y cortar por *code points*.
  - Redactor: `Set` de secretos con longitud ≥ 4, reemplazando primero el más largo; además, las expresiones regulares `/Bearer\s+\S+/g` → `Bearer [redacted]` y `/\bcf(?:ut|at|k)_[A-Za-z0-9_-]+/g` → `[redacted]`.
  - Tiempo relativo:
    - menos de 60 s, o una fecha futura → `just now`;
    - menos de 60 min → `Nm ago`;
    - menos de 24 h → `Nh ago`;
    - menos de 30 días → `Nd ago`;
    - en otro caso → la parte de fecha ISO.

- [ ] **Step 5: Verificar** — `npx vitest run tests/core && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 6: Commit** (el spec y el plan ya están en `main`)

```bash
git add -A && git commit -m "chore: scaffold cf-pages with masking, redaction and time utils"
```

---

### Task 2: Esqueleto del CLI: errores, IO, salida, `main` y harness de pruebas

**Files:**
- Create: `src/cli.ts`, `src/main.ts`, `src/version.ts`
- Create: `src/core/errors.ts`, `src/core/io.ts`, `src/core/output.ts`, `src/core/context.ts`, `src/core/flags.ts`, `src/core/config/paths.ts`
- Create: `tests/setup.ts`, `tests/helpers/run.ts`, `tests/helpers/cf.ts`, `tests/fixtures/pages.ts`. Los fixtures empiezan vacíos y crecen en la Task 7.
- Test: `tests/cli/skeleton.test.ts`, `tests/core/output.test.ts`

**Interfaces:**
- Produces:
  - `type ErrorCode = 'usage'|'auth_required'|'auth_invalid'|'permission_denied'|'keyring_unavailable'|'not_found'|'confirmation_required'|'cancelled'|'api_error'|'rate_limited'|'verification_failed'|'deployment_failed'|'unexpected'`
  - `EXIT_CODES: Record<ErrorCode, number>`, con esta correspondencia:
    - `usage` → 2
    - `auth_*`, `permission_denied`, `keyring_unavailable` → 3
    - `not_found` → 4
    - `confirmation_required`, `cancelled` → 5
    - `api_error`, `rate_limited`, `verification_failed` → 6
    - `deployment_failed` → 7
    - `unexpected` → 1
  - `class CliError extends Error { code; hint?; details?; get exitCode() }`, con el constructor `(code, message, opts?: { hint?: string; details?: Record<string, unknown>; cause?: unknown })`.
  - `interface Prompts { text(msg, o?: { default?: string; validate?: (v: string) => true | string }): Promise<string>; password(msg): Promise<string>; confirm(msg, o?: { default?: boolean }): Promise<boolean>; select<T extends string>(msg, choices: { value: T; name: string }[]): Promise<T> }`
  - `interface IO { stdout(t: string): void; stderr(t: string): void; stdinIsTTY: boolean; stdoutIsTTY: boolean; stderrIsTTY: boolean; readStdin(): Promise<string>; prompts: Prompts }`
  - `createNodeIO(): IO`: usa inquirer con contexto `{ output: process.stderr }` y convierte `ExitPromptError` en `CliError('cancelled')`.
  - `interface GlobalFlags { json: boolean; yes: boolean; confirm?: string; dryRun: boolean; input: boolean; color: boolean; debug: boolean }`
  - `readGlobalFlags(cmd: Command): GlobalFlags`
  - `interface Context { io: IO; env: Readonly<Record<string, string | undefined>>; platform: NodeJS.Platform; now(): Date; sleep(ms: number): Promise<void>; configDir: string; redactor: Redactor; version: string }`
  - `createNodeContext(): Context`
  - `defaultConfigDir(env, platform, homedir): string`. Usa `CF_PAGES_CONFIG_DIR` si existe; si no, en `win32` `%APPDATA%\cf-pages`, y en el resto `$XDG_CONFIG_HOME/cf-pages` o `~/.config/cf-pages`.
  - `interface Output { data<T>(value: T, human: (v: T) => string): void; note(msg: string): void; warn(msg: string): void; header(a: { label: string; accountId: string }): void }`
  - `createOutput(io, flags): Output`
  - `renderError(io, flags, err: CliError): void`
  - `renderTable(headers: string[], rows: string[][]): string`
  - `paint(io, flags, stream: 'stdout' | 'stderr', format: Parameters<typeof styleText>[0], text: string): string`
  - `main(argv: string[], ctx: Context, configure?: (program: Command) => void): Promise<number>`. `configure` es un hook que solo usan las pruebas para añadir comandos de prueba.
  - `createProgram(ctx: Context): Command`: registra los comandos de las tareas siguientes.
- Test helpers:
  - `runCli(args: string[], opts?: RunOptions): Promise<RunResult>`
  - `RunOptions { env?; stdin?: string; tty?: boolean; answers?: (string | boolean)[]; configDir?: string; now?: Date }`
  - `RunResult { exitCode; stdout; stderr; prompts: string[]; json<T = any>(): T }`
  - Si se pide un prompt y la cola `answers` está vacía, se lanza `Error('Unexpected prompt: …')`.
  - `fakeIO(opts: { tty?: boolean; stdin?: string; answers?: (string | boolean)[] }): IO & { out: string; err: string; prompts: string[] }`, para las pruebas unitarias.
  - `tests/setup.ts` exporta `server = setupServer()` con `onUnhandledRequest: 'error'`.
  - `tests/helpers/cf.ts`:
    - `ACCT = '0123456789abcdef0123456789abcdef'`
    - `cfUrl(path)`
    - `ok(result, resultInfo?)`
    - `fail(status, code, message)`
    - `recordRequests()`, que devuelve `{ method, path, search, json?, form? }[]` mediante `server.events`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
// tests/cli/skeleton.test.ts
it('--version prints package version', async () => {
  const r = await runCli(['--version']); expect(r.exitCode).toBe(0); expect(r.stdout.trim()).toBe(pkg.version); });
it('help shows disclaimer and exit codes', async () => {
  const r = await runCli(['--help']); expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('Unofficial. Not affiliated with or endorsed by Cloudflare.');
  expect(r.stdout).toContain('7  deployment finished in failure (--wait)'); });
it('unknown option → exit 2 and a single JSON error document', async () => {
  const r = await runCli(['--json', '--bogus']); expect(r.exitCode).toBe(2);
  expect(r.json()).toEqual({ ok: false, error: expect.objectContaining({ code: 'usage' }) }); });
it('unknown command → exit 2', async () => expect((await runCli(['nope'])).exitCode).toBe(2));

// tests/core/output.test.ts
it('json mode emits one envelope with account', ...);   // header({label:'Acme',accountId:ACCT}) + data({a:1}) → stdout === JSON {ok:true,account:{label:'Acme',accountId:ACCT},data:{a:1}}
it('human mode writes header to stderr as "Acme · account …9abcdef"', ...);   // "…" + last 7 chars of the account ID
it('data() twice throws', ...);
it('renderError in json writes {ok:false,error:{code,message,hint}} to stdout', ...);
it('unexpected error messages are redacted', ...); // main(argv, ctx, p => p.command('boom').action(() => { throw new Error('boom cfat_secretsecret') })) → stderr lacks 'cfat_secretsecret', exit 1
it('no color when NO_COLOR set or stream not TTY', ...);
```

- [ ] **Step 2: Ejecutar y ver que fallan** — `npx vitest run tests/cli tests/core/output.test.ts` → FAIL.

- [ ] **Step 3: Implementar** los archivos de la lista.
  - **Programa raíz (`main`)**:
    - `program.name('cf-pages').description('Manage Cloudflare Pages projects from the terminal. Unofficial. Not affiliated with or endorsed by Cloudflare.').version(ctx.version)`.
    - Opciones globales: `--json`, `-y, --yes`, `--confirm <project>`, `--dry-run`, `--no-input`, `--no-color` y `--debug`.
    - `exitOverride()` y `configureOutput({ writeOut: io.stdout, writeErr: io.stderr })`. Los `CommanderError` `commander.helpDisplayed` y `commander.version` devuelven 0; cualquier otro `CommanderError` se convierte en `CliError('usage')`.
    - Cuando falla el parseo, el modo JSON se detecta con `argv.includes('--json')`.
    - Los errores que no son `CliError` pasan a `CliError('unexpected', redactor.apply(err.message))`. Con `--debug`, se escribe además en stderr el stack redactado.
  - **Ayuda**: añadir con `addHelpText('after', …)` este bloque exacto:

```
Exit codes:
  0  success
  1  unexpected error
  2  invalid usage
  3  authentication required or invalid
  4  not found (project, deployment, variable)
  5  confirmation required or cancelled
  6  Cloudflare API error (including rate limiting)
  7  deployment finished in failure (--wait)
```

  - `src/version.ts` importa `package.json` con `with { type: 'json' }` y exporta `VERSION`.
  - `src/cli.ts` empieza con `#!/usr/bin/env node` y ejecuta `process.exitCode = await main(process.argv.slice(2), createNodeContext())`.
  - **Color**: `styleText` con `{ stream }`. Se desactiva si `flags.color === false`, si existe `NO_COLOR` o si el stream no es una TTY.

- [ ] **Step 4: Verificar** — `npx vitest run && npm run typecheck && npm run build && node dist/cli.js --help` → PASS, y la ayuda muestra el disclaimer.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: CLI skeleton with JSON envelope, exit codes and test harness"`

---

### Task 3: Niveles de confirmación

**Files:**
- Create: `src/core/confirm.ts`
- Test: `tests/core/confirm.test.ts` (con un `IO` falso de `tests/helpers/run.ts`, exportado como `fakeIO(opts)`)

**Interfaces:**
- Consumes: `IO`, `GlobalFlags` y `CliError` de la Task 2.
- Produces:
  - `type ConfirmLevel = 'preview' | 'production'`
  - `interface Settings { productionRequiresTty: boolean }`
  - `canPrompt(io: IO, flags: GlobalFlags): boolean`, que vale `io.stdinIsTTY && io.stderrIsTTY && flags.input`.
  - `confirmMutation(io, flags, settings: Settings, req: { level: ConfirmLevel; project: string; action: string }): Promise<void>`

- [ ] **Step 1: Escribir las pruebas que fallan** (`p = { project: 'my-site', action: 'Redeploy main' }`)

```ts
it('preview + tty + yes answer → resolves; prompt mentions action', ...);       // answers [true]; prompts[0] contains 'Redeploy main'
it('preview + tty + no → cancelled (exit 5)', ...);                              // answers [false]
it('preview + no tty, no flags → confirmation_required mentioning --yes', ...);
it('preview + no tty + --yes → resolves', ...);
it('production + no tty + --yes only → confirmation_required', ...);            // message contains '--confirm my-site' and '--yes is not enough'
it('production + no tty + --confirm my-site → resolves', ...);
it('production + no tty + --confirm other → usage', ...);
it('production + tty: typing "my-site" resolves, "my-sit" cancels', ...);
it('production + tty + --confirm my-site → resolves without prompting', ...);   // prompts.length === 0
it('productionRequiresTty + no tty + --confirm my-site → confirmation_required mentioning productionRequiresTty', ...);
it('tty but --no-input behaves as non-interactive', ...);
```

- [ ] **Step 2: Ejecutar** — `npx vitest run tests/core/confirm.test.ts` → FAIL.

- [ ] **Step 3: Implementar `confirmMutation`** según §6.1 y §6.5. Textos exactos:
  - Prompt de producción: `Type the project name (my-site) to confirm:`
  - Prompt de preview: `<action>. Continue?`, con `default: false`.
  - Sin TTY en producción: `This changes production. Re-run with --confirm <project> (--yes is not enough).`

- [ ] **Step 4: Verificar** — PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat: confirmation levels for preview and production mutations"` (con `git add` de los archivos nuevos).

---

### Task 4: Configuración, auditoría y el comando `settings`

**Files:**
- Create: `src/core/config/store.ts`, `src/core/audit.ts`, `src/commands/settings.ts`
- Modify: `src/main.ts` (registrar `settings`)
- Test: `tests/core/config.test.ts`, `tests/core/audit.test.ts`, `tests/commands/settings.test.ts`

**Interfaces:**
- Consumes: `Settings` y `confirmMutation`/`canPrompt` de la Task 3.
- Produces:
  - `interface ProfileConfig { label: string; accountId: string; storage: 'keyring' | 'file'; tokenType: 'user' | 'account'; tokenExpiresOn?: string; createdAt: string }`
  - `interface ConfigFile { version: 1; profiles: { default?: ProfileConfig }; settings: Settings }`
  - `readConfig(dir): Promise<ConfigFile>`:
    - si el archivo no existe, devuelve una copia del valor por defecto con `productionRequiresTty: false`;
    - si el JSON está corrupto, lanza `CliError('unexpected', …, { hint: '<path>' })`.
  - `writeConfig(dir, cfg): Promise<void>`: crea el directorio con 0700, escribe un `.tmp` con 0600 y luego hace `rename`.
  - `CONFIG_FILE = 'config.json'`
  - `interface AuditEntry { ts: string; command: string; project?: string; env?: 'production' | 'preview'; deploymentId?: string; keys?: string[]; result: 'ok' | 'error'; errorCode?: string; credentialSource: 'env' | 'keyring' | 'file' }`
  - `appendAudit(dir, entry): Promise<boolean>`: escribe JSONL en `audit.log` con 0600 y devuelve `false` si falla, sin lanzar.
  - Comandos `settings get [key]` y `settings set <key> <value>`. La única clave es `productionRequiresTty` y los únicos valores, `true` o `false`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('read missing config returns defaults', ...);
it('write → read roundtrip; dir 0700, file 0600 (skip win32)', ...);
it('corrupt config → CliError unexpected with path hint', ...);
it('appendAudit writes one JSON object per line, 0600', ...);
it('settings set without TTY → exit 5 and config unchanged', async () => {
  const r = await runCli(['settings', 'set', 'productionRequiresTty', 'false'], { configDir });
  expect(r.exitCode).toBe(5); expect(r.stderr).toContain('only be changed from an interactive terminal'); });
it('settings set in TTY with confirmation updates config', ...);   // tty:true, answers [true]
it('settings set unknown key or value → exit 2', ...);
it('settings get --json → {ok:true,data:{productionRequiresTty:false}}', ...);
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar.** `settings set` exige `canPrompt`. Así un agente no puede desactivar la protección (§6.5). Sin TTY, lanza `CliError('confirmation_required', 'Settings can only be changed from an interactive terminal.')`. En una TTY pregunta `Set productionRequiresTty to <v>?`.
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: config store, audit log and settings command`

---

### Task 5: Almacenes de secretos, resolución de credenciales y `Session`

**Files:**
- Create: `src/core/credentials/types.ts`, `src/core/credentials/keyring-store.ts`, `src/core/credentials/file-store.ts`, `src/core/credentials/resolve.ts`, `src/core/session.ts`
- Modify: `src/core/context.ts` (añadir `openKeyring(): Promise<SecretStore>`), `tests/helpers/run.ts` (añadir la opción `keyring?: Map<string, string> | 'unavailable'` y el helper `loggedIn(opts?)`)
- Test: `tests/core/credentials.test.ts`, `tests/core/file-store.test.ts`

**Interfaces:**
- Consumes: `readConfig` (Task 4), `Context` y `Output` (Task 2), `confirmMutation` (Task 3), `appendAudit` (Task 4).
- Produces:
  - `interface SecretStore { readonly kind: 'keyring' | 'file'; get(account: string): Promise<string | null>; set(account: string, secret: string): Promise<void>; delete(account: string): Promise<boolean> }`
  - `type CredentialSource = 'env' | 'keyring' | 'file'`
  - `interface Credentials { token: string; accountId: string; label: string; source: CredentialSource; storage?: 'keyring' | 'file'; tokenType?: 'user' | 'account'; tokenExpiresOn?: string }`
  - `KEYRING_SERVICE = 'cf-pages'`, `PROFILE = 'default'`
  - `KEYRING_HINT = 'Set CF_PAGES_API_TOKEN and CF_PAGES_ACCOUNT_ID, or run \`cf-pages login --insecure-storage\` to store the token in a 0600 file.'`
  - `openKeyringStore(): Promise<SecretStore>`:
    - hace `import('@napi-rs/keyring')` y usa `new AsyncEntry(KEYRING_SERVICE, account, { linux: { store: 'secret-service' } })` con `getPassword`, `setPassword` y `deleteCredential`;
    - prueba el almacén con `get(PROFILE)`;
    - si falla la importación o la prueba, lanza `CliError('keyring_unavailable', 'No secure credential store is available on this system.', { hint: KEYRING_HINT })`.
  - `fileSecretStore(dir): SecretStore`: guarda `credentials.json` como `{ "<account>": "<token>" }`, con 0600.
  - `resolveCredentials(ctx): Promise<Credentials>`
  - `interface Session { ctx: Context; flags: GlobalFlags; out: Output; settings(): Promise<Settings>; credentials(): Promise<Credentials>; confirm(req: { level: ConfirmLevel; project: string; action: string }): Promise<void>; audit(e: Omit<AuditEntry, 'ts' | 'credentialSource'>): Promise<void> }`
  - `createSession(ctx, flags): Session`

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('env vars take precedence over stored profile', ...);               // source 'env', label from profile ('Acme') or 'environment'
it('only CF_PAGES_API_TOKEN set → auth_invalid naming CF_PAGES_ACCOUNT_ID', ...);
it('CLOUDFLARE_API_TOKEN alone is ignored → auth_required', ...);
it('not logged in → auth_required with hint "Run `cf-pages login` in your terminal."', ...);
it('profile present but keyring entry missing → auth_required "Stored credentials are incomplete"', ...);
it('storage file reads credentials.json', ...);
it('resolved token is registered in the redactor', ...);                // ctx.redactor.apply(token) === '[redacted]'
it('session.credentials() warns when token expires within 7 days, not at 8', ...);
it('session.credentials() emits account header once', ...);
it('session.audit() fills ts and credentialSource; failure only warns', ...);
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar** según §4.2. `Session.credentials()` se memoriza: añade el token al redactor, emite `out.header` y, si `tokenExpiresOn` cae en menos de 7 días desde `ctx.now()`, avisa con `out.warn('API token expires on YYYY-MM-DD.')`.
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: keyring/file secret stores and credential resolution`

---

### Task 6: Cliente HTTP de la API de Cloudflare

**Decisión (§7.3, opción b):** cliente propio y fino sobre `fetch`. Motivos:
- Medido: el SDK ocupa unos 71 MB desempaquetado.
- Necesitamos de todas formas control propio de reintentos (que no deben duplicar mutaciones), de la redacción y de la correspondencia con los códigos de salida.
- v1 usa solo 12 endpoints.

Se documenta en `docs/decisions/0001-http-client.md`, con la medida del bundle que se añade en la Task 16.

**Files:**
- Create: `src/core/http/client.ts`, `docs/decisions/0001-http-client.md`
- Modify: `src/core/session.ts` (añadir `client(): Promise<ApiClient>`)
- Test: `tests/core/http-client.test.ts`

**Interfaces:**
- Consumes: `CliError` y `Redactor`.
- Produces:
  - `API_BASE = 'https://api.cloudflare.com/client/v4'`
  - `API_TOKENS_URL = 'https://dash.cloudflare.com/profile/api-tokens'`
  - `interface CfError { code: number; message: string }`
  - `interface ResultInfo { page: number; per_page: number; count: number; total_count: number; total_pages: number }`
  - `interface RequestOptions { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; query?: Record<string, string | number | undefined>; json?: unknown; form?: Record<string, string> }`
  - `class ApiError extends CliError { status: number; cfErrors: CfError[] }`
  - `new ApiClient({ token, userAgent, sleep, debug?: (line: string) => void, timeoutMs = 30_000, maxRetries = 2 })`
  - `.request<T>(o: RequestOptions): Promise<{ result: T; resultInfo?: ResultInfo }>`

- [ ] **Step 1: Escribir las pruebas que fallan** (msw)

```ts
it('sends Bearer token and User-Agent cf-pages/<version>; returns result and result_info', ...);
it('GET retries 5xx twice with backoff then succeeds', ...);           // 500,500,200 → ok; sleep called with 500 then 1000
it('GET 503 x3 → ApiError api_error, exit 6', ...);
it('POST 500 is NOT retried; hint says it may or may not have been applied', async () => {
  // 1 request recorded; err.hint contains 'may or may not have been applied' and 'cf-pages deployments list'
});
it('POST 429 retry-after 2 → retried once and succeeds', ...);
it('429 retry-after 300 → rate_limited immediately, message mentions 300', ...);
it('401 → auth_invalid; 403 → permission_denied with API_TOKENS_URL in hint; 404 → not_found', ...);
it('200 with success:false → api_error "[8000007] …"', ...);
it('form option sends multipart with branch=refactor/web-docs unencoded', ...);
it('debug lines never contain the token or bodies', ...);               // debug spy; line like 'GET /accounts/…/pages/projects 200 12ms'
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar** según §6.4 y la Review Focus 1.
  - Hint para mutaciones con 5xx o timeout: `The request may or may not have been applied. Check with \`cf-pages deployments list <project>\` before retrying.`
  - Hint para 403: `The API token needs the "Cloudflare Pages: Edit" permission (Read for read-only commands) on this account. Manage tokens: <API_TOKENS_URL>`
  - El timeout usa `AbortSignal.timeout`.
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: Cloudflare API client with safe retries and error mapping`

---

### Task 7: Capa de la API de Pages, tipos y URLs del dashboard

**Files:**
- Create: `src/providers/pages/types.ts`, `src/providers/pages/api.ts`, `src/providers/pages/dashboard.ts`, `src/commands/shared.ts`
- Modify: `tests/fixtures/pages.ts` (añadir `makeProject(overrides?)` y `makeDeployment(overrides?)`). Valores por defecto:
  - proyecto `my-site`, subdominio `my-site.pages.dev`, `production_branch: 'main'`;
  - `source` de GitHub con `example-org/my-site`, `production_deployments_enabled: true` y `preview_deployment_setting: 'all'`;
  - `deployment_configs` con `env_vars: {}` en producción y en preview.
- Test: `tests/providers/pages/api.test.ts`, `tests/providers/pages/dashboard.test.ts`

**Interfaces:**
- Consumes: `ApiClient` (Task 6) y `Session` (Task 5).
- Produces (los tipos siguen los esquemas `pages_*` del OpenAPI `cloudflare/api-schemas`):
  - `type PagesEnv = 'production' | 'preview'`
  - `type EnvVar = { type: 'plain_text'; value: string } | { type: 'secret_text'; value?: string }`
  - `type EnvVars = Record<string, EnvVar>`
  - `interface Stage { name: string; status: string; started_on: string | null; ended_on: string | null }`
  - `interface Deployment { id: string; short_id: string; project_name: string; environment: PagesEnv; url: string; aliases: string[] | null; created_on: string; modified_on: string; is_skipped: boolean; skip_reason?: string | null; latest_stage: Stage; stages: Stage[]; deployment_trigger: { type: string; metadata: { branch: string; commit_hash: string; commit_message: string; commit_dirty: boolean } } }`
  - `interface DeploymentConfig { env_vars?: Record<string, EnvVar | null> | null; wrangler_config_hash?: string | null; build_image_major_version?: number | null }`
  - `interface SourceConfig { owner: string; repo_name: string; production_deployments_enabled?: boolean; preview_deployment_setting?: 'all' | 'none' | 'custom'; preview_branch_includes?: string[]; preview_branch_excludes?: string[]; path_includes?: string[]; path_excludes?: string[] }`
  - `interface Project { id: string; name: string; subdomain: string; domains: string[]; production_branch: string; created_on: string; source?: { type: string; config: SourceConfig } | null; build_config?: { build_command?: string | null; destination_dir?: string | null; root_dir?: string | null } | null; deployment_configs: { production?: DeploymentConfig; preview?: DeploymentConfig }; latest_deployment?: Deployment | null; canonical_deployment?: Deployment | null }`
  - `interface DeploymentLogs { total: number; includes_container_logs: boolean; data: { ts: string; line: string }[] }`
  - `interface Domain { name: string; status: string; validation_data?: { status?: string; method?: string; error_message?: string } | null }`
  - `type EnvVarPatch = Record<string, { type: 'plain_text' | 'secret_text'; value: string } | null>`
  - `class PagesApi`, construido con `(client, accountId)`. Métodos:
    - `probe()`
    - `listProjects()`, que pagina con `per_page=10`
    - `getProject(name)`
    - `listDeploymentsPage(name, { env?, page, perPage }) → { items, totalPages }`
    - `getDeployment(name, id)`
    - `getDeploymentLogs(name, id)`
    - `createDeployment(name, branch)`
    - `retryDeployment(name, id)`
    - `rollbackDeployment(name, id)`
    - `patchEnvVars(name, env, patch, opts?: { wranglerConfigHash?: string | null }) → Project`
    - `listDomains(name)`
  - `DASH_BASE = 'https://dash.cloudflare.com'`
  - `projectDashboardUrl(acct, project)`, `deploymentDashboardUrl(acct, project, id)`
  - `type DashboardSection = 'deployments' | 'settings' | 'domains' | 'variables' | 'builds'`
  - `SECTION_PATHS: Record<DashboardSection, string | null>`: todos `null` hasta la Task 17; `null` significa que se usa la URL del proyecto.
  - `sectionDashboardUrl(acct, project, section)`
  - `GITHUB_APP_URL = 'https://github.com/apps/cloudflare-workers-and-pages'` (se verifica en la Task 17)
  - `pagesApi(s: Session): Promise<{ api: PagesApi; accountId: string }>`

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('probe → GET /accounts/ACCT/pages/projects?per_page=1', ...);
it('listProjects paginates until total_pages', ...);                   // 2 pages of 10 + 3
it('listDeploymentsPage passes env, page, per_page', ...);
it('createDeployment posts multipart with only branch field', ...);    // form === { branch: 'refactor/web-docs' }
it('retry/rollback POST to /deployments/<id>/retry|rollback', ...);
it('path segments are encodeURIComponent-ed', ...);                    // id 'a/b' → '/deployments/a%2Fb'
it('patchEnvVars sends exactly the patch under deployment_configs[env].env_vars', async () => {
  // json === { deployment_configs: { production: { env_vars: { A: { type: 'plain_text', value: '1' }, B: null } } } }
});
it('patchEnvVars keeps wrangler_config_hash when given', ...);         // json.deployment_configs.preview.wrangler_config_hash === 'abc'
it('dashboard urls', () => {
  expect(projectDashboardUrl(ACCT, 'my-site')).toBe(`https://dash.cloudflare.com/${ACCT}/pages/view/my-site`);
  expect(deploymentDashboardUrl(ACCT, 'my-site', 'd1')).toBe(`https://dash.cloudflare.com/${ACCT}/pages/view/my-site/d1`);
  expect(sectionDashboardUrl(ACCT, 'my-site', 'domains')).toBe(projectDashboardUrl(ACCT, 'my-site')); // unverified → project
});
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar.** `wranglerConfigHash` imita lo que hace Wrangler: reenvía el hash existente junto a `env_vars` (spec §3; se comprueba en la Task 17, punto 4).
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: Pages API layer, types and dashboard URLs`

---

### Task 8: Comandos de auth: `login`, `logout`, `whoami`

**Files:**
- Create: `src/core/credentials/token.ts`, `src/commands/auth.ts`
- Modify: `src/main.ts` (registrar)
- Test: `tests/core/token.test.ts`, `tests/commands/auth.test.ts`

**Interfaces:**
- Consumes: `ApiClient`, `PagesApi.probe`, almacenes, `writeConfig`/`readConfig`, `canPrompt` y `Session`.
- Produces:
  - `type TokenKind = 'user' | 'account' | 'global_key' | 'unknown'`
  - `classifyToken(token): TokenKind`:
    - prefijo `cfut_` → `user`;
    - prefijo `cfat_` → `account`;
    - prefijo `cfk_`, o el patrón `/^[0-9a-f]{37}$/` → `global_key`;
    - cualquier otro → `unknown`.
  - `verifyToken(client, accountId, kind): Promise<{ tokenType: 'user' | 'account'; status: string; expiresOn?: string }>`:
    - `user` → `GET /user/tokens/verify`;
    - `account` → `GET /accounts/{acct}/tokens/verify`;
    - `unknown` → primero el de usuario y, si hay un `ApiError` con `cfErrors` que incluye el código 1000, el de cuenta.
  - Comandos `login [--label <label>] [--account-id <id>] [--token-stdin] [--insecure-storage]`, `logout` y `whoami`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('classifyToken', () => { expect(classifyToken('cfut_x')).toBe('user'); expect(classifyToken('cfat_x')).toBe('account');
  expect(classifyToken('cfk_x')).toBe('global_key'); expect(classifyToken('a'.repeat(37))).toBe('global_key'); expect(classifyToken('legacy-token')).toBe('unknown'); });
it('unprefixed token: user verify code 1000 → account verify', ...);
it('interactive login stores token in keyring and profile in config', async () => {
  // tty, answers ['Acme', ACCT, 'cfat_test_token_value_1234567890']; requests: GET /accounts/ACCT/tokens/verify, GET /accounts/ACCT/pages/projects?per_page=1
  // keyring.get('default') === token; config.profiles.default matches {label:'Acme',accountId:ACCT,storage:'keyring',tokenType:'account'}
  // stdout+stderr never contain the token; stderr mentions 'Cloudflare Pages · Edit' guidance and that Edit can't be verified until the first change
});
it('non-TTY without --token-stdin → exit 3, asks a person to run login in their own terminal', ...);
it('--token-stdin with --label/--account-id works non-interactively', ...);
it('Global API Key rejected with exit 2 before any request', ...);
it('invalid account id format → exit 2', ...);                          // not 32 hex chars
it('token status "disabled" → exit 3, nothing stored', ...);
it('pages probe 403 → exit 3 permission_denied, nothing stored', ...);
it('keyring unavailable → exit 3 with KEYRING_HINT before any prompt', ...);   // prompts.length === 0
it('--insecure-storage writes credentials.json 0600 and warns', ...);
it('already logged in + non-TTY without --yes → exit 5', ...);
it('logout clears keyring and profile; second logout says "Already logged out" with exit 0', ...);
it('whoami shows label, account, type, source, storage, expiry and live status, never the token', ...); // --json data keys: label, accountId, tokenType, source, storage, expiresOn, status
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar** según §4.1. El orden del login es este:
  1. Elegir y probar el almacén (o `--insecure-storage`).
  2. Si ya hay un perfil, confirmar que se reemplaza.
  3. Obtener el label (1–64 caracteres), el Account ID (`/^[0-9a-f]{32}$/`) y el token, que se recorta y no puede tener espacios.
  4. Clasificar el token.
  5. Verificarlo y exigir `status === 'active'`.
  6. `probe()`.
  7. Guardar.

  Textos exactos:
  - Guía (stderr, antes del prompt del token): `Create a token at https://dash.cloudflare.com/profile/api-tokens (or an account-owned token under Manage Account → Account API Tokens) with the permission: Account · Cloudflare Pages · Edit.`
  - Sin TTY: `Login needs a person at a terminal. Run \`cf-pages login\` in your own terminal (or pipe the token with --token-stdin).`
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: login, logout and whoami with token validation`

---

### Task 9: Lógica de deploys

**Files:**
- Create: `src/providers/pages/deployments.ts`
- Test: `tests/providers/pages/deployments.test.ts`

**Interfaces:**
- Consumes: `PagesApi` y `Deployment` (Task 7).
- Produces:
  - `type DeploymentState = 'queued' | 'building' | 'success' | 'failure' | 'canceled' | 'skipped'`
  - `deploymentState(d): DeploymentState`. Se decide en este orden:
    1. `is_skipped` → `skipped`;
    2. `latest_stage.status` es `failure`, `canceled` o `skipped` → ese mismo estado;
    3. `name === 'deploy'` con `status === 'success'` → `success`;
    4. `name === 'queued'` → `queued`;
    5. en cualquier otro caso → `building`.
  - `isTerminal(s)`
  - `collectDeployments(api, project, { env?, branch?, limit }): Promise<Deployment[]>`:
    - pide páginas con `perPage` 25 hasta reunir `limit` o agotar `totalPages`, con un máximo de 8 páginas;
    - filtra por rama con coincidencia exacta;
    - ordena por `created_on` descendente.
  - `latestByBranch(ds): { branch: string; deployment: Deployment }[]`: el deploy más nuevo de cada rama, ordenados del más nuevo al más antiguo.
  - `resolveDeploymentRef(api, project, ref: string | undefined, opts: { branch?: string }): Promise<Deployment>`:
    - `undefined` o `latest` → el más nuevo, de la rama indicada si hay una;
    - `/^[0-9a-f]{8}$/i` → busca el `short_id` entre los 100 más recientes;
    - cualquier otro valor → `getDeployment`.
  - `currentProductionDeployment(project, productionDeployments): Deployment | undefined`: `canonical_deployment`, o en su defecto el deploy de producción exitoso más nuevo.
  - `findRollbackTarget(productionDeployments, current): Deployment | undefined`: el deploy de producción exitoso más nuevo que sea anterior a `current`, con un id distinto.
  - `waitForDeployment(api, project, id, { sleep, now, intervalMs = 5000, timeoutMs = 1_200_000, onState? }): Promise<Deployment>`

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it.each([...])('deploymentState %s', ...);                              // one row per rule above
it('collectDeployments filters exact branch (refactor/web-docs ≠ refactor/web-docs-2) and sorts newest first', ...);
it('collectDeployments stops at limit and at totalPages', ...);
it('resolveDeploymentRef: latest, latest on branch, short id, full id, not found → exit 4 "No deployment with short id …"', ...);
it('findRollbackTarget skips failed, skipped, preview and newer deployments', ...);
it('waitForDeployment polls until success, calling onState on each change', ...);
it('waitForDeployment times out after 20 minutes with api_error and dashboard hint', ...); // fake now()
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: deployment state, listing, refs, rollback target and wait`

---

### Task 10: Diagnóstico, view models y `projects list/show`

**Files:**
- Create: `src/providers/pages/diagnose.ts`, `src/providers/pages/views.ts`, `src/commands/projects.ts`
- Modify: `src/main.ts`
- Test: `tests/providers/pages/diagnose.test.ts`, `tests/commands/projects.test.ts`

**Interfaces:**
- Consumes: la Task 9 completa y las URLs del dashboard (Task 7).
- Produces:
  - `type FindingCode = 'no_git_source' | 'production_deployments_disabled' | 'preview_deployments_disabled' | 'preview_branches_filtered' | 'watch_paths' | 'wrangler_config_managed' | 'skipped' | 'latest_failed' | 'expect_found' | 'expect_missing'`
  - `interface Finding { level: 'info' | 'warning'; code: FindingCode; message: string; hint?: string }`
  - `isWranglerManaged(p: Project): boolean`: `wrangler_config_hash` no vacío en producción o en preview.
  - `diagnoseProject({ project, deployments, expect?: { sha: string; branch?: string } }): Finding[]`
  - `SKIP_REASON_TEXT: Record<string, string>`
  - `interface DeploymentView { id; shortId; environment; branch; commit: { hash; shortHash; message }; state: DeploymentState; skipReason: string | null; createdOn; url; aliases: string[]; dashboardUrl }`
  - `deploymentView(d, acct): DeploymentView`
  - `interface ProjectSummaryView { name; subdomain; domains: string[]; productionBranch; repo: string | null; production: DeploymentView | null; dashboardUrl }`
  - `projectSummaryView(p, acct)`
  - `ProjectDetailView`, que añade a lo anterior:
    - `git: { provider, repo, productionDeploymentsEnabled, previewSetting, previewIncludes, previewExcludes, pathIncludes, pathExcludes } | null`;
    - `build: { command, outputDir, rootDir, imageVersion }`;
    - `wranglerManaged`;
    - `domains: { name, status, error }[]`;
    - `latestByBranch: DeploymentView[]`, con un máximo de 10;
    - `findings: Finding[]`.
  - `projectDetailView(p, domains, deployments, findings, acct)`
  - Comandos `projects list` y `projects show <project> [--expect <sha>] [--branch <branch>]`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
// diagnose (one test per code; exact copy where fixed)
it('production disabled', ...);   // message 'Automatic production deployments are disabled for this project.'
it('preview none / custom filters / watch paths / wrangler hash', ...);
it('skipped deployment uses SKIP_REASON_TEXT', ...);   // commit_message → 'Deployment ab12cd34 (main 1a2b3c4) was skipped because the commit message contains a skip flag such as [skip ci] or [CF-Pages-Skip].'
it('latest failed on a branch → hint "cf-pages deployments logs my-site <short>"', ...);
it('expect sha found → expect_found with state', ...);
it('expect sha missing and unexplained → expect_missing', ...); // message starts 'No deployment found for commit 1a2b3c4 on main.'; hint contains 'cf-pages deployments redeploy my-site --branch main' and GITHUB_APP_URL
it('expect missing but production disabled → no expect_missing (already explained)', ...);
it('--expect with non-hex or <7 chars → exit 2', ...);
// commands
it('projects list (human) shows name, repo, production state and age', ...);
it('projects list --json returns ProjectSummaryView[] with dashboardUrl', ...);
it('any command needing credentials without login → exit 3', ...);
it('projects show --json never leaks env var values or web_analytics_token', async () => {
  // fixture: canonical_deployment/latest_deployment/deployments with env_vars {SECRET_PLAIN:{type:'plain_text',value:'super-secret-plain'}}, build_config.web_analytics_token 'wat-123'
  // expect(r.stdout).not.toContain('super-secret-plain'); expect(r.stdout).not.toContain('wat-123');
});
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar.**
  - Textos exactos de `SKIP_REASON_TEXT`:
    - `commit_message`: `skipped because the commit message contains a skip flag such as [skip ci] or [CF-Pages-Skip]`
    - `preview_deployments_disabled`: `skipped because preview deployments are disabled`
    - `production_deployments_disabled`: `skipped because production deployments are disabled`
    - `path_config`: `skipped by build watch paths (no matching files changed)`
    - `branch_config`: `skipped by branch deployment controls`
    - `superseded_queued_build`: `skipped because a newer build for the same branch replaced it in the queue`
    - `pages_to_workers_conversion`: `skipped during a Pages-to-Workers conversion`
    - cualquier otro valor: `skipped (<reason>)`
  - `projects show` pide el proyecto, los dominios y `collectDeployments` con `limit 50`.
  - Salida humana por secciones: Project, Git, Auto-deploy, Build, Domains, Latest per branch, Diagnosis y Dashboard.
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: projects list/show with push diagnosis`

---

### Task 11: `deployments list/show/logs`

**Files:**
- Create: `src/commands/deployments.ts` (solo lectura en esta tarea)
- Modify: `src/main.ts` (registrar `deployments` con el alias `deploys`)
- Test: `tests/commands/deployments-read.test.ts`

**Interfaces:**
- Consumes: Tasks 9 y 10 (`deploymentView`).
- Produces:
  - `deployments list <project> [--env <production|preview>] [--branch <b>] [--limit <n>]`, con límite por defecto de 20 y rango de 1 a 200.
  - `deployments show <project> <deployment>`: el JSON es `DeploymentView` más `stages` y `trigger`.
  - `deployments logs <project> [deployment] [--branch <b>] [--tail <n>] [--output <file>]`. Su JSON:
    - por defecto: `{ deployment: DeploymentView, total, returned, truncated, lines: { ts, line }[] }`;
    - con `--output`: `{ deployment, total, path }`.
  - `formatLogLines(lines): string`, que genera `"<ts>  <line>"` por línea. La Task 12 lo reutiliza.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('list filters exact branch with slash', ...);                       // --branch refactor/web-docs
it('list --limit 0 or 201 → exit 2', ...);
it('show --json excludes env_vars snapshot', ...);                     // stdout lacks 'super-secret-plain'
it('logs defaults to latest deployment; --branch picks latest on branch', ...);
it('logs --tail 2 returns last 2 of 5 lines, truncated true', ...);
it('logs --output writes file and refuses to overwrite existing file (exit 2)', ...);
it('logs of a deployment with no log lines → note "No build log available for <short> (skipped: …)" and exit 0', ...);
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar.** `--output` escribe con `fs.writeFile(path, text, { flag: 'wx' })`. Si el archivo ya existe (`EEXIST`), lanza `CliError('usage', 'File exists: <path>')`.
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: deployments list, show and build logs`

---

### Task 12: `deployments redeploy/retry/rollback` + `--wait`

**Files:**
- Modify: `src/commands/deployments.ts`
- Test: `tests/commands/deployments-write.test.ts`

**Interfaces:**
- Consumes: `confirm` y `audit` de `Session`; `waitForDeployment`, `findRollbackTarget` y `currentProductionDeployment` (Task 9); `formatLogLines` (Task 11).
- Produces:
  - `deployments redeploy <project> [--branch <b>] [--wait]`
  - `deployments retry <project> <deployment> [--wait]`
  - `deployments rollback <project> [deployment]`
  - En dry-run, el JSON es `{ dryRun: true, action, project, branch?, environment, target?: DeploymentView }`.
  - En caso de éxito, el JSON es `DeploymentView`.
  - Si `--wait` termina en fallo: `CliError('deployment_failed', …, { details: { deploymentId, state, logTail: string[] } })`, con exit 7.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('redeploy production branch without flags (non-TTY) → exit 5 mentioning --confirm my-site; no POST', ...);
it('redeploy --confirm my-site → POST multipart branch=main, audit line {command:"deployments redeploy",project,env:"production",deploymentId}', ...);
it('redeploy --branch feature/x --yes → preview level, POST branch=feature/x', ...);
it('redeploy --dry-run → no POST, data.dryRun true, exit 0', ...);
it('redeploy on a Direct Upload project (no source) → exit 2 with dashboard link', ...);
it('--wait success: building → success, exit 0, progress on stderr', ...);
it('--wait failure: exit 7, stderr shows last 30 log lines, JSON error code deployment_failed', ...);
it('retry uses the deployment environment for the confirmation level and reports the returned id', ...);
it('rollback default target = previous successful production deployment; requires --confirm; POST /deployments/<target>/rollback', ...);
it('rollback human output shows from → to and warns the next push to main deploys over it', ...);
it('rollback to a preview or failed deployment → exit 2', ...);
it('rollback with no earlier successful production deployment → exit 4', ...);
it('productionRequiresTty=true + --confirm, non-TTY → exit 5', ...);
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar** según §5.3.
  - Nivel de confirmación del redeploy: `branch === project.production_branch ? 'production' : 'preview'`.
  - Advertencia del rollback: `The next push to <production_branch> will deploy over this rollback.`
  - Con `--wait`, el progreso se escribe en stderr con `out.note('<short> <state>…')`.
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: redeploy, retry and rollback with confirmations and --wait`

---

### Task 13: Planes de cambios de variables (lógica pura)

**Files:**
- Create: `src/providers/pages/env.ts`
- Test: `tests/providers/pages/env.test.ts`

**Interfaces:**
- Consumes: `EnvVars`, `EnvVarPatch` y `Project` (Task 7), y `describeMasked`/`SECRET_PLACEHOLDER` (Task 1).
- Produces:
  - `type EnvVarType = 'plain_text' | 'secret_text'`
  - `ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`
  - `currentEnvVars(p: Project, env: PagesEnv): EnvVars`: `null` o ausente → `{}`, y se descartan las entradas `null`.
  - `newKeys(current, keys): string[]`
  - `PlanItem`, que es una de estas formas:
    - `{ key, action: 'create', type, value }`
    - `{ key, action: 'update', fromType, type, oldValue?: string, value, becomesReadable: boolean, overwritesSecret: boolean }`
    - `{ key, action: 'unchanged', type: 'plain_text' }`
    - `{ key, action: 'delete', type, oldValue?: string }`
  - `interface EnvPlan { env: PagesEnv; items: PlanItem[] }`
  - `planSet(current, entries: { key: string; value: string }[], opts: { env: PagesEnv; type?: EnvVarType }): EnvPlan`
  - `planUnset(current, keys, env): EnvPlan`
  - `hasChanges(plan): boolean`
  - `buildEnvPatch(plan): EnvVarPatch`
  - `verifyApplied(before: EnvVars, plan, after: EnvVars): string[]`
  - `interface EnvVarView { key; type: EnvVarType; readable: boolean; masked: string | null; length: number | null; value?: string }`
  - `envVarView(key, v: EnvVar, reveal = false): EnvVarView`
  - `planItemView(item): object`, con los valores ocultos y nunca `value`.
  - `renderPlan(plan, project): string`

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('env_vars null or missing preview config → {}', ...);                       // Review Focus 4
it('existing plain, same value → unchanged and excluded from patch', ...);
it('existing secret without type flag → update keeps secret_text, overwritesSecret true, oldValue undefined', ...);
it('secret → plain only with type plain_text; becomesReadable true', ...);
it('new key without type → CliError usage "New variable(s) NEW_KEY need a type: pass --plain or --secret."', ...);
it('invalid key name or duplicate keys → usage', ...);
it('planUnset missing key → not_found listing missing keys', ...);
it('buildEnvPatch: create/update → {type,value}; delete → null; unchanged omitted', () => {
  expect(buildEnvPatch(plan)).toEqual({ NEW: { type: 'plain_text', value: 'v1' }, OLD: null });
});
it('verifyApplied reports changed keys missing, deleted keys present, and untouched keys that vanished', ...);
it('envVarView never includes value unless reveal; secrets masked null, readable false', ...);
it('renderPlan uses + ~ ! - = markers with masked values', ...);
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar** según §5.4 (reglas de tipo y garantías 1–4).
  - Marcadores de `renderPlan`: `+` crear, `~` cambiar, `!` cambio de secreto a texto plano, `-` borrar, `=` sin cambios.
  - Línea de un secreto: `~ KEY  secret_text  [secret — not readable] → will be overwritten`.
  - Línea de `!`: `! KEY  secret_text → plain_text  value will become readable`.
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: env var change planning, patch building and verification`

---

### Task 14: `env list/get/set/unset`

**Files:**
- Create: `src/commands/env.ts`
- Modify: `src/main.ts`
- Test: `tests/commands/env.test.ts`

**Interfaces:**
- Consumes: Task 13; `isWranglerManaged` (Task 10); `createDeployment` y `deploymentView`; `Session.confirm` y `audit`; `util.parseEnv` de `node:util`.
- Produces:
  - `env list <project> [--env <e>]`, con JSON `{ project, environments: { production?: EnvVarView[]; preview?: EnvVarView[] }, dashboardUrl }`. `dashboardUrl` usa `sectionDashboardUrl(…, 'variables')`.
  - `env get <project> <key> --env <e> [--reveal]`
  - `env set <project> [key] --env <e> [--secret | --plain] [--from-file <path>] [--redeploy] [--branch <b>]`
  - `env unset <project> <keys...> --env <e> [--redeploy] [--branch <b>]`
  - El JSON de `set` y `unset` es `{ project, env, changes: planItemView[], applied: boolean, dryRun?: true, redeploy?: DeploymentView }`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('set from stdin strips one trailing newline and patches only that key', async () => {
  // runCli(['env','set','my-site','NEW_KEY','--env','preview','--plain','--yes'], { stdin: 'hunter2-plain-value\n' })
  // PATCH json.deployment_configs.preview.env_vars === { NEW_KEY: { type: 'plain_text', value: 'hunter2-plain-value' } }
  // stdout+stderr never contain 'hunter2-plain-value'; audit line keys ['NEW_KEY'] and no value
});
it('set --env production without --confirm → exit 5, no PATCH', ...);
it('set --dry-run prints masked diff, no PATCH, applied false', ...);
it('set on existing secret without flag keeps secret_text', ...);
it('set new key without --plain/--secret (non-TTY) → exit 2, no PATCH', ...);
it('set --from-file patches only changed keys; unchanged keys omitted', ...);
it('wrangler-managed project: preview change with --yes only → exit 5 (needs --confirm)', ...);
it('post-PATCH verification mismatch → exit 6 verification_failed listing keys', ...);
it('positional "KEY=value" → exit 2 "Values are never accepted as arguments…", no request', ...);
it('--secret and --plain together, or key and --from-file together → exit 2', ...);
it('unset sends KEY: null and reminds changes apply on next deployment', ...);
it('--redeploy --env preview without --branch → exit 2 before any PATCH', ...);
it('--redeploy --env production --confirm my-site → PATCH then POST branch=main', ...);
it('get --reveal on secret → exit 2 "Cloudflare does not return secret values; secrets can only be overwritten."', ...);
it('get --reveal on plain → stdout exactly "<value>\\n", stderr warning, audit "env get --reveal"', ...);
it('list without --env shows both environments masked; --json has no "value" field', ...);
it('get without --env → exit 2', ...);
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar el flujo de `set` y `unset`** exactamente en este orden:
  1. Validar los argumentos. Un `key` que contenga `=` se rechaza con exit 2. Si es `--redeploy` con `--env preview`, se exige `--branch`.
  2. `getProject` → `before = currentEnvVars`.
  3. Obtener los valores:
     - con `--from-file`: `parseEnv`; si no hay ninguna entrada → exit 2;
     - si se puede preguntar: `prompts.password('Value for KEY (env)')`;
     - si stdin no es una TTY: `readStdin()` y quitar un solo `\n` o `\r\n` final;
     - en otro caso: exit 2 `Provide the value on stdin.`;
     - un valor vacío → exit 2 `Empty values are not allowed.`;
     - cada valor se registra en el redactor.
  4. Elegir el tipo de las claves nuevas: el flag, o si se puede preguntar, un `prompts.select` entre `plain_text` y `secret_text`.
  5. Calcular el plan con `planSet` o `planUnset`. Si `!hasChanges` → `No changes.` y exit 0, sin PATCH.
  6. Escribir el diff con `renderPlan` en stderr. Si el proyecto está gestionado por Wrangler, añadir la advertencia de §5.4, garantía 5.
  7. Con `--dry-run`, emitir el plan y terminar.
  8. Si hay `becomesReadable` y se puede preguntar → confirmación extra `<KEY> will become readable plain text. Continue?`.
  9. `confirm` con el nivel `production` si `env === 'production'` o el proyecto está gestionado por Wrangler; si no, `preview`.
  10. `patchEnvVars(..., buildEnvPatch(plan), { wranglerConfigHash })`.
  11. Volver a pedir el proyecto y ejecutar `verifyApplied`. Si hay discrepancias, lanzar `CliError('verification_failed', 'Cloudflare reports a different result than expected for: A, B')`.
  12. `audit` con `{ command, project, env, keys }`.
  13. Escribir la nota `Changes apply to the next deployment.`.
  14. Redeploy:
      - con `--redeploy`: `createDeployment` con `production_branch` o `--branch`, sin una segunda confirmación;
      - en una TTY sin `--redeploy`, para producción: preguntar `Redeploy <branch> now?`;
      - en una TTY sin `--redeploy`, para preview: preguntar `Branch to redeploy (empty to skip):`.
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: env list/get/set/unset with masked diff, confirmation and verification`

---

### Task 15: Comando `dashboard`

**Files:**
- Create: `src/commands/dashboard.ts`
- Modify: `src/core/context.ts` (añadir `openUrl(url: string): Promise<void>`), `src/main.ts`, `tests/helpers/run.ts` (el resultado incluye `opened: string[]`)
- Test: `tests/commands/dashboard.test.ts`

**Interfaces:**
- Consumes: las URLs del dashboard (Task 7) y `resolveDeploymentRef` (Task 9).
- Produces: `dashboard <project> [deployment] [--section <deployments|settings|domains|variables|builds>] [--open]`, con JSON `{ url }`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('prints project URL without any API call', ...);                    // recordRequests() empty
it('full deployment id → deployment URL without API call; short id resolves via API', ...);
it('unverified section falls back to project URL', ...);
it('--open in TTY calls openUrl once; without TTY prints URL and notes "--open ignored: not an interactive terminal"', ...);
```

- [ ] **Step 2: Ejecutar** — FAIL.
- [ ] **Step 3: Implementar.** La versión de Node de `openUrl` usa `spawn` con un array de argumentos, sin shell:
  - darwin: `open <url>`;
  - win32: `cmd /c start "" <url>`;
  - en los demás sistemas: `xdg-open <url>`.

  Se lanza con `detached` y `stdio: 'ignore'`, y después `unref()`.
- [ ] **Step 4: Verificar** — PASS.
- [ ] **Step 5: Commit** — `feat: dashboard command with deep links`

---

### Task 16: Empaquetado, documentación, CI y release

**Files:**
- Create: `scripts/check-size.mjs`, `README.md`, `docs/json-output.md`, `CHANGELOG.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Modify: `package.json` (script `check:size`), `docs/decisions/0001-http-client.md` (añadir el tamaño medido del bundle)

- [ ] **Step 1: `scripts/check-size.mjs`.**
  - Ejecuta `npm pack --dry-run --json` y falla si `unpackedSize >= 3_000_000`.
  - También falla si `package.json` tiene `dependencies` no vacías, o si la lista de archivos incluye algo fuera de `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md` o `package.json`.
  - Comprobar con `npm run build && npm run check:size` → PASS, imprimiendo el tamaño.
  - **Smoke del tarball:**
    1. `npm pack` a un directorio temporal.
    2. En otro directorio temporal vacío: `npm init -y && npm i <tarball> --omit=optional`.
    3. `npx cf-pages --help` debe salir con 0 y mostrar el disclaimer.
    4. `npx cf-pages whoami` debe salir con 3 (no hay login), sin errores de módulo no encontrado.

    Esto prueba que el bundle no depende de paquetes sin instalar y que la ausencia de `@napi-rs/keyring` no rompe el CLI. Se añade también como paso del CI.
- [ ] **Step 2: Revisar la cobertura de Pages del CLI oficial `cf`.** Se lee la documentación y el repo de `cf` (https://blog.cloudflare.com/cloudflare-cf-cli-launch/ y developers.cloudflare.com) **sin instalarlo ni ejecutarlo**. Se anotan en tres líneas qué comandos de Pages ofrece y cuáles faltan frente a `cf-pages`, para usarlas en la sección "Why cf-pages?" del README.
- [ ] **Step 3: Escribir `README.md`** (en inglés). Secciones en este orden:
  1. Disclaimer.
  2. Qué resuelve: los 3 casos de uso.
  3. Instalación: `npx cf-pages`, `npm i -g cf-pages`.
  4. Login: permisos del token, almacén seguro, `--insecure-storage` y las variables `CF_PAGES_*`.
  5. Comandos.
  6. Modelo de seguridad: niveles de confirmación, ocultamiento, auditoría y `productionRequiresTty`.
  7. Lo que **no** protege: §6.5 traducido literalmente.
  8. Uso desde agentes: `--json`, códigos de salida y stdin.
  9. "Why cf-pages?": comparación con Wrangler (§3) y con `cf` (Step 2).
  10. Licencia.

  `docs/json-output.md` documenta el envelope y el `data` de cada comando, con los nombres de campos de los view models.
- [ ] **Step 4: CI.**
  - `ci.yml`: en `push`/`pull_request`, una matriz `os: [ubuntu-latest, macos-latest, windows-latest]` × `node: [22, 24]`. Pasos: `npm ci`, `lint`, `typecheck`, `test`, `build`, `check:size` y `node dist/cli.js --help`.
  - `release.yml`: en los tags `v*`, con `permissions: { id-token: write, contents: read }`. Pasos: `setup-node` con Node 24, `npm i -g npm@latest`, `npm ci`, `npm test`, `npm run build` y `npm publish` (trusted publishing). En `CHANGELOG.md` se anota que la primera publicación la hace el autor a mano y que después se configura `npm trust`.
- [ ] **Step 5: Verificar** — `npm run lint && npm run typecheck && npm test && npm run build && npm run check:size && node dist/cli.js --help` → todo PASS.
- [ ] **Step 6: Commit** — `docs: README, JSON schema docs, CI and release workflows`

---

### Task 17: Verificación contra cuenta real (§11)

**Precondición:** pedirle al usuario que ejecute **en su terminal** `node dist/cli.js login` con la cuenta de pruebas (label `Testing`). El builder nunca maneja el token. **Antes de cada paso que mute algo, se pide permiso explícito al usuario.** Los resultados se anotan en `docs/verification/2026-10-live-checks.md`, sin tokens, sin Account IDs y sin valores de variables.

**Files:**
- Create: `docs/verification/2026-10-live-checks.md`
- Modify: lo que los resultados exijan, cada cambio con su propia prueba (rojo → verde) y su commit. Lo previsible: `SECTION_PATHS` y `GITHUB_APP_URL` (Task 7); `currentProductionDeployment` (Task 9); el uso de `wranglerConfigHash` (Task 7).

- [ ] **Step 1 (lectura):** `projects show landing-studio --json`. Anotar la fuente Git, `preview_deployment_setting`, si tiene `wrangler_config_hash` y los últimos deploys.
- [ ] **Step 2 (lectura): rutas de secciones.** Imprimir las URLs candidatas (`…/pages/view/landing-studio/settings`, `/settings/builds`, `/settings/environment-variables`, `/domains`). El usuario confirma cuáles abren la página correcta. Se rellenan en `SECTION_PATHS` solo las confirmadas. Se comprueba con WebFetch que `GITHUB_APP_URL` existe.
- [ ] **Step 3 (muta, preview, con permiso):** `env set landing-studio CF_PAGES_CHECK --env preview --plain --yes` con el valor por stdin, y otra vez con `--secret`.
  - Comprobar con `env list --json` que las demás variables no cambiaron (§11, puntos 2 y 7).
  - Después, `env unset … --yes`.
- [ ] **Step 4 (muta, preview, con permiso):** `deployments retry landing-studio <preview> --yes --wait --json`. Anotar si el id es nuevo (§11, punto 3).
- [ ] **Step 5 (muta, producción, con permiso):**
  1. `deployments rollback landing-studio --confirm landing-studio`.
  2. Comprobar en `projects show` que la producción actual es el destino, lo que valida `canonical_deployment`.
  3. Pedir al usuario que haga un push a la rama de producción y observar si el auto-deploy pasa por encima del rollback (§11, punto 6).
  4. Restaurar con un rollback al deploy original.
- [ ] **Step 6 (opcional, con el usuario):**
  - Si `landing-studio` tiene `wrangler.toml`, observar el efecto de un PATCH de variables (§11, punto 4).
  - Si el usuario acepta activar controles de rama en el dashboard, comprobar si un `redeploy` por API los respeta (§11, punto 5).
  - Si algo no se puede comprobar, se anota y el comportamiento conservador se mantiene.
- [ ] **Step 7 (lectura, cuenta principal):** el usuario vuelve a hacer `login` con la cuenta principal. Ejecutar `deployments list <proyecto> --env preview` para localizar un deploy fallido y `deployments logs <proyecto> <short> --tail 50`. Confirmar que los logs de un deploy fallido están disponibles (§11, punto 1).
- [ ] **Step 8:** ajustar el código o las pruebas según los hallazgos (TDD), volver a ejecutar `npm test` y el comando afectado, y hacer commit. `git commit -m "test: record live verification results"`.

---

## Siguiente plan (no incluido aquí)
**Agent Skill (`skills/cf-pages/`)**, según §9. Se planifica cuando el CLI v1 esté publicado y estable, usando los comandos y el JSON definitivos (`docs/json-output.md`).
