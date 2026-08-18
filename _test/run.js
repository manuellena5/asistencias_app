// Suite de humo sobre las dos apps, contra el Apps Script simulado
// (_test/mock-server.js). Solo para verificar localmente.
//   node _test/mock-server.js   # en una terminal
//   node _test/run.js           # en otra
const { chromium } = require('playwright');
// Las fechas del mock son relativas a hoy, así que las expectativas se
// calculan a partir del mismo módulo en vez de estar escritas a mano.
const F = require('./fixtures.js');
const BASE = 'http://localhost:8099';
const CHROME = process.env.CHROME_PATH || undefined;

// Payloads que el mock cuelga del nombre de un jugador y de una observación.
const XSS_NOMBRE = 'DIAZ JONATAN <img src=# onerror="window.__xss=1">';

const errors = [];
const fails = [];
// ignorarRed=true para la página donde cortamos la conexión a propósito: ahí
// un fetch fallido es exactamente lo que estamos probando, no un error.
function attach(page, tag, ignorarRed) {
  const esFalloDeRed = t => /net::ERR_|Failed to fetch|Failed to load resource/.test(t);
  page.on('pageerror', e => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (ignorarRed && esFalloDeRed(m.text())) return;
    errors.push(`[${tag}] console.error: ${m.text()}`);
  });
  page.on('response', r => { if (r.status() >= 400) errors.push(`[${tag}] HTTP ${r.status()} ${r.url()}`); });
}
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails.push(`${label}\n    esperado: ${JSON.stringify(expected)}\n    obtenido: ${JSON.stringify(actual)}`);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ' -> ' + JSON.stringify(actual)}`);
}
function show(label, v) { console.log(`    ${label}:`, v); }

// Recorre las 4 pestañas de reportes y devuelve un resumen de cada una.
async function walkReports(page) {
  const out = {};
  await page.click('.report-tabs button:nth-child(1)'); // Semanal
  await page.waitForTimeout(300);
  out.semanal = {
    cards: await page.$$eval('.semanal-card', e => e.length),
    header: (await page.textContent('.week-nav-info')).replace(/\s+/g, ' ').trim()
  };
  await page.click('.report-tabs button:nth-child(2)'); // Mensual
  await page.waitForTimeout(300);
  out.mensual = {
    periodos: await page.$$eval('#period-sel option', o => o.map(x => x.textContent)),
    cards: await page.$$eval('#report-out .card', e => e.length)
  };
  await page.click('.report-tabs button:nth-child(3)'); // Por jugador
  await page.waitForTimeout(300);
  out.jugador = {
    jugadores: await page.$$eval('#player-sel option', o => o.map(x => x.textContent)),
    filas: await page.$$eval('#report-out .p-row', e => e.length)
  };
  await page.click('.report-tabs button:nth-child(4)'); // Totales
  await page.waitForTimeout(300);
  out.totales = {
    ranking: await page.$$eval('.semanal-card', e => e.length),
    hdr: (await page.textContent('#report-out .card-hdr')).replace(/\s+/g, ' ').trim()
  };
  await page.click('.report-tabs button:nth-child(1)'); // volver a Semanal
  await page.waitForTimeout(200);
  return out;
}

(async () => {
  // Primero los tests del Apps Script contra un Sheets simulado: son
  // instantaneos y cubren lo que el navegador no puede tocar.
  fails.push(...require('./apps-script.test.js').fails);

  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // Apuntar la app al Apps Script simulado antes de que corra cualquier script
  await ctx.addInitScript(() => {
    localStorage.setItem('club_script_url', 'http://localhost:8099/exec');
  });

  // ================= APP LECTOR =================
  console.log('\n=== index.html (consulta) ===');
  const p = await ctx.newPage();
  attach(p, 'index');
  await p.goto(BASE + '/index.html');
  await p.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20000 });
  await p.waitForSelector('.semanal-card', { timeout: 10000 });

  check('nav de 3 pestañas', await p.$$eval('.nav button', b => b.map(x => x.textContent.trim())),
    ['\u{1F4CA}Reportes', '\u{1F4C5}Por día', '⚙️Ajustes']);

  // Invariantes del fixture. Las fechas se generan relativas a hoy, así que
  // esto se chequea explícitamente: si alguna se rompe, los checks de rango
  // de más abajo pasarían sin probar nada.
  const fechas30 = F.enRango(F.desdeParaDias(30), '');
  const fechas90 = F.enRango(F.desdeParaDias(90), '');
  console.log(`    (fixture: ${F.FECHAS.length} fechas, ${fechas30.length} en los últimos 30 días, hoy=${F.hoy()})`);
  check('fixture: la fecha más reciente es hoy', fechas30[fechas30.length - 1], F.hoy());
  check('fixture: 90 días es más ancho que 30', fechas90.length > fechas30.length, true);
  check('fixture: "Todo" es más ancho que 90 días', F.FECHAS.length > fechas90.length, true);
  check('fixture: la fecha "sin datos" realmente no tiene datos',
    F.FECHAS.indexOf(F.FECHA_SIN_DATOS), -1);

  const repLector = await walkReports(p);
  check('semanal: 4 jugadores', repLector.semanal.cards, 4);
  // Mensual solo ofrece los meses que hay dentro del rango activo (30 días)
  check('mensual: los meses del rango', repLector.mensual.periodos, F.mesesDe(fechas30));
  check('por jugador: 4 en el selector', repLector.jugador.jugadores.length, 4);
  check('totales: ranking de 4', repLector.totales.ranking, 4);
  show('semanal header', repLector.semanal.header);
  show('totales header', repLector.totales.hdr);

  // ===== RANGO DE FECHAS =====
  // Se cuentan las requests reales al backend para verificar el caché por rango.
  const getAll = [];
  p.on('request', r => { if (r.url().includes('action=getAllAttendance')) getAll.push(r.url()); });

  const fechasEn = async () => p.evaluate(() => allDays.map(d => d.date));
  check('rango por defecto: 30 días', await p.evaluate(() => rangoReportes), '30');
  check('30 días: solo trae las fechas de los últimos 30 días', await fechasEn(), fechas30);

  await p.click('#rango-row .pill[data-r="todos"]');
  await p.waitForTimeout(600);
  const fechasTodo = await fechasEn();
  check('Todo: trae todas las fechas', fechasTodo.length, F.FECHAS.length);
  check('30 días es un subconjunto de Todo',
    fechas30.every(f => fechasTodo.includes(f)), true);
  check('Todo: la request no lleva desde',
    getAll[getAll.length - 1].includes('desde='), false);

  await p.click('#rango-row .pill[data-r="torneo"]');
  await p.waitForTimeout(600);
  check('Torneo: corta en TORNEO_CUTOFF', await fechasEn(), F.enRango(F.TORNEO_CUTOFF, ''));
  check('Torneo: la request lleva desde=' + F.TORNEO_CUTOFF,
    getAll[getAll.length - 1].includes('desde=' + F.TORNEO_CUTOFF), true);
  check('Torneo: el fixture tiene algo antes del corte (si no, el check no prueba nada)',
    F.FECHAS.some(f => f < F.TORNEO_CUTOFF), true);

  // Volver a un rango ya visto NO debe disparar otra request
  const antes = getAll.length;
  await p.click('#rango-row .pill[data-r="todos"]');
  await p.waitForTimeout(600);
  await p.click('#rango-row .pill[data-r="30"]');
  await p.waitForTimeout(600);
  check('volver a un rango ya visto sale del caché (0 requests nuevas)',
    getAll.length - antes, 0);
  check('el rango elegido queda guardado',
    await p.evaluate(() => localStorage.getItem('club_rango_reportes')), '30');

  // Totales tiene que decir de qué período habla
  await p.click('.report-tabs button:nth-child(4)');
  await p.waitForTimeout(300);
  check('Totales nombra el rango en el encabezado',
    (await p.textContent('#report-out .card-hdr')).includes('últimos 30 días'), true);

  // Semanal: al llegar al principio del rango, aviso en vez de semana vacía
  await p.click('.report-tabs button:nth-child(1)');
  await p.waitForTimeout(300);
  for (let i = 0; i < 6; i++) {
    const btn = await p.$('.week-nav-btn:not([disabled])');
    if (!btn) break;
    await p.click('.week-nav-bar .week-nav-btn:first-child').catch(() => { });
    await p.waitForTimeout(150);
    if (await p.$('#btn-ampliar-rango')) break;
  }
  check('semanal: al principio del rango aparece "Cargar más historial"',
    await p.isVisible('#btn-ampliar-rango'), true);
  check('semanal: el aviso nombra el rango',
    (await p.textContent('#report-out')).includes('últimos 30 días'), true);

  // El botón amplía el rango y trae más historial
  const fechasAntes = (await fechasEn()).length;
  await p.click('#btn-ampliar-rango');
  await p.waitForTimeout(800);
  check('"Cargar más historial" amplía el rango a 90 días',
    await p.evaluate(() => rangoReportes), '90');
  check('"Cargar más historial" trae más fechas',
    (await fechasEn()).length > fechasAntes, true);

  // Volver al default para el resto de la suite
  await p.click('#rango-row .pill[data-r="30"]');
  await p.waitForTimeout(500);

  // Pantalla Por día
  await p.click('.nav button:nth-child(2)');
  await p.waitForTimeout(250);
  // El strip muestra los últimos 7 días con datos (el mock tiene 9)
  check('día: chips de fechas (los últimos 7 con datos)',
    await p.$$eval('.date-chip', e => e.length), Math.min(7, F.FECHAS.length));
  await p.click('.date-chip');
  await p.waitForSelector('.ro-row', { timeout: 10000 });
  check('día: 4 filas', await p.$$eval('.ro-row', e => e.length), 4);
  check('día: muestra quién cargó', (await p.textContent('#day-out')).includes('Cargado por'), true);
  show('día: título', (await p.textContent('#day-out .card-hdr')).replace(/\s+/g, ' ').trim());

  // ===== XSS: nombres y observaciones son texto libre de la planilla =====
  // El nombre del jugador ya pasó por las 4 pestañas de reportes y por la
  // vista por día. FECHA_CON_OBS además tiene un justificado, así que trae la
  // observación maliciosa a pantalla.
  check('lector: el nombre malicioso se muestra como texto literal',
    (await p.textContent('#day-out')).includes(XSS_NOMBRE), true);
  await p.fill('#day-date', F.FECHA_CON_OBS);
  await p.waitForSelector('.ro-obs', { timeout: 10000 });
  check('lector: la observación maliciosa se muestra como texto literal',
    (await p.textContent('.ro-obs')).includes('<script>window.__xss=1</script>'), true);
  check('lector: nada del payload se ejecutó',
    await p.evaluate(() => window.__xss), undefined);

  await p.fill('#day-date', F.FECHA_SIN_DATOS);
  await p.waitForTimeout(900);
  check('día sin datos: mensaje correcto',
    (await p.textContent('#day-out')).includes('no hay asistencia cargada'), true);

  // Garantía de solo lectura
  check('lector: 0 botones de estado editables', await p.$$eval('.status-btns', e => e.length), 0);
  check('lector: sin botón Guardar', await p.$$eval('#btn-save', e => e.length), 0);
  check('lector: sin alta de jugadores', await p.$$eval('.add-row', e => e.length), 0);
  const lectorPosts = [];
  p.on('request', r => { if (r.method() === 'POST') lectorPosts.push(r.url()); });
  await p.click('.nav button:nth-child(1)'); await p.waitForTimeout(500);
  await p.click('.nav button:nth-child(3)'); await p.waitForTimeout(500);
  check('lector: 0 POST al backend', lectorPosts.length, 0);

  // ================= APP CARGA =================
  console.log('\n=== carga.html (profes) ===');
  const q = await ctx.newPage();
  attach(q, 'carga');
  await q.goto(BASE + '/carga.html');
  await q.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20000 });

  check('nav de 4 pestañas (con Reportes)', await q.$$eval('.nav button', b => b.map(x => x.textContent.trim())),
    ['\u{1F4CB}Asistencia', '\u{1F4CA}Reportes', '\u{1F465}Jugadores', '⚙️Config']);

  check('picker "¿quién sos?" se abre solo', await q.isVisible('#staff-picker-overlay'), true);
  await q.click('#staff-picker-list button'); // PEREZ JUAN (s1)
  await q.waitForTimeout(200);
  // Paso 2: sin PIN el picker no deja pasar
  check('picker: pide el PIN después del nombre', await q.isVisible('#staff-pin-step'), true);
  // Aserción en positivo: el texto dice a quién pedirle el PIN y nada más.
  // (Que no mencione de dónde salen los dígitos lo verifica el scan de todo el
  // repo en apps-script.test.js.)
  check('picker: el texto del PIN solo dice a quién pedírselo',
    (await q.textContent('#staff-picker-msg')).includes('Te lo da el encargado de la planilla'), true);

  // Formato inválido: se corta en el cliente, sin pegarle al servidor
  await q.fill('#staff-pin-input', '12');
  await q.click('#staff-pin-confirm');
  await q.waitForTimeout(200);
  check('picker: rechaza un PIN que no son 4 dígitos', await q.isVisible('#staff-picker-overlay'), true);

  // PIN con formato válido pero equivocado: lo rechaza el SERVIDOR, al
  // ingresarlo. No se acepta ni queda guardado en el dispositivo.
  await q.fill('#staff-pin-input', '9999');
  await q.click('#staff-pin-confirm');
  await q.waitForTimeout(800);
  check('picker: un PIN equivocado no cierra el modal', await q.isVisible('#staff-picker-overlay'), true);
  check('picker: un PIN equivocado muestra el error', await q.isVisible('#staff-pin-error'), true);
  check('picker: el error no distingue PIN de usuario',
    (await q.textContent('#staff-pin-error')).trim(), 'PIN incorrecto.');
  check('picker: el campo se limpia después de fallar',
    await q.inputValue('#staff-pin-input'), '');
  check('picker: un PIN equivocado NO se guarda en el dispositivo',
    await q.evaluate(() => localStorage.getItem('club_staff_pin')), null);

  await q.fill('#staff-pin-input', '1234');
  await q.click('#staff-pin-confirm');
  await q.waitForTimeout(800);
  check('picker: se cierra con nombre + PIN correcto', await q.isVisible('#staff-picker-overlay'), false);
  check('picker: el PIN correcto sí se guarda',
    await q.evaluate(() => localStorage.getItem('club_staff_pin')), '1234');

  // >>> Los reportes tienen que estar acá y ser IGUALES a los del lector <<<
  await q.click('.nav button:nth-child(2)');
  await q.waitForSelector('.semanal-card', { timeout: 10000 });
  const repCarga = await walkReports(q);
  check('reportes idénticos a los del lector', repCarga, repLector);

  // Volver a asistencia y cargar un día
  await q.click('.nav button:nth-child(1)');
  await q.waitForTimeout(300);
  await q.click('.date-chip');
  await q.waitForSelector('.player-card', { timeout: 10000 });
  check('form: 4 jugadores activos', await q.$$eval('.player-card', e => e.length), 4);
  const estados = await q.$$eval('.player-card', cards => cards.map(c => {
    const b = c.querySelector('.status-btns button[class*="sel-"]');
    return c.querySelector('.name').textContent + '=' + (b ? b.textContent.trim() : '?');
  }));
  check('form: precarga los estados guardados', estados,
    ['ACOSTA MARTIN=A', 'BENITEZ LUCAS=P', 'CORDOBA NAHUEL=P', XSS_NOMBRE + '=E/A']);
  check('carga: el nombre malicioso se muestra como texto literal en el form',
    await q.$$eval('.player-card .name', e => e.map(x => x.textContent)).then(n => n.includes(XSS_NOMBRE)), true);

  await q.click('.player-card:nth-child(1) .status-btns button:nth-child(3)'); // marcar J
  await q.waitForTimeout(150);
  check('form: campo de observación al marcar J', await q.isVisible('#obs-0'), true);

  const posts = [];
  q.on('request', r => { if (r.method() === 'POST') posts.push({ url: r.url(), body: r.postData() }); });
  await q.click('#btn-save');
  await q.waitForSelector('#save-modal-overlay', { state: 'visible', timeout: 10000 });
  check('guardar: modal de éxito', (await q.textContent('#save-modal-title')).trim(), 'Asistencia guardada');
  check('guardar: 1 POST al backend', posts.length, 1);
  {
    const body = JSON.parse(posts[0].body);
    check('guardar: el POST lleva staffId y pin', { staffId: body.staffId, pin: body.pin },
      { staffId: 's1', pin: '1234' });
    // El PIN se agrega en el envío, no al encolar: un item viejo de la cola
    // tiene que subir con el PIN vigente, no con el de cuando se encoló.
    check('guardar: el PIN no viaja dentro del payload encolable',
      JSON.stringify(body.data).includes('1234'), false);
  }

  // El botón del modal lleva a los reportes DENTRO de la app de carga
  await q.click('#save-modal-actions button');
  await q.waitForTimeout(1500);
  check('modal "Ver reportes" navega a la pantalla interna',
    await q.$eval('#scr-reports', e => e.classList.contains('active')), true);
  check('modal "Ver reportes" no salió de carga.html',
    (new URL(q.url())).pathname.endsWith('/carga.html'), true);
  await q.waitForSelector('.semanal-card', { timeout: 10000 });
  check('reportes se recargaron después de guardar',
    await q.$$eval('.semanal-card', e => e.length) > 0, true);

  // Jugadores + config
  await q.click('.nav button:nth-child(3)');
  await q.waitForTimeout(300);
  check('jugadores: 5 filas (incluye inactivo)', await q.$$eval('.mgmt-item', e => e.length), 5);
  check('jugadores: el nombre malicioso se muestra como texto literal',
    (await q.textContent('#mgmt-list')).includes(XSS_NOMBRE), true);
  // El picker de cuerpo técnico y la lista de jugadores arman los botones por
  // DOM: ya no queda ni un onclick inline con datos de la planilla adentro.
  check('jugadores: sin onclick inline con datos de la planilla',
    await q.$$eval('#mgmt-list [onclick]', e => e.length), 0);
  check('picker de cuerpo técnico: sin onclick inline',
    await q.$$eval('#staff-picker-list [onclick]', e => e.length), 0);

  check('carga: nada del payload se ejecutó',
    await q.evaluate(() => window.__xss), undefined);

  await q.click('.nav button:nth-child(4)');
  await q.waitForTimeout(300);
  check('config: muestra quién sos',
    (await q.textContent('#staff-cfg-current')).includes('PEREZ JUAN'), true);
  check('config: sin link de compartir', await q.$$eval('#share-url', e => e.length), 0);

  // El lector no ofrece atajos a la app de carga desde Ajustes
  check('lector: sin link a carga.html en Ajustes',
    await p.$$eval('a[href="carga.html"]', e => e.length), 0);

  // ================= PIN DEL CUERPO TÉCNICO =================
  console.log('\n=== PIN del cuerpo técnico ===');

  // EL check crítico: si el PIN viaja en el GET público, toda la tarea no
  // sirve para nada.
  const staffJson = await (await ctx.request.get(BASE + '/exec?action=getStaff')).json();
  check('getStaff NO devuelve el campo pin en ninguna fila',
    staffJson.staff.some(s => 'pin' in s), false);
  check('getStaff: ninguna fila contiene el valor del PIN',
    JSON.stringify(staffJson).includes('1234'), false);

  // Un POST sin PIN es rechazado por el backend (equivalente al curl del plan)
  const sinPin = await (await ctx.request.post(BASE + '/exec', {
    headers: { 'Content-Type': 'text/plain' },
    data: JSON.stringify({ action: 'saveAttendance', data: [], overwrite: true })
  })).json();
  check('POST sin PIN: rechazado', { status: sinPin.status, code: sinPin.code },
    { status: 'error', code: 'no-autorizado' });

  // Un profe sin PIN cargado en la hoja tampoco puede escribir
  const s2 = await (await ctx.request.post(BASE + '/exec', {
    headers: { 'Content-Type': 'text/plain' },
    data: JSON.stringify({ action: 'saveAttendance', staffId: 's2', pin: '9999', data: [], overwrite: true })
  })).json();
  check('POST de un profe sin PIN en la hoja: rechazado', s2.code, 'no-autorizado');

  // ===== Bloqueo después de 5 intentos fallidos =====
  // Se usa GOMEZ CARLOS (s2), que no tiene PIN en la hoja, para no ensuciar el
  // contador de s1 que usan los demás checks.
  await ctx.request.get(BASE + '/exec?action=__reset');
  const blkCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await blkCtx.addInitScript(() => {
    localStorage.setItem('club_script_url', 'http://localhost:8099/exec');
  });
  const b = await blkCtx.newPage();
  attach(b, 'carga-bloqueo');
  await b.goto(BASE + '/carga.html');
  await b.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20000 });
  await b.click('#staff-picker-list button:nth-child(2)'); // GOMEZ CARLOS (s2)
  await b.waitForSelector('#staff-pin-step', { state: 'visible', timeout: 5000 });

  const mensajes = [];
  for (let i = 1; i <= 5; i++) {
    await b.fill('#staff-pin-input', '000' + i);
    await b.click('#staff-pin-confirm');
    await b.waitForTimeout(500);
    mensajes.push((await b.textContent('#staff-pin-error')).trim());
  }
  check('bloqueo: avisa los intentos restantes recién sobre el final',
    mensajes.map(m => m.includes('intento')), [false, false, true, true, false]);
  check('bloqueo: el 4º fallo avisa que quedan 2', mensajes[2], 'PIN incorrecto. Te quedan 2 intentos.');
  check('bloqueo: el 5º fallo avisa que queda 1', mensajes[3], 'PIN incorrecto. Te queda 1 intento.');

  // El 6º intento ya cae en el bloqueo del servidor
  await b.fill('#staff-pin-input', '4321');
  await b.click('#staff-pin-confirm');
  await b.waitForTimeout(600);
  check('bloqueo: tras 5 fallos el servidor responde bloqueado',
    (await b.textContent('#staff-pin-error')).includes('Demasiados intentos'), true);
  check('bloqueo: el botón de confirmar queda deshabilitado',
    await b.isDisabled('#staff-pin-confirm'), true);
  check('bloqueo: nada quedó guardado',
    await b.evaluate(() => localStorage.getItem('club_staff_pin')), null);
  await blkCtx.close();
  await ctx.request.get(BASE + '/exec?action=__reset');

  // ===== Sin conexión al configurar: no dejar trabado al profe =====
  const offCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await offCtx.addInitScript(() => {
    localStorage.setItem('club_script_url', 'http://localhost:8099/exec');
  });
  const o = await offCtx.newPage();
  attach(o, 'carga-offline', true);
  await o.goto(BASE + '/carga.html');
  await o.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20000 });
  await o.click('#staff-picker-list button');
  await o.waitForSelector('#staff-pin-step', { state: 'visible', timeout: 5000 });
  // Cortar la red recién ahora: el picker ya está armado con la lista
  await offCtx.setOffline(true);
  await o.fill('#staff-pin-input', '1234');
  await o.click('#staff-pin-confirm');
  await o.waitForTimeout(1000);
  check('sin conexión: el picker igual deja configurar',
    await o.isVisible('#staff-picker-overlay'), false);
  check('sin conexión: el PIN se guarda para validarlo al primer guardado',
    await o.evaluate(() => localStorage.getItem('club_staff_pin')), '1234');
  await offCtx.setOffline(false);
  await offCtx.close();

  // ===== PIN incorrecto desde la app: no se pierde lo cargado =====
  const pinCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await pinCtx.addInitScript(() => {
    localStorage.setItem('club_script_url', 'http://localhost:8099/exec');
    localStorage.setItem('club_staff_id', 's1');
    localStorage.setItem('club_staff_name', 'PEREZ JUAN');
    localStorage.setItem('club_staff_cargo', 'DT');
    localStorage.setItem('club_staff_pin', '0000'); // PIN equivocado
  });
  const w = await pinCtx.newPage();
  attach(w, 'carga-pin');
  await w.goto(BASE + '/carga.html');
  await w.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20000 });
  await w.click('.date-chip');
  await w.waitForSelector('.player-card', { timeout: 10000 });
  const fechaPin = await w.inputValue('#att-date');
  await w.click('#btn-save');
  await w.waitForSelector('#save-modal-overlay', { state: 'visible', timeout: 10000 });

  check('PIN incorrecto: modal específico', (await w.textContent('#save-modal-title')).trim(), 'PIN incorrecto');
  check('PIN incorrecto: el guardado local NO se borra',
    await w.evaluate(f => JSON.parse(localStorage.getItem('att_' + f) || '[]').length, fechaPin), 4);
  check('PIN incorrecto: queda en la cola, marcado para no reintentar solo',
    await w.evaluate(() => {
      const q = JSON.parse(localStorage.getItem('club_pending_queue') || '[]');
      return { largo: q.length, needsPin: q[0] && q[0].needsPin };
    }), { largo: 1, needsPin: true });
  check('PIN incorrecto: el PIN no quedó guardado dentro del item encolado',
    await w.evaluate(() => (localStorage.getItem('club_pending_queue') || '').includes('0000')), false);

  // Corregir el PIN desde el modal => se sube lo que estaba frenado
  await w.click('#save-modal-actions button'); // "Cambiar PIN"
  await w.waitForSelector('#staff-pin-step', { state: 'visible', timeout: 5000 });
  await w.fill('#staff-pin-input', '1234');
  await w.click('#staff-pin-step .btn-primary');
  await w.waitForTimeout(1200); // el reintento automático tras corregir el PIN
  check('PIN corregido: la cola se vacía sola',
    await w.evaluate(() => JSON.parse(localStorage.getItem('club_pending_queue') || '[]').length), 0);
  check('PIN corregido: queda guardado', await w.evaluate(() => localStorage.getItem('club_staff_pin')), '1234');
  await pinCtx.close();

  // ============ SERVIDOR QUE RECHAZA (el POST ya no es ciego) ============
  // Con mode:'no-cors' este caso se veía como un guardado exitoso: el fetch
  // resolvía igual y el profe leía "✅ ya se sincronizaron con la planilla".
  console.log('\n=== carga.html contra un servidor que rechaza ===');
  const errCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await errCtx.addInitScript(() => {
    localStorage.setItem('club_script_url', 'http://localhost:8099/exec-error');
    // Quién sos y PIN ya cargados, para que el picker no tape el formulario
    localStorage.setItem('club_staff_id', 's1');
    localStorage.setItem('club_staff_name', 'PEREZ JUAN');
    localStorage.setItem('club_staff_cargo', 'DT');
    localStorage.setItem('club_staff_pin', '1234');
  });
  const z = await errCtx.newPage();
  attach(z, 'carga-error');
  await z.goto(BASE + '/carga.html');
  await z.waitForSelector('#boot-overlay', { state: 'detached', timeout: 20000 });
  await z.click('.date-chip');
  await z.waitForSelector('.player-card', { timeout: 10000 });
  const fechaErr = await z.inputValue('#att-date');
  await z.click('#btn-save');
  await z.waitForSelector('#save-modal-overlay', { state: 'visible', timeout: 10000 });

  check('error del servidor: modal de fallo',
    (await z.textContent('#save-modal-title')).trim(), 'No se pudo guardar');
  check('error del servidor: muestra el motivo que dio la planilla',
    (await z.textContent('#save-modal-msg')).includes('La hoja Asistencias_App no existe'), true);
  check('error del servidor: NO se encola (no sirve reintentar cada 60s)',
    await z.evaluate(() => JSON.parse(localStorage.getItem('club_pending_queue') || '[]').length), 0);
  check('error del servidor: el guardado local se conserva',
    await z.evaluate(f => JSON.parse(localStorage.getItem('att_' + f) || '[]').length, fechaErr), 4);
  await errCtx.close();

  // ================= PÁGINA PUENTE =================
  console.log('\n=== asistencias_app.html (puente) ===');
  const r = await ctx.newPage();
  attach(r, 'puente');
  await r.goto(BASE + '/asistencias_app.html');
  await r.waitForTimeout(600);
  check('dos opciones', await r.$$eval('.opt .t', e => e.map(x => x.textContent.trim())),
    ['\u{1F4CB} Cargar asistencia', '\u{1F4CA} Ver reportes']);

  // ================= MANIFESTS =================
  console.log('\n=== manifests ===');
  for (const m of ['manifest.json', 'manifest-carga.json']) {
    const j = await (await ctx.request.get(BASE + '/' + m)).json();
    show(m, `start_url=${j.start_url} name="${j.name}" icon=${j.icons[0].src}`);
  }

  console.log('\n=== RESULTADO ===');
  if (fails.length) { console.log('CHECKS FALLIDOS:'); fails.forEach(f => console.log('  ✗ ' + f)); }
  else console.log('  todos los checks ✓');
  console.log(errors.length ? 'ERRORES JS/HTTP:\n  ' + errors.join('\n  ') : '  sin errores JS ✓');

  await browser.close();
  process.exit(fails.length || errors.length ? 1 : 0);
})();
