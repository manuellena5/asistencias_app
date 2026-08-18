// Suite de humo sobre las dos apps, contra el Apps Script simulado
// (_test/mock-server.js). Solo para verificar localmente.
//   node _test/mock-server.js   # en una terminal
//   node _test/run.js           # en otra
const { chromium } = require('playwright');
const BASE = 'http://localhost:8099';
const CHROME = process.env.CHROME_PATH || undefined;

// Payloads que el mock cuelga del nombre de un jugador y de una observación.
const XSS_NOMBRE = 'DIAZ JONATAN <img src=# onerror="window.__xss=1">';

const errors = [];
const fails = [];
function attach(page, tag) {
  page.on('pageerror', e => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${tag}] console.error: ${m.text()}`); });
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

  const repLector = await walkReports(p);
  check('semanal: 4 jugadores', repLector.semanal.cards, 4);
  check('mensual: 1 mes', repLector.mensual.periodos, ['Agosto 2026']);
  check('por jugador: 4 en el selector', repLector.jugador.jugadores.length, 4);
  check('totales: ranking de 4', repLector.totales.ranking, 4);
  show('semanal header', repLector.semanal.header);
  show('totales header', repLector.totales.hdr);

  // Filtro de torneo
  await p.click('#torneo-filter-row .pill[data-t="todos"]');
  await p.waitForTimeout(400);
  show('filtro "Todo" -> header', (await p.textContent('.week-nav-info')).replace(/\s+/g, ' ').trim());
  await p.click('#torneo-filter-row .pill[data-t="clausura"]');
  await p.waitForTimeout(300);

  // Pantalla Por día
  await p.click('.nav button:nth-child(2)');
  await p.waitForTimeout(250);
  check('día: 5 chips de fechas', await p.$$eval('.date-chip', e => e.length), 5);
  await p.click('.date-chip');
  await p.waitForSelector('.ro-row', { timeout: 10000 });
  check('día: 4 filas', await p.$$eval('.ro-row', e => e.length), 4);
  check('día: muestra quién cargó', (await p.textContent('#day-out')).includes('Cargado por'), true);
  show('día: título', (await p.textContent('#day-out .card-hdr')).replace(/\s+/g, ' ').trim());

  // ===== XSS: nombres y observaciones son texto libre de la planilla =====
  // El nombre del jugador ya pasó por las 4 pestañas de reportes y por la
  // vista por día. 2026-08-13 además tiene un justificado, así que trae la
  // observación maliciosa a pantalla.
  check('lector: el nombre malicioso se muestra como texto literal',
    (await p.textContent('#day-out')).includes(XSS_NOMBRE), true);
  await p.fill('#day-date', '2026-08-13');
  await p.waitForSelector('.ro-obs', { timeout: 10000 });
  check('lector: la observación maliciosa se muestra como texto literal',
    (await p.textContent('.ro-obs')).includes('<script>window.__xss=1</script>'), true);
  check('lector: nada del payload se ejecutó',
    await p.evaluate(() => window.__xss), undefined);

  await p.fill('#day-date', '2026-08-05');
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
  await q.click('#staff-picker-list button');
  await q.waitForTimeout(300);

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
  q.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
  await q.click('#btn-save');
  await q.waitForSelector('#save-modal-overlay', { state: 'visible', timeout: 10000 });
  check('guardar: modal de éxito', (await q.textContent('#save-modal-title')).trim(), 'Asistencia guardada');
  check('guardar: 1 POST al backend', posts.length, 1);

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

  // ============ SERVIDOR QUE RECHAZA (el POST ya no es ciego) ============
  // Con mode:'no-cors' este caso se veía como un guardado exitoso: el fetch
  // resolvía igual y el profe leía "✅ ya se sincronizaron con la planilla".
  console.log('\n=== carga.html contra un servidor que rechaza ===');
  const errCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await errCtx.addInitScript(() => {
    localStorage.setItem('club_script_url', 'http://localhost:8099/exec-error');
    // Quién sos ya elegido, para que el picker no tape el formulario
    localStorage.setItem('club_staff_id', 's1');
    localStorage.setItem('club_staff_name', 'PEREZ JUAN');
    localStorage.setItem('club_staff_cargo', 'DT');
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
