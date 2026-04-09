// Google Apps Script for Attendance Tracking App
// Deploy this as a web app (Execute as: your account, Who has access: Anyone)

const SHEET_ID = '1Smw2TaBSfPQG7gjtQn-2DI0PTtoZUtM5cTw7gtLMo4o';
const ATTENDANCE_SHEET_NAME = 'Asistencias_App';
const PLAYERS_SHEET_NAME = 'Jugadores';

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
      default:
        response = { status: 'ok', message: 'Apps Script is running' };
    }

    return ContentService.createTextOutput(JSON.stringify(response))
      .setMimeType(ContentService.MimeType.JSON)
      .setHeader('Access-Control-Allow-Origin', '*')
      .setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      .setHeader('Access-Control-Allow-Headers', 'Content-Type');
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: error.toString()
    }))
      .setMimeType(ContentService.MimeType.JSON)
      .setHeader('Access-Control-Allow-Origin', '*');
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
        response = saveAttendanceData(data.data);
        break;
      case 'addPlayer':
        response = addNewPlayer(data.name);
        break;
      default:
        response = { status: 'error', message: 'Unknown action' };
    }

    return ContentService.createTextOutput(JSON.stringify(response))
      .setMimeType(ContentService.MimeType.JSON)
      .setHeader('Access-Control-Allow-Origin', '*')
      .setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      .setHeader('Access-Control-Allow-Headers', 'Content-Type');
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: error.toString()
    }))
      .setMimeType(ContentService.MimeType.JSON)
      .setHeader('Access-Control-Allow-Origin', '*');
  }
}

/**
 * Handle OPTIONS requests (for CORS preflight)
 */
function doOptions(e) {
  return ContentService.createTextOutput('')
    .setHeader('Access-Control-Allow-Origin', '*')
    .setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    .setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Save attendance records to the Asistencias_App sheet
 */
function saveAttendanceData(records) {
  try {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    let sheet = spreadsheet.getSheetByName(ATTENDANCE_SHEET_NAME);

    // Create sheet if it doesn't exist
    if (!sheet) {
      sheet = spreadsheet.insertSheet(ATTENDANCE_SHEET_NAME);
      // Add headers
      sheet.appendRow(['Timestamp', 'Fecha', 'Jugador', 'Estado', 'Observación']);
    }

    // Append each record
    records.forEach(record => {
      sheet.appendRow([
        record.timestamp,
        record.fecha,
        record.jugador,
        record.estado,
        record.observacion || ''
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
 * Add a new player to the Jugadores sheet
 */
function addNewPlayer(name) {
  try {
    const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
    let sheet = spreadsheet.getSheetByName(PLAYERS_SHEET_NAME);

    // Create sheet if it doesn't exist
    if (!sheet) {
      sheet = spreadsheet.insertSheet(PLAYERS_SHEET_NAME);
      // Add headers
      sheet.appendRow(['Nombre', 'Fecha_Agregado', 'Activo']);
    }

    // Check if player already exists
    const range = sheet.getDataRange();
    const values = range.getValues();
    for (let i = 1; i < values.length; i++) {
      if (values[i][0] === name) {
        return {
          status: 'warning',
          message: 'Player already exists'
        };
      }
    }

    // Add new player
    const now = new Date();
    sheet.appendRow([name, now.toISOString(), 'TRUE']);

    return {
      status: 'success',
      message: `Player ${name} added successfully`
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
      if (values[i][1] === fecha) { // Fecha column
        records.push({
          timestamp: values[i][0],
          fecha: values[i][1],
          jugador: values[i][2],
          estado: values[i][3],
          observacion: values[i][4] || ''
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
 * Get all players data
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

    // Skip header row
    for (let i = 1; i < values.length; i++) {
      if (values[i][2] === 'TRUE' || values[i][2] === true) { // Activo column
        players.push({
          nombre: values[i][0],
          fechaAgregado: values[i][1]
        });
      }
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
        observacion: values[i][4] || ''
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
      attendanceSheet.appendRow(['Timestamp', 'Fecha', 'Jugador', 'Estado', 'Observación']);
    }

    // Create Jugadores sheet
    let playersSheet = spreadsheet.getSheetByName(PLAYERS_SHEET_NAME);
    if (!playersSheet) {
      playersSheet = spreadsheet.insertSheet(PLAYERS_SHEET_NAME);
      playersSheet.appendRow(['Nombre', 'Fecha_Agregado', 'Activo']);

      // Add default players
      const defaultPlayers = [
        'Bernaus Agustin', 'Bernaus Federico', 'Carranza Matias', 'Del Valle Jonatan',
        'Diaz Jonatan', 'Fossarelli Antonio', 'Gomez Gustavo', 'Gomez Juan Pablo',
        'Lazaneo Juan Manuel', 'Landriel Federico', 'Lecuima Esteban', 'Lencina Nicolas',
        'Lovera Ignacio', 'Mendoza Alexis', 'Ñañez Ruben', 'Nieto Fabio Armando',
        'Paireti Franco', 'Pochettino Dante', 'Sanchez Hernan', 'Vijarra Nahuel',
        'Villaruel Daniel'
      ];

      const now = new Date();
      defaultPlayers.forEach(name => {
        playersSheet.appendRow([name, now.toISOString(), 'TRUE']);
      });
    }

    Logger.log('Sheets initialized successfully');
  } catch (error) {
    Logger.log('Error initializing sheets: ' + error.toString());
  }
}
