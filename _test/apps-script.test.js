// Corre las funciones de apps_script.js contra un Google Sheets simulado.
// No reemplaza probar en la planilla real, pero cubre lo que la suite del
// navegador no puede tocar: el reescrito en lote de saveAttendanceData
// (filas parejas, overwrite, hoja vacia) y pinValido.
//
//   node _test/apps-script.test.js
// run.js tambien lo invoca, asi que con `node _test/run.js` alcanza.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'apps_script.js'), 'utf8');

const fails = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails.push(`${label}\n    esperado: ${JSON.stringify(expected)}\n    obtenido: ${JSON.stringify(actual)}`);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' -> ' + JSON.stringify(actual)}`);
}

// ---------- Sheets simulado ----------
function nuevaHoja(valores) {
  const hoja = {
    _v: valores.map(f => f.slice()),
    _llamadas: 0, // cuantas operaciones de escritura se hicieron
    getDataRange() {
      const self = this;
      return { getValues: () => self._v.map(f => f.slice()) };
    },
    clearContents() { this._llamadas++; this._v = []; return this; },
    appendRow(fila) { this._llamadas++; this._v.push(fila.slice()); return this; },
    getRange(fila, col, nFilas, nCols) {
      const self = this;
      return {
        setValues(bloque) {
          self._llamadas++;
          if (!bloque.length) throw new Error('setValues([]) — bloque vacio');
          const ancho = bloque[0].length;
          bloque.forEach(f => {
            if (f.length !== ancho) throw new Error('setValues con filas de distinto ancho');
          });
          bloque.forEach((f, i) => { self._v[fila - 1 + i] = f.slice(); });
          return this;
        },
        setValue(v) {
          self._llamadas++;
          while (self._v.length < fila) self._v.push([]);
          self._v[fila - 1][col - 1] = v;
          return this;
        }
      };
    },
    deleteRow(i) { this._llamadas++; this._v.splice(i - 1, 1); return this; }
  };
  return hoja;
}

function cargar(hojas) {
  const stubs = {
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: n => hojas[n] || null,
        insertSheet: n => (hojas[n] = nuevaHoja([]))
      }),
      flush: () => { }
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => { }, releaseLock: () => { } })
    },
    Utilities: {
      getUuid: () => 'uuid-' + Math.random().toString(36).slice(2, 10),
      formatDate: (d) => {
        const p = n => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      }
    },
    ContentService: { createTextOutput: t => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
    Logger: { log: () => { } },
    // CacheService simulado. Guarda el TTL para poder verificar que el bloqueo
    // se pone con expiración (que es lo que hace que se levante solo).
    CacheService: (() => {
      const store = {};
      const cache = {
        get: k => (store[k] === undefined ? null : store[k].v),
        put: (k, v, ttl) => { store[k] = { v: v, ttl: ttl }; },
        remove: k => { delete store[k]; }
      };
      return { getScriptCache: () => cache, _store: store };
    })()
  };
  const fn = new Function(
    'SpreadsheetApp', 'LockService', 'Utilities', 'ContentService', 'Logger', 'CacheService',
    SRC + '\nreturn {saveAttendanceData,getAllAttendanceData,getStaffData,pinValido,' +
    'estadoBloqueo,registrarFallo,limpiarFallos,MAX_INTENTOS,BLOQUEO_SEG,ATTENDANCE_HEADER};'
  );
  const api = fn(stubs.SpreadsheetApp, stubs.LockService, stubs.Utilities,
    stubs.ContentService, stubs.Logger, stubs.CacheService);
  api._cacheStore = stubs.CacheService._store;
  return api;
}

function registros(fecha, jugadores) {
  return jugadores.map(([nombre, id, estado]) => ({
    timestamp: fecha + 'T20:00:00', fecha, jugador: nombre, estado,
    observacion: '', jugadorId: id, cargadoPorNombre: 'PEREZ JUAN', cargadoPorId: 's1'
  }));
}

console.log('\n=== apps_script.js (Sheets simulado) ===');

// ---------- saveAttendanceData ----------
{
  const HDR = ['Timestamp', 'Fecha', 'Jugador', 'Estado', 'Observación', 'JugadorID', 'CargadoPorNombre', 'CargadoPorID'];
  const hojas = { Asistencias_App: nuevaHoja([HDR]) };
  const gas = cargar(hojas);
  const hoja = hojas.Asistencias_App;

  // Dia nuevo
  gas.saveAttendanceData(registros('2026-08-18', [['A', 'p1', 'P'], ['B', 'p2', 'A']]), true);
  check('guarda 2 filas + encabezado', hoja._v.length, 3);
  check('el encabezado se conserva', hoja._v[0], HDR);

  // Otro dia: no toca el anterior
  gas.saveAttendanceData(registros('2026-08-20', [['A', 'p1', 'A'], ['B', 'p2', 'P']]), true);
  check('otro dia se suma sin pisar el anterior', hoja._v.length, 5);

  // Re-guardar el mismo dia con estados distintos: NO debe duplicar
  const escrituras = hoja._llamadas;
  gas.saveAttendanceData(registros('2026-08-18', [['A', 'p1', 'J'], ['B', 'p2', 'E/A']]), true);
  check('re-guardar el mismo dia no deja filas fantasma', hoja._v.length, 5);
  check('re-guardar deja exactamente 1 fila por jugador en esa fecha',
    hoja._v.slice(1).filter(f => f[1] === '2026-08-18').map(f => f[2] + '=' + f[3]),
    ['A=J', 'B=E/A']);
  check('las filas del otro dia siguen intactas',
    hoja._v.slice(1).filter(f => f[1] === '2026-08-20').map(f => f[2] + '=' + f[3]),
    ['A=A', 'B=P']);
  // clearContents + setValues = 2 operaciones, sin importar cuantos jugadores
  check('un guardado = 2 operaciones de escritura (no una por fila)',
    hoja._llamadas - escrituras, 2);
}

// Hoja que no existe todavia
{
  const hojas = {};
  const gas = cargar(hojas);
  const r = gas.saveAttendanceData(registros('2026-08-18', [['A', 'p1', 'P']]), true);
  check('crea la hoja si no existe', r.status, 'success');
  check('hoja nueva: encabezado + 1 fila', hojas.Asistencias_App._v.length, 2);
}

// Sin registros: no puede tirar setValues([])
{
  const HDR = ['Timestamp', 'Fecha', 'Jugador', 'Estado', 'Observación', 'JugadorID', 'CargadoPorNombre', 'CargadoPorID'];
  const hojas = { Asistencias_App: nuevaHoja([HDR]) };
  const gas = cargar(hojas);
  const r = gas.saveAttendanceData([], true);
  check('guardar sin registros no rompe', r.status, 'success');
  check('sin registros queda solo el encabezado', hojas.Asistencias_App._v.length, 1);
}

// Filas viejas mas cortas que el encabezado (esquema anterior, sin JugadorID)
{
  const hojas = {
    Asistencias_App: nuevaHoja([
      ['Timestamp', 'Fecha', 'Jugador', 'Estado', 'Observación'],
      ['2026-01-02T20:00', '2026-01-02', 'VIEJO', 'P', '']
    ])
  };
  const gas = cargar(hojas);
  const r = gas.saveAttendanceData(registros('2026-08-18', [['A', 'p1', 'P']]), true);
  check('filas viejas mas cortas: no rompe setValues', r.status, 'success');
  check('filas viejas mas cortas: se emparejan al ancho del encabezado',
    hojas.Asistencias_App._v.every(f => f.length === 8), true);
  check('la fila vieja se conserva',
    hojas.Asistencias_App._v.slice(1).filter(f => f[2] === 'VIEJO').length, 1);
}

// Fechas que Sheets devuelve como objetos Date
{
  const HDR = ['Timestamp', 'Fecha', 'Jugador', 'Estado', 'Observación', 'JugadorID', 'CargadoPorNombre', 'CargadoPorID'];
  const hojas = {
    Asistencias_App: nuevaHoja([
      HDR,
      ['2026-08-18T20:00', new Date(2026, 7, 18), 'A', 'P', '', 'p1', 'PEREZ JUAN', 's1']
    ])
  };
  const gas = cargar(hojas);
  gas.saveAttendanceData(registros('2026-08-18', [['A', 'p1', 'J']]), true);
  check('overwrite reconoce fechas guardadas como Date (normalizeFecha)',
    hojas.Asistencias_App._v.length, 2);
  check('overwrite con Date deja el estado nuevo', hojas.Asistencias_App._v[1][3], 'J');
}

// ---------- getAllAttendanceData: rango desde/hasta ----------
{
  const HDR = ['Timestamp', 'Fecha', 'Jugador', 'Estado', 'Observación', 'JugadorID', 'CargadoPorNombre', 'CargadoPorID'];
  const fila = (f, jug) => ['2026T20:00', f, jug, 'P', '', 'p1', 'PEREZ JUAN', 's1'];
  const hojas = {
    Asistencias_App: nuevaHoja([
      HDR,
      fila('2026-03-10', 'A'),
      fila('2026-07-14', 'A'),
      fila(new Date(2026, 7, 4), 'A'),   // Sheets devuelve Date: 2026-08-04
      fila('2026-08-18', 'A')
    ])
  };
  const gas = cargar(hojas);
  const fechas = r => r.data.map(x => x.fecha);

  check('sin parametros devuelve todo', fechas(gas.getAllAttendanceData()),
    ['2026-03-10', '2026-07-14', '2026-08-04', '2026-08-18']);
  check('desde filtra por fecha', fechas(gas.getAllAttendanceData('2026-07-01', '')),
    ['2026-07-14', '2026-08-04', '2026-08-18']);
  check('hasta filtra por fecha', fechas(gas.getAllAttendanceData('', '2026-07-14')),
    ['2026-03-10', '2026-07-14']);
  check('desde y hasta juntos', fechas(gas.getAllAttendanceData('2026-07-01', '2026-08-04')),
    ['2026-07-14', '2026-08-04']);
  check('el borde desde es inclusivo', fechas(gas.getAllAttendanceData('2026-08-18', '')),
    ['2026-08-18']);
  check('el filtro usa normalizeFecha, no new Date (celda Date incluida)',
    fechas(gas.getAllAttendanceData('2026-08-04', '2026-08-04')), ['2026-08-04']);
  check('rango sin datos devuelve vacio, no error',
    gas.getAllAttendanceData('2027-01-01', '').data.length, 0);
}

// ---------- pinValido / getStaffData ----------
{
  const hojas = {
    CuerpoTecnico: nuevaHoja([
      ['Nombre', 'Cargo', 'Habilitado', 'ID', 'PIN'],
      ['PEREZ JUAN', 'DT', '', 's1', '1234'],
      ['GOMEZ CARLOS', 'PF', '', 's2', ''],          // sin PIN cargado
      ['LOPEZ ANA', 'AY', 'NO', 's3', '5678']        // deshabilitada
    ])
  };
  const gas = cargar(hojas);
  check('PIN correcto autoriza', gas.pinValido('s1', '1234'), true);
  check('PIN incorrecto no autoriza', gas.pinValido('s1', '9999'), false);
  check('sin PIN en la hoja no autoriza (no hay modo permisivo)', gas.pinValido('s2', '1234'), false);
  check('deshabilitado no autoriza aunque el PIN sea correcto', gas.pinValido('s3', '5678'), false);
  check('staffId inexistente no autoriza', gas.pinValido('sX', '1234'), false);
  check('sin staffId ni pin no autoriza', gas.pinValido('', ''), false);
  check('PIN numerico (Sheets lo devuelve como number) igual matchea',
    gas.pinValido('s1', 1234), true);

  // EL check critico: getStaff es un GET publico
  const staff = gas.getStaffData();
  check('getStaff no expone el PIN', JSON.stringify(staff).includes('1234'), false);
  check('getStaff no tiene campo pin', staff.staff.some(s => 'pin' in s), false);
}

// ---------- bloqueo por intentos fallidos ----------
{
  const gas = cargar({});
  check('arranca sin bloqueo', gas.estadoBloqueo('s1'), { intentos: 0, bloqueado: false });

  for (let i = 1; i < gas.MAX_INTENTOS; i++) gas.registrarFallo('s1');
  check(`${gas.MAX_INTENTOS - 1} fallos todavia no bloquean`, gas.estadoBloqueo('s1').bloqueado, false);

  gas.registrarFallo('s1');
  check(`${gas.MAX_INTENTOS} fallos bloquean`, gas.estadoBloqueo('s1').bloqueado, true);

  // El bloqueo tiene que expirar solo: con PropertiesService habria que
  // limpiarlo a mano y un profe podria quedar trabado sin nadie a quien llamar.
  check('el bloqueo se guarda con expiracion (se levanta solo)',
    gas._cacheStore['pinfail_s1'].ttl, gas.BLOQUEO_SEG);
  check('la ventana del bloqueo es de 15 minutos', gas.BLOQUEO_SEG, 15 * 60);

  gas.limpiarFallos('s1');
  check('un PIN correcto limpia el contador', gas.estadoBloqueo('s1').bloqueado, false);

  // El contador va por staffId, no global
  gas.registrarFallo('s1');
  check('el contador es por staffId, no compartido', gas.estadoBloqueo('s2').intentos, 0);

  // Sin staffId no explota (un POST vacio no tiene que tirar excepcion)
  check('sin staffId no rompe', gas.estadoBloqueo('').bloqueado, false);
  check('registrarFallo sin staffId no rompe', gas.registrarFallo(''), 0);
}

// ---------- ninguna referencia al origen del PIN ----------
{
  const raiz = path.join(__dirname, '..');
  const archivos = [];
  (function recorrer(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      if (e.name === 'node_modules' || e.name === '.git') return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (/\.(js|html|md|json|css|svg)$/.test(e.name)) archivos.push(p);
    });
  })(raiz);

  // Los terminos se arman en tiempo de ejecucion a proposito: si estuvieran
  // escritos literalmente, este archivo seria el mismo una de las menciones
  // que el check busca evitar.
  const TERMINOS = [
    [100, 110, 105],                                                   // el documento
    [100, 111, 99, 117, 109, 101, 110, 116, 111, 32, 100, 101, 32, 105, 100, 101, 110, 116, 105, 100, 97, 100]
  ].map(cs => String.fromCharCode.apply(null, cs));
  const re = new RegExp('\\b(' + TERMINOS.join('|') + ')\\b', 'i');

  const sospechosos = archivos.filter(f => re.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(raiz, f));

  check('ningun archivo del repo menciona de donde salen los digitos del PIN',
    sospechosos, []);
}

console.log(fails.length ? '\nCHECKS FALLIDOS:\n  ✗ ' + fails.join('\n  ✗ ') : '  todos los checks ✓');
if (require.main === module) process.exit(fails.length ? 1 : 0);
module.exports = { fails };
