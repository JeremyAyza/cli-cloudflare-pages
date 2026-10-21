# 0001. Cliente HTTP propio sobre `fetch`

- Estado: aceptada
- Fecha: 2026-10-21
- Contexto de diseño: §6.4 y §7.3 de `docs/superpowers/specs/2026-10-21-cloudflare-pages-cli-design.md`

## Contexto

Todas las llamadas a Cloudflare tienen que pasar por un único módulo. El diseño ofrecía dos caminos (§7.3):

- (a) usar el SDK oficial `cloudflare` v7.3.0, metiendo en el bundle solo la parte que se usa;
- (b) escribir un cliente propio y fino sobre `fetch`.

Los datos que pesan en la decisión:

- El SDK oficial ocupa unos **71 MB desempaquetado**. El objetivo del paquete publicado es **menos de 3 MB** para que `npx cf-pages` arranque rápido.
- Necesitamos control propio sobre los **reintentos**. Un reintento tras un 5xx o un timeout de un `POST`, `PATCH` o `DELETE` puede duplicar un deploy o repetir un cambio que sí se aplicó. El reintento automático del SDK no distingue entre lectura y mutación como lo exige el proyecto (Review Focus 1).
- Necesitamos control propio de la **redacción**: en `--debug` solo salen método, ruta, estado y duración, nunca cabeceras ni cuerpos, y toda línea pasa por el `Redactor`.
- Necesitamos que cada fallo se traduzca a un `CliError` con su código de salida (3 auth, 4 no encontrado, 6 API) y con una pista de qué probar.
- v1 usa solo unos **12 endpoints**, todos con el mismo sobre de respuesta (`success`, `errors`, `result`, `result_info`).

## Decisión

Cliente propio y fino sobre el `fetch` global de Node (≥ 22.12), en `src/core/http/client.ts`, sin dependencias en tiempo de ejecución.

- Auth con `Authorization: Bearer <token>` y `User-Agent: cf-pages/<versión>`.
- Un timeout por intento con `AbortSignal.timeout` (30 s por defecto), que cubre también la lectura del cuerpo.
- Reintentos:
  - `GET` se repite ante 5xx, error de red y timeout, hasta 2 veces, con espera de `500 * 2 ** intento` ms.
  - Cualquier método se repite ante un 429 con `retry-after` ≤ 10 s (sin `retry-after` se espera 1 s), porque un 429 significa que la petición se rechazó sin hacer nada. Con `retry-after` > 10 s termina enseguida con `rate_limited`.
  - `POST`, `PATCH` y `DELETE` **nunca** se repiten ante 5xx, error de red o timeout. Terminan con `api_error` y la pista de comprobar con `cf-pages deployments list <project>` antes de reintentar.
- Correspondencia de errores: 401 → `auth_invalid`, 403 → `permission_denied` (la pista nombra el permiso y la página de tokens), 404 → `not_found`, 429 → `rate_limited`, el resto de fallos → `api_error`. Un `200` con `success: false` también es `api_error`, con el mensaje `[código] texto` de Cloudflare.
- `ApiError` expone `status` y `cfErrors` para que los servicios de dominio puedan reaccionar a códigos concretos de Cloudflare.
- Un cuerpo que no es JSON (por ejemplo un 502 en HTML) produce un `api_error` limpio con el estado en el mensaje, nunca un fallo de parseo.
- Las redirecciones se rechazan: la API no las usa y el token no debe seguir una a otro host.
- El cliente recibe `sleep`, `token`, `userAgent` y `debug` por inyección. `Session.client()` lo construye una vez con las credenciales resueltas.

## Consecuencias

- El paquete sigue sin dependencias en tiempo de ejecución y el tamaño no depende del SDK.
- La política de reintentos seguros vive en un solo sitio y tiene pruebas propias (msw), incluidas las de que una mutación no se duplica.
- Los endpoints y sus tipos se mantienen a mano. Si Cloudflare cambia un campo, hay que actualizar el view model correspondiente; las pruebas con msw y la verificación contra una cuenta real (§11) son la red de seguridad.
- No heredamos mejoras futuras del SDK (por ejemplo, nuevos endpoints). Para v1 no hacen falta.
- Si algún día se amplía a muchos más endpoints, esta decisión se puede revisar y pasar a la opción (a).

## Medida

El tamaño del bundle y del paquete desempaquetado se mide en la Task 16 y se añade aquí. _Pendiente: bundle size measured in Task 16._
