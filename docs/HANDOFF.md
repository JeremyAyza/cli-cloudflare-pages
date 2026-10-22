# Handoff — cf-pages CLI v1

Fecha: 2026-10-21 · Pausado antes de la Task 9 a petición del usuario (cambio de PC).

Documentos de referencia:
- Spec aprobado: `docs/superpowers/specs/2026-10-21-cloudflare-pages-cli-design.md`
- Plan: `docs/superpowers/plans/2026-10-21-cf-pages-cli-v1.md`
- Ledger completo (copia del original, que está ignorado por git): `docs/handoff-progress.md`

---

## 1. Estado actual

- **Rama:** `feat/cli-v1`. `main` = `fa18b33`, que solo contiene docs (spec y plan). Es la base del merge.
- **Último commit de código:** `2c42e2f` ("fix: never echo option values in usage errors; full login rollback").
- **Verificación al pausar:** `npm test` → 22 archivos, 473/473 tests; `npm run typecheck` y `npm run lint` limpios (Node v22.23.3).
- **Nada se ha subido (push)** ni publicado.

### Tareas completas (con revisión aprobada)

| Task | Contenido | Commits |
|---|---|---|
| 1 | Scaffold + ocultamiento/redacción/tiempo | `8e6b977..f4370d0` |
| 2 | Esqueleto CLI, envelope JSON, exit codes, harness | `f4370d0..783d964` |
| 3 | Niveles de confirmación | `783d964..e2acf7a` |
| 4 | Config, auditoría, comando `settings` | `e2acf7a..ab5d535` |
| 5 | Llavero/archivo, resolución de credenciales, `Session` | `ab5d535..fdc7545` |
| 6 | Cliente HTTP (reintentos seguros, mapeo de errores) | `fdc7545..229965b` |
| 7 | Capa API de Pages, tipos, URLs del dashboard | `3d694c0..baa7beb` (`3d694c0` = sincronización del plan) |
| 8 | `login` / `logout` / `whoami` | `baa7beb..2c42e2f` |

### Siguiente tarea

**Task 9: lógica de deploys** (`src/providers/pages/deployments.ts`). Su brief está en el plan. Después siguen las Tasks 10–16, la pausa obligatoria y la Task 17.

---

## 2. Registro completo de decisiones (Rulings)

Cada decisión lleva su motivo y lo que cuesta si es incorrecta.

1. **Repo inicializado por el controlador** (`main` = commit de docs, trabajo en `feat/cli-v1`); la Task 1 no hace `git init`. *Motivo:* repo nuevo y vacío; la rama protege `main`. *Si es incorrecta:* nada (se puede renombrar la rama).
2. **Corregido el vector del test de ocultamiento** a `'abcd•••ABCD (40)'`. *Motivo:* error aritmético en el plan; la regla del spec es 4+4. *Si es incorrecta:* nada.
3. **Smoke del tarball** (pack → instalar en un directorio vacío → `npx cf-pages --help` sale con 0, `whoami` sale con 3) añadido a la Task 16 y al CI. *Motivo:* las dependencias van dentro del bundle; sin esto, un fallo de empaquetado solo aparecería después de publicar. *Si es incorrecta:* unos segundos de CI.
4. **Titular de la LICENSE: "cf-pages contributors".** *Motivo:* no conozco el nombre legal del autor, y no se permiten nombres del equipo en el repo. *Si es incorrecta:* editar una línea.
5. **La Task 17 (verificación real) es una parada de seguridad:** hay que pedir al usuario que haga login y que apruebe cada mutación. *Motivo:* §11 del spec. *Si es incorrecta:* —
6. **Si TypeScript 7 rompiera el tooling, se puede fijar TS 6.** *Motivo:* el spec solo exige TypeScript. *Si es incorrecta:* nada funcional. (Al final funcionó TS 7.0.2.)
7. **`cf-pages` sin argumentos muestra la ayuda en stdout y sale con 0.** *Motivo:* convención habitual; el spec no dice nada. *Si es incorrecta:* un cambio trivial.
8. **`main` redacta `message`/`hint`/`details` de TODOS los `CliError`**, no solo de los inesperados. *Motivo:* "el token nunca se imprime" pesa más que la redacción más estrecha del plan. *Si es incorrecta:* nada (redactar algo que no es secreto no lo altera).
9. **Cambio de firma: `readGlobalFlags(cmd, env)`.** El color efectivo es `flag && !NO_COLOR && TERM !== 'dumb'`, y `paint` no lee `process.env`. *Motivo:* el núcleo debe ser inyectable vía `Context`. *Si es incorrecta:* los briefs siguientes tienen que pasar `env`.
10. **En preview también se acepta `--confirm <proyecto>` coincidente**, además de `--yes`; si no coincide, es un error de uso. *Motivo:* el flag más fuerte debe satisfacer el nivel más débil, y un agente puede pasar siempre `--confirm`. *Si es incorrecta:* nada (sigue habiendo un consentimiento explícito).
11. **El nombre del proyecto tecleado se compara exactamente**, sin `trim`. *Motivo:* la rigidez es el objetivo. *Si es incorrecta:* el usuario vuelve a escribirlo.
12. **`AuditEntry.credentialSource` pasa a ser opcional y `settings set` se audita.** *Motivo:* desactivar una protección es relevante para la seguridad (§6.2). *Si es incorrecta:* una línea más en el log.
13. **Las pruebas nunca tocan el llavero real.** `openKeyringStore` se prueba solo con `@napi-rs/keyring` mockeado. *Motivo:* escribir en tu llavero desde las pruebas es un efecto fuera del repo. *Si es incorrecta:* la integración real se verifica solo en la Task 17.
14. **Con credenciales por variables de entorno, se usa el label del perfil solo si `accountId` coincide**; si no, se muestra "environment". *Motivo:* mostrar un label guardado para otra cuenta nombraría la cuenta equivocada. *Si es incorrecta:* un cambio de una línea.
15. **Pista de las mutaciones con 5xx o timeout:** "The request may or may not have been applied. Check the current state (`cf-pages deployments list <project>` or `cf-pages env list <project>`) before retrying." *Motivo:* los PATCH de v1 cambian variables, y `deployments list` no las muestra. *Si es incorrecta:* cambiar el texto.
16. **`ApiClient` rechaza los segmentos de ruta `.` y `..`**, en crudo o codificados, antes de enviar nada. *Motivo:* es el único punto por el que pasan todas las peticiones y evita peticiones mal dirigidas. *Si es incorrecta:* nada (ningún id válido es `.` ni `..`).
17. **`login --token-stdin` con stdin en una TTY da un error de uso** antes de leer nada. *Motivo:* al teclear en una TTY el token se ve en pantalla. *Si es incorrecta:* nada.
18. **En `whoami --json`, `storage` es el enum estable `'keyring' | 'file'`**, con `insecure: true` cuando es archivo; la salida humana mantiene "file (insecure)". *Motivo:* el JSON es un contrato para agentes. *Si es incorrecta:* un campo.

---

## 3. Menores pendientes

Detalle completo en `docs/handoff-progress.md`. La revisión final (Opus) debe decidir cuáles se corrigen antes del merge.

### Deben resolverse ANTES del merge (RESUELTOS en d243ba3)

**Seguridad (Resueltos)**
- [x] **T5.** `file-store` adjunta como `cause` el `SyntaxError` de `JSON.parse`. Corregido: se eliminó `cause` para que V8 nunca cite fragmentos de credenciales en errores de parseo JSON.
- [x] **T5 y T4.** `private-file` se abre con `'wx'` en lugar de `'w'`. Además, se endurecen permisos de directorios (0700) y archivos (0600) preexistentes, incluido `audit.log`.
- [x] **T8.**
  - [x] Opción corta con valor pegado (`-zSECRETO`): se corta al nombre corto de la opción (`-z`).
  - [x] "unknown command": solo repite palabras alfabéticas simples en minúsculas (sin dígitos ni símbolos ni mayúsculas), redactando cualquier otro valor como `[redacted]`.
- [x] **T6.** Caracteres de control en segmentos: `ApiClient` rechaza caracteres de control ASCII (crudos y codificados en porcentaje `%00-%1F, %7F`) y los limpia antes de evaluar segmentos `.` / `..`.

**Test flaky (Resuelto)**
- [x] **T6.** `tests/core/http-client.test.ts` → "POST 429 retry-after 2": estabilizado con `hangUntilAborted` (el mock se cancela inmediatamente cuando el cliente aborta la señal en lugar de dejar un temporizador activo tras finalizar el test) y `settleRecordedRequests()` en `setup.ts`.

### Resto, no bloqueante

**T1**
- Casos límite de `time` sin tests.
- `biome` sin `!coverage`.
- La redacción de "Bearer" distingue mayúsculas.

**T2**
- Defaults duplicados en `flagsFromArgv`.
- Los errores inesperados no traen hint.
- `Output.note`/`warn` no pasan por el redactor: hay que vigilarlo en las tasks que interpolen entrada del usuario.
- `header()` después de `data()` se pierde en modo JSON.
- `external` de tsdown está deprecado; revisarlo en el smoke de la Task 16.

**T3**
- Nombre y duplicación en `confirm.ts`.
- Ramas sin test.

**T4**
- Un test de error que no comprueba nada.
- El mensaje de versión no soportada.
- **Para el README (Task 16):** `CF_PAGES_CONFIG_DIR` permite apuntar a otra config. Es inherente al modelo de amenazas, así que hay que documentarlo.

**T5**
- Las variables de entorno fallan si `config.json` está corrupto.
- El llavero se lee dos veces por comando, lo que podría generar un doble aviso en macOS.
- Se acepta un token guardado vacío.
- El aviso de caducidad incluye exactamente los 7 días.

**T6**
- `retry-after` en formato fecha.
- Un callback de debug que lanza un error.
- Tests faltantes.

**T7**
- Que `result` sea `null` en los listados.
- Que `makeDeployment({id})` no actualice `short_id`.

**T8**
- El orden de las comprobaciones de login sin TTY.
- `logout` sin perfil no limpia tokens huérfanos.
- `auth.ts` tiene 546 líneas.
- Tests que afirman más de lo que comprueban.

**Para verificar en la Task 17**
- Cloudflare podría responder a tokens inválidos con 400 (6003/6111) o 403 (10000) en lugar de 401.
- Un 2xx sin cuerpo.

---

## 4. Forma de ejecución acordada

- Se sigue con **Subagent-Driven Development**, ejecutando las tareas del plan en orden con un ledger.
- **Preferencia del usuario a partir de la Task 9:**
  - **Revisión completa** (revisor independiente de spec y calidad, con bucle de correcciones) **solo en las Tasks 12, 13 y 14**: mutaciones de deploys, planes de variables y comandos `env`.
  - **En el resto, autorrevisión del implementador**, agrupando las tareas pequeñas en un mismo envío. Por ejemplo, 9+10, 11 sola, 15+16.
  - **Se mantiene la revisión final de toda la rama con Opus**, que tiene que triar la lista de menores, sobre todo los de seguridad.
  - **Se mantiene la pausa antes de la Task 17**: el usuario hace el login y aprueba cada mutación.
- Hay que indicar siempre el modelo de cada subagente: implementadores en `sonnet`, revisiones de seguridad y final en `opus`.

---

## 5. Reglas que no deben olvidarse

- **Nunca tocar el llavero real del sistema en las pruebas.** Solo se usan el llavero falso del harness y los mocks.
- **Las mutaciones contra una cuenta real se hacen solo en `landing-studio`**, que está en una cuenta distinta a la de los proyectos de clientes, y **siempre con permiso explícito del usuario** antes de cada una. Sobre los proyectos de clientes solo se permite leer.
- **El token lo introduce el usuario** con `cf-pages login` en su terminal. **Nunca el agente**: ni lo lee, ni lo pide, ni lo pega.
- **Ningún nombre del equipo** (apprunn, rctm, casamarket…) **en `src/` ni en `tests/`.** Los ejemplos usan `my-site`, `example-org` y `Acme`.
- Todo texto del CLI y la documentación pública va en inglés.
- No hacer push ni publicar sin que el usuario lo pida.

---

## 6. Cómo retomar en otra PC

1. Restaurar el repo desde el bundle (ver el comando de empaquetado en el mensaje de entrega):
   ```bash
   git clone cf-pages.bundle cli-cloudflare-pages
   cd cli-cloudflare-pages
   git checkout feat/cli-v1
   ```
2. Usar Node ≥ 22.12 (`.nvmrc` = 22) e instalar: `npm ci`.
3. Comprobar la base: `npm test && npm run typecheck && npm run lint`. Debe dar 473 tests en verde.
4. Recrear el ledger de trabajo, que está ignorado por git:
   ```bash
   mkdir -p .superpowers/sdd/2026-10-21-cf-pages-cli-v1
   cp docs/handoff-progress.md .superpowers/sdd/2026-10-21-cf-pages-cli-v1/progress.md
   ```
   Si el script `sdd-workspace` del skill crea su propio `.gitignore`, ejecutarlo primero y copiar después.
5. Pedir a Claude Code: *"Continúa la ejecución del plan `docs/superpowers/plans/2026-10-21-cf-pages-cli-v1.md` desde la Task 9 con subagent-driven-development, siguiendo `docs/HANDOFF.md`"*.
6. Antes de la Task 17, la pausa: hacer `login` con la cuenta de pruebas (label "Testing") en tu propia terminal.
