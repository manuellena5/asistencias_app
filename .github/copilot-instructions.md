# Copilot Instructions — Asistencias App

## Descripción del proyecto

PWA de registro de asistencias para un club deportivo, alojada en **GitHub Pages** con backend en **Google Apps Script** conectado a **Google Sheets**.

- **Frontend**: `asistencias_app.html` — app SPA completa en HTML/CSS/JS vanilla, sin frameworks.
- **Backend**: `apps_script.js` — Google Apps Script deployado como Web App pública.
- **Service Worker**: `sw.js` — estrategia cache-first para el app shell. Nunca cachea llamadas a GAS/Sheets.
- **Manifest**: `manifest.json` — configuración PWA.

---

## Funcionalidades actuales

### Pantalla Asistencia (tab activo por defecto)
- El usuario elige una fecha con un `<input type="date">`.
- Al cambiar la fecha, se consulta al backend si ya tiene datos para ese día (`getAttendance`). El resultado se cachea en `cachedDateData{}` (memoria de sesión).
- Se muestra un banner de estado: "datos cargados" o "sin datos para esta fecha".
- Se muestra un botón para cargar la lista de jugadores.
- Al hacer clic, la lista se renderiza instantáneamente desde el caché.
- Cada jugador tiene botones de estado: **P** (Presente), **A** (Ausente), **J** (Justificado).
- Si la fecha tiene datos previos, se pre-cargan (`applyFormData`). Si no, se usa el estado por defecto configurado.
- El botón Guardar envía todos los registros al backend (`saveAttendance` con `overwrite: true`).
- Las notificaciones usan `navigator.serviceWorker.ready.then(reg => reg.showNotification(...))` — nunca `new Notification()`.

### Pantalla Reportes
- Carga todos los registros históricos (`getAllAttendance`).
- Muestra estadísticas de presencia por jugador (días P / días J / días A / total).
- Filtro por rangos de fecha.

### Pantalla Jugadores
- Lista los jugadores desde la hoja **Jugadores** del Sheet (fuente de verdad).
- Permite agregar jugadores nuevos (`addPlayer`). Se escribe en columna A (Nombre) solamente.
- No permite eliminar jugadores desde la app.
- Los jugadores se cachean en `localStorage` (`club_players_v2`) con TTL de 1 hora.

### Pantalla Configuraciones
- Campo para ingresar y guardar la URL del Web App de Google Apps Script.
- Selector de **estado por defecto** (A — Ausente / P — Presente) para días sin datos.
- Ambos valores se persisten en `localStorage`.

---

## REGLA CRÍTICA: Versión del Service Worker

> **Cada vez que se modifique cualquier archivo del proyecto (`asistencias_app.html`, `sw.js`, `manifest.json`, `apps_script.js`), se DEBE incrementar el número de versión del caché en `sw.js`.**

```js
// sw.js — línea 1
const CACHE_NAME = 'asistencias-v11'; // <- incrementar este número
```

**Por qué es obligatorio:** El SW usa estrategia cache-first. Sin cambiar la versión, los usuarios (especialmente en mobile instalado como PWA) seguirán viendo la versión anterior indefinidamente.

Patrón a seguir al editar:
1. Hacer el cambio en el archivo correspondiente.
2. Cambiar `asistencias-vN` → `asistencias-v(N+1)` en `sw.js`.
3. Nunca saltarse este paso, aunque el cambio sea cosmético.

---

## Arquitectura Google Apps Script

### Restricciones conocidas de GAS

- `ContentService.TextOutput` **NO soporta** `.setHeader()`. Llamarlo lanza `TypeError` que rompe toda la respuesta. **Nunca usar `.setHeader()`**.
- GAS maneja CORS automáticamente cuando el Web App está deployado como "Anyone can access".
- Las fechas en Sheets se deserializan como objetos `Date` de JavaScript, no como strings. Siempre normalizar:
  ```js
  const dateStr = cellFecha instanceof Date
    ? cellFecha.toISOString().split('T')[0]
    : (cellFecha || '').toString().trim();
  ```
- Deployar como: **Ejecutar como: tu cuenta** / **Acceso: Cualquier persona**.
- Cada cambio en `apps_script.js` requiere **nuevo deployment** en GAS (no alcanza con guardar).

### Endpoints actuales

| Método | action | Descripción |
|--------|--------|-------------|
| GET | `getAttendance&fecha=YYYY-MM-DD` | Registros de un día específico |
| GET | `getAttendanceDates` | Lista de fechas únicas con datos (ligero) |
| GET | `getAllAttendance` | Todos los registros históricos |
| GET | `getPlayers` | Lista de jugadores |
| POST | `saveAttendance` | Guarda asistencia (con `overwrite: true` reemplaza el día) |
| POST | `addPlayer` | Agrega jugador nuevo |

### Estructura de Sheets

**Asistencias_App**: `Timestamp | Fecha | Jugador | Estado | Observación`

**Jugadores**: `Nombre | Litros/dia | Vianda | Remis | Monto Remis | Fecha`
(La app solo lee/escribe columna A — Nombre)

---

## Variables de estado clave (frontend)

```js
let players = [];             // lista desde Sheets, cacheada en localStorage
let scriptUrl = '';           // URL del Web App GAS, guardada en localStorage
let defaultStatus = 'A';      // 'A' o 'P', guardada en localStorage
let cachedDateData = {};       // {fecha: records[]} — caché en memoria por sesión
let loadedDates = new Set();   // fechas con datos, para chips de navegación
let allDays = [];              // datos para reportes
let allObs = {};               // observaciones para estado J
```

---

## Patrones de desarrollo establecidos

### Llamadas al backend
```js
// Siempre usar la variable scriptUrl como base
const res = await fetch(`${scriptUrl}?action=getAttendance&fecha=${fecha}`);
const json = await res.json();
if (json.status !== 'success') throw new Error(json.message);
```

### Caché de jugadores (localStorage)
```js
const CACHE_KEY = 'club_players_v2';
const CACHE_TTL = 3600000; // 1 hora
// Siempre verificar TTL antes de usar el caché
```

### Notificaciones en PWA instalada
```js
// CORRECTO — funciona cuando el SW está activo
navigator.serviceWorker.ready.then(reg =>
  reg.showNotification('Título', { body: 'Mensaje' })
);
// INCORRECTO — lanza "Illegal constructor" con SW activo
new Notification('Título');
```

### Alias de jugadores
El objeto `ALIASES` normaliza nombres inconsistentes entre registros históricos y la lista actual:
```js
const ALIASES = {
  'DIAZ JONATAN CHANCLA': 'DIAZ JONATAN',
  // ...
};
```
Usar siempre la función `norm()` al comparar nombres de jugadores.

---

## Guía para apps similares en GitHub Pages + Google Apps Script

### Estructura mínima recomendada
```
index.html          # App SPA
sw.js               # Service Worker
manifest.json       # PWA manifest
apps_script.js      # Código GAS (se copia/pega en el editor de GAS)
.github/
  copilot-instructions.md
```

### Checklist de setup
1. **Google Sheets**: crear hoja con las columnas necesarias. Anotar el `SHEET_ID` (está en la URL).
2. **Google Apps Script**: crear proyecto en script.google.com, pegar `apps_script.js`, deployar como Web App.
   - Ejecutar como: tu cuenta Google.
   - Quién tiene acceso: Cualquier persona (para que la PWA pueda llamarlo sin auth).
3. **Frontend**: guardar la URL del deployment en el campo de Configuraciones de la app.
4. **Service Worker**: registrar en el HTML, nunca cachear las URLs de GAS/Sheets.
5. **GitHub Pages**: activar en Settings → Pages → rama `main`, carpeta raíz.
6. **Primer deploy**: verificar que el SW se instala, que el manifest es válido, y que las llamadas al backend funcionan.

### Gotchas frecuentes
- **CORS**: GAS lo maneja solo si el Web App es público. No agregar headers manuales.
- **Fechas**: siempre comparar con `instanceof Date` en GAS.
- **SW caché stale**: siempre versionar `CACHE_NAME` en cada cambio.
- **Notificaciones**: usar `reg.showNotification()` vía SW, no el constructor directo.
- **Re-deploy GAS**: guardar el archivo en GAS no es suficiente; hay que hacer "New deployment" o "Manage deployments → Deploy new version".
- **Límites de GAS**: 6 minutos de ejecución por invocación, 20k llamadas/día en cuenta gratuita.
