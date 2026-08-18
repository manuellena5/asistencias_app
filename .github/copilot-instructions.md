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

> ⚠️ **Esta separación es de UX, no de seguridad.** El Apps Script está deployado como "Cualquier persona" y acepta POST sin autenticación: quien abra la consola puede escribir igual. Si en algún momento hace falta seguridad real, hay que agregar un token en los `case` de `doPost` validado contra `PropertiesService`, y que el profe lo cargue una vez desde Config (nunca hardcodeado en el HTML — el repo es público).

## REGLA CRÍTICA 2: versión del Service Worker

> **Cada vez que se modifique cualquier archivo (`index.html`, `carga.html`, `common.js`, `reports.js`, `common.css`, `sw.js`, los manifests, `apps_script.js`), se DEBE incrementar el número de versión del caché en `sw.js`.**

```js
const CACHE_NAME = 'asistencias-v29'; // <- incrementar este número
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
- Constantes: `APP_VERSION`, `SHEET_ID`, `DEFAULT_SCRIPT_URL`, `DIAS_C/L`, `MESES`, `ALIASES`, `TORNEO_CUTOFF`, `ESTADO_LABEL`.
- Estado: `players`, `inactiveSet`, `dynamicAliases`, `scriptUrl`, `staffList`, `cachedDateData`, `loadedDates`, `rawAllDays`, `allDays`, `allObs`, `torneoFilter`.
- Lecturas: `loadPlayersFromSheet()`, `loadStaffFromSheet()`, `fetchLoadedDates()`, `fetchAttendanceForDate(fecha)`, `fetchAllAttendance()`.
- Resolución de nombres: `normName()`, `resolvePlayerKey()`, `displayName()`.
- Fechas: `todayStr()`, `localTimestamp()`, `weekKey()`, `getWeekDays()`, `formatDate*()`, `formatWeek()`, `formatMonth()`.
- UI: `toast()`, `hideBootOverlay()`, `go()`, `renderDatesStrip(onPick)`, `forceUpdate()`.

Cada app define `SCREEN_TITLES` y (opcional) `onScreenChange(screen)`, que `go()` invoca.

**Hook `pendingSaveGuard`:** `common.js` lo define como `() => false`. `carga.html` lo reemplaza por `hasPendingSaveFor` para que `fetchAttendanceForDate` no pise un guardado local que todavía no subió a Sheets. El lector lo deja en `false` porque nunca guarda nada.

### `reports.js` — pantalla de Reportes
- `initReportsScreen()` inyecta el markup en `#scr-reports`.
- `loadReports()` trae el historial y renderiza. Ambas apps la llaman al arrancar y desde `onScreenChange`.
- `invalidateReports()` marca los datos como vencidos → la próxima vez que se entre a Reportes se vuelven a traer del servidor.
- Estado propio: `reportView`, `weekIdx`, `semanalShowAll`, `semanalSortBy`, `totalesAsc`, `reportsLoaded`.
- Renderers: `renderWeekly()`, `renderMonthly()`, `renderPlayer()`, `renderTotales()`.

**Cuándo llamar a `invalidateReports()`:** después de cualquier cosa que cambie lo que los reportes muestran. En `carga.html` ya está en `saveAttendance()`, `addPlayer()`, `confirmRename()` y `togglePlayerActivo()`. Si agregás otra mutación, sumala.

### `carga.html` — profes
Mantiene: cola offline (`pendingQueue`), sincronización automática (`online` + cada 60s), modal de confirmación, picker de cuerpo técnico, notificaciones.

Usa **verde** (`--primary:#065f46`) para distinguirse visualmente del lector (azul).

### `localStorage` compartido
Las dos apps viven en el mismo origen de GitHub Pages, así que comparten `localStorage`. La lista de jugadores, `club_script_url` y `club_torneo_filter` se cachean una vez y sirven para ambas. Claves: `club_players`, `club_inactive_players`, `club_name_aliases`, `club_script_url`, `club_staff`, `club_staff_id/name/cargo`, `club_default_status`, `club_torneo_filter`, `club_pending_queue`, `att_<fecha>`.

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
| GET | `getAllAttendance` | Todos los registros históricos | ambas (reportes) |
| GET | `getPlayers` | Lista de jugadores (con `id` y `activo`) | ambas |
| GET | `getStaff` | Cuerpo técnico habilitado | ambas |
| POST | `saveAttendance` | Guarda asistencia (`overwrite:true` reemplaza el día) | **solo carga** |
| POST | `addPlayer` | Agrega jugador nuevo | **solo carga** |
| POST | `setPlayerActivo` | Activa/desactiva jugador | **solo carga** |
| POST | `renamePlayer` | Renombra jugador | **solo carga** |

### Estructura de Sheets

**Asistencias_App**: `Timestamp | Fecha | Jugador | Estado | Observación | JugadorID | CargadoPorNombre | CargadoPorID`

**Jugadores**: `Nombre | Activo | ID` (`Activo` vacío = activo, `NO` = inactivo)

**CuerpoTecnico**: `Nombre | Cargo | Habilitado | ID`

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
```js
// no-cors: no podemos leer la respuesta, pero una excepción es señal
// confiable de "no hay conexión" → encolar el cambio
try {
  await postToScript('saveAttendance', { data: records, overwrite: true });
} catch (e) {
  queuePendingAction('saveAttendance', { data: records, overwrite: true }, fecha, label);
}
invalidateReports(); // los reportes en memoria quedaron viejos
```

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

- **CORS**: GAS lo maneja solo si el Web App es público. No agregar headers manuales.
- **Fechas en GAS**: normalizar siempre con `normalizeFecha()`; nunca `toISOString()`.
- **Fechas en el cliente**: "hoy" se calcula con `todayStr()`, que usa hora local. `new Date().toISOString()` da el día siguiente después de las 21:00 en Argentina. Lo mismo vale para `weekKey()` y `getWeekDays()`, que arman las fechas con `getFullYear/getMonth/getDate` locales.
- **SW caché stale**: siempre versionar `CACHE_NAME` en cada cambio, y sumar los archivos nuevos a `CACHED_URLS`.
- **Reportes desactualizados tras guardar**: si agregás una mutación nueva en `carga.html`, llamá a `invalidateReports()`.
- **Re-deploy GAS**: guardar el archivo en GAS no es suficiente; hay que hacer "New deployment" o "Manage deployments → Deploy new version".
- **Límites de GAS**: 6 minutos de ejecución por invocación, 20k llamadas/día en cuenta gratuita.
- **`asistencias_app.html`**: no borrarlo hasta que todos hayan reinstalado la app que les corresponde — es la URL que abren las PWAs viejas ya instaladas.

---

## Cómo probar local

Hay un servidor de prueba con un Apps Script simulado en `_test/`:

```bash
npm i -D playwright            # una sola vez
node _test/mock-server.js      # terminal 1 → http://localhost:8099
node _test/run.js              # terminal 2 → suite de humo
```

La suite verifica, entre otras cosas, que **los reportes de las dos apps sean idénticos** y que la app de consulta no mande ni un solo POST. `_test/` no forma parte de la app y no se sirve en producción.
