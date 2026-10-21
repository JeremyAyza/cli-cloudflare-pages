# CLI para Cloudflare Pages + Agent Skill — Diseño

Fecha: 2026-10-21 · Estado: **aprobado por el usuario** (2026-10-21)

Nombre del paquete npm y del comando (decidido por el usuario): **`cf-pages`**.
- Estaba libre en npm el 2026-10-21, igual que las variantes `cfpages`, `cf_pages` y `cf.pages`, que npm también bloquearía por parecido.
- Si al publicar por primera vez estuviera tomado, se consulta al usuario antes de elegir otro.
- Se ejecuta con `npx cf-pages`.
- El prefijo de las variables de entorno (`CF_PAGES_`), la entrada del llavero, las rutas de configuración y el directorio de la skill usan `cf-pages`.
- **Herramienta no oficial** (decisión mía). Cloudflare tiene ahora su propio CLI `cf`, así que un `cf-pages` podría confundirse con un complemento oficial. El README, la descripción en npm y el `--help` dicen claramente: "Unofficial. Not affiliated with or endorsed by Cloudflare." No se usa el logo ni la marca de Cloudflare.

---

## 1. Intención y por qué

El autor es el **único administrador** de una cuenta de Cloudflare con varios proyectos de **Cloudflare Pages conectados a GitHub**. Los desarrolladores del equipo no tienen acceso al dashboard, así que todo pasa por él:

- *"Pasé cambios pero no se ven"*: Cloudflare no detectó el commit y ni siquiera intentó desplegar. Un commit vacío tampoco funcionó. La solución fue pedir un deploy a demanda del último commit de la rama.
- *"Mi preview falló"*: el dev no puede ver el log. La causa era un `bun.lock` desactualizado, y para descubrirlo hubo que entrar al dashboard, abrir el deploy y copiar el log.
- *"Cámbiame una variable del .env"*: se hace a mano en la UI y puede afectar a producción o a previews, es decir, a clientes reales.

Hoy cada una de estas tareas es un viaje al dashboard. Además, el agente que el autor ya usa leyó el token de un `.env` en texto plano y llamó a la API directamente con él.

**Qué se quiere:** un CLI muy profesional y seguro que convierta estas tareas en comandos. Una vez el CLI esté maduro, una **Agent Skill** independiente del agente (Claude Code, Codex, Antigravity, Gemini CLI, Cursor…) para que el agente del autor haga lo mismo por él, de forma segura.

**Contexto open source:** el autor podría publicarlo como open source. Debe ser fácil para cualquiera: TypeScript, publicado en npm y ejecutable con `npx`, multiplataforma, sin nada específico de su equipo (nada de `apprunn`, `rctm`, etc. en el código).

**Éxito:** el autor resuelve los tres casos de arriba desde la terminal en segundos, sin abrir el dashboard. Su agente puede hacer lo mismo sin ver el token y le pide confirmación explícita antes de tocar producción. El alcance real de esta garantía está en §6.5.

---

## 2. Objetivos, no-objetivos y anti-objetivos

### Objetivos (v1)
1. **Login como onboarding.** Se guardan un label, el Account ID y el API token en un almacén seguro. Sin credenciales, ningún otro comando funciona.
2. **Proyectos:** listar y ver el detalle, con diagnóstico de por qué un push podría no estar desplegándose.
3. **Deploys:** listar, ver, logs de build, redeploy a demanda, reintentar y rollback.
4. **Variables de entorno:** listar ocultas, revelar una de forma explícita, crear o cambiar, y borrar. Todo con máximo cuidado.
5. **Apto para agentes:** salida `--json`, códigos de salida estables y nunca colgarse esperando un prompt.
6. **Agent Skill** (después de que el CLI esté maduro).

### No-objetivos (v1, puede que más adelante)
- Varios perfiles o cuentas. **Una sola cuenta**, aunque la estructura debe permitir añadir perfiles sin rehacer nada.
- Soporte para **Workers**. El código debe quedar organizado para añadirlo en una versión futura (ver §7.4).
- **Crear proyectos** (v2).
- Gestionar dominios personalizados (en v1 solo se muestran en `projects show`).
- Borrar deploys, Direct Upload (subir archivos), cancelar builds.
- Cualquier integración con GitHub dentro del CLI. El CLI no usa `gh` ni tokens de GitHub. Cruzar el log con el repo es trabajo del agente (§9).
- Permisos multiusuario. Solo quien instala el CLI y carga sus credenciales lo usa, y solo esa persona le pide cosas a su agente.
- Servidor MCP o UI web.

### Anti-objetivos (fracaso aunque "funcione")
- Cambiar una variable de **producción** por accidente, o que un cambio de una variable borre o vacíe otras.
- Que el token o el valor de una variable aparezcan en pantalla, logs, errores, historial del shell o en el contexto del agente sin que el usuario lo haya pedido explícitamente.
- Que el agente se quede colgado en un prompt interactivo.
- Que el CLI solo funcione en la máquina o la cuenta del autor.
- Guardar el token en texto plano sin que el usuario lo haya elegido conscientemente.

---

## 3. Hechos verificados que condicionan el diseño

Se verificaron el 2026-10-21 contra el OpenAPI oficial (`cloudflare/api-schemas`), la documentación de developers.cloudflare.com, el SDK `cloudflare` v7.3.0 y el código de Wrangler 4.151.3. Los marcados **[sin verificar]** deben comprobarse contra una cuenta real antes de dar por terminada la parte que dependa de ellos (§11).

**Deploys**
- Redeploy: `POST /accounts/{acct}/pages/projects/{proj}/deployments`. Es `multipart/form-data` con el campo `branch`, construye el HEAD de esa rama y por defecto usa la rama de producción. Funciona para ramas de preview. Siempre se envía `branch` de forma explícita.
- Retry: `POST .../deployments/{id}/retry`, sin cuerpo. Devuelve un objeto Deployment. Se usa el `id` de la respuesta y no se asume que sea el mismo [sin verificar si es nuevo].
- Rollback: `POST .../deployments/{id}/rollback`. Solo admite como destino un deploy de **producción** que terminó con éxito. Es instantáneo. No hay documentación de que pause el auto-deploy, así que se asume que el siguiente push a la rama de producción vuelve a desplegar encima [sin verificar].
- Logs de build: `GET .../deployments/{id}/history/logs` devuelve `{ total, includes_container_logs, data: [{ ts, line }] }`. No hay paginación. No se sabe si hay logs para deploys fallidos, cancelados o saltados, ni cuánto tiempo se retienen [sin verificar].
- Listar: `GET .../deployments` acepta solo `env`, `page` y `per_page` (**no hay `sort`**). Los campos útiles son `id`, `short_id` (8 caracteres), `url`, `aliases`, `environment`, `created_on`, `is_skipped`, `skip_reason`, `latest_stage {name, status}` y `deployment_trigger {type, metadata {branch, commit_hash, commit_message}}`.
- Valores de `skip_reason`: `commit_message`, `preview_deployments_disabled`, `production_deployments_disabled`, `path_config`, `branch_config`, `pages_to_workers_conversion`, `superseded_queued_build`.
- Límites de build: Free tiene 500 al mes y 1 concurrente. Un build tiene un timeout de 20 minutos. Desde 2026-08-11, un build en cola se descarta si llega otro más nuevo para la misma rama.

**Variables de entorno**
- Viven en `deployment_configs.{production,preview}.env_vars`, como `{ NAME: { type, value } }`. Los tipos son `plain_text` y `secret_text`.
- Los **secretos no se pueden leer**. La API no devuelve su valor (`""` o ausente [sin verificar cuál]). Las variables `plain_text` sí se devuelven completas.
- `PATCH` del proyecto **fusiona por clave**: las claves que no se envían se conservan y `KEY: null` borra esa variable. Wrangler hace exactamente esto. Los demás campos de `deployment_configs` (bindings, compatibility_date…) son opcionales y no se tocan si no se envían.
- **Prohibido leer, modificar y reenviar el mapa completo.** Reenviaría los secretos con valor vacío y los borraría.
- Los cambios **solo se aplican en el siguiente deploy**, porque cada deploy guarda su propia copia de las variables.
- **Riesgo:** si el repo del proyecto tiene `wrangler.toml` o `wrangler.json`, ese archivo es la fuente de verdad, y el siguiente deploy puede sobrescribir las variables cambiadas por la API. Probable señal: `deployment_configs.*.wrangler_config_hash` no vacío [sin verificar].

**Auth**
- Prefijos de token: `cfut_` (de usuario), `cfat_` (de cuenta) y `cfk_` (Global Key, **rechazar**). Los tokens anteriores a 2026 no tienen prefijo.
- `GET /user/tokens/verify` rechaza los tokens de cuenta con el código 1000. Para esos hay que usar `GET /accounts/{acct}/tokens/verify`. Ninguno de los dos devuelve permisos.
- Para comprobar la cuenta y el permiso de lectura: `GET /accounts/{acct}/pages/projects?per_page=1`.
- No se puede comprobar el permiso de escritura sin escribir.
- Permisos: en el dashboard se llaman "Cloudflare Pages Read / Edit" y en la API "Pages Read / Pages Write".
- Límite de peticiones: 1200 cada 5 minutos por token. Si se supera, todas las llamadas quedan bloqueadas 5 minutos (HTTP 429 con `retry-after`).

**Por qué no basta con Wrangler:** Wrangler **no** dispara builds de proyectos conectados a Git, **no** trae logs de build, **no** gestiona variables `plain_text`, **no** hace retry ni rollback y **no** gestiona dominios. Ese hueco es la razón de ser de este CLI.

**El nuevo CLI oficial `cf`:**
- Está en beta abierta desde el 2026-09-28. Se instala con `npm i -g cf`.
- Sus más de 3000 comandos se **generan a partir del OpenAPI**, y por defecto responden en JSON.
- Su autenticación es `cf auth login` (por navegador) o las variables `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.
- Cloudflare dice que, al terminar la beta, Wrangler redirigirá a `cf`.
- Su anuncio se centra en Workers y no menciona Pages.
- **Posicionamiento de `cf-pages`:**
  - Que `cf` tenga en teoría los endpoints de Pages como comandos genéricos no cubre lo que este CLI aporta: flujos de Pages **pensados y seguros**. Eso incluye el diagnóstico de "no veo mis cambios", los logs del último deploy de una rama, el rollback al anterior, el redeploy con `--wait`, las variables ocultas con diff y confirmación por entorno, los enlaces al dashboard y la skill con recetas de diagnóstico.
  - El builder revisa al planificar qué ofrece `cf` hoy para Pages: lo lee en su documentación y su repo, sin instalarlo ni ejecutarlo sin permiso. Así se confirma el hueco igual que con Wrangler, y si hiciera falta se ajusta el README.
- Fuentes:
  - https://blog.cloudflare.com/cloudflare-cf-cli-launch/
  - https://www.infoq.com/news/2026/10/cloudflare-cf-cli/

**Pages frente a Workers:** Cloudflare recomienda Workers para proyectos nuevos (desde la portada de la documentación de Pages, actualizada 2026-08), pero **no** ha anunciado la deprecación de Pages ni ninguna fecha de cierre. Hay mucha gente que sigue usando Pages. Workers Builds tiene API pública (trigger, listar, logs), pero exige un token **de usuario**.

---

## 4. Credenciales y login (decidido)

### 4.1 Flujo
- `cf-pages login` es el primer paso obligatorio. Pide:
  1. **Label**: un nombre para recordar de quién son las credenciales, por ejemplo "Casamarket". Es solo descriptivo.
  2. **Account ID**.
  3. **API token**, con entrada oculta.
- Durante el login, el CLI explica qué token crear: un **token de cuenta** con permiso *Cloudflare Pages: Edit*, que es el de menor privilegio. Los tokens de usuario también se aceptan.
- Validación al hacer login, antes de guardar nada:
  1. Si el token es `cfk_`/Global Key, se rechaza.
  2. Se verifica con el endpoint que corresponde al prefijo. Si el token no tiene prefijo, se prueba primero el de usuario y, si devuelve el código 1000, el de cuenta.
  3. El `status` debe ser `active`.
  4. `GET /accounts/{acct}/pages/projects?per_page=1` debe responder, lo que demuestra la cuenta y el permiso de lectura.
  5. Se avisa de que el permiso de escritura no se puede comprobar sin escribir.
  6. Se guarda `expires_on` si existe.
- Sin credenciales, todos los comandos salvo `login`, `--help` y `--version` terminan con el código de "auth requerida" (§6.3) y un mensaje claro.
- `cf-pages logout` borra el token del almacén seguro y la configuración.
- `cf-pages whoami` muestra el label, el Account ID, el tipo de token, el origen de las credenciales (almacén o variables de entorno), la caducidad y el estado actual. **Nunca muestra el token.**
- En la cabecera de la salida humana de cualquier comando se indica la cuenta, por ejemplo `Casamarket · cuenta …5572347`. En `--json` va como campo.
- Si un token caduca en menos de 7 días, se avisa por stderr.
- Si la API responde 401/403, el comando termina con el código de auth y una pista: "vuelve a ejecutar `login`" o "al token le falta el permiso Edit".

### 4.2 Almacenamiento (decisión mía)
- **Token:** almacén seguro del sistema mediante `@napi-rs/keyring` v2. Es el llavero en macOS, Credential Manager en Windows y Secret Service en Linux.
  - Se declara como `optionalDependency` y se importa de forma perezosa.
  - En Linux se fuerza `linux.store: 'secret-service'` para que falle de forma explícita en lugar de caer en keyutils, que se pierde al reiniciar.
  - Si el binario nativo no está, el CLI no debe romperse.
- **Si no hay almacén seguro** (Linux sin entorno gráfico, WSL, Docker): **no se cae en silencio a texto plano**. El login falla y explica las dos alternativas:
  - Variables de entorno.
  - `login --insecure-storage`, que guarda el token en un archivo con permisos 0600 tras una advertencia explícita y queda registrado en `whoami`.
- **Configuración no secreta** (label, Account ID, backend usado, tipo de token, caducidad): archivo JSON en el directorio de configuración XDG del sistema, con permisos 0600 para el archivo y 0700 para el directorio.
- Se organiza con un "perfil" llamado `default` desde el primer día (clave en el llavero y sección en la configuración) para que los perfiles futuros sean un cambio aditivo. No se expone ningún flag de perfil en v1.
- **Variables de entorno** para CI o máquinas sin almacén: `CF_PAGES_API_TOKEN` + `CF_PAGES_ACCOUNT_ID`. Tienen prioridad sobre lo guardado. Deben estar las dos, o error. **No** se lee `CLOUDFLARE_API_TOKEN` de forma automática, para que nadie use sin querer el token de Wrangler (decisión mía).
- **El token nunca se pasa como argumento** (quedaría en el historial y en `ps`). Solo hay dos formas de introducirlo: el prompt oculto en una TTY, o `--token-stdin`.
- **El agente no hace login.** Si se ejecuta `login` sin TTY y sin `--token-stdin`, termina con un mensaje que pide a la persona hacerlo en su terminal.

---

## 5. Comandos (v1)

Forma general: `cf-pages <recurso> <verbo> [args] [flags]`. El proyecto siempre se pasa por nombre como argumento. Los deploys se identifican por `id`, por `short_id` (8 caracteres) o con la palabra `latest`. Los nombres exactos de comandos y flags quedan a criterio del builder, siempre que cubran lo siguiente y sigan las reglas de seguridad del §6.

### 5.1 Auth
- `login [--label] [--account-id] [--token-stdin] [--insecure-storage]`
- `logout`
- `whoami`

### 5.2 Proyectos (lectura)
- `projects list`: nombre, subdominio `*.pages.dev`, dominios, rama de producción, repo conectado, último deploy de producción (estado y antigüedad).
- `projects show <proj>`: todo lo anterior y además:
  - Origen Git (`owner/repo`).
  - Configuración de auto-deploy: `production_deployments_enabled`, `preview_deployment_setting`, includes y excludes de ramas y rutas (*build watch paths*).
  - Configuración de build (comando, directorio de salida, raíz) y versión de la imagen de build.
  - Dominios con su estado de validación.
  - Si parece gestionado por un archivo de Wrangler.
  - Último deploy de producción, último de preview y deploys recientes saltados con su `skip_reason`.
  - **Diagnóstico** con pistas legibles para el caso "no veo mis cambios". Ejemplos: "los deploys de producción están desactivados", "las ramas de preview están filtradas", "watch paths activos: un push que no toque esas rutas no despliega", "el último push fue saltado por `[skip ci]` en el mensaje".
  - Siempre muestra **el último commit desplegado de cada rama** (sha corto, mensaje y antigüedad), para que la persona lo compare con lo que sabe que empujó.
  - Incluye el enlace al dashboard del proyecto.
- **Commit esperado** (decisión mía). El CLI no tiene acceso a GitHub, así que no puede saber qué commit se empujó. Hay dos caminos:
  - **Opcional:** `projects show <proj> --expect <sha> [--branch <rama>]` busca un deploy para ese commit. Si no lo hay y la configuración no explica por qué, dice: "no hay ningún deploy para `<sha>`; probablemente la integración GitHub ↔ Cloudflare no lo detectó; solución: `deployments redeploy --branch <rama>`".
  - **Sin `--expect`:** el CLI informa solo de las causas de configuración y de los últimos commits desplegados. Con el agente, la comparación con el repo la hace el agente (§9).
  - El CLI **no** lee el `git` local.

### 5.3 Deploys
- `deployments list <proj> [--env production|preview] [--branch <rama>] [--limit N]`:
  - Columnas: entorno, rama, commit corto con su mensaje, estado (`latest_stage`), si fue saltado y por qué, antigüedad, URL.
  - Pagina internamente hasta `--limit`. El filtro por rama se hace en el cliente.
- `deployments show <proj> <deploy>`: detalle completo, incluidas las etapas (`stages`), el trigger y el enlace al dashboard (`https://dash.cloudflare.com/{acct}/pages/view/{proj}/{deployId}`).
- `deployments logs <proj> [<deploy>] [--branch <rama>] [--tail N] [--output <archivo>]`:
  - Trae el log de build. Por defecto usa el último deploy; con `--branch`, el último deploy de esa rama.
  - Con `--output` lo escribe a un archivo en lugar de stdout, para no saturar la salida de un agente.
- `deployments redeploy <proj> [--branch <rama>] [--wait]`:
  - Deploy a demanda del último commit de la rama. Por defecto, la rama de producción.
  - Es lo que se hizo a mano en el incidente de `rctm`.
- `deployments retry <proj> <deploy> [--wait]`.
- `deployments rollback <proj> [<deploy>]`:
  - Por defecto vuelve al deploy de producción exitoso anterior al actual.
  - Muestra el cambio "de → a", con commit, fecha y URL.
  - Advierte de que el próximo push a la rama de producción desplegará encima.
- `--wait` (decisión mía) consulta el estado hasta que el deploy termina, respetando los límites de peticiones y con un intervalo de unos 5 s y un máximo de 20 minutos.
  - Si el deploy falla, muestra las últimas líneas del log y termina con el código "deploy fallido".
  - Sirve al humano ("¿ya quedó?") y al agente.
- Después de un redeploy, retry o rollback se muestran el `id`, la URL y el enlace al dashboard del deploy resultante.

### 5.4 Variables de entorno
- `env list <proj> [--env production|preview]`:
  - Sin `--env` muestra los dos entornos lado a lado, lo que ayuda a ver diferencias entre preview y producción.
  - Columnas: nombre, tipo, valor oculto, longitud.
- `env get <proj> <KEY> --env <e> [--reveal]`:
  - Sin `--reveal` muestra el valor oculto.
  - Con `--reveal` muestra el valor completo de **esa** variable, solo si es `plain_text`. Para un secreto explica que Cloudflare no permite leerlo.
- `env set <proj> <KEY> --env <e> [--secret | --plain] [--redeploy]`: crea o cambia una variable.
  - **El valor nunca va como argumento.** Se pide con un prompt oculto en una TTY, o se lee de stdin si no hay TTY.
- `env set <proj> --env <e> --from-file <ruta.env> [--secret | --plain] [--redeploy]`:
  - Importa varias variables de un archivo dotenv.
  - El diff muestra qué claves se crean y cuáles se cambian. Las claves que no están en el archivo **no se tocan**.
- **Reglas de tipo** (decisión mía; nunca se convierte un secreto en legible sin querer):
  - Una clave **existente** conserva su tipo actual si no se pasa ni `--secret` ni `--plain`.
  - Una clave **nueva** necesita que se elija el tipo de forma explícita. En una TTY se pregunta; sin TTY, falta `--secret` o `--plain` y el comando termina con código 2.
  - Pasar de `secret_text` a `plain_text` exige `--plain` de forma explícita. El diff lo marca como advertencia ("este valor pasará a ser legible") y en una TTY se pide una confirmación adicional.
  - En `--from-file`, estas reglas se aplican clave por clave. `--secret` o `--plain` fijan el tipo de las claves nuevas y de cualquier cambio de tipo que se pida.
- `env unset <proj> <KEY...> --env <e> [--redeploy]`: borra una o varias claves, enviando `KEY: null`.
- `--env` es **obligatorio** en `get`, `set` y `unset`. No hay entorno por defecto.

**Regla de ocultamiento** (pedida por el usuario: los extremos visibles sirven para comparar con otros sistemas):

| Longitud del valor | Se muestra | Ejemplo |
|---|---|---|
| ≥ 24 caracteres | primeros 4 + `•••` + últimos 4 | `sk_l•••9io2 (40)` |
| 12–23 caracteres | primeros 2 + `•••` + últimos 2 | `ab•••2T (16)` |
| < 12 caracteres | todo oculto | `••••• (8)` |
| `secret_text` | no se puede leer | `[secreto — no legible]` |

- La longitud siempre se muestra.
- En `--json` se aplica la misma regla: el campo `value` nunca aparece sin `--reveal`, solo `masked` y `length`.

**Garantías de seguridad en `set` y `unset`** (obligatorias):
1. El `PATCH` incluye **solo las claves que cambian**. Nunca se reenvía el mapa completo y nunca se reenvían secretos leídos de la API.
2. Antes de aplicar, se lee el estado actual y se muestra un **diff con valores ocultos**: proyecto, entorno, y por cada clave creada, cambiada o borrada, el valor anterior y el nuevo ocultos y si cambia de tipo.
3. **Idempotencia:** si una `plain_text` ya tiene ese valor, no se envía nada. Un secreto no se puede comparar, así que el diff avisa de que se sobrescribirá.
4. Después de aplicar, se vuelve a leer y se comprueba que el resultado es el esperado. Si no coincide, termina con un error claro.
5. Si el proyecto parece gestionado por un archivo de Wrangler, se muestra una **advertencia fuerte** de que el próximo deploy podría sobrescribir el cambio. Además, el cambio sube al nivel de confirmación de producción **incluso en preview** (§6.1).
6. Al terminar se recuerda que el cambio se aplica en el próximo deploy. En una TTY se ofrece el redeploy; con `--redeploy` se hace sin preguntar, con la confirmación que corresponda al entorno.

### 5.5 Enlaces al dashboard (pedido por el usuario)
- Toda salida de `show` y `list` incluye el enlace al dashboard del recurso. En `--json` va en el campo `dashboardUrl`.
- `cf-pages dashboard <proj> [<deploy>] [--section <sección>]` imprime el enlace exacto al proyecto, a un deploy o a una sección como configuración, dominios, variables o builds.
  - Con `--open`, además lo abre en el navegador. Nunca se abre de forma automática, y nunca sin TTY.
- Cuando el CLI no puede hacer algo, el error o la pista incluye el enlace **a la página exacta del dashboard** donde se hace. Ejemplos: crear un proyecto, gestionar dominios, cambiar la configuración de build, reconectar la integración con GitHub.
- Formatos verificados en el código de Wrangler:
  - proyecto: `https://dash.cloudflare.com/{acct}/pages/view/{proj}`;
  - deploy: `https://dash.cloudflare.com/{acct}/pages/view/{proj}/{deployId}`.
- Las rutas de las secciones están **[sin verificar]**. El builder las confirma abriéndolas en la cuenta de pruebas antes de incluirlas. Si alguna no se puede verificar, se usa el enlace del proyecto.

---

## 6. Modelo de seguridad y comportamiento

### 6.1 Niveles de confirmación
| Nivel | Comandos | Interactivo (TTY) | No interactivo |
|---|---|---|---|
| Lectura | `list`, `show`, `logs`, `env list`, `env get` sin `--reveal` | sin confirmación | sin confirmación |
| Mutación en preview | `redeploy`/`retry` de preview, `env set/unset --env preview` | `¿Continuar? (y/N)` | exige `--yes` |
| Mutación en producción | `redeploy`/`retry` de producción, `rollback`, `env set/unset --env production`, y `env set/unset` en **cualquier** entorno si el proyecto parece gestionado por un archivo de Wrangler | escribir el **nombre del proyecto** | exige `--confirm <nombre-del-proyecto>`; `--yes` **no basta** |
| Lectura sensible | `env get --reveal` (una sola clave, solo `plain_text`) | sin confirmación adicional: `--reveal` ya es la petición explícita | igual; se registra en la auditoría (nombre de la clave, nunca el valor) |

- Todas las mutaciones aceptan `--dry-run`: muestra exactamente lo que haría (incluido el diff) y no cambia nada.
- Sin TTY y sin el flag requerido, el comando no pregunta. Termina con el código "confirmación requerida" y un mensaje que dice qué flag falta.
- **Nunca hay prompts si stdin no es una TTY.** Existe `--no-input` para forzar ese comportamiento.

### 6.2 Protección de secretos
- El token nunca se imprime, ni en `--debug`. Las cabeceras `Authorization` y cualquier valor de variable se redactan en logs, errores y trazas.
- Los valores de las variables siguen la regla de ocultamiento en toda salida. `--reveal` solo actúa sobre una clave concreta.
- **Registro de auditoría local** (decisión mía): un archivo JSONL con permisos 0600 en el directorio de configuración. Cada mutación añade una línea con fecha, comando, proyecto, entorno, id del deploy, **nombres** de las claves (nunca valores) y resultado. Permite saber qué hizo el agente.

### 6.3 Salida y códigos de salida
- Por defecto la salida es para humanos: tablas, color que respeta `NO_COLOR`, y sin color ni animaciones si no hay TTY.
- `--json`: **un único documento JSON en stdout**, tanto en caso de éxito como de error (`{ ok: false, error: { code, message, hint } }`), con un esquema estable y documentado. El progreso y los diagnósticos van a stderr.
- Códigos de salida (documentados en `--help`):

| Código | Significado |
|---|---|
| 0 | éxito |
| 1 | error inesperado |
| 2 | uso inválido |
| 3 | auth requerida o inválida |
| 4 | no encontrado (proyecto, deploy, variable) |
| 5 | confirmación requerida, o cancelado por el usuario |
| 6 | error de la API de Cloudflare (incluido el límite de peticiones) |
| 7 | el deploy terminó en fallo (`--wait`) |

- Todos los mensajes de error dicen **qué pasó, qué se esperaba y qué probar**.

### 6.4 Cliente de la API
- Todas las llamadas pasan por un único módulo, que se encarga de:
  - inyectar la auth;
  - aplicar timeouts;
  - reintentar ante 429 y 5xx respetando `retry-after`;
  - convertir los errores a tipos propios, que se corresponden con los códigos de salida;
  - redactar los datos sensibles en `--debug`.
- Las peticiones a Cloudflare van **solo** a `api.cloudflare.com`. No hay telemetría.

### 6.5 Modelo de amenazas y sus límites (decisión mía, a partir de lo hablado)
Solo el dueño de las credenciales le pide cosas a su agente. Por eso v1 trata al agente como **descuidado, no hostil**.

**Contra qué protege:**
- Errores humanos o del agente, como el entorno equivocado o borrar o vaciar variables.
- Tokens en texto plano en `.env` o archivos de configuración.
- Que el token o los valores aparezcan en pantalla, logs o el contexto del modelo.
- Que el agente actúe sin preguntar, porque la skill exige el `--dry-run` y la confirmación en el chat.

**Contra qué no protege, y se documenta así en el README:**
- El CLI **no puede distinguir** a un agente de una persona. Un agente que decida ignorar la skill puede pasar `--confirm <proyecto>` igual que tú. Esa fricción frena accidentes, no malicia.
- Un proceso que corre con tu mismo usuario del sistema podría, en teoría, leer el token del llavero o del archivo 0600. El almacén seguro evita fugas en texto plano, no a un atacante que ya ejecuta código como tú.
- Un repo con instrucciones maliciosas que el agente lea (*prompt injection*). La defensa es la confirmación humana en el chat.

**Opción para quien quiera más** (decisión mía, coste bajo):
- Ajuste `productionRequiresTty: true`, desactivado por defecto.
- Con él activo, las mutaciones de producción **solo** se aceptan desde una terminal interactiva. Sin TTY, aunque se pase `--confirm`, terminan con el código 5, y el agente tiene que pedirle a la persona que ejecute el comando ella misma.
- Por defecto queda desactivado porque el flujo deseado incluye que el agente lance un redeploy de producción después de que el usuario lo confirme en el chat.

---

## 7. Cómo se construye

### 7.1 Decidido por el usuario
- **TypeScript**, publicado en **npm** y ejecutable con **`npx`** o con instalación global. Debe ser fácil de usar para cualquiera.
- Una sola cuenta en v1.
- La skill debe ser independiente del agente.

### 7.2 Stack (decisión mía; el builder puede cambiar una pieza si lo justifica)
- Node `>=22.12`. Node 22 es el mínimo que exigen commander 15, vitest 5 y msw 3.
- **commander 15** con `@commander-js/extra-typings`.
- **@inquirer/prompts** para la entrada oculta, siempre detrás de una comprobación de TTY propia, porque ninguna librería de prompts degrada bien sin TTY.
- **`node:util.styleText`** para el color, que respeta `NO_COLOR` y `TERM=dumb`.
- **tsdown** para empaquetar en un bundle.
- **vitest 5** y **msw 3** para las pruebas.
- **`@napi-rs/keyring` v2** como `optionalDependency`.
- Licencia por defecto: **MIT**.
- Idioma de los mensajes del CLI y la documentación: **inglés** (open source). El README puede tener además una versión en español.

### 7.3 SDK de Cloudflare
El SDK oficial `cloudflare` v7.3.0 cubre todos los endpoints de v1. Tiene tipos y reintentos, cero dependencias, y es ESM/CJS con Node ≥20. Pero ocupa **unos 71 MB desempaquetado**, demasiado para un `npx` ágil.

**Restricción:** la instalación del paquete publicado debe ser ligera. El objetivo orientativo es **menos de 3 MB desempaquetado**, sin contar el binario nativo del llavero, y debe medirse.

El builder elige entre dos opciones y documenta la elección con la medida:
- (a) meter en el bundle solo la parte del SDK que se usa, mediante la entrada `cloudflare/tree-shakable`, sin dependencia del SDK en tiempo de ejecución;
- (b) escribir un cliente propio y fino con `fetch` para los cerca de 15 endpoints, usando los tipos del OpenAPI.

### 7.4 Preparado para Workers
Se organiza en capas, sin crear abstracciones que todavía no hacen falta:
- `core/`: configuración, credenciales, cliente HTTP, salida, confirmaciones, ocultamiento y auditoría. No sabe nada de Pages.
- `providers/pages/`: servicios de dominio (proyectos, deploys, logs, variables) y sus tipos.
- `commands/`: capa fina que traduce flags a llamadas de servicio.

Añadir Workers en el futuro sería crear `providers/workers/` y sus comandos, sin tocar `core/`. A tener en cuenta para entonces: la API de Workers Builds exige un token de usuario, no de cuenta, así que el login tendría que contemplarlo.

### 7.5 Calidad y release
- Las pruebas unitarias simulan la API con msw. Cubren como mínimo:
  - la regla de ocultamiento (con los límites exactos 11/12/23/24);
  - el cuerpo del `PATCH`: solo las claves cambiadas, `null` para borrar y nunca secretos;
  - los niveles de confirmación con y sin TTY;
  - la redacción del token en errores y en `--debug`;
  - la precedencia de credenciales;
  - la correspondencia de errores de la API con los códigos de salida;
  - el esquema `--json`.
- CI en GitHub Actions: lint, typecheck, tests y build en macOS, Linux y Windows.
- Publicación en npm con **trusted publishing** (OIDC) y provenance. La primera publicación es manual, como exige npm.
- Versionado semántico y changelog.

---

## 8. Fases
1. **CLI** completo, hasta que sea "muy profesional": core y login → proyectos y deploys de lectura → redeploy, retry y rollback → variables → release.
2. **Agent Skill**, solo cuando el CLI esté estable.

---

## 9. Agent Skill (fase 2)

### Formato y distribución
- Se sigue el estándar abierto **Agent Skills** (agentskills.io):
  - `skills/cf-pages/SKILL.md`, y además `references/` con la referencia completa de comandos y las recetas de diagnóstico.
  - El frontmatter usa solo los campos del estándar (`name` igual al nombre del directorio, `description` entre comillas y en tercera persona, `compatibility`, `license`).
  - El cuerpo tiene menos de 500 líneas.
  - No se usan campos propios de ningún agente.
- Se publica en el repo de GitHub y dentro del paquete npm.
- Instalación documentada para todos los agentes: `npx skills add <repo>` y `gh skill install`.
  - Esto llega a `.agents/skills`, que leen Codex, Gemini CLI, Antigravity, Cursor y Copilot, y a `.claude/skills`, porque Claude Code **no** lee `.agents/skills`.
  - Un comando propio `cf-pages skill install` queda para después.

### Reglas que la skill impone al agente
- Usar **siempre** el CLI con `--json`. **Nunca** llamar a la API de Cloudflare directamente con curl ni leer tokens de archivos `.env`.
- Si el CLI dice que falta el login, **pedir a la persona** que ejecute `cf-pages login` en su terminal. El agente no maneja tokens.
- Antes de cualquier mutación:
  1. ejecutarla con `--dry-run`;
  2. mostrar a la persona qué va a pasar;
  3. esperar su confirmación explícita en el chat;
  4. solo entonces repetirla con `--yes` (preview) o `--confirm <proyecto>` (producción).
- La confirmación vale **para esa acción concreta**, no para las siguientes.
- No usar `--reveal` salvo que la persona lo pida explícitamente para **esa** variable. Antes, avisar de que el valor pasará al proveedor del modelo.
- Limitar el tamaño de la salida: logs con `--tail` primero, y `--output <archivo>` si hace falta el log completo.

### Recetas de diagnóstico (en `references/`)
- **"No veo mis cambios"**:
  1. `projects show` para revisar el diagnóstico y la configuración de auto-deploy;
  2. `deployments list --branch`;
  3. comparar con el último commit usando las herramientas propias del agente (`git log`, `gh`);
  4. si falta el deploy, proponer `deployments redeploy --branch` con `--wait`.
- **"¿Por qué falló el deploy o el preview?"**:
  1. `deployments logs --tail`;
  2. identificar la etapa y el error;
  3. cruzarlo con el repo usando `git` o `gh` del propio agente (lockfile desactualizado, versión de Node, variable faltante, comando de build);
  4. proponer la solución;
  5. si procede, proponer `retry` o `redeploy`.
- **"Cambia la variable X"**:
  1. `env list` para ver el contexto;
  2. `env set --dry-run`;
  3. confirmar con la persona;
  4. aplicar;
  5. ofrecer el redeploy.

### Validación de la skill
- Validar con `skills-ref validate`.
- Probarla al menos en **dos agentes distintos** (por ejemplo Claude Code y Codex) con los tres escenarios, y comprobar que piden confirmación, no revelan valores y no se cuelgan.

---

## 10. Qué queda a criterio del builder
- Los nombres exactos de los subcomandos y flags, siempre que respeten §5 y §6.
- La opción (a) o (b) del §7.3, documentada con la medida.
- El esquema JSON concreto de cada comando, que debe ser estable y estar documentado.
- La estructura interna de archivos dentro de las capas del §7.4.
- El formato de las tablas y la presentación humana.
- Los textos de ayuda y los mensajes, en inglés, claros y accionables.

## 11. Verificaciones obligatorias contra una cuenta real
Antes de dar por terminada cada parte, se comprueba en la cuenta real y se ajusta el comportamiento:
1. Los logs están disponibles para un deploy **fallido**. Sirve, por ejemplo, el preview que falló por `bun.lock`.
2. La forma en que la API devuelve un `secret_text` (`""` o sin campo).
3. Si `retry` devuelve un deploy nuevo.
4. El significado real de `wrangler_config_hash`, y si un `PATCH` de variables se respeta en proyectos con archivo de Wrangler.
5. Si un `redeploy` vía API respeta o ignora los controles de ramas.
6. El comportamiento tras un rollback cuando llega un push nuevo.
7. Un `PATCH` de una sola clave no altera las demás variables ni los bindings: comparar el estado antes y después.

Las verificaciones de lectura (1 y 2) se hacen sobre los proyectos reales. Las que mutan (3–7) se hacen **solo sobre un proyecto de pruebas**, nunca sobre producción de clientes.

**Proyecto de pruebas:** el usuario lo designó.
- Es `landing-studio`, en la cuenta `…651c1`. Es **otra cuenta**, distinta de la de los proyectos de clientes (`…2347`).
- Como v1 es de una sola cuenta, se verifica en este orden:
  1. `login` con la cuenta de pruebas, con un label como "Pruebas";
  2. las verificaciones;
  3. `logout` y `login` con la cuenta principal.
- Lo primero es comprobar, solo leyendo, qué tiene `landing-studio`: si está conectado a Git, si tiene ramas de preview y si tiene `wrangler.toml`. Lo que le falte para alguna verificación se le pide al usuario.

**Quién las ejecuta:**
- El usuario hace `cf-pages login` **una vez** en su terminal.
- A partir de ahí, el builder ejecuta el CLI ya compilado, que lee el token del llavero. Nunca maneja el token directamente.
- Antes de cada verificación que mute algo, el builder pide permiso al usuario.
