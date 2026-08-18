// Servidor de prueba: sirve los archivos de la app y simula el Apps Script.
// Solo para verificar localmente — NO forma parte de la app.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8099;

// A DIAZ JONATAN se le cuelga un payload de XSS a propósito: los nombres y
// las observaciones son texto libre que sale de la planilla y se interpola en
// innerHTML en las dos apps. El prefijo 'DIAZ ' se mantiene para que el orden
// alfabético (y por lo tanto el resto de los checks) no cambie.
// src=# en vez de src=x: si el escape falla igual dispara onerror, pero no
// genera un 404 que la suite registraría como error de HTTP.
const XSS_NOMBRE = 'DIAZ JONATAN <img src=# onerror="window.__xss=1">';
const XSS_OBS = '"><img src=# onerror="window.__xss=1"><script>window.__xss=1</script>';

const PLAYERS = [
  { nombre: 'ACOSTA MARTIN', activo: true, id: 'p1' },
  { nombre: 'BENITEZ LUCAS', activo: true, id: 'p2' },
  { nombre: 'CORDOBA NAHUEL', activo: true, id: 'p3' },
  { nombre: XSS_NOMBRE, activo: true, id: 'p4' },
  { nombre: 'ESPINOZA RAMIRO', activo: false, id: 'p5' }
];

const STAFF = [
  { nombre: 'PEREZ JUAN', cargo: 'DT', habilitado: true, id: 's1' },
  { nombre: 'GOMEZ CARLOS', cargo: 'PF', habilitado: true, id: 's2' }
];

const FECHAS = ['2026-08-04', '2026-08-06', '2026-08-11', '2026-08-13', '2026-08-18'];
const ESTADOS = ['P', 'P', 'E/A', 'J', 'A'];

function recordsFor(fecha) {
  const fi = FECHAS.indexOf(fecha);
  if (fi < 0) return [];
  return PLAYERS.filter(p => p.activo).map((p, i) => ({
    timestamp: fecha + 'T20:00:00.000',
    fecha,
    jugador: p.nombre,
    estado: ESTADOS[(i + fi) % ESTADOS.length],
    observacion: ESTADOS[(i + fi) % ESTADOS.length] === 'J' ? XSS_OBS : '',
    jugadorId: p.id,
    cargadoPorNombre: STAFF[fi % 2].nombre,
    cargadoPorId: STAFF[fi % 2].id
  }));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function json(res, out) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(out));
}

// Respuesta de los GET, igual para /exec y /exec-error: lo que cambia entre
// los dos endpoints es solo cómo contestan los POST.
function handleGet(u) {
  const action = u.searchParams.get('action');
  if (action === 'getPlayers') return { status: 'success', count: PLAYERS.length, players: PLAYERS };
  if (action === 'getStaff') return { status: 'success', count: STAFF.length, staff: STAFF };
  if (action === 'getAttendanceDates') return { status: 'success', dates: FECHAS };
  if (action === 'getAttendance') return { status: 'success', data: recordsFor(u.searchParams.get('fecha')) };
  if (action === 'getAllAttendance') {
    const all = [];
    FECHAS.forEach(f => all.push(...recordsFor(f)));
    return { status: 'success', count: all.length, data: all };
  }
  return { status: 'ok' };
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');

  // /exec-error simula un Apps Script que responde OK a nivel HTTP pero
  // rechaza toda escritura. Es el caso que con mode:'no-cors' se veía como
  // un guardado exitoso.
  if (u.pathname === '/exec' || u.pathname === '/exec-error') {
    const rechaza = u.pathname === '/exec-error';
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        console.log(`  [mock] POST recibido (${rechaza ? 'rechaza' : 'acepta'}):`, body.slice(0, 120));
        json(res, rechaza
          ? { status: 'error', message: 'La hoja Asistencias_App no existe' }
          : { status: 'success' });
      });
      return;
    }
    json(res, handleGet(u));
    return;
  }

  let p = u.pathname === '/' ? '/index.html' : u.pathname;
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end('404'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
}).listen(PORT, () => console.log('mock en http://localhost:' + PORT));
