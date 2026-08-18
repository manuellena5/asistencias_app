# Copilot Instructions — Asistencias App

## Descripción del proyecto

Dos PWAs de asistencias para un club deportivo, alojadas en **GitHub Pages** con backend en **Google Apps Script** conectado a **Google Sheets**.

La app original (`asistencias_app.html`, un solo archivo) se dividió en **dos apps separadas** que comparten el mismo Sheet, el mismo Apps Script y el mismo `localStorage`.

**La división es por permiso de escritura, no por información.** Las dos apps muestran exactamente los mismos reportes. La única diferencia es que desde la app de consulta no se puede modificar nada.

| Archivo | Qué es | Quién la usa |
|---|---|---|
| `index.html` | App de **consulta** (solo lectura): reportes + asistencia por día | Dirigentes, jugadores, cualquiera |
| `carga.html` | App de **carga**: asistencia + reportes + plantel | Cuerpo técnico (profes) |
| `reports.js` | Pantalla de Reportes completa (markup + lógica) | **Ambas** |
| `common.js` | Estado, lecturas GET, resolución de nombres, fechas, navegación | Ambas |
| `common.css` | Estilos compartidos | Ambas |
| `sw.js` | Service Worker único (raíz) que cubre las dos apps | Ambas |
| `manifest.json` | PWA de consulta (azul, `start_url: ./index.html`) | — |
| `manifest-carga.json` | PWA de carga (verde, `start_url: ./carga.html`) | — |
| `icon.svg` / `icon-carga.svg` | Íconos distintos para que se distingan en el celular | — |
| `apps_script.js` | Código GAS (se copia/pega en el editor de GAS) | — |
| `asistencias_app.html` | **Página puente**: dos botones para elegir app | Migración de installs viejos |

### Pantallas

| | `index.html` (consulta) | `carga.html` (profes) |
|---|---|---|
| Asistencia (formulario P / E-A / J / A) | — | ✅ |
| Reportes (semanal / mensual / jugador / totales) | ✅ | ✅ |
| Por día (detalle solo lectura) | ✅ | — (lo cubre el formulario) |
| Jugadores (alta, renombre, activo/inactivo) | — | ✅ |
| Ajustes | mínimos | completos |

---

## REGLA CRÍTICA 1: el lector nunca escribe

`index.html`, `common.js` y `reports.js` **no pueden hacer POST** al Apps Script. Solo GET:
`getAllAttendance`, `getAttendance`, `getAttendanceDates`, `getPlayers`, `getStaff`.

Todas las escrituras (`saveAttendance`, `addPlayer`, `setPlayerActivo`, `renamePlayer`) viven **solo** en `carga.html`, junto con la cola offline (`pendingQueue`).

Si estás por agregar un POST, preguntate en qué archivo va. Si la respuesta es `index.html`, `common.js` o `reports.js`, va en `carga.html`.

### Quién puede escribir: el PIN del cuerpo técnico

La separación en dos apps es de UX. Lo que **sí** frena a quien abra la consola es el PIN:

- Cada profe tiene un PIN de 4 dígitos en la columna **E de `CuerpoTecnico`**, cargado a mano.
- Todo POST manda `staffId` + `pin`. `doPost` corta **antes** del `switch` con `pinValido(staffId, pin)` y devuelve `{status:'error', code:'no-autorizado', restantes}` si no valida.
- **Sin PIN en la hoja, ese profe no puede escribir.** Es una decisión explícita: no agregar un fallback permisivo, dejaría la validación sin efecto.
- **`getStaffData()` nunca devuelve la columna E.** Es un GET público: si el PIN viajara ahí, toda la validación no serviría para nada. La columna E se lee solo dentro de `pinValido()`.
- `doGet` sigue abierto a propósito: la consulta es pública.

> 🔒 **No documentes ni menciones en ningún lado de dónde salen esos dígitos** — ni en comentarios, ni en docs, ni en textos de la interfaz, ni en nombres de variables o mensajes de test. Este repo es público.

**Validación inmediata.** La acción `verifyPin` solo valida y responde, no escribe nada. El cliente la usa para rechazar un PIN equivocado **en el momento en que se ingresa**, en vez de aceptarlo y que falle recién al guardar. Un PIN que no valida no se guarda en el dispositivo.

**Bloqueo por intentos fallidos.** 5 fallos → `code:'bloqueado'` durante 15 minutos. El contador va **por `staffId`, no por dispositivo** (si no, cambiar de navegador reseteaba el límite). Se lleva en **`CacheService`, no `PropertiesService`**: el cache expira solo, así que el bloqueo se levanta sin que nadie intervenga — con Properties habría que limpiarlo a mano y un profe podría quedar trabado un domingo a la noche. Un PIN correcto limpia el contador.

El mensaje de error dice solo "PIN incorrecto", **nunca** si el problema es el PIN o el usuario: distinguirlos le confirmaría a quien prueba cuál de los dos acertó.

El PIN se agrega en `postToScript()` **en el momento del envío**, nunca dentro del payload que se encola: un item que quedó en la cola tiene que subir con el PIN vigente, no con el que había cuando se encoló.

> Alcance real: 4 dígitos frenan al curioso, no a alguien decidido. El bloqueo de 5 intentos hace inviable probar las 10.000 combinaciones, pero el PIN sigue viajando en el body. Para el caso de uso del club alcanza. Si hiciera falta más, el camino es deployar el Web App como "Solo usuarios de mi dominio" o meter Google Sign-In.

## REGLA CRÍTICA 2: versión del Service Worker

> **Cada vez que se modifique cualquier archivo (`index.html`, `carga.html`, `common.js`, `reports.js`, `common.css`, `sw.js`, los manifests, `apps_script.js`), se DEBE incrementar el número de versión del caché en `sw.js`.**

```js
const CACHE_NAME = 'asistencias-v35'; // <- incrementar este número
```

**Por qué es obligatorio:** el SW usa estrategia cache-first. Sin cambiar la versión, los usuarios (especialmente en mobile con la PWA instalada) siguen viendo la versión anterior indefinidamente.

Patrón al editar:
1. Hacer el cambio.
2. `asistencias-vN` → `asistencias-v(N+1)` en `sw.js`.
3. Si agregaste un archivo nuevo, sumarlo también a `CACHED_URLS`.
4. Nunca saltarse este paso, aunque el cambio sea cosmético.

## REGLA CRÍTICA 3: los reportes van en `reports.js`, no en el HTML

Las dos apps muestran los mismos reportes. Para que no puedan quedar desincronizadas, `reports.js` trae **también el markup**: cada HTML solo declara el contenedor vacío

```html
<div id="scr-reports" class="screen"></div>
```

y llama a `initReportsScreen()` en el `DOMContentLoaded`. Nunca copiar el HTML de las pestañas de reportes dentro de un `.html`.

---

## Cómo se reparten las responsabilidades

### `common.js` — base compartida
- Constantes: `APP_VERSION`, `SHEET_ID`, `DEFAULT_SCRIPT_URL`, `DIAS_C/L`, `MESES`, `ALIASES`, `TORNEO_CUTOFF`, `ESTADO_LABEL`, `RANGO_LABEL`, `RANGO_SIGUIENTE`.
- Estado: `players`, `inactiveSet`, `dynamicAliases`, `scriptUrl`, `staffList`, `cachedDateData`, `loadedDates`, `allDays`, `allObs`, `rangoReportes`, `reportsCache`.
- Lecturas: `loadPlayersFromSheet()`, `loadStaffFromSheet()`, `fetchLoadedDates()`, `fetchAttendanceForDate(fecha)`, `fetchAllAttendance(rango)`.
- Rango de reportes: `rangoDesdeHasta(rango)`, `clearReportsCache()`, `migrarRangoGuardado()`.
- Resolución de nombres: `normName()`, `resolvePlayerKey()`, `displayName()`.
- Fechas: `todayStr()`, `dateStr(d)`, `localTimestamp()`, `weekKey()`, `getWeekDays()`, `formatDate*()`, `formatWeek()`, `formatMonth()`.
- UI: `esc()`, `toast()`, `hideBootOverlay()`, `go()`, `renderDatesStrip(onPick)`, `forceUpdate()`.

> **Regla de `esc()`:** todo dato que venga de la planilla y vaya a `innerHTML` pasa por `esc()`. Nombres de jugadores, nombres del cuerpo técnico y sobre todo las **observaciones** (texto libre que escribe el profe a mano) se muestran en las dos apps: con que alguien escriba `<img src=x onerror=...>` una vez, le rompe la pantalla a todos los que miran los reportes.
>
> Donde el dato tiene que ir dentro de un `onclick` inline, `esc()` **no alcanza** — escapar la comilla rompe el JavaScript y no escaparla lo deja inyectable. Ahí se arma el elemento por DOM con `textContent` + listener (`openStaffPicker()` y `renderMgmt()` en `carga.html` son los ejemplos).

Cada app define `SCREEN_TITLES` y (opcional) `onScreenChange(screen)`, que `go()` invoca.

**Hook `pendingSaveGuard`:** `common.js` lo define como `() => false`. `carga.html` lo reemplaza por `hasPendingSaveFor` para que `fetchAttendanceForDate` no pise un guardado local que todavía no subió a Sheets. El lector lo deja en `false` porque nunca guarda nada.

### `reports.js` — pantalla de Reportes
- `initReportsScreen()` inyecta el markup en `#scr-reports`.
- `loadReports()` trae el historial del rango activo y renderiza. Ambas apps la llaman al arrancar y desde `onScreenChange`.
- `invalidateReports()` marca los datos como vencidos **y limpia el caché de todos los rangos** → la próxima vez que se entre a Reportes se vuelven a traer del servidor.
- Estado propio: `reportView`, `weekIdx`, `semanalShowAll`, `semanalSortBy`, `totalesAsc`, `reportsLoaded`.
- Renderers: `renderWeekly()`, `renderMonthly()`, `renderPlayer()`, `renderTotales()`.

**Rango de fechas.** Un solo selector arriba de las pestañas: `30 días` (default) / `90 días` / `Torneo` (desde `TORNEO_CUTOFF`) / `Todo`. El servidor filtra; `allDays` ya viene recortado. Los datos se cachean por rango en memoria, así que volver a un rango ya visto no refetchea.

Si tocás un reporte, **que no mienta sobre el período que muestra**:
- El encabezado de Totales nombra el rango (`Ranking · últimos 30 días`), no dice "General".
- Mensual solo ofrece los meses que hay dentro del rango.
- Semanal, al llegar a la semana más vieja del rango, muestra `avisoAmpliarHtml()` con un botón "Cargar más historial" (`ampliarRango()`: 30 → 90 → todos). Sin eso, una semana sin datos se lee como "esa semana no hubo prácticas" cuando en realidad esos días nunca se descargaron. **Es el detalle que más fácil se pasa por alto.**
- El selector de Por Jugador se arma con los del rango **más** `activePlayers()`, para que un jugador sin asistencias en el rango igual aparezca con 0%.

**Cuándo llamar a `invalidateReports()`:** después de cualquier cosa que cambie lo que los reportes muestran. En `carga.html` ya está en `saveAttendance()`, `addPlayer()`, `confirmRename()` y `togglePlayerActivo()`. Si agregás otra mutación, sumala.

### `carga.html` — profes
Mantiene: cola offline (`pendingQueue`), sincronización automática (`online` + cada 60s), modal de confirmación, picker de cuerpo técnico, notificaciones.

Usa **verde** (`--primary:#065f46`) para distinguirse visualmente del lector (azul).

### `localStorage` compartido
Las dos apps viven en el mismo origen de GitHub Pages, así que comparten `localStorage`. La lista de jugadores, `club_script_url` y `club_rango_reportes` se cachean una vez y sirven para ambas. Claves: `club_players`, `club_inactive_players`, `club_name_aliases`, `club_script_url`, `club_staff`, `club_staff_id/name/cargo`, `club_staff_pin`, `club_default_status`, `club_rango_reportes`, `club_pending_queue`, `att_<fecha>`.

`club_rango_reportes` reemplazó a `club_torneo_filter`; `migrarRangoGuardado()` en `common.js` convierte el valor viejo (`'clausura'`/`'apertura'` → `'torneo'`) para no romperle la vista a quien ya lo tenga guardado.

---

## Arquitectura Google Apps Script

### Restricciones conocidas de GAS

- `ContentService.TextOutput` **NO soporta** `.setHeader()`. Llamarlo lanza `TypeError` que rompe toda la respuesta. **Nunca usar `.setHeader()`**.
- GAS maneja CORS automáticamente cuando el Web App está deployado como "Anyone can access".
- Las fechas en Sheets se deserializan como objetos `Date` de JavaScript, no como strings. Siempre normalizar con `normalizeFecha()`:
  ```js
  const dateStr = normalizeFecha(cellFecha);
  ```
  **Nunca usar `toISOString()`** sobre esas celdas: pasa la fecha a UTC y corre el día según el offset de la zona horaria del proyecto. `normalizeFecha()` usa `Utilities.formatDate(cell, TIMEZONE, 'yyyy-MM-dd')` con la zona explícita de Argentina.
- Deployar como: **Ejecutar como: tu cuenta** / **Acceso: Cualquier persona**.
- Cada cambio en `apps_script.js` requiere **nuevo deployment** en GAS (no alcanza con guardar).

### Endpoints actuales

| Método | action | Descripción | Quién lo usa |
|--------|--------|-------------|--------------|
| GET | `getAttendance&fecha=YYYY-MM-DD` | Registros de un día específico | ambas |
| GET | `getAttendanceDates` | Lista de fechas únicas con datos (ligero) | ambas |
| GET | `getAllAttendance[&desde=&hasta=]` | Registros del rango (sin params: todo) | ambas (reportes) |
| GET | `getPlayers` | Lista de jugadores (con `id` y `activo`) | ambas |
| GET | `getStaff` | Cuerpo técnico habilitado (**nunca el PIN**) | ambas |
| POST | `verifyPin` | Valida el PIN y responde. **No escribe nada** | **solo carga** |
| POST | `saveAttendance` | Guarda asistencia (`overwrite:true` reemplaza el día) | **solo carga** |
| POST | `addPlayer` | Agrega jugador nuevo | **solo carga** |
| POST | `setPlayerActivo` | Activa/desactiva jugador | **solo carga** |
| POST | `renamePlayer` | Renombra jugador | **solo carga** |

**Todos los POST requieren `staffId` + `pin`** en el body, `verifyPin` incluido. Sin eso, `doPost` responde `{status:'error', code:'no-autorizado', restantes:N}` sin tocar nada, o `code:'bloqueado'` si ya se pasó de 5 fallos.

`desde`/`hasta` son `YYYY-MM-DD` y se comparan como **strings ya normalizados** con `normalizeFecha()`. Nunca compares con `new Date(celda)`: es el bug que tenía el viejo `getReportsData` (borrado), que corría el día según la zona horaria.

### Concurrencia y costo de las escrituras

Las cuatro mutaciones corren dentro de `conLock()` (`LockService`, `waitLock(20000)`). Sin eso, dos profes guardando el mismo día casi al mismo tiempo leen la hoja los dos, borran los dos y escriben los dos: filas duplicadas o borradas de más.

`saveAttendanceData` hace **una sola escritura**: lee todo, filtra la fecha en memoria y reescribe el bloque completo con `clearContents()` + un único `setValues()`. Antes hacía `deleteRow()` en un loop y `appendRow()` en otro (~60 llamadas a la API con 30 jugadores). Al armar el bloque, las filas se emparejan al ancho del encabezado con `filaAlAncho()`: `setValues` exige filas parejas y en la hoja pueden quedar filas del esquema viejo, más cortas. El bloque siempre incluye el encabezado, así que nunca se llama a `setValues([])`.

### Estructura de Sheets

**Asistencias_App**: `Timestamp | Fecha | Jugador | Estado | Observación | JugadorID | CargadoPorNombre | CargadoPorID`

**Jugadores**: `Nombre | Activo | ID` (`Activo` vacío = activo, `NO` = inactivo)

**CuerpoTecnico**: `Nombre | Cargo | Habilitado | ID | PIN`

> ⚠️ La columna **E (PIN)** no se devuelve **nunca** por GET, y no hay que agregarla a `getStaffData()`. Se lee solo dentro de `pinValido()`. Un profe sin PIN cargado no puede escribir: si se deploya con la columna vacía, **nadie puede cargar asistencia**.

Los IDs se autogeneran del lado GAS si faltan (backfill en `getPlayersData` / `getStaffData`).

---

## Patrones de desarrollo establecidos

### Lecturas (ambas apps)
```js
// Siempre a través de los helpers de common.js
const records = await fetchAttendanceForDate(fecha);
const res = await fetchAllAttendance(); // llena rawAllDays / allObs
```

### Escrituras (solo carga.html)

`postToScript()` usa **`mode:'cors'`, ya no `no-cors`**. Con `no-cors` la respuesta era opaca y el `fetch` resolvía OK aunque el Apps Script hubiera tirado una excepción o el deployment estuviera roto: la app mostraba "✅ guardado y sincronizado" con la asistencia en ningún lado. Funciona porque `/exec` responde un 302 hacia `script.googleusercontent.com`, que manda `Access-Control-Allow-Origin: *` cuando el Web App es público. **`Content-Type: text/plain`** mantiene el POST como *simple request*, así que no hay preflight `OPTIONS` (que GAS no maneja bien) — no lo cambies a `application/json`.

Como ahora `postToScript` tira en varios casos distintos, hay que separarlos. **Nunca uses un solo `catch` genérico:**

```js
try {
  await postToScript('saveAttendance', { data: records, overwrite: true });
} catch (e) {
  if (esErrorDeRed(e)) {
    // No llegó a la red (offline / TypeError): encolar, se reintenta solo.
    queuePendingAction('saveAttendance', payload, fecha, label);
  } else if (esNoAutorizado(e)) {
    // PIN rechazado: encolar MARCADO (needsPin) para que el reintento
    // automático cada 60s no insista con el mismo PIN malo.
    queuePendingAction('saveAttendance', payload, fecha, label, true);
  } else {
    // El servidor respondió con error: avisar y NO encolar. Reintentarlo
    // cada 60s con el mismo payload no lo va a arreglar nunca.
  }
}
invalidateReports(); // los reportes en memoria quedaron viejos
```

El guardado local (`att_<fecha>` en `localStorage`) se hace **siempre primero** y no se toca en ningún caso de error: un rechazo nunca pierde lo que el profe cargó.

`trySyncPending(silent, retryPin)` saltea los items con `needsPin` salvo que el intento sea explícito (botón "Sincronizar", o después de corregir el PIN).

### Identidad de jugadores
Cada jugador tiene un `id` estable. Los registros de asistencia guardan `JugadorID`, así que renombrar a alguien no rompe el historial. `resolvePlayerKey(record)` devuelve el id si lo reconoce, o `'NAME:xxx'` como fallback para registros viejos sin `JugadorID`; el objeto `ALIASES` + `dynamicAliases` resuelve esos casos por nombre.

### Notificaciones en PWA instalada
```js
// CORRECTO — funciona cuando el SW está activo
navigator.serviceWorker.ready.then(reg => reg.showNotification('Título', { body: 'Mensaje' }));
// INCORRECTO — lanza "Illegal constructor" con SW activo
new Notification('Título');
```

---

## Gotchas frecuentes

- **CORS**: GAS lo maneja solo si el Web App es público. No agregar headers manuales. Los POST van con `mode:'cors'` + `Content-Type: text/plain` (ver "Escrituras"); no lo cambies a `application/json` ni vuelvas a `no-cors`.
- **Escapar**: todo dato de la planilla que vaya a `innerHTML` pasa por `esc()`. Si va dentro de un `onclick` inline, armá el elemento por DOM.
- **PIN**: nunca lo devuelvas desde un GET, y nunca lo guardes dentro del payload que se encola.
- **Fechas en GAS**: normalizar siempre con `normalizeFecha()`; nunca `toISOString()`.
- **Fechas en el cliente**: "hoy" se calcula con `todayStr()`, que usa hora local. `new Date().toISOString()` da el día siguiente después de las 21:00 en Argentina. Lo mismo vale para `weekKey()` y `getWeekDays()`, que arman las fechas con `getFullYear/getMonth/getDate` locales.
- **SW caché stale**: siempre versionar `CACHE_NAME` en cada cambio, y sumar los archivos nuevos a `CACHED_URLS`.
- **Reportes desactualizados tras guardar**: si agregás una mutación nueva en `carga.html`, llamá a `invalidateReports()`.
- **Re-deploy GAS**: guardar el archivo en GAS no es suficiente; hay que hacer "New deployment" o "Manage deployments → Deploy new version".
- **Límites de GAS**: 6 minutos de ejecución por invocación, 20k llamadas/día en cuenta gratuita.
- **Escrituras en Sheets**: nunca `deleteRow()` / `appendRow()` en un loop. Leé todo, resolvé en memoria y escribí una vez con `setValues()`. Y siempre dentro de `conLock()`.
- **`asistencias_app.html`**: no borrarlo hasta que todos hayan reinstalado la app que les corresponde — es la URL que abren las PWAs viejas ya instaladas.

---

## Cómo probar local

Hay un servidor de prueba con un Apps Script simulado en `_test/`:

```bash
npm i -D playwright            # una sola vez
node _test/mock-server.js      # terminal 1 → http://localhost:8099
node _test/run.js              # terminal 2 → suite completa
```

Si no querés bajar los browsers de Playwright, podés usar el Chrome del sistema:

```bash
CHROME_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" node _test/run.js
```

`run.js` corre dos cosas:

1. **`_test/apps-script.test.js`** — ejecuta las funciones reales de `apps_script.js` contra un Google Sheets simulado. Cubre lo que el navegador no puede tocar: `overwrite` sin duplicados, filas del esquema viejo (más cortas), guardado sin registros, fechas que Sheets devuelve como `Date`, el filtro `desde`/`hasta`, y `pinValido`. También corre solo: `node _test/apps-script.test.js`.
2. **La suite de humo en el navegador** sobre las dos apps.

Verifica, entre otras cosas, que **los reportes de las dos apps sean idénticos**, que la app de consulta no mande ni un solo POST, que un nombre o una observación con HTML no ejecute nada (`window.__xss` queda `undefined`), que un error del servidor se vea como error, y que **`getStaff` no devuelva el campo `pin`**.

El mock sirve a propósito un jugador y una observación con payload de XSS, y expone `/exec-error` (responde HTTP 200 con `status:'error'`) para probar el camino de error del servidor.

**Las fechas de prueba se generan relativas a hoy**, en `_test/fixtures.js`, que comparten el mock (sirve los datos) y `run.js` (arma las expectativas). Si agregás un check que dependa de una fecha, sacala de ahí — nunca la escribas a mano, o la suite se va a romper sola cuando pase el tiempo. `fixtures.js` lee `TORNEO_CUTOFF` y `MESES` de `common.js`, así que si cambian en la app, la suite los sigue sin tocar nada. El orden de `FECHAS` importa: el mock deriva los estados del índice, así que `FECHAS[4]` es hoy y `FECHAS[3]` es el día con justificado.

`_test/` no forma parte de la app y no se sirve en producción.
