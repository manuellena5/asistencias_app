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

- [x] T1 — Limpieza de archivos y código muerto — `76d40bf`
- [x] T2 — Que el POST deje de ser ciego (prerequisito de T4) — `a816ef6`
- [x] T3 — Escapar HTML en datos de usuario — `62a34c1`
- [x] T4 — PIN del cuerpo técnico para autorizar escrituras — `3045fb7`, revisada más abajo
- [x] T5 — LockService + escrituras en lote en el Apps Script — `638138f`
- [x] T6 — Reportes por rango de fechas (no traer todo el historial) — `f7c9313`
- [x] T7 — Actualizar documentación y cierre

**Todo terminado.** `sw.js` quedó en `asistencias-v37`. `CACHED_URLS` no referencia ningún archivo borrado (`asistencias.html` nunca estuvo ahí).

---

## ⚠️ Qué falta hacer a mano (M)

Esto no lo puede hacer el código. **En este orden:**

1. **Cargar la columna E (PIN) en la hoja `CuerpoTecnico`** — 4 dígitos por cada profe habilitado.
   Si se deploya el Apps Script con la columna vacía, **nadie puede cargar asistencia**.
2. **Deployar el Apps Script**: pegar `apps_script.js` en el editor de GAS y hacer
   **Deploy → Manage deployments → Deploy new version**. Guardar no alcanza.
   Lo tocaron T1, T4, T5 y T6.
3. **Avisarle a cada profe su PIN** por un canal privado (no por el repo ni por el chat del
   equipo). La primera vez que abran la app les va a pedir el nombre y después el PIN.
4. **Probar en la planilla real** lo que la suite no puede verificar sola:
   guardar un día, volver a guardarlo con estados distintos, y confirmar que quedó
   **exactamente una fila por jugador** (T5). Cronometrar antes/después con ~25 jugadores:
   debería bajar de varios segundos a menos de uno.

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

> **Especificación revisada.** Reemplaza la versión original de esta tarea. Tres cambios
> respecto de aquella: el PIN se valida **al ingresarlo** (no recién al guardar), hay
> **bloqueo temporal** tras 5 intentos fallidos, y **ninguna referencia en ningún archivo ni
> en la interfaz** a de qué se derivan los dígitos — este repo es público.

**Por qué:** el Apps Script está deployado como "Cualquier persona" y `doPost` no validaba
nada. Quien abriera la consola del navegador (o mandara un curl) podía sobrescribir la
asistencia de cualquier día. La separación en dos apps es de UX, no de seguridad.

Requiere T2 terminada: sin poder leer la respuesta del servidor, nada de esto funciona.

**Decisiones tomadas, no las cambies:**
- Sin PIN cargado en la hoja, el profe no puede escribir. No hay modo permisivo.
- El contador de intentos va por `staffId`, **no por dispositivo**.
- El mensaje de error dice solo "PIN incorrecto", nunca si el problema es el PIN o el usuario.

### 4a. Esquema de la hoja
`CuerpoTecnico` pasa de `A=Nombre | B=Cargo | C=Habilitado | D=ID` a sumar **`E=PIN`**
(4 dígitos, los carga M a mano).

### 4b. Apps Script
1. **`getStaffData()` NO devuelve el PIN.** Es el punto más importante de toda la tarea: ese
   endpoint es un GET público. La columna E se lee solo dentro de `pinValido()`.
2. `pinValido(staffId, pin)`: exige fila habilitada, PIN no vacío y coincidente.
3. **Bloqueo:** 5 fallos → 15 minutos bloqueado, con `CacheService` y **no**
   `PropertiesService`. El cache expira solo, así que el bloqueo se levanta sin que nadie
   intervenga; con Properties habría que limpiarlo a mano y un profe podría quedar trabado un
   domingo a la noche sin nadie a quien llamar. Un PIN correcto limpia el contador.
4. **Acción `verifyPin`:** solo valida y responde, no escribe nada. Es la que permite rechazar
   el PIN al ingresarlo en vez de esperar al guardado.
5. **Puerta de entrada en `doPost`**, antes del `switch`: primero `estadoBloqueo`
   (`code:'bloqueado'`), después `pinValido` (`code:'no-autorizado'` + `restantes`). Aplica a
   `verifyPin` y a las 4 escrituras. **No toca `doGet`** — la consulta sigue abierta a
   propósito.

### 4c. Cliente (`carga.html`)
6. `postToScript()` agrega `staffId` y `pin` **en el momento del envío**, nunca dentro del
   payload que se encola: un item viejo de la cola tiene que subir con el PIN vigente.
   `postToScriptComo()` es la variante con credenciales explícitas, para verificar un PIN que
   todavía no está guardado.
7. **Picker con validación inmediata:** después de elegir el nombre pide el PIN
   (`type="password"`, `inputmode="numeric"`, `maxlength="4"`) y llama a `verifyPin` **antes**
   de guardar nada. Si el servidor lo rechaza: error debajo del input, se limpia el campo, el
   modal no se cierra y el PIN **no** se guarda. Desde el tercer fallo muestra cuántos
   intentos quedan. Si vuelve `bloqueado`, deshabilita el botón de confirmar.
   El label es "PIN" y la única ayuda dice "Te lo da el encargado de la planilla".
8. **Sin conexión al configurar:** si `verifyPin` falla por red (no por rechazo del servidor),
   se guarda el PIN con un aviso y se valida al primer guardado. Sin esto, un profe sin señal
   no podría ni terminar de configurar la app.
9. **Cambiar PIN** desde Config abre el mismo flujo con la misma validación.
10. **Rechazo al guardar** (pasa si M cambia el PIN en la planilla mientras el profe lo tiene
    guardado): modal claro, **no** se borra el guardado local ni la cola, y el item queda
    marcado `needsPin` para que el reintento automático cada 60s no insista con el mismo PIN
    malo — que además solo sumaría fallos hasta bloquearlo.

**Verificación:** mock con `s1` PIN `1234`, `s2` sin PIN, más el contador de fallos.
PIN correcto cierra y guarda · PIN incorrecto no cierra, limpia el campo y no guarda ·
5 fallos → `bloqueado` y botón deshabilitado · profe sin PIN rechazado ·
**`getStaff` no devuelve `pin`** (check crítico) · sin conexión deja configurar con aviso ·
la app de consulta sigue funcionando sin PIN · ningún archivo del repo menciona de dónde
salen los dígitos.

**Listo cuando:** un `curl` con un POST de `saveAttendance` sin PIN válido es rechazado,
escribir mal el PIN cinco veces bloquea 15 minutos, y los profes con PIN cargado guardan
normal.

> **Antes de deployar:** M tiene que cargar la columna E de todos los profes habilitados. Si
> deployás con la columna vacía, **nadie puede cargar asistencia**.

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

## Pendientes futuros

Cosas que existen pero no vale la pena tocar todavía:

- **`asistencias_app.html` (página puente).** No borrar hasta confirmar que todos los profes reinstalaron la app que les corresponde. Revisar en un par de meses.
- **`TORNEO_CUTOFF` hardcodeado** en `2026-07-01`. Cuando arranque la temporada que viene hay que actualizarlo a mano. Se podría mover a una hoja de config, pero es un cambio al año.
- **Seguridad real por usuario.** El PIN de 4 dígitos frena al curioso, no a alguien decidido: viaja en el body y es fuerza-brutable (10.000 combinaciones) si alguien scriptea contra el endpoint. Para el caso de uso del club alcanza. Si algún día hace falta más, el camino es deployar el Web App como "Solo usuarios de mi dominio" o meter Google Sign-In.
- **Rate limiting** en el Apps Script. El límite de 20k llamadas/día de la cuenta gratuita es holgado para el uso real, pero no hay nada que frene un script que golpee el endpoint.

---

## Hallazgos nuevos

Cosas que aparecieron durante la implementación.

### Decisiones que se apartaron un poco del plan (y por qué)

- **T2 — `postToScript` acepta `status:'warning'`, no solo `'success'`.** El plan decía tirar
  si `json.status!=='success'`. Pero `addPlayer` devuelve `{status:'warning'}` cuando el
  jugador ya existía en la planilla, y eso no es un rechazo: el alta local ya se hizo igual.
  Con la regla literal, agregar un jugador que ya estaba en la hoja mostraba un falso
  "no se pudo guardar". Se aceptan `success` y `warning`; cualquier otra cosa tira.

- **T2 — el criterio red/servidor se aplicó también a las 3 mutaciones de jugadores.** El plan
  lo pedía explícito solo para `saveAttendance` y `trySyncPending`, pero `addPlayer`,
  `renamePlayer` y `setPlayerActivo` tenían el mismo `catch` genérico y el mismo bug de fondo.

- **T3 — `renderMgmt()` también se pasó a DOM + listeners.** La tabla del plan solo marcaba el
  picker de cuerpo técnico (`carga.html:758`), pero `renderMgmt()` tenía exactamente el mismo
  patrón: el `id` del jugador dentro de un `onclick` inline, escapando solo la comilla simple
  (`idAttr`). Una comilla doble en el id cerraba el atributo. Ahí `esc()` no sirve —
  `&#39;` dentro de un `onclick` rompe el JavaScript en vez de protegerlo — así que se aplicó
  la misma solución de raíz que al picker.

- **T4 — el rechazo por PIN es un tercer caso, no "error de servidor".** T2 dejó la regla
  "error del servidor ⇒ no encolar", pero T4 pide lo contrario para el PIN (encolar para no
  perder lo cargado). Se resolvió con `needsPin` en el item de la cola: se encola, pero el
  reintento automático lo saltea hasta que el profe corrija el PIN.

- **T6 — `ampliarRango()` va 30 → 90 → todos, sin pasar por "Torneo".** El ancho de "Torneo"
  depende de la fecha de hoy (hoy `TORNEO_CUTOFF` cae *después* de los 90 días, así que
  sería un paso hacia atrás). Torneo sigue disponible como opción del selector.

### ⚠️ El origen del PIN quedó en el historial de git

El Paso 0 de la T4 revisada sacó de los archivos toda mención a de qué se derivan los dígitos
del PIN. Pero **eso ya estaba commiteado** en `3045fb7` y `544a3d9`, así que sigue visible en
el historial del repo, que es público: `git log -p` lo muestra igual.

Reescribir la historia (`filter-repo` + force push) no vale la pena para esto y rompería
cualquier clon existente. Lo que sí conviene tener en cuenta:

- Es una pista sobre **cómo se eligieron** los PIN actuales, no los PIN en sí — esos nunca
  estuvieron en el repo, están solo en la columna E de la planilla.
- Si te parece que importa, la salida limpia no es reescribir la historia sino **cambiar los
  PIN por números que no se deriven de nada** y avisarles a los profes. El código ya no supone
  nada sobre su origen.
- De acá en adelante hay un check automático que falla si alguien vuelve a escribirlo en
  cualquier archivo del repo (`_test/apps-script.test.js`).

### Cosas del entorno, no del código

- **Dos `.lock` de git abandonados bloqueaban todo commit**: `.git/index.lock` (18-ago 17:47,
  0 bytes) y `.git/refs/heads/main.lock` (28-jul, apuntando a un sha que nunca se escribió).
  No había ningún proceso de git corriendo. Se borraron. Si vuelve a pasar, es lo mismo:
  verificar que no haya git abierto y borrar el `.lock`.
- **`node_modules/` quedaba sin trackear ni ignorar** después del `npm i -D playwright` que
  pide este mismo documento. Se agregó un `.gitignore` mínimo.
- **Los browsers de Playwright no estaban descargados.** La suite corre igual contra el Chrome
  del sistema con `CHROME_PATH=...`; quedó documentado en `copilot-instructions.md`.
- **El payload de XSS de la suite usa `src=#`, no `src=x`.** Con `src=x` el navegador pide
  `/x`, da 404, y el listener de respuestas de `run.js` lo registra como error de HTTP —
  un fallo de XSS ensuciaba la salida con ruido que no era el punto. Con `src=#` el `onerror`
  dispara igual si el escape falla, sin generar un 404.
  Verificado que el check **falla** si se saca un solo `esc()`.

### Resueltos después del cierre

- **`APP_VERSION` pasó a `2.2.0`** (estaba en `2.1.1`). Con el PIN, el rango de reportes y el
  cambio de esquema en `CuerpoTecnico`, era un cambio menor de versión.
- **Las fechas de la suite ya no están fijas.** Estaban clavadas alrededor de 2026-08-18, así
  que los checks de "últimos 30 días" iban a empezar a fallar solos con el tiempo. Ahora se
  generan relativas a hoy en `_test/fixtures.js`, compartido por el mock y por `run.js` para
  que no haya dos copias de la misma cuenta. `fixtures.js` lee `TORNEO_CUTOFF` y `MESES` de
  `common.js`, así que sigue los cambios de la app sola. Verificado con 158 fechas simuladas
  a lo largo de 3 años: las invariantes se mantienen, y ahora también se chequean dentro de
  la suite (si el fixture degenera, el check avisa en vez de pasar sin probar nada).

### Sugerencias para más adelante (no se tocaron)

- **El pie de `index.html` dice "Corte Clausura: 1 Jul 2026"**, que sigue siendo cierto pero
  ahora solo aplica a la opción "Torneo" del selector. Quizá convenga reescribirlo.
