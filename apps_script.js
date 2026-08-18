// Google Apps Script for Attendance Tracking App
// Deploy this as a web app (Execute as: your account, Who has access: Anyone)

const SHEET_ID = '1Smw2TaBSfPQG7gjtQn-2DI0PTtoZUtM5cTw7gtLMo4o';
const ATTENDANCE_SHEET_NAME = 'Asistencias_App';
const PLAYERS_SHEET_NAME = 'Jugadores';
const STAFF_SHEET_NAME = 'CuerpoTecnico';

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
      case 'getReports':
        response = getReportsData(e.parameter.startDate, e.parameter.endDate);
        break;
      case 'getAllAttendance':
        response = getAllAttendanceData();
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

    switch (action) {
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
 * Handle OPTIONS requests (for CORS preflight)
 */
function doOptions(e) {
  return ContentService.createTextOutput('')
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Save attendance records to the Asistencias_App sheet
 */
function saveAttendanceData(records, overwrite) {
  try {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    let sheet = spreadsheet.getSheetByName(ATTENDANCE_SHEET_NAME);

    // Create sheet if it doesn't exist
    if (!sheet) {
      sheet = spreadsheet.insertSheet(ATTENDANCE_SHEET_NAME);
      sheet.appendRow(['Timestamp', 'Fecha', 'Jugador', 'Estado', 'Observación', 'JugadorID', 'CargadoPorNombre', 'CargadoPorID']);
    }

    // If overwrite: delete all existing rows for this date before inserting
    if (overwrite && records.length > 0) {
      const fecha = records[0].fecha;
      const values = sheet.getDataRange().getValues();
      // Iterate backwards to safely delete rows
      for (let i = values.length - 1; i >= 1; i--) {
        const cellFecha = values[i][1];
        const cellStr = cellFecha instanceof Date
          ? cellFecha.toISOString().split('T')[0]
          : cellFecha.toString();
        if (cellStr === fecha) {
          sheet.deleteRow(i + 1); // sheet rows are 1-indexed
        }
      }
    }

    // Append new records — columna F guarda el ID estable del jugador
    // (si el nombre se renombra después, el registro sigue mapeado por ID).
    // Columnas G/H guardan quién cargó la asistencia (nombre + ID estable
    // del cuerpo técnico, mismo patrón por si le cambian el nombre después).
    records.forEach(record => {
      sheet.appendRow([
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

    return {
      status: 'success',
      message: `${records.length} attendance records saved`,
      count: records.length
    };
  } catch (error) {
    return {
      status: 'error',
      message: error.toString()
    };
  }
}

/**
 * Add a new player to the Jugadores sheet.
 * El ID lo genera el cliente (porque el guardado usa no-cors y no puede leer
 * la respuesta del servidor); si por algún motivo no llega, se genera acá.
 */
function addNewPlayer(name, id) {
  try {
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
  } catch (error) {
    return {
      status: 'error',
      message: error.toString()
    };
  }
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
      const cellFecha = values[i][1];
      const cellStr = cellFecha instanceof Date
        ? cellFecha.toISOString().split('T')[0]
        : (cellFecha || '').toString().trim();
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
 * Get cuerpo técnico data. Columnas: A=Nombre, B=Cargo, C=Habilitado, D=ID.
 * Mismo patrón que getPlayersData: si una fila no tiene ID, se le genera
 * uno acá y se graba en la hoja (auto-migración).
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
  try {
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
  } catch (error) {
    return {
      status: 'error',
      message: error.toString()
    };
  }
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
  try {
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
  } catch (error) {
    return {
      status: 'error',
      message: error.toString()
    };
  }
}

/**
 * Get reports data for a date range
 */
function getReportsData(startDate, endDate) {
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
    const start = new Date(startDate);
    const end = new Date(endDate);

    // Skip header row
    for (let i = 1; i < values.length; i++) {
      const recordDate = new Date(values[i][1]);
      if (recordDate >= start && recordDate <= end) {
        records.push({
          timestamp: values[i][0],
          fecha: values[i][1],
          jugador: values[i][2],
          estado: values[i][3],
          observacion: values[i][4] || ''
        });
      }
    }

    // Aggregate by player and date
    const aggregated = {};
    records.forEach(record => {
      const key = record.jugador;
      if (!aggregated[key]) {
        aggregated[key] = {
          present: 0,
          total: 0,
          dates: {}
        };
      }
      aggregated[key].total++;
      if (record.estado === 'P' || record.estado === 'E/A') {
        aggregated[key].present++;
      }
      if (!aggregated[key].dates[record.fecha]) {
        aggregated[key].dates[record.fecha] = record.estado;
      }
    });

    return {
      status: 'success',
      count: records.length,
      aggregated: aggregated,
      raw: records
    };
  } catch (error) {
    return {
      status: 'error',
      message: error.toString()
    };
  }
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
      const fecha = values[i][1] instanceof Date
        ? values[i][1].toISOString().split('T')[0]
        : values[i][1].toString().trim();
      if (fecha) datesSet.add(fecha);
    }

    return { status: 'success', dates: [...datesSet].sort() };
  } catch (error) {
    return { status: 'error', message: error.toString() };
  }
}

/**
 * Get ALL attendance records (used by the web app for reports)
 */
function getAllAttendanceData() {
  try {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    const sheet = spreadsheet.getSheetByName(ATTENDANCE_SHEET_NAME);

    if (!sheet) {
      return { status: 'success', data: [] };
    }

    const values = sheet.getDataRange().getValues();
    const records = [];

    // Skip header row
    for (let i = 1; i < values.length; i++) {
      if (!values[i][0]) continue; // skip empty rows
      records.push({
        timestamp:   values[i][0] ? values[i][0].toString() : '',
        fecha:       values[i][1] ? (values[i][1] instanceof Date
                      ? values[i][1].toISOString().split('T')[0]
                      : values[i][1].toString()) : '',
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

    // CuerpoTecnico sheet — la carga a mano el usuario (Nombre/Cargo/Habilitado);
    // solo se crea con encabezados si todavía no existe.
    const staffSheet = spreadsheet.getSheetByName(STAFF_SHEET_NAME);
    if (!staffSheet) {
      const newStaffSheet = spreadsheet.insertSheet(STAFF_SHEET_NAME);
      newStaffSheet.appendRow(['Nombre', 'Cargo', 'Habilitado', 'ID']);
    }

    Logger.log('Sheets initialized successfully');
  } catch (error) {
    Logger.log('Error initializing sheets: ' + error.toString());
  }
}
