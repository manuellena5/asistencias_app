// Fechas de prueba, generadas RELATIVAS A HOY para que la suite no caduque.
// Antes estaban fijas alrededor de 2026-08-18 y los checks de "últimos 30
// días" iban a empezar a fallar solos con el paso del tiempo.
//
// Lo comparten mock-server.js (que sirve los datos) y run.js (que arma las
// expectativas), así no hay dos copias de la misma cuenta que se puedan
// desincronizar.
const fs = require('fs');
const path = require('path');

// TORNEO_CUTOFF y MESES se leen de common.js: son las mismas constantes que
// usa la app, así que si cambian ahí, la suite las sigue sin tocar nada.
const COMMON = fs.readFileSync(path.join(__dirname, '..', 'common.js'), 'utf8');
const TORNEO_CUTOFF = COMMON.match(/TORNEO_CUTOFF\s*=\s*'([^']+)'/)[1];
const MESES = JSON.parse(COMMON.match(/const MESES = (\[[^\]]+\])/)[1].replace(/'/g, '"'));

const pad = n => String(n).padStart(2, '0');
function aStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function hoy() { return aStr(new Date()); }

// n días antes de `desde` (o de hoy). Hora local, igual que todayStr() en la app.
function diasAtras(n, desde) {
  const d = desde ? new Date(desde + 'T12:00:00') : new Date();
  d.setDate(d.getDate() - n);
  return aStr(d);
}

// Dentro de los últimos 30 días. EL ORDEN IMPORTA: recordsFor() deriva los
// estados del índice en este array, así que el día de HOY tiene que quedar en
// la posición 4 y FECHAS[3] tiene que ser el día con un justificado.
const FECHAS_RECIENTES = [14, 12, 7, 5, 0].map(n => diasAtras(n));

// Fuera de los 30 días: dos dentro de los 90 (para que "Cargar más historial"
// efectivamente traiga algo al pasar de 30 a 90), una fuera de los 90 (para
// que "Todo" sea más ancho que 90), y una anterior al TORNEO_CUTOFF, para que
// el filtro de Torneo siempre tenga algo que recortar sin importar la fecha.
const FECHAS_VIEJAS = [45, 75, 200].map(n => diasAtras(n))
  .concat([diasAtras(20, TORNEO_CUTOFF)]);

// Set preserva el orden de inserción, así que los índices de las recientes no
// se mueven aunque alguna vieja caiga en el mismo día.
const FECHAS = [...new Set(FECHAS_RECIENTES.concat(FECHAS_VIEJAS))];

// El día con un justificado (y por lo tanto con observación a la vista).
const FECHA_CON_OBS = FECHAS[3];

// Una fecha que NO tiene datos, para el caso "este día no tiene asistencia".
let FECHA_SIN_DATOS = diasAtras(1);
for (let n = 1; FECHAS.indexOf(FECHA_SIN_DATOS) >= 0; n++) FECHA_SIN_DATOS = diasAtras(n);

// El 'desde' que manda la app para un rango de N días (mismo cálculo que
// rangoDesdeHasta() en common.js: hoy - (N-1)).
function desdeParaDias(dias) { return diasAtras(dias - 1); }

// Las fechas del fixture que caen dentro de un rango, ordenadas.
function enRango(desde, hasta) {
  return FECHAS.slice().sort()
    .filter(f => (!desde || f >= desde) && (!hasta || f <= hasta));
}

// Los meses que la pantalla Mensual debería ofrecer para un conjunto de
// fechas, con el mismo formato que formatMonth() de common.js.
function mesesDe(fechas) {
  return [...new Set(fechas.map(f => f.substring(0, 7)))].sort().reverse()
    .map(mk => { const [y, m] = mk.split('-'); return MESES[+m - 1] + ' ' + y; });
}

module.exports = {
  TORNEO_CUTOFF, MESES,
  FECHAS, FECHAS_RECIENTES, FECHAS_VIEJAS, FECHA_CON_OBS, FECHA_SIN_DATOS,
  hoy, aStr, diasAtras, desdeParaDias, enRango, mesesDe
};
