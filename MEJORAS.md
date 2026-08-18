# Plan de mejoras — Asistencias App

Documento de trabajo para resolver **de a una** las mejoras pendientes.
Repo: `C:\Users\manuel.ellena\Git\asistencias_app`

Contexto: los datos de la planilla fueron **inicializados en cero** y hay **backup hecho**. Se pueden borrar archivos, cambiar el esquema de las hojas y romper compatibilidad con datos históricos.

---

## Cómo trabajar este documento

**Una tarea por vez.** No arranques la siguiente hasta que la anterior esté verificada y commiteada.

Reglas que aplican a TODAS las tareas:

1. Leé `.github/copilot-instructions.md` antes de tocar nada. Tiene las reglas del proyecto.
2. **Subí `CACHE_NAME` en `sw.js`** en cada tarea que toque un archivo servido (html/js/css/manifest). Si no, nadie ve el cambio. Va de a uno: v29 → v30 → v31…
3. Si agregás un archivo nuevo, sumalo también a `CACHED_URLS` en `sw.js`.
4. **Corré la suite antes y después** de cada tarea:
   ```bash
   npm i -D playwright        # una sola vez
   node _test/mock-server.js  # terminal 1
   node _test/run.js          # terminal 2
   ```
   Si una tarea cambia el comportamiento esperado, **actualizá la suite en la misma tarea**, no después.
5. Un commit por tarea, con el número: `T3: escapar HTML en nombres y observaciones`.
6. Las tareas que tocan `apps_script.js` requieren que M haga **"Deploy → Manage deployments → Deploy new version"** en GAS. Guardar no alcanza. Avisale al terminar cada una de esas.
7. No inventes cambios fuera del alcance de la tarea. Si encontrás algo más, anotalo al final de este archivo en "Hallazgos nuevos" y seguí.

---

## Estado de las tareas

- [ ] T1 — Limpieza de archivos y código muerto
- [ ] T2 — Que el POST deje de ser ciego (prerequisito de T4)
- [ ] T3 — Escapar HTML en datos de usuario
- [ ] T4 — PIN del cuerpo técnico para autorizar escrituras
- [ ] T5 — LockService + escrituras en lote en el Apps Script
- [ ] T6 — Reportes por rango de fechas (no traer todo el historial)
- [ ] T7 — Actualizar documentación y cierre

---

## T1 — Limpieza de archivos y código muerto

**Por qué:** hay ~26KB de archivo muerto en el repo, una función del Apps Script que nadie llama, y un mapa de alias que apunta a jugadores que ya no existen (los datos se resetearon).

**Archivos:** `asistencias.html`, `apps_script.js`, `common.js`, `_to_delete/`

**Qué hacer:**

1. **Borrar `asistencias.html`.** Es la versión original de enero, 25979 bytes. Verificado: no la referencia ningún HTML, JS, JSON ni el manifest. No está en `CACHED_URLS`.
   ```bash
   git rm asistencias.html
   ```

2. **Borrar la carpeta `_to_delete/`** completa. Son temporales de deploys anteriores.

3. **Borrar `getReportsData()` de `apps_script.js`** (arranca en la línea ~450, `function getReportsData(startDate, endDate)`) y el `case 'getReports':` de `doGet`. Verificado: ningún cliente llama a `action=getReports`. Además tiene un bug latente — usa `new Date(values[i][1])` sin `normalizeFecha()`, que es justo lo que el resto del archivo evita.

4. **Vaciar `ALIASES` en `common.js`.** Los 5 alias mapean nombres de jugadores del historial viejo, que ya no existe. Dejá el objeto vacío con el comentario explicando para qué sirve:
   ```js
   // Alias fijos para nombres inconsistentes en registros históricos.
   // Vacío desde el reset de datos de 2026-08. Si en el futuro aparecen
   // registros con nombres que no matchean el plantel actual, se agregan acá.
   const ALIASES = {};
   ```
   **No borres** `normName()`, `dynamicAliases` ni `resolvePlayerKey()` — siguen haciendo falta para los renombres desde la app.

**Verificación:**
- `grep -rn "asistencias\.html\|getReports\b" --include=*.html --include=*.js .` no devuelve nada (salvo menciones en docs, que se arreglan en T7).
- La suite pasa igual que antes.

**Listo cuando:** el repo no tiene archivos huérfanos y `node _test/run.js` sigue en verde.

---

## T2 — Que el POST deje de ser ciego

**Por qué (esto es un bug real, no una mejora cosmética):** `postToScript()` en `carga.html` usa `mode:'no-cors'`. Con eso el navegador devuelve una respuesta opaca: el `fetch` resuelve OK **aunque el Apps Script haya tirado una excepción, aunque la hoja no exista, aunque el deployment esté roto**. La app le muestra al profe "✅ Asistencia guardada… ya se sincronizaron con la planilla" y la asistencia no está en ningún lado.

Hoy el único caso que se detecta es "no hay red" (ahí el fetch sí tira). Cualquier error del servidor pasa como éxito.

Además esto es **prerequisito de T4**: si no arreglamos esto primero, un PIN mal cargado se va a ver como un guardado exitoso.

**Archivo:** `carga.html`

**Qué hacer:**

1. Cambiar `postToScript()` a `mode:'cors'` manteniendo `Content-Type: text/plain`:
   ```js
   async function postToScript(action,payload){
     const res=await fetch(scriptUrl,{
       method:'POST',mode:'cors',redirect:'follow',
       headers:{'Content-Type':'text/plain'}, // text/plain evita el preflight OPTIONS
       body:JSON.stringify({action,...payload})
     });
     if(!res.ok) throw new Error('HTTP '+res.status);
     const json=await res.json();
     if(json.status!=='success') throw new Error(json.message||'El servidor rechazó el guardado');
     return json;
   }
   ```

   > **Por qué funciona:** `/exec` responde un 302 hacia `script.googleusercontent.com`, y ese destino sí manda `Access-Control-Allow-Origin: *` cuando el Web App está deployado como "Cualquier persona". `text/plain` mantiene el POST como "simple request", así que no hay preflight `OPTIONS` (que GAS no maneja bien).

2. **Problema a resolver con cuidado:** hoy `saveAttendance()` distingue dos casos en el `catch` — sin conexión (encolar) vs. error real (mostrar fallo). Ahora `postToScript` va a tirar en **ambos** casos y hay que separarlos, si no un error del servidor se encola para siempre y se reintenta cada 60s eternamente.

   Distinguí así: si `navigator.onLine === false` **o** el error es un `TypeError` de red (el fetch no llegó a destino) → encolar como offline. Si el servidor respondió pero con error → mostrar el modal de fallo y **no** encolar.

   ```js
   function esErrorDeRed(e){
     return !navigator.onLine || e instanceof TypeError;
   }
   ```

3. Aplicar el mismo criterio en `trySyncPending()`: si un item falla por error del servidor (no por red), **sacalo de la cola** y avisá con un toast, en vez de reintentarlo para siempre. Un item que falla 5 veces seguidas por error del servidor no se va a arreglar solo.

4. Ahora que se puede leer la respuesta, `addPlayer()` puede usar el `id` que devuelve el servidor. **No lo cambies en esta tarea** — el id lo sigue generando el cliente porque tiene que funcionar offline. Solo dejá un comentario aclarándolo.

**Verificación:**
- Agregá al mock (`_test/mock-server.js`) una acción que devuelva `{status:'error',message:'...'}` y un check nuevo en la suite: al guardar contra ese error, el modal tiene que decir **"No se pudo guardar"**, no "Asistencia guardada".
- Check nuevo: tras un error del servidor, `club_pending_queue` en localStorage queda **vacía** (no se encoló).
- Check que ya existe: el guardado exitoso sigue mostrando "Asistencia guardada" y manda 1 POST.

**Listo cuando:** un error del servidor se ve como error en la pantalla del profe. Probalo también contra el GAS real antes de dar por cerrada la tarea — si por algún motivo CORS falla en producción, volvé a `no-cors` y avisá, porque entonces T4 necesita otro enfoque.

---

## T3 — Escapar HTML en datos de usuario

**Por qué:** los nombres de jugadores, los nombres del cuerpo técnico y el campo libre de **observación** (el motivo de justificación) se interpolan directo en `innerHTML` sin escapar. Un nombre o una observación con `<` rompe el render; con `<img src=x onerror=...>` ejecuta JavaScript. Como la observación la escribe el profe a mano y se muestra en **las dos apps**, alcanza con que alguien escriba algo raro una vez para que le rompa la pantalla a todos los que miran los reportes.

Puntos confirmados sin escapar:

| Archivo | Línea aprox. | Dato |
|---|---|---|
| `reports.js` | 382 | `${d.obs}` — observación |
| `index.html` | 210 | `${cargadoPor}` |
| `index.html` | 219 | `${r.nombre}` |
| `index.html` | 223 | `${r.obs}` — observación |
| `carga.html` | 280, 298, 332 | `${cargadoPor}` |
| `carga.html` | 396, 630 | `${p.nombre}` |
| `carga.html` | 758 | `${s.nombre}`, `${s.cargo}` y `'${s.id}'` dentro de un `onclick` |

**Archivos:** `common.js`, `reports.js`, `index.html`, `carga.html`

**Qué hacer:**

1. Agregar en `common.js`, en la sección de helpers de UI:
   ```js
   // Escapa datos que vienen de la planilla antes de meterlos en innerHTML.
   // Los nombres y sobre todo las observaciones son texto libre.
   function esc(s){
     if(s===null||s===undefined)return '';
     return String(s)
       .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
       .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
   }
   ```

2. Envolver **todas** las interpolaciones de la tabla de arriba: `${esc(d.obs)}`, `${esc(p.nombre)}`, etc.

3. Caso especial `carga.html:758` (picker de cuerpo técnico): el `id` va dentro de un atributo `onclick='selectStaff("...")'`. En vez de parchear el escape, **reemplazá el `onclick` inline por un listener**:
   ```js
   list.innerHTML='';
   enabled.forEach(s=>{
     const b=document.createElement('button');
     b.className='btn btn-sec';
     b.style.cssText='margin-top:0;text-align:left';
     b.textContent=s.nombre+(s.cargo?' — '+s.cargo:'');
     b.onclick=()=>selectStaff(s.id);
     list.appendChild(b);
   });
   ```
   Usar `textContent` evita el problema de raíz.

4. Revisá también `renderMgmt()` en `carga.html` — ya escapa comillas a mano en el input de rename (`.replace(/"/g,'&quot;')`). Reemplazalo por `esc()` para que sea consistente.

**Verificación:**
- En el mock, poné un jugador llamado `<img src=x onerror="window.__xss=1">` y una observación `"><script>window.__xss=1</script>`.
- Check nuevo en la suite: después de renderizar reportes y la vista por día, `await page.evaluate(() => window.__xss)` tiene que ser `undefined`, y el nombre se tiene que ver como texto literal.

**Listo cuando:** el jugador con nombre malicioso se muestra como texto y no ejecuta nada, en las dos apps.

---

## T4 — PIN del cuerpo técnico para autorizar escrituras

**Por qué:** el Apps Script está deployado como "Cualquier persona" y `doPost` no valida nada. Quien abra la consola del navegador (o mande un curl) puede sobrescribir la asistencia de cualquier día. La separación en dos apps es de UX, no de seguridad.

**Decisiones ya tomadas (no las cambies):**
- El PIN son **los últimos 4 dígitos del DNI** de cada profe.
- **Sin PIN cargado en la hoja, el profe no puede escribir.** No hay modo permisivo.
- Requiere T2 terminada: si no, el rechazo se ve como guardado exitoso.

**Archivos:** `apps_script.js`, `carga.html`, hoja `CuerpoTecnico`

**Qué hacer:**

### 4a. Esquema de la hoja

La hoja `CuerpoTecnico` hoy es `A=Nombre | B=Cargo | C=Habilitado | D=ID`.
Agregar **`E=PIN`**. M carga a mano los 4 dígitos de cada profe.

### 4b. Apps Script

1. **`getStaffData()` NO debe devolver el PIN.** Es el punto más importante de toda la tarea: ese endpoint es un GET público. Leé la columna E solo dentro de la función de validación, nunca en la respuesta de `getStaff`.

2. Agregar la validación:
   ```js
   /**
    * Valida que (staffId, pin) corresponda a una fila habilitada de CuerpoTecnico.
    * El PIN son los últimos 4 dígitos del DNI, cargados a mano en la columna E.
    * Sin PIN en la hoja => no puede escribir (decisión explícita, no lo cambies
    * por un fallback permisivo: dejaría la validación sin efecto).
    */
   function staffAutorizado(staffId, pin) {
     if (!staffId || !pin) return false;
     const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(STAFF_SHEET_NAME);
     if (!sheet) return false;
     const values = sheet.getDataRange().getValues();
     for (let i = 1; i < values.length; i++) {
       const rowId  = (values[i][3] || '').toString().trim();
       const rowPin = (values[i][4] || '').toString().trim();
       const habilitado = (values[i][2] || '').toString().trim().toUpperCase() !== 'NO';
       if (rowId && rowId === staffId.toString().trim()) {
         return habilitado && rowPin !== '' && rowPin === pin.toString().trim();
       }
     }
     return false;
   }
   ```

3. En `doPost`, **antes** del `switch`, cortar si no está autorizado:
   ```js
   if (!staffAutorizado(data.staffId, data.pin)) {
     return ContentService.createTextOutput(JSON.stringify({
       status: 'error',
       code: 'no-autorizado',
       message: 'PIN incorrecto o usuario no habilitado para cargar.'
     })).setMimeType(ContentService.MimeType.JSON);
   }
   ```
   Aplica a las 4 acciones: `saveAttendance`, `addPlayer`, `setPlayerActivo`, `renamePlayer`.
   **No toques `doGet`** — la consulta sigue siendo abierta a propósito.

### 4c. Cliente (`carga.html`)

4. `postToScript()` agrega `staffId` y `pin` a **todos** los POST:
   ```js
   body:JSON.stringify({action,staffId:myStaffId,pin:myStaffPin,...payload})
   ```

5. Guardar el PIN en `localStorage` con la clave `club_staff_pin`, junto a `club_staff_id`.

6. En el picker "¿Quién sos?": después de elegir el nombre, pedir el PIN. Input `type="password"` con `inputmode="numeric"` y `maxlength="4"` (en el celular tiene que abrir el teclado numérico). El picker bloqueante de la primera vez no se cierra hasta que haya nombre **y** PIN.

7. En Config, donde hoy dice "Estás cargando como: X", agregar un botón **"Cambiar PIN"** para corregirlo sin tener que reelegir quién sos.

8. **Manejo del rechazo (importante para que no se pierdan datos):** cuando un POST vuelve con `code:'no-autorizado'`:
   - Mostrar un modal claro: "PIN incorrecto — la asistencia quedó guardada en este dispositivo pero no se subió".
   - **No borrar el guardado local ni la cola.** El profe corrige el PIN y le da a "Sincronizar", y sube lo que ya tenía cargado.
   - **No** encolar reintentos automáticos de algo rechazado por PIN: reintentar cada 60s con el mismo PIN malo no sirve. Marcá el item de la cola como "necesita PIN" y que solo se reintente después de que el profe cambie el PIN.

9. **Ojo con la cola offline:** los items encolados guardan el payload al momento de encolar. Si el PIN se manda dentro del payload, un item viejo puede llevar un PIN desactualizado. Resolvelo agregando `staffId`/`pin` **en el momento del envío** (dentro de `postToScript`), no al encolar. El código del punto 4 ya hace eso — asegurate de que `queuePendingAction` no guarde el PIN en el payload.

**Verificación:**
- Mock: `staffAutorizado` simulado; `s1` con PIN `1234`, `s2` **sin PIN**.
- Check: POST con PIN correcto → guarda.
- Check: POST con PIN incorrecto → modal de error, el dato queda en localStorage, la cola conserva el item.
- Check: profe sin PIN en la hoja → rechazado.
- Check: **`getStaff` no devuelve el campo `pin`** en ninguna fila. Este es el check crítico — si el PIN viaja en el GET, toda la tarea no sirve para nada.
- Check: la app de consulta sigue funcionando sin PIN (solo lee).

**Listo cuando:** un `curl` con un POST de `saveAttendance` sin PIN válido es rechazado, y los profes con PIN cargado guardan normal.

> **Antes de deployar:** M tiene que cargar la columna E de todos los profes habilitados. Si deployás con la columna vacía, **nadie puede cargar asistencia**.

---

## T5 — LockService + escrituras en lote en el Apps Script

**Por qué:** dos problemas en `saveAttendanceData()`.

1. **Sin `LockService`.** Si dos profes guardan el mismo día casi al mismo tiempo, los dos leen la hoja, los dos borran filas y los dos escriben. Resultado: filas duplicadas o borradas de más. Con datos en cero recién, es el momento de arreglarlo.

2. **Una llamada a la API de Sheets por fila.** El `overwrite` hace `deleteRow()` en un loop, y el guardado hace `appendRow()` en un loop. Con 30 jugadores eso son ~30 borrados + 30 inserciones = 60 llamadas por guardado. Es lento hoy y va a empeorar; el límite de GAS es de 6 minutos por invocación.

**Archivo:** `apps_script.js`

**Qué hacer:**

1. Envolver `saveAttendanceData` (y `addNewPlayer`, `setPlayerActivo`, `renamePlayer`) en un lock:
   ```js
   const lock = LockService.getScriptLock();
   try {
     lock.waitLock(20000); // 20s
   } catch (e) {
     return { status:'error', message:'El sistema está ocupado, probá de nuevo en unos segundos.' };
   }
   try {
     // ... la lógica de siempre
   } finally {
     lock.releaseLock();
   }
   ```

2. Reemplazar el borrado fila-por-fila por **una sola escritura**: leer todo, filtrar en memoria las filas de esa fecha, y reescribir la hoja con `clearContents()` + un único `setValues()` del bloque completo (encabezado + filas que quedan + filas nuevas).

3. Reemplazar el `appendRow()` en loop por un único `setValues()` sobre el rango correspondiente.

4. Cuidado al reescribir: si el array de filas queda vacío, `setValues([])` tira error. Manejá ese caso.

**Verificación:**
- Guardar un día, volver a guardarlo con estados distintos, y confirmar en la planilla que hay **exactamente** una fila por jugador (no duplicados, no faltantes).
- Cronometrá un guardado antes y después con ~25 jugadores. Debería bajar de varios segundos a menos de uno.
- La suite tiene que seguir pasando.

**Listo cuando:** re-guardar el mismo día no deja filas fantasma y el guardado es visiblemente más rápido.

---

## T6 — Reportes por rango de fechas

**Por qué:** `getAllAttendance` trae **todo el historial** en cada apertura de la pantalla de Reportes, y el cliente lo agrupa entero. Con una temporada completa (≈100 prácticas × 30 jugadores = 3000 filas) eso es una descarga grande y un parseo pesado en el celular, para mostrar una semana.

**Decisión ya tomada:** el rango por defecto son los **últimos 30 días**.

**Archivos:** `apps_script.js`, `common.js`, `reports.js`

**Qué hacer:**

### 6a. Apps Script

1. `getAllAttendanceData()` acepta `desde` y `hasta` (`YYYY-MM-DD`, opcionales) y filtra por fecha antes de armar la respuesta. Sin parámetros, sigue devolviendo todo (así el modo "Todo" funciona igual).
2. Filtrá con la fecha ya normalizada (`normalizeFecha()`), comparando strings `YYYY-MM-DD`. **No** uses `new Date()` para comparar: es exactamente el bug que tiene el `getReportsData` que borramos en T1.

### 6b. Cliente

3. `fetchAllAttendance()` en `common.js` acepta un rango y lo manda como query params.

4. **Reemplazar la fila de pills Apertura/Clausura/Todo por un selector de rango.** No apiles dos filas de filtros — que sea un solo control:

   | Opción | Rango |
   |---|---|
   | 30 días | *(default)* últimos 30 días desde hoy |
   | 90 días | últimos 90 días |
   | Torneo | desde `TORNEO_CUTOFF` |
   | Todo | sin filtro |

   Guardar la elección en `localStorage` (podés reusar la clave `club_torneo_filter` o crear `club_rango_reportes`; si la reusás, migrá el valor viejo `'clausura'` → `'torneo'` para no romperle la vista a quien ya lo tenga guardado).

5. **Cachear por rango en memoria.** Si el usuario va de "30 días" a "Todo" y vuelve, no debería refetchear. Un objeto `{rango: datos}` alcanza. `invalidateReports()` tiene que limpiar **todo** el caché, no solo el rango activo.

6. **Cuidado con los reportes que dependen del set completo:**
   - **Totales** con rango de 30 días muestra el % de esos 30 días, no de la temporada. Está bien, pero **el encabezado tiene que decir el rango** para que nadie lo lea como total histórico. Ej: `Ranking · últimos 30 días`.
   - **Mensual** con 30 días puede mostrar un mes cortado por la mitad. Que el selector de mes ofrezca solo los meses que hay dentro del rango.
   - **Semanal**: si el usuario navega hacia atrás y se sale del rango cargado, hoy simplemente no hay datos. Detectalo y mostrá un aviso con un botón "Cargar más historial" que amplíe el rango, en vez de mostrar una semana vacía como si no hubiera habido prácticas. **Este es el detalle que más fácil se pasa por alto y el que más confunde al usuario.**
   - **Por jugador**: el selector de jugadores se arma con los que aparecen en el rango. Sumale siempre `activePlayers()` para que un jugador sin asistencias en el rango igual aparezca (con 0%).

7. Los chips de "últimos días cargados" usan `getAttendanceDates`, que es liviano y no cambia. Dejalo como está.

**Verificación:**
- Mock: cargá fechas repartidas en ~6 meses (algunas dentro de los últimos 30 días, otras muy viejas).
- Check: con rango "30 días", la request lleva `desde=` y el conjunto de fechas devuelto es un subconjunto.
- Check: con rango "Todo", vienen todas.
- Check: cambiar de rango y volver **no** dispara una segunda request al servidor (caché).
- Check: navegar con el `‹` del semanal más allá del rango muestra el aviso de "cargar más", no una semana vacía.
- Check: el encabezado de Totales nombra el rango.

**Listo cuando:** abrir Reportes con el default trae solo los últimos 30 días y ningún reporte miente sobre qué período está mostrando.

---

## T7 — Documentación y cierre

**Archivos:** `.github/copilot-instructions.md`, `MEJORAS.md`

1. Actualizar `copilot-instructions.md`:
   - Tabla de archivos: sacar `asistencias.html`.
   - Endpoints: sacar `getReports`; documentar `desde`/`hasta` en `getAllAttendance`; marcar que los POST requieren `staffId` + `pin`.
   - Estructura de Sheets: agregar `E=PIN` en `CuerpoTecnico`, con la advertencia de que **nunca** se devuelve por GET.
   - Reemplazar el bloque "⚠️ Esta separación es de UX, no de seguridad" por la descripción de cómo funciona el PIN ahora.
   - Documentar que `postToScript` ya no es `no-cors` y por qué, y la distinción error-de-red vs. error-de-servidor.
   - Sumar `esc()` a la lista de helpers de `common.js` con la regla: **todo dato que venga de la planilla y vaya a `innerHTML` pasa por `esc()`**.
   - Actualizar el rango por defecto de reportes.

2. En este archivo (`MEJORAS.md`), marcar las tareas hechas y mover lo que quede a "Pendientes futuros".

3. Confirmar que `sw.js` quedó en la versión correcta y que `CACHED_URLS` no referencia archivos borrados.

---

## Fuera de alcance (por ahora)

Cosas que existen pero no vale la pena tocar todavía:

- **`asistencias_app.html` (página puente).** No borrar hasta confirmar que todos los profes reinstalaron la app que les corresponde. Revisar en un par de meses.
- **`TORNEO_CUTOFF` hardcodeado** en `2026-07-01`. Cuando arranque la temporada que viene hay que actualizarlo a mano. Se podría mover a una hoja de config, pero es un cambio al año.
- **Seguridad real por usuario.** El PIN de 4 dígitos frena al curioso, no a alguien decidido: viaja en el body y es fuerza-brutable (10.000 combinaciones) si alguien scriptea contra el endpoint. Para el caso de uso del club alcanza. Si algún día hace falta más, el camino es deployar el Web App como "Solo usuarios de mi dominio" o meter Google Sign-In.
- **Rate limiting** en el Apps Script. El límite de 20k llamadas/día de la cuenta gratuita es holgado para el uso real, pero no hay nada que frene un script que golpee el endpoint.

---

## Hallazgos nuevos

*(Anotá acá lo que encuentres durante la implementación y no entre en el alcance de la tarea en curso.)*
