/* ============================================================
   common.js — lógica compartida por index.html (lector) y
   carga.html (profes).

   Las dos apps viven en el mismo origen de GitHub Pages, así que
   COMPARTEN localStorage: la lista de jugadores, la URL del Apps
   Script y el filtro de torneo se cachean una sola vez y sirven
   para ambas.

   Reglas al tocar este archivo:
   - Subir CACHE_NAME en sw.js (si no, nadie ve el cambio).
   - No meter acá nada que escriba en Sheets: las escrituras viven
     solo en carga.html. El lector nunca hace POST.
   ============================================================ */

// ======================== CONFIG ========================
const APP_VERSION = '2.1.1';
const SHEET_ID = '1Smw2TaBSfPQG7gjtQn-2DI0PTtoZUtM5cTw7gtLMo4o';
const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxhHtweVcfXJoiX-caV0eGDXJDRpjriJrK1Mfguz8_Yyg14ftyzheEilSzJ8zXt4B6yVQ/exec';
const DIAS_C = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DIAS_L = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const TORNEO_CUTOFF = '2026-07-01'; // Inicio Torneo Clausura

const ESTADO_LABEL = { 'P': 'Presente', 'E/A': 'Entrena Afuera', 'J': 'Justificado', 'A': 'Ausente' };

// Alias fijos para nombres inconsistentes en registros históricos.
// Vacío desde el reset de datos de 2026-08. Si en el futuro aparecen
// registros con nombres que no matchean el plantel actual, se agregan acá.
const ALIASES = {};

// ======================== ESTADO COMPARTIDO ========================
// players: array de {id, nombre}. El id es estable y no cambia si se renombra
// al jugador — es lo que vincula cada registro de asistencia a la persona real.
let players = JSON.parse(localStorage.getItem('club_players') || 'null') || [];
// Migración defensiva: si quedó guardado el formato viejo (array de strings),
// los envolvemos como objetos sin id — se corrige solo en el próximo fetch exitoso.
if (players.length && typeof players[0] === 'string') {
  players = players.map(nombre => ({ id: null, nombre }));
}

// inactiveSet guarda IDs de jugador.
let inactiveSet = new Set(JSON.parse(localStorage.getItem('club_inactive_players') || '[]'));
// Alias dinámicos: nombre viejo (mayúsculas) -> nombre nuevo (mayúsculas), generados al renombrar.
// Solo hace falta para registros de asistencia MUY viejos que no tienen JugadorID guardado.
let dynamicAliases = JSON.parse(localStorage.getItem('club_name_aliases') || '{}');
let scriptUrl = localStorage.getItem('club_script_url') || DEFAULT_SCRIPT_URL;

// Cuerpo técnico (lo usa carga.html para el "¿quién sos?"; el lector solo lo
// muestra como "cargado por").
let staffList = JSON.parse(localStorage.getItem('club_staff') || '[]');

// Caché de asistencia por fecha, en memoria de sesión.
let cachedDateData = {};
let loadedDates = new Set();

// Reportes
let rawAllDays = [];  // todos los días traídos del servidor, sin filtrar por torneo
let allDays = [];     // subset filtrado por torneo, usado por los reportes
let allObs = {};
let torneoFilter = localStorage.getItem('club_torneo_filter') || 'clausura';

// Hook: carga.html lo reemplaza por hasPendingSaveFor para no pisar un guardado
// local que todavía no subió a Sheets. En el lector siempre es false porque
// el lector nunca guarda nada.
let pendingSaveGuard = () => false;

sortPlayers();

// ======================== PERSISTENCIA LOCAL ========================
function genId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}
function sortPlayers() { players.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' })); }
function savePlayers() { localStorage.setItem('club_players', JSON.stringify(players)); }
function saveInactiveSet() { localStorage.setItem('club_inactive_players', JSON.stringify([...inactiveSet])); }
function saveAliases() { localStorage.setItem('club_name_aliases', JSON.stringify(dynamicAliases)); }
function isActive(player) { return !inactiveSet.has(player.id); }
function activePlayers() { return players.filter(isActive); }

// ======================== LECTURAS DEL APPS SCRIPT ========================
// Todas son GET. Ninguna función de este archivo escribe en la planilla.

// Trae la lista de jugadores desde Sheets (fuente de verdad) y refresca el
// caché local. Devuelve true si pudo actualizar desde el servidor.
async function loadPlayersFromSheet() {
  if (!scriptUrl) return false;
  try {
    const r = await fetch(scriptUrl + '?action=getPlayers');
    const j = await r.json();
    if (j.status === 'success' && j.players && j.players.length > 0) {
      players = j.players.map(p => ({ id: p.id, nombre: p.nombre }));
      sortPlayers();
      inactiveSet = new Set(j.players.filter(p => p.activo === false).map(p => p.id));
      savePlayers();
      saveInactiveSet();
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function loadStaffFromSheet() {
  if (!scriptUrl) return false;
  try {
    const r = await fetch(scriptUrl + '?action=getStaff');
    const j = await r.json();
    if (j.status === 'success' && j.staff) {
      staffList = j.staff;
      localStorage.setItem('club_staff', JSON.stringify(staffList));
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

// Fechas que tienen asistencia cargada (endpoint liviano). Solo actualiza
// loadedDates; cada app decide cómo renderizar los chips.
async function fetchLoadedDates() {
  if (!scriptUrl) return false;
  try {
    const r = await fetch(scriptUrl + '?action=getAttendanceDates');
    const j = await r.json();
    if (j.status === 'success' && j.dates) {
      loadedDates = new Set(j.dates);
      return true;
    }
  } catch (e) { }
  return false;
}

// Registros de una fecha. Usa el caché en memoria; si no hay, pega al servidor
// y cae al respaldo de localStorage si no hay conexión.
async function fetchAttendanceForDate(fecha) {
  if (cachedDateData.hasOwnProperty(fecha)) return cachedDateData[fecha];

  let records;
  if (scriptUrl) {
    try {
      const r = await fetch(scriptUrl + '?action=getAttendance&fecha=' + fecha);
      const j = await r.json();
      records = (j.status === 'success' && j.data) ? j.data : [];
      // La planilla es la fuente de verdad: si no hay un guardado local todavía
      // pendiente de subir para esta fecha, actualizamos el respaldo offline
      // para que refleje lo que realmente hay en Sheets (incluye borrados).
      if (!pendingSaveGuard(fecha)) localStorage.setItem('att_' + fecha, JSON.stringify(records));
    } catch (e) {
      const stored = localStorage.getItem('att_' + fecha);
      records = stored ? (JSON.parse(stored) || []) : [];
    }
  } else {
    const stored = localStorage.getItem('att_' + fecha);
    records = stored ? (JSON.parse(stored) || []) : [];
  }
  cachedDateData[fecha] = records;
  return records;
}

// Trae TODO el historial y lo agrupa por fecha en rawAllDays / allObs.
// Devuelve {ok:true} o {ok:false, error}.
async function fetchAllAttendance() {
  rawAllDays = [];
  allObs = {};
  if (!scriptUrl) return { ok: false, error: 'sin-url' };
  try {
    const r = await fetch(scriptUrl + '?action=getAllAttendance');
    const j = await r.json();
    if (j.status === 'success' && j.data) {
      const byDate = {};
      j.data.forEach(rec => {
        if (!rec.fecha) return;
        const key = resolvePlayerKey(rec);
        if (!byDate[rec.fecha]) byDate[rec.fecha] = {};
        byDate[rec.fecha][key] = rec.estado;
        if (rec.estado === 'J' && rec.observacion) {
          if (!allObs[rec.fecha]) allObs[rec.fecha] = {};
          allObs[rec.fecha][key] = rec.observacion;
        }
      });
      for (const [date, pmap] of Object.entries(byDate)) {
        rawAllDays.push({ date, players: pmap });
      }
    }
    rawAllDays.sort((a, b) => a.date.localeCompare(b.date));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ======================== FILTRO DE TORNEO ========================
function applyTorneoFilterData() {
  allDays = rawAllDays.filter(d => {
    if (torneoFilter === 'todos') return true;
    if (torneoFilter === 'clausura') return d.date >= TORNEO_CUTOFF;
    return d.date < TORNEO_CUTOFF; // apertura
  });
}

// ======================== RESOLUCIÓN DE NOMBRES ========================
// Resolver "a la vieja usanza" (alias + fuzzy match contra la lista actual de
// jugadores). Solo se usa como fallback para registros de asistencia que no
// tienen JugadorID guardado (de antes del cambio de esquema).
function normName(n) {
  if (!n) return '';
  let s = n.trim().replace(/["'“”‘’]/g, '').replace(/\s+/g, ' ').toUpperCase();
  // Resolver alias (incluye renombres hechos desde la app). Con protección
  // contra ciclos por si un nombre fue renombrado varias veces.
  for (let i = 0; i < 10; i++) {
    if (dynamicAliases[s]) { s = dynamicAliases[s]; continue; }
    if (ALIASES[s]) { s = ALIASES[s]; continue; }
    break;
  }
  for (const p of players) {
    if (s === p.nombre.toUpperCase()) return p.nombre.toUpperCase();
    const pts = p.nombre.toUpperCase().split(' ');
    if (pts.length >= 2 && s.includes(pts[0]) && s.includes(pts[1])) return p.nombre.toUpperCase();
  }
  return s;
}

// Resuelve un registro de asistencia (tal como viene de la planilla) a una key
// estable: el ID del jugador actual si se puede reconocer, o 'NAME:xxx' como
// fallback para registros viejos sin JugadorID que no matchean a nadie actual.
function resolvePlayerKey(record) {
  if (record.jugadorId) {
    const p = players.find(pl => pl.id === record.jugadorId);
    if (p) return p.id;
  }
  const canonical = normName(record.jugador);
  const p2 = players.find(pl => pl.nombre.toUpperCase() === canonical);
  if (p2) return p2.id;
  return 'NAME:' + canonical;
}

// Convierte una key (id de jugador, o 'NAME:xxx' de fallback) en el nombre a mostrar.
function displayName(key) {
  if (typeof key === 'string' && key.indexOf('NAME:') === 0) {
    const raw = key.slice(5);
    return raw.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
  }
  const p = players.find(pl => pl.id === key);
  return p ? p.nombre : key;
}

// ======================== FECHAS ========================
// Fecha local del dispositivo (no UTC): toISOString() adelanta un día
// después de las 21:00 en Argentina (UTC-3) y "hoy" pasaba a ser mañana.
function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Timestamp con la hora local del dispositivo (no UTC), para que la columna
// Timestamp de Asistencias_App refleje la hora real de carga en Argentina.
function localTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T'
    + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function weekKey(ds) {
  const d = new Date(ds + 'T12:00:00'); const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d); mon.setDate(diff);
  const pad = (n) => String(n).padStart(2, '0');
  return mon.getFullYear() + '-' + pad(mon.getMonth() + 1) + '-' + pad(mon.getDate());
}

function getWeekDays(wk) {
  const days = [];
  const pad = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < 7; i++) {
    const d = new Date(wk + 'T12:00:00');
    d.setDate(d.getDate() + i);
    days.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
  }
  return days;
}

function formatDateShort(ds) { const d = new Date(ds + 'T12:00:00'); return DIAS_C[d.getDay()] + ' ' + d.getDate().toString().padStart(2, '0'); }
function formatChipLabel(ds) { const d = new Date(ds + 'T12:00:00'); return DIAS_C[d.getDay()] + ' ' + d.getDate() + ' ' + MESES[d.getMonth()].substring(0, 3); }
function formatDateLong(ds) { const d = new Date(ds + 'T12:00:00'); return DIAS_L[d.getDay()] + ' ' + d.getDate() + ' ' + MESES[d.getMonth()]; }
function formatWeek(wk) { const d = new Date(wk + 'T12:00:00'); const e = new Date(d); e.setDate(e.getDate() + 6); return `${d.getDate()} ${MESES[d.getMonth()].substring(0, 3)} - ${e.getDate()} ${MESES[e.getMonth()].substring(0, 3)}`; }
function formatMonth(mk) { const [y, m] = mk.split('-'); return MESES[+m - 1] + ' ' + y; }
function pctColor(p) { return p >= 75 ? 'var(--green)' : p >= 50 ? 'var(--yellow)' : 'var(--red)'; }
function badgeClass(p) { return p >= 75 ? 'badge-g' : p >= 50 ? 'badge-y' : 'badge-r'; }
function dotClass(estado) { return estado === 'E/A' ? 'EA' : estado; }

// ======================== UI COMPARTIDA ========================
// Escapa datos que vienen de la planilla antes de meterlos en innerHTML.
// Los nombres y sobre todo las observaciones son texto libre: un nombre con
// '<' rompe el render, y uno con '<img src=x onerror=...>' ejecuta JavaScript
// en la pantalla de todos los que miran los reportes.
// REGLA: todo dato de la planilla que vaya a innerHTML pasa por esc().
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'success');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function hideBootOverlay() {
  const el = document.getElementById('boot-overlay');
  if (!el) return;
  el.classList.add('hidden');
  setTimeout(() => el.remove(), 250);
}

// Navegación entre pantallas. Cada app define SCREEN_TITLES y, opcionalmente,
// una función global onScreenChange(screen).
let SCREEN_TITLES = {};
function go(screen, btn) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('scr-' + screen);
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const t = SCREEN_TITLES[screen] || {};
  const hT = document.getElementById('hdr-title');
  const hS = document.getElementById('hdr-sub');
  if (hT) hT.textContent = t.title || '';
  if (hS) hS.textContent = t.sub || '';
  if (typeof onScreenChange === 'function') onScreenChange(screen);
}

// Chips con los últimos días que tienen datos. onPick recibe la fecha.
function renderDatesStrip(onPick) {
  const strip = document.getElementById('dates-strip');
  const chips = document.getElementById('dates-chips');
  if (!strip || !chips) return;
  if (!loadedDates.size) { strip.style.display = 'none'; return; }
  const sorted = [...loadedDates].sort().reverse().slice(0, 7);
  chips.innerHTML = '';
  sorted.forEach(d => {
    const chip = document.createElement('button');
    chip.className = 'date-chip';
    chip.textContent = formatChipLabel(d);
    chip.title = formatDateLong(d);
    chip.onclick = () => onPick(d);
    chips.appendChild(chip);
  });
  strip.style.display = 'block';
}

// ======================== PWA / SERVICE WORKER ========================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}

async function forceUpdate() {
  const btn = document.getElementById('btn-force-update');
  if (btn) { btn.disabled = true; btn.textContent = 'Actualizando...'; }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) { await reg.unregister(); }
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    toast('Caché limpiado — recargando...', 'success');
  } catch (e) {
    toast('No se pudo limpiar todo el caché, recargando igual...', 'error');
  } finally {
    setTimeout(() => { window.location.reload(); }, 600);
  }
}
