// Google Apps Script for Attendance Tracking App
// Deploy this as a web app (Execute as: your account, Who has access: Anyone)

const SHEET_ID = '1Smw2TaBSfPQG7gjtQn-2DI0PTtoZUtM5cTw7gtLMo4o';
const ATTENDANCE_SHEET_NAME = 'Asistencias_App';
const PLAYERS_SHEET_NAME = 'Jugadores';
const STAFF_SHEET_NAME = 'CuerpoTecnico';
const TIMEZONE = 'America/Argentina/Buenos_Aires';

// Encabezado canonico de Asistencias_App. Define tambien el ancho del bloque
// que se escribe de una sola vez en saveAttendanceData.
const ATTENDANCE_HEADER = ['Timestamp', 'Fecha', 'Jugador', 'Estado', 'Observación', 'JugadorID', 'CargadoPorNombre', 'CargadoPorID'];

/**
 * Corre fn() con el lock del script tomado y devuelve lo que fn() devuelva.
 *
 * Sin esto, dos profes guardando el mismo dia casi al mismo tiempo leen la
 * hoja los dos, borran los dos y escriben los dos: el resultado son filas
 * duplicadas o borradas de mas.
 */
function conLock(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000); // 20s
  } catch (e) {
    return { status: 'error', message: 'El sistema está ocupado, probá de nuevo en unos segundos.' };
  }
  try {
    return fn();
  } catch (error) {
    return { status: 'error', message: error.toString() };
  } finally {
    lock.releaseLock();
  }
}

/** Lleva una fila al ancho exacto de ancho columnas (setValues exige filas parejas). */
function filaAlAncho(fila, ancho) {
  const f = fila.slice(0, ancho);
  while (f.length < ancho) f.push('');
  return f;
}

/**
 * Normaliza el valor de la columna Fecha a 'YYYY-MM-DD'.
 * Sheets deserializa las fechas como objetos Date; toISOString() las pasa a UTC
 * y puede correr el dia segun el offset de la zona del proyecto, asi que
 * formateamos siempre con la zona horaria explicita.
 */
function normalizeFecha(cell) {
  if (!cell) return '';
  if (cell instanceof Date) {
    return Utilities.formatDate(cell, TIMEZONE, 'yyyy-MM-dd');
  }
  return cell.toString().trim();
}

/**
 * Main handler for GET requests
 * Reads data from sheets
 */
function doGet(e) {
  const action = e.parameter.action || 'default';

  try {
    let response = {};

    switch (action) {
      case 'getAttendance':
        response = getAttendanceData(e.parameter.fecha);
        break;
      case 'getPlayers':
        response = getPlayersData();
        break;
      case 'getAllAttendance':
        response = getAllAttendanceData(e.parameter.desde, e.parameter.hasta);
        break;
      case 'getAttendanceDates':
        response = getAttendanceDatesData();
        break;
      case 'getStaff':
        response = getStaffData();
        break;
      default:
        response = { status: 'ok', message: 'Apps Script is running' };
    }

    return ContentService.createTextOutput(JSON.stringify(response))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: error.toString()
    }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Main handler for POST requests
 * Saves data to sheets
 */
function doPost(e) {
  const contentType = e.contentType || 'application/json';

  try {
    let data;
    if (contentType === 'application/json') {
      data = JSON.parse(e.postData.contents);
    } else {
      data = JSON.parse(e.postData.contents);
    }

    const action = data.action;
    let response = {};

    // Puerta de entrada: todo POST requiere (staffId, pin) de una fila
    // habilitada de CuerpoTecnico. Aplica a verifyPin y a las 4 escrituras.
    // doGet queda abierto a proposito: la consulta es publica.
    const bloqueo = estadoBloqueo(data.staffId);
    if (bloqueo.bloqueado) {
      return jsonOut({
        status: 'error',
        code: 'bloqueado',
        message: 'Demasiados intentos fallidos. Esperá 15 minutos y volvé a probar.'
      });
    }
    if (!pinValido(data.staffId, data.pin)) {
      const n = registrarFallo(data.staffId);
      // El mensaje no distingue si el problema es el PIN o el usuario: decirlo
      // le confirmaria a quien prueba cual de los dos acerto.
      return jsonOut({
        status: 'error',
        code: 'no-autorizado',
        restantes: Math.max(0, MAX_INTENTOS - n),
        message: 'PIN incorrecto.'
      });
    }
    limpiarFallos(data.staffId);

    switch (action) {
      // Solo valida y responde: no escribe nada. Es lo que permite rechazar el
      // PIN cuando el profe lo ingresa, en vez de esperar al primer guardado.
      case 'verifyPin':
        response = { status: 'success', message: 'PIN correcto' };
        break;
      case 'saveAttendance':
        response = saveAttendanceData(data.data, data.overwrite === true);
        break;
      case 'addPlayer':
        response = addNewPlayer(data.name, data.id);
        break;
      case 'setPlayerActivo':
        response = setPlayerActivo(data.id, data.activo, data.name);
        break;
      case 'renamePlayer':
        response = renamePlayer(data.id, data.newName, data.oldName);
        break;
      default:
        response = { status: 'error', message: 'Unknown action' };
    }

    return jsonOut(response);
  } catch (error) {
    return jsonOut({ status: 'error', message: error.toString() });
  }
}

/** Respuesta JSON. ContentService.TextOutput NO soporta setHeader(). */
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ======================== BLOQUEO POR INTENTOS FALLIDOS ========================
// 5 fallos seguidos => bloqueado 15 minutos.
//
// El contador va por staffId, no por dispositivo: si no, cambiar de navegador
// o entrar de incognito reseteaba el limite y no frenaba nada.
//
// Se usa CacheService y NO PropertiesService a proposito: el cache expira solo,
// asi que el bloqueo se levanta sin que nadie intervenga. Con Properties habria
// que limpiarlo a mano, y un profe podria quedar trabado un domingo a la noche
// sin nadie a quien llamar.
const MAX_INTENTOS = 5;
const BLOQUEO_SEG = 15 * 60;

function estadoBloqueo(staffId) {
  if (!staffId) return { intentos: 0, bloqueado: false };
  const n = parseInt(CacheService.getScriptCache().get('pinfail_' + staffId) || '0', 10);
  return { intentos: n, bloqueado: n >= MAX_INTENTOS };
}

function registrarFallo(staffId) {
  if (!staffId) return 0;
  const cache = CacheService.getScriptCache();
  const n = parseInt(cache.get('pinfail_' + staffId) || '0', 10) + 1;
  // Cada fallo renueva la ventana: 5 intentos dentro de 15 minutos, no 5 de por vida.
  cache.put('pinfail_' + staffId, String(n), BLOQUEO_SEG);
  return n;
}

function limpiarFallos(staffId) {
  if (!staffId) return;
  CacheService.getScriptCache().remove('pinfail_' + staffId);
}

/**
 * Valida que (staffId, pin) corresponda a una fila habilitada de CuerpoTecnico.
 * El PIN es de 4 digitos y se carga a mano en la columna E.
 *
 * Sin PIN en la hoja => no puede escribir (decision explicita, no lo cambies
 * por un fallback permisivo: dejaria la validacion sin efecto).
 *
 * La columna E se lee SOLO desde aca. getStaffData() nunca la devuelve: ese
 * endpoint es un GET publico y si el PIN viajara ahi, todo esto no serviria
 * para nada.
 */
function pinValido(staffId, pin) {
  if (!staffId || !pin) return false;
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(STAFF_SHEET_NAME);
  if (!sheet) return false;
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const rowId = (values[i][3] || '').toString().trim();
    const rowPin = (values[i][4] || '').toString().trim();
    const habilitado = (values[i][2] || '').toString().trim().toUpperCase() !== 'NO';
    if (rowId && rowId === staffId.toString().trim()) {
      return habilitado && rowPin !== '' && rowPin === pin.toString().trim();
    }
  }
  return false;
}

/**
 * Handle OPTIONS requests (for CORS preflight)
 */
function doOptions(e) {
  return ContentService.createTextOutput('')
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Save attendance records to the Asistencias_App sheet.
 *
 * Todo el trabajo se hace en memoria y termina en UNA sola escritura. Antes
 * el overwrite hacia deleteRow() en un loop y el guardado appendRow() en otro:
 * con 30 jugadores eran ~60 llamadas a la API de Sheets por guardado.
 */
function saveAttendanceData(records, overwrite) {
  return conLock(function () {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    let sheet = spreadsheet.getSheetByName(ATTENDANCE_SHEET_NAME);

    // Create sheet if it doesn't exist
    if (!sheet) {
      sheet = spreadsheet.insertSheet(ATTENDANCE_SHEET_NAME);
      sheet.appendRow(ATTENDANCE_HEADER);
    }

    const ancho = ATTENDANCE_HEADER.length;
    const values = sheet.getDataRange().getValues();
    const tieneEncabezado = values.length > 0 && values[0].some(function (c) { return c !== '' && c !== null; });
    const encabezado = tieneEncabezado ? filaAlAncho(values[0], ancho) : ATTENDANCE_HEADER.slice();

    // Filas existentes, sin las vacias
    let filas = values.slice(1)
      .filter(function (r) { return r.some(function (c) { return c !== '' && c !== null; }); })
      .map(function (r) { return filaAlAncho(r, ancho); });

    // overwrite: en vez de borrar fila por fila, se filtra en memoria
    if (overwrite && records.length > 0) {
      const fecha = records[0].fecha;
      filas = filas.filter(function (r) { return normalizeFecha(r[1]) !== fecha; });
    }

    // Columna F guarda el ID estable del jugador (si el nombre se renombra
    // después, el registro sigue mapeado por ID). Columnas G/H guardan quién
    // cargó la asistencia (nombre + ID estable del cuerpo técnico, mismo
    // patrón por si le cambian el nombre después).
    records.forEach(function (record) {
      filas.push([
        record.timestamp,
        record.fecha,
        record.jugador,
        record.estado,
        record.observacion || '',
        record.jugadorId || '',
        record.cargadoPorNombre || '',
        record.cargadoPorId || ''
      ]);
    });

    // Una sola escritura del bloque completo. El bloque siempre tiene al menos
    // el encabezado, asi que nunca se llama a setValues([]) (que tira error).
    const bloque = [encabezado].concat(filas);
    sheet.clearContents();
    sheet.getRange(1, 1, bloque.length, ancho).setValues(bloque);
    SpreadsheetApp.flush();

    return {
      status: 'success',
      message: `${records.length} attendance records saved`,
      count: records.length
    };
  });
}

/**
 * Add a new player to the Jugadores sheet.
 * El ID lo genera el cliente (el alta tiene que funcionar sin conexión, así
 * que no puede depender de la respuesta); si por algún motivo no llega, se
 * genera acá.
 */
function addNewPlayer(name, id) {
  return conLock(function () {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    let sheet = spreadsheet.getSheetByName(PLAYERS_SHEET_NAME);

    // Create sheet if it doesn't exist
    if (!sheet) {
      sheet = spreadsheet.insertSheet(PLAYERS_SHEET_NAME);
      sheet.appendRow(['Nombre', 'Activo', 'ID']);
    }

    // Check if player already exists (column A)
    const range = sheet.getDataRange();
    const values = range.getValues();
    for (let i = 1; i < values.length; i++) {
      if ((values[i][0] || '').toString().trim().toLowerCase() === name.toLowerCase()) {
        return {
          status: 'warning',
          message: 'Player already exists'
        };
      }
    }

    const newId = (id && id.toString().trim()) || Utilities.getUuid();
    // Nombre en columna A, Activo en B (vacío = activo), ID en C
    sheet.appendRow([name, '', newId]);

    return {
      status: 'success',
      message: `Player ${name} added successfully`,
      id: newId
    };
  });
}

/**
 * Get attendance data for a specific date
 */
function getAttendanceData(fecha) {
  try {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = spreadsheet.getSheetByName(ATTENDANCE_SHEET_NAME);

    if (!sheet) {
      return {
        status: 'success',
        data: []
      };
    }

    const range = sheet.getDataRange();
    const values = range.getValues();
    const records = [];

    // Skip header row
    for (let i = 1; i < values.length; i++) {
      const cellStr = normalizeFecha(values[i][1]);
      if (cellStr === fecha) {
        records.push({
          timestamp: values[i][0],
          fecha: cellStr,
          jugador: values[i][2],
          estado: values[i][3],
          observacion: values[i][4] || '',
          jugadorId: values[i][5] || '',
          cargadoPorNombre: values[i][6] || '',
          cargadoPorId: values[i][7] || ''
        });
      }
    }

    return {
      status: 'success',
      count: records.length,
      data: records
    };
  } catch (error) {
    return {
      status: 'error',
      message: error.toString()
    };
  }
}

/**
 * Get all players data. Columnas: A=Nombre, B=Activo, C=ID.
 * Si una fila no tiene ID todavía (jugadores cargados antes de este cambio),
 * se le genera uno acá mismo y se graba en la hoja (auto-migración, sin
 * necesidad de tocar nada a mano).
 */
function getPlayersData() {
  try {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = spreadsheet.getSheetByName(PLAYERS_SHEET_NAME);

    if (!sheet) {
      return {
        status: 'success',
        players: []
      };
    }

    const range = sheet.getDataRange();
    const values = range.getValues();
    const players = [];

    for (let i = 1; i < values.length; i++) {
      const nombre = (values[i][0] || '').toString().trim();
      if (!nombre) continue;

      const activoRaw = (values[i][1] || '').toString().trim().toUpperCase();
      let id = (values[i][2] || '').toString().trim();
      if (!id) {
        id = Utilities.getUuid();
        sheet.getRange(i + 1, 3).setValue(id); // backfill columna C
      }

      players.push({ nombre: nombre, activo: activoRaw !== 'NO', id: id });
    }

    return {
      status: 'success',
      count: players.length,
      players: players
    };
  } catch (error) {
    return {
      status: 'error',
      message: error.toString()
    };
  }
}

/**
 * Get cuerpo técnico data. Columnas: A=Nombre, B=Cargo, C=Habilitado, D=ID,
 * E=PIN.
 * Mismo patrón que getPlayersData: si una fila no tiene ID, se le genera
 * uno acá y se graba en la hoja (auto-migración).
 *
 * ⚠️ La columna E (PIN) NO se lee ni se devuelve acá, y no hay que agregarla:
 * este endpoint es un GET público. El PIN se usa solo dentro de
 * pinValido(), que corre del lado del servidor.
 */
function getStaffData() {
  try {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = spreadsheet.getSheetByName(STAFF_SHEET_NAME);

    if (!sheet) {
      return {
        status: 'success',
        staff: []
      };
    }

    const range = sheet.getDataRange();
    const values = range.getValues();
    const staff = [];

    for (let i = 1; i < values.length; i++) {
      const nombre = (values[i][0] || '').toString().trim();
      if (!nombre) continue;

      const cargo = (values[i][1] || '').toString().trim();
      const habilitadoRaw = (values[i][2] || '').toString().trim().toUpperCase();
      let id = (values[i][3] || '').toString().trim();
      if (!id) {
        id = Utilities.getUuid();
        sheet.getRange(i + 1, 4).setValue(id); // backfill columna D
      }

      staff.push({ nombre: nombre, cargo: cargo, habilitado: habilitadoRaw !== 'NO', id: id });
    }

    return {
      status: 'success',
      count: staff.length,
      staff: staff
    };
  } catch (error) {
    return {
      status: 'error',
      message: error.toString()
    };
  }
}

/**
 * Activar o desactivar un jugador (columna B de la hoja Jugadores).
 * Se busca por ID (columna C); si no llega ID (clientes viejos) se hace
 * fallback por nombre. Los jugadores desactivados mantienen todo su
 * historial de asistencias, pero dejan de aparecer en la carga y en los
 * reportes.
 */
function setPlayerActivo(id, activo, name) {
  return conLock(function () {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = spreadsheet.getSheetByName(PLAYERS_SHEET_NAME);
    if (!sheet) {
      return { status: 'error', message: 'Hoja Jugadores no encontrada' };
    }

    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      const rowId = (values[i][2] || '').toString().trim();
      const rowNombre = (values[i][0] || '').toString().trim();
      const matches = id
        ? rowId === id.toString().trim()
        : rowNombre.toLowerCase() === (name || '').toString().trim().toLowerCase();
      if (matches) {
        sheet.getRange(i + 1, 2).setValue(activo ? '' : 'NO'); // columna B = Activo
        return { status: 'success', message: 'Estado actualizado' };
      }
    }
    return { status: 'error', message: 'Jugador no encontrado' };
  });
}

/**
 * Cambiar el nombre de un jugador (columna A). Se busca por ID (columna C);
 * si no llega ID (clientes viejos) se hace fallback por el nombre anterior.
 * El historial de asistencias ya guardado NO se modifica: los registros
 * viejos que tengan JugadorID siguen apuntando al mismo jugador aunque
 * cambie de nombre; los registros muy viejos sin JugadorID se resuelven
 * en el cliente vía el mapa de alias por nombre.
 */
function renamePlayer(id, newName, oldName) {
  return conLock(function () {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = spreadsheet.getSheetByName(PLAYERS_SHEET_NAME);
    if (!sheet) {
      return { status: 'error', message: 'Hoja Jugadores no encontrada' };
    }
    if (!newName || !newName.toString().trim()) {
      return { status: 'error', message: 'Nombre nuevo vacío' };
    }

    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      const rowId = (values[i][2] || '').toString().trim();
      const rowNombre = (values[i][0] || '').toString().trim();
      const matches = id
        ? rowId === id.toString().trim()
        : rowNombre.toLowerCase() === (oldName || '').toString().trim().toLowerCase();
      if (matches) {
        sheet.getRange(i + 1, 1).setValue(newName.toString().trim());
        return { status: 'success', message: 'Nombre actualizado' };
      }
    }
    return { status: 'error', message: 'Jugador no encontrado' };
  });
}

/**
 * Get unique dates that have attendance records (lightweight — no player data)
 */
function getAttendanceDatesData() {
  try {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = spreadsheet.getSheetByName(ATTENDANCE_SHEET_NAME);
    if (!sheet) return { status: 'success', dates: [] };

    const values = sheet.getDataRange().getValues();
    const datesSet = new Set();

    for (let i = 1; i < values.length; i++) {
      if (!values[i][1]) continue;
      const fecha = normalizeFecha(values[i][1]);
      if (fecha) datesSet.add(fecha);
    }

    return { status: 'success', dates: [...datesSet].sort() };
  } catch (error) {
    return { status: 'error', message: error.toString() };
  }
}

/**
 * Get attendance records for the reports screen.
 *
 * desde / hasta son opcionales, en formato 'YYYY-MM-DD'. Sin parametros
 * devuelve todo el historial (asi el modo "Todo" sigue funcionando igual).
 *
 * El filtro compara STRINGS ya normalizados con normalizeFecha(), no objetos
 * Date: 'YYYY-MM-DD' ordena igual como string que como fecha, y asi no se
 * repite el bug del viejo getReportsData, que hacia new Date(celda) y corria
 * el dia segun la zona horaria.
 */
function getAllAttendanceData(desde, hasta) {
  try {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = spreadsheet.getSheetByName(ATTENDANCE_SHEET_NAME);

    if (!sheet) {
      return { status: 'success', data: [] };
    }

    const d = (desde || '').toString().trim();
    const h = (hasta || '').toString().trim();

    const values = sheet.getDataRange().getValues();
    const records = [];

    // Skip header row
    for (let i = 1; i < values.length; i++) {
      if (!values[i][0]) continue; // skip empty rows
      const fecha = normalizeFecha(values[i][1]);
      if (d && fecha < d) continue;
      if (h && fecha > h) continue;
      records.push({
        timestamp:   values[i][0] ? values[i][0].toString() : '',
        fecha:       fecha,
        jugador:     values[i][2] || '',
        estado:      values[i][3] || '',
        observacion: values[i][4] || '',
        jugadorId:   values[i][5] || '',
        cargadoPorNombre: values[i][6] || '',
        cargadoPorId:     values[i][7] || ''
      });
    }

    return {
      status: 'success',
      count: records.length,
      desde: d,
      hasta: h,
      data: records
    };
  } catch (error) {
    return { status: 'error', message: error.toString() };
  }
}

/**
 * Helper function to initialize sheets
 * Run this once to create the initial structure
 */
function initializeSheets() {
  try {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);

    // Create Asistencias_App sheet
    let attendanceSheet = spreadsheet.getSheetByName(ATTENDANCE_SHEET_NAME);
    if (!attendanceSheet) {
      attendanceSheet = spreadsheet.insertSheet(ATTENDANCE_SHEET_NAME);
      attendanceSheet.appendRow(['Timestamp', 'Fecha', 'Jugador', 'Estado', 'Observación', 'JugadorID', 'CargadoPorNombre', 'CargadoPorID']);
    }

    // Jugadores sheet — already exists con columnas propias, no recrear
    const playersSheet = spreadsheet.getSheetByName(PLAYERS_SHEET_NAME);
    if (!playersSheet) {
      // Only create if truly missing (no existing data to preserve)
      const newSheet = spreadsheet.insertSheet(PLAYERS_SHEET_NAME);
      newSheet.appendRow(['Nombre', 'Activo', 'ID']);
    }

    // CuerpoTecnico sheet — la carga a mano el usuario (Nombre/Cargo/Habilitado
    // y el PIN de 4 dígitos); solo se crea con encabezados si todavía no
    // existe.
    const staffSheet = spreadsheet.getSheetByName(STAFF_SHEET_NAME);
    if (!staffSheet) {
      const newStaffSheet = spreadsheet.insertSheet(STAFF_SHEET_NAME);
      newStaffSheet.appendRow(['Nombre', 'Cargo', 'Habilitado', 'ID', 'PIN']);
    }

    Logger.log('Sheets initialized successfully');
  } catch (error) {
    Logger.log('Error initializing sheets: ' + error.toString());
  }
}
