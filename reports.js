/* ============================================================
   reports.js — pantalla de Reportes, compartida por index.html
   (consulta) y carga.html (profes).

   Las dos apps muestran EXACTAMENTE los mismos reportes: la
   diferencia entre ellas es quién puede escribir, no quién puede
   mirar. Por eso esto vive en un solo archivo.

   Depende de common.js (allDays, rawAllDays, allObs, players,
   inactiveSet, torneoFilter, displayName, formatters...).
   Solo lee: no hace ni un POST.

   Uso desde cada app:
     initReportsScreen();          // inyecta el markup en #scr-reports
     await loadReports();          // trae los datos y renderiza
     // y en onScreenChange: if(screen==='reports'&&!reportsLoaded)loadReports();
   ============================================================ */

let reportView = 'semanal';
let weekIdx = 0;
let semanalShowAll = false;
let semanalSortBy = 'pct';
let totalesAsc = false;
let reportsLoaded = false;

// Markup de la pantalla. Se inyecta por JS para que las dos apps no puedan
// quedar desincronizadas copiando y pegando HTML.
function initReportsScreen() {
  const scr = document.getElementById('scr-reports');
  if (!scr) return;
  scr.innerHTML = `
    <div class="pills-row" id="torneo-filter-row">
      <div class="pills">
        <button class="pill" data-t="apertura" onclick="setTorneoFilter('apertura',this)">Apertura</button>
        <button class="pill active" data-t="clausura" onclick="setTorneoFilter('clausura',this)">Clausura</button>
        <button class="pill" data-t="todos" onclick="setTorneoFilter('todos',this)">Todo</button>
      </div>
    </div>
    <div class="report-tabs">
      <button class="active" onclick="setReport('semanal',this)">Semanal</button>
      <button onclick="setReport('mensual',this)">Mensual</button>
      <button onclick="setReport('jugador',this)">Por Jugador</button>
      <button onclick="setReport('totales',this)">Totales</button>
    </div>
    <select id="period-sel" class="period-sel" style="display:none" onchange="renderReport()"></select>
    <select id="player-sel" class="period-sel" style="display:none" onchange="renderReport()"></select>
    <div id="report-out"></div>`;
}

// Marcar los reportes como "hay que volver a traerlos". Lo llama carga.html
// después de guardar una asistencia, para que al entrar a Reportes se vea
// lo recién cargado y no la foto vieja.
function invalidateReports() {
  reportsLoaded = false;
}

function setReport(view, btn) {
  reportView = view;
  if (view === 'semanal') { weekIdx = 0; semanalShowAll = false; semanalSortBy = 'pct'; }
  document.querySelectorAll('.report-tabs button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const showPeriod = view === 'mensual' || view === 'jugador';
  document.getElementById('player-sel').style.display = view === 'jugador' ? '' : 'none';
  document.getElementById('period-sel').style.display = showPeriod ? '' : 'none';
  buildPeriodSelector();
  renderReport();
}

async function loadReports() {
  const out = document.getElementById('report-out');
  if (!out) return;
  out.innerHTML = '<div class="loading"><div class="sp"></div>Cargando datos...</div>';

  // Reflejar el filtro de torneo guardado en los botones
  document.querySelectorAll('#torneo-filter-row .pill').forEach(b => {
    b.classList.toggle('active', b.dataset.t === torneoFilter);
  });

  if (!scriptUrl) {
    out.innerHTML = '<div class="card" style="padding:20px;text-align:center;color:var(--gray)">Configurá la URL del Apps Script en Ajustes para ver los reportes.</div>';
    return;
  }

  const res = await fetchAllAttendance();
  if (!res.ok) {
    out.innerHTML = `<div class="card" style="padding:20px;text-align:center;color:var(--red)">No se pudieron cargar los datos${res.error && res.error !== 'sin-url' ? ': ' + res.error : ''}.<br><span style="font-size:.8rem;color:var(--gray)">Revisá tu conexión y volvé a intentar.</span></div>`;
    return;
  }
  reportsLoaded = true;

  // Selector de jugador (siempre sobre el set completo, sin filtrar por torneo)
  const psel = document.getElementById('player-sel');
  psel.innerHTML = '';
  const allP = new Set();
  rawAllDays.forEach(d => Object.keys(d.players).forEach(p => allP.add(p)));
  activePlayers().forEach(p => allP.add(p.id));
  [...allP].filter(k => !inactiveSet.has(k))
    .sort((a, b) => displayName(a).localeCompare(displayName(b), 'es', { sensitivity: 'base' }))
    .forEach(k => {
      const o = document.createElement('option'); o.value = k; o.textContent = displayName(k); psel.appendChild(o);
    });

  applyTorneoFilter();
}

// ======================== FILTRO DE TORNEO ========================
function setTorneoFilter(v, btn) {
  torneoFilter = v;
  localStorage.setItem('club_torneo_filter', v);
  document.querySelectorAll('#torneo-filter-row .pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyTorneoFilter();
}

function applyTorneoFilter() {
  applyTorneoFilterData();
  weekIdx = 0;
  buildPeriodSelector();
  renderReport();
}

function buildPeriodSelector() {
  if (reportView === 'semanal' || reportView === 'totales') return;
  const sel = document.getElementById('period-sel');
  sel.innerHTML = '';
  if (reportView === 'mensual') {
    const months = [...new Set(allDays.map(d => d.date.substring(0, 7)))].sort().reverse();
    months.forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = formatMonth(m); sel.appendChild(o); });
  } else {
    const weeks = [...new Set(allDays.map(d => weekKey(d.date)))].sort().reverse();
    const ao = document.createElement('option'); ao.value = 'all'; ao.textContent = 'Todas las semanas'; sel.appendChild(ao);
    weeks.forEach(w => { const o = document.createElement('option'); o.value = w; o.textContent = formatWeek(w); sel.appendChild(o); });
  }
}

function renderReport() {
  if (!document.getElementById('report-out')) return;
  if (reportView === 'semanal') renderWeekly();
  else if (reportView === 'mensual') renderMonthly();
  else if (reportView === 'totales') renderTotales();
  else renderPlayer();
}

function changeWeek(dir) { weekIdx += dir; renderReport(); }
function setSemanalFilter(mode) { semanalShowAll = (mode === 'full'); renderReport(); }
function setSemanalSort(sort) { semanalSortBy = sort; renderReport(); }
function toggleTotalesSort() { totalesAsc = !totalesAsc; renderReport(); }

// ======================== SEMANAL ========================
function renderWeekly() {
  const out = document.getElementById('report-out');
  const weeks = [...new Set(allDays.map(d => weekKey(d.date)))].sort().reverse();
  if (!weeks.length) { out.innerHTML = '<div class="card" style="padding:20px;text-align:center;color:var(--gray)">No hay datos disponibles.</div>'; return; }

  weekIdx = Math.max(0, Math.min(weekIdx, weeks.length - 1));
  const curWeek = weeks[weekIdx];
  const weekData = allDays.filter(d => weekKey(d.date) === curWeek);
  const practiceDays = weekData.map(d => d.date);
  const total = practiceDays.length;

  const displayDays = semanalShowAll ? getWeekDays(curWeek) : practiceDays;

  const allP = [...new Set([...activePlayers().map(p => p.id), ...weekData.flatMap(d => Object.keys(d.players))])].filter(p => !inactiveSet.has(p));
  const att = {};
  allP.forEach(p => { att[p] = 0; });
  weekData.forEach(d => {
    Object.entries(d.players).forEach(([p, st]) => {
      if (!att.hasOwnProperty(p)) att[p] = 0;
      if (st === 'P' || st === 'E/A') att[p]++;
    });
  });

  const sortedP = total === 0 ? [...allP] : semanalSortBy === 'name'
    ? [...allP].sort((a, b) => displayName(a).localeCompare(displayName(b)))
    : [...allP].sort((a, b) => (att[b] || 0) - (att[a] || 0));

  const avgPct = sortedP.length && total ? Math.round(sortedP.reduce((s, p) => s + (att[p] || 0) / total * 100, 0) / sortedP.length) : 0;
  const isNewest = weekIdx === 0;
  const prevDis = weekIdx >= weeks.length - 1;
  const nextDis = weekIdx <= 0;

  let h = `<div class="week-nav-bar">
    <button class="week-nav-btn" onclick="changeWeek(1)" ${prevDis ? 'disabled' : ''}>&#8249;</button>
    <div class="week-nav-info">
      <strong>${formatWeek(curWeek)}</strong>
      ${total} práctica${total !== 1 ? 's' : ''} · ${avgPct}% prom.${isNewest ? ' · Semana actual' : ''}
    </div>
    <button class="week-nav-btn" onclick="changeWeek(-1)" ${nextDis ? 'disabled' : ''}>&#8250;</button>
  </div>
  <div class="pills-row">
    <div class="pills">
      <button class="pill${!semanalShowAll ? ' active' : ''}" onclick="setSemanalFilter('only')">Solo con datos</button>
      <button class="pill${semanalShowAll ? ' active' : ''}" onclick="setSemanalFilter('full')">Semana completa</button>
    </div>
    <div class="pills">
      <button class="pill${semanalSortBy === 'pct' ? ' active' : ''}" onclick="setSemanalSort('pct')">% ↓</button>
      <button class="pill${semanalSortBy === 'name' ? ' active' : ''}" onclick="setSemanalSort('name')">A-Z</button>
    </div>
  </div>`;

  if (!sortedP.length) {
    h += '<div class="card" style="padding:16px;text-align:center;color:var(--gray)">Sin jugadores registrados.</div>';
  } else {
    sortedP.forEach(p => {
      const cnt = att[p] || 0;
      const pct = total ? Math.round(cnt / total * 100) : 0;
      let dotsH = '';
      displayDays.forEach(date => {
        const hasPractice = practiceDays.includes(date);
        const lbl = formatDateShort(date).split(' ')[0];
        if (!hasPractice) {
          dotsH += `<div class="day-col" style="opacity:.3"><div class="day-lbl">${lbl}</div><div class="dot none">—</div></div>`;
        } else {
          const dayRec = weekData.find(d => d.date === date);
          const st = dayRec ? dayRec.players[p] : '';
          if (st) {
            dotsH += `<div class="day-col"><div class="day-lbl">${lbl}</div><div class="dot ${dotClass(st)}">${st}</div></div>`;
          } else {
            dotsH += `<div class="day-col"><div class="day-lbl">${lbl}</div><div class="dot none">—</div></div>`;
          }
        }
      });
      h += `<div class="semanal-card">
        <div class="semanal-card-top">
          <span class="semanal-card-name">${displayName(p)}</span>
          <span class="badge ${badgeClass(pct)}">${pct}%</span>
        </div>
        <div class="semanal-card-bot">
          <div class="dots-row">${dotsH}</div>
          <div style="font-size:.8rem;color:var(--gray);white-space:nowrap;margin-left:8px">${cnt}/${total} pract.</div>
        </div>
      </div>`;
    });
  }

  out.innerHTML = h;
}

// ======================== TOTALES ========================
function renderTotales() {
  const out = document.getElementById('report-out');
  const total = allDays.length;
  if (!total) { out.innerHTML = '<div class="card" style="padding:20px;text-align:center;color:var(--gray)">No hay datos disponibles.</div>'; return; }

  const allP = [...new Set([...activePlayers().map(p => p.id), ...allDays.flatMap(d => Object.keys(d.players))])].filter(p => !inactiveSet.has(p));
  const att = {};
  allP.forEach(p => { att[p] = 0; });
  allDays.forEach(d => {
    Object.entries(d.players).forEach(([p, st]) => {
      if (!att.hasOwnProperty(p)) att[p] = 0;
      if (st === 'P' || st === 'E/A') att[p]++;
    });
  });

  const sortedP = [...allP].sort((a, b) => {
    const pa = total ? (att[a] || 0) / total * 100 : 0;
    const pb = total ? (att[b] || 0) / total * 100 : 0;
    return totalesAsc ? pa - pb : pb - pa;
  });

  const avgPct = sortedP.length ? Math.round(sortedP.reduce((s, p) => s + (att[p] || 0) / total * 100, 0) / sortedP.length) : 0;

  let h = `<div class="card">
    <div class="card-hdr">Ranking General<span class="badge ${badgeClass(avgPct)}">${avgPct}% prom</span><button class="sort-dir-btn" onclick="toggleTotalesSort()">${totalesAsc ? '↑ Menor primero' : '↓ Mayor primero'}</button></div>
    <div class="stats">
      <div class="stat"><div class="n">${total}</div><div class="l">Prácticas</div></div>
      <div class="stat"><div class="n">${sortedP.length}</div><div class="l">Jugadores</div></div>
      <div class="stat"><div class="n">${avgPct}%</div><div class="l">Promedio</div></div>
    </div>
  </div>`;

  sortedP.forEach((p, i) => {
    const cnt = att[p] || 0;
    const pct = total ? Math.round(cnt / total * 100) : 0;
    h += `<div class="semanal-card">
      <div class="semanal-card-top">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="rank-num">#${i + 1}</span>
          <span class="semanal-card-name">${displayName(p)}</span>
        </div>
        <span class="badge ${badgeClass(pct)}">${pct}%</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;background:${pctColor(pct)}"></div></div>
      <div style="font-size:.8rem;color:var(--gray)">${cnt} presentes / ${total} prácticas</div>
    </div>`;
  });

  out.innerHTML = h;
}

// ======================== MENSUAL ========================
function renderMonthly() {
  const out = document.getElementById('report-out');
  const sel = document.getElementById('period-sel').value;
  const data = allDays.filter(d => d.date.substring(0, 7) === sel);
  if (!data.length) { out.innerHTML = '<div class="card" style="padding:20px;text-align:center;color:var(--gray)">No hay datos para este mes.</div>'; return; }

  const total = data.length;
  const allP = [...new Set([...activePlayers().map(p => p.id), ...data.flatMap(d => Object.keys(d.players))])].filter(p => !inactiveSet.has(p));

  const weeks = {};
  data.forEach(d => { const w = weekKey(d.date); if (!weeks[w]) weeks[w] = []; weeks[w].push(d); });
  const wKeys = Object.keys(weeks).sort();

  const att = {};
  allP.forEach(p => { att[p] = 0; });
  data.forEach(d => Object.entries(d.players).forEach(([p, st]) => { if (!att.hasOwnProperty(p)) att[p] = 0; if (st === 'P' || st === 'E/A') att[p]++; }));
  const sortedP = allP.sort((a, b) => (att[b] || 0) - (att[a] || 0));
  const avgPct = sortedP.length ? Math.round(sortedP.reduce((s, p) => s + (att[p] / total * 100), 0) / sortedP.length) : 0;

  let h = `<div class="card"><div class="card-hdr">${formatMonth(sel)}<span class="badge ${badgeClass(avgPct)}">${avgPct}% prom</span></div>
    <div class="stats">
      <div class="stat"><div class="n">${total}</div><div class="l">Prácticas</div></div>
      <div class="stat"><div class="n">${wKeys.length}</div><div class="l">Semanas</div></div>
      <div class="stat"><div class="n">${avgPct}%</div><div class="l">Asistencia</div></div>
    </div></div>`;

  wKeys.forEach((wk, wi) => {
    const wd = weeks[wk]; const wt = wd.length;
    const wa = {}; allP.forEach(p => { wa[p] = 0; });
    wd.forEach(d => Object.entries(d.players).forEach(([p, st]) => { if (!wa.hasOwnProperty(p)) wa[p] = 0; if (st === 'P' || st === 'E/A') wa[p]++; }));
    const wavg = allP.length ? Math.round(allP.reduce((s, p) => s + (wa[p] / wt * 100), 0) / allP.length) : 0;

    h += `<div class="card"><div class="card-hdr">Semana ${wi + 1}: ${formatWeek(wk)}<span class="badge ${badgeClass(wavg)}">${wavg}% · ${wt} prác.</span></div>`;
    sortedP.forEach(p => {
      const pct = Math.round(wa[p] / wt * 100);
      h += `<div class="p-row"><span class="date">${displayName(p)}</span><span class="st">${wa[p]}/${wt}</span><span class="st" style="min-width:40px;text-align:right;color:${pctColor(pct)}">${pct}%</span></div>`;
    });
    h += `</div>`;
  });

  h += `<div class="card"><div class="card-hdr">Total del Mes</div>`;
  sortedP.forEach(p => {
    const pct = Math.round(att[p] / total * 100);
    h += `<div class="p-row"><span class="date">${displayName(p)}</span><span class="st">${att[p]}/${total}</span><span class="st" style="min-width:40px;text-align:right;color:${pctColor(pct)}">${pct}%</span></div>`;
  });
  h += `</div>`;
  out.innerHTML = h;
}

// ======================== POR JUGADOR ========================
function renderPlayer() {
  const out = document.getElementById('report-out');
  const pk = document.getElementById('player-sel').value;
  const sel = document.getElementById('period-sel').value;
  if (!pk) { out.innerHTML = '<div class="card" style="padding:20px;text-align:center">Seleccioná un jugador</div>'; return; }

  let data = sel === 'all' ? allDays : allDays.filter(d => weekKey(d.date) === sel);
  const total = data.length;
  let attended = 0;
  const details = [];
  data.forEach(d => {
    const st = d.players[pk] || 'A';
    const pres = (st === 'P' || st === 'E/A');
    if (pres) attended++;
    const obs = (allObs[d.date] && allObs[d.date][pk]) || '';
    details.push({ date: d.date, status: st, obs, present: pres });
  });
  const pct = total ? Math.round(attended / total * 100) : 0;

  let h = `<div class="card"><div class="card-hdr">${displayName(pk)}<span class="badge ${badgeClass(pct)}">${pct}%</span></div>
    <div class="stats" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat"><div class="n" style="color:var(--green)">${attended}</div><div class="l">Presentes</div></div>
      <div class="stat"><div class="n" style="color:var(--red)">${total - attended}</div><div class="l">Ausencias</div></div>
      <div class="stat"><div class="n">${total}</div><div class="l">Prácticas</div></div>
      <div class="stat"><div class="n" style="color:${pctColor(pct)}">${pct}%</div><div class="l">Asistencia</div></div>
    </div></div>`;

  if (details.length) {
    const trend = details.slice(-8);
    let trendH = '';
    trend.forEach(d => {
      const lbl = formatDateShort(d.date).split(' ')[0];
      trendH += `<div class="day-col"><div class="day-lbl">${lbl}</div><div class="dot ${dotClass(d.status)}" title="${formatDateLong(d.date)}">${d.status}</div></div>`;
    });
    h += `<div class="card"><div class="card-hdr">Tendencia reciente</div><div style="padding:12px;display:flex;gap:6px;flex-wrap:wrap">${trendH}</div></div>`;
  }

  h += `<div class="card"><div class="card-hdr">Historial</div>`;
  details.slice().reverse().forEach(d => {
    const stLabel = ESTADO_LABEL[d.status] || d.status;
    const obsHtml = d.status === 'J' && d.obs ? `<span style="font-size:.78rem;color:var(--gray);font-style:italic;display:block;margin-top:2px">"${d.obs}"</span>` : '';
    h += `<div class="p-row" style="flex-wrap:wrap"><span class="date">${formatDateLong(d.date)}</span><div style="display:flex;flex-direction:column;align-items:flex-end"><div style="display:flex;align-items:center;gap:6px"><span class="dot ${dotClass(d.status)}">${d.status}</span><span class="st" style="color:${d.present ? 'var(--green)' : 'var(--red)'}">${stLabel}</span></div>${obsHtml}</div></div>`;
  });
  h += `</div>`;
  out.innerHTML = h;
}
