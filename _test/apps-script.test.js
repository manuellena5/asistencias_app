// Corre las funciones de apps_script.js contra un Google Sheets simulado.
// No reemplaza probar en la planilla real, pero cubre lo que la suite del
// navegador no puede tocar: el reescrito en lote de saveAttendanceData
// (filas parejas, overwrite, hoja vacia) y staffAutorizado.
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
    Logger: { log: () => { } }
  };
  const fn = new Function(
    'SpreadsheetApp', 'LockService', 'Utilities', 'ContentService', 'Logger',
    SRC + '\nreturn {saveAttendanceData,getAllAttendanceData,getStaffData,staffAutorizado,ATTENDANCE_HEADER};'
  );
  return fn(stubs.SpreadsheetApp, stubs.LockService, stubs.Utilities, stubs.ContentService, stubs.Logger);
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

// ---------- staffAutorizado / getStaffData ----------
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
  check('PIN correcto autoriza', gas.staffAutorizado('s1', '1234'), true);
  check('PIN incorrecto no autoriza', gas.staffAutorizado('s1', '9999'), false);
  check('sin PIN en la hoja no autoriza (no hay modo permisivo)', gas.staffAutorizado('s2', '1234'), false);
  check('deshabilitado no autoriza aunque el PIN sea correcto', gas.staffAutorizado('s3', '5678'), false);
  check('staffId inexistente no autoriza', gas.staffAutorizado('sX', '1234'), false);
  check('sin staffId ni pin no autoriza', gas.staffAutorizado('', ''), false);
  check('PIN numerico (Sheets lo devuelve como number) igual matchea',
    gas.staffAutorizado('s1', 1234), true);

  // EL check critico: getStaff es un GET publico
  const staff = gas.getStaffData();
  check('getStaff no expone el PIN', JSON.stringify(staff).includes('1234'), false);
  check('getStaff no tiene campo pin', staff.staff.some(s => 'pin' in s), false);
}

console.log(fails.length ? '\nCHECKS FALLIDOS:\n  ✗ ' + fails.join('\n  ✗ ') : '  todos los checks ✓');
if (require.main === module) process.exit(fails.length ? 1 : 0);
module.exports = { fails };
