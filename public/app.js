(() => {
  'use strict';
  const STORAGE_KEY = 'repstate_hypertrophy44_v1';
  const SYNC_BASE_KEY = `${STORAGE_KEY}_sync_base_v1`;
  const defaults = {
    settings: { startDate: '', loadUnit: 'kg', bodyUnit: 'kg', phase: 'Bulk' },
    logs: {}, checkins: {}, sessionDates: {}, milestones: {}, syncMeta: {},
    ui: { page: 'overview', week: null, day: 'all', strengthExercise: 'Incline DB Bench Press (30°)', quickLog: true }
  };
  const app = document.querySelector('#app');
  const modalRoot = document.querySelector('#modal-root');
  let program;
  let activeUsername = '';
  let state = loadState();
  let stateSnapshot = JSON.parse(JSON.stringify(state));
  const syncInfo = { loggedIn: false, username: '', lastUsername: '', legacy: false, authMode: 'login', busy: false, timer: null, pending: false };
  let toastTimer;
  let localEditRevision = 0;

  function loadState(key=STORAGE_KEY) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '{}');
      return {
        ...defaults, ...parsed,
        settings: { ...defaults.settings, ...(parsed.settings || {}) },
        logs: parsed.logs || {}, checkins: parsed.checkins || {}, sessionDates: parsed.sessionDates || {},
        milestones: parsed.milestones || {}, syncMeta: parsed.syncMeta || {},
        ui: { ...defaults.ui, ...(parsed.ui || {}) }
      };
    } catch (_) { return structuredClone(defaults); }
  }
  function noteChangedData() {
    const previous = stateSnapshot || {};
    const stamp = Date.now();
    ['settings', 'logs', 'checkins', 'sessionDates', 'milestones'].forEach(section => {
      const before = previous[section] || {}, after = state[section] || {};
      state.syncMeta ||= {};
      state.syncMeta[section] ||= {};
      new Set([...Object.keys(before), ...Object.keys(after)]).forEach(key => {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) state.syncMeta[section][key] = stamp;
      });
    });
    stateSnapshot = JSON.parse(JSON.stringify(state));
  }
  function setSavedStatus(label, saving=false) {
    const status = document.querySelector('.saved-status');
    if (status) { status.innerHTML = `<i></i> ${esc(label)}`; status.classList.toggle('saving', saving); }
  }
  function persist() {
    localEditRevision++;
    noteChangedData();
    localStorage.setItem(currentStorageKey(), JSON.stringify(state));
    setSavedStatus(syncInfo.loggedIn ? 'Saved locally · syncing' : 'Saved locally');
    if (syncInfo.loggedIn) queueSync();
  }
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function parseLocalDate(value) { return value ? new Date(`${value}T12:00:00`) : null; }
  function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function currentWeek() {
    if (!state.settings.startDate) return 1;
    const start = parseLocalDate(state.settings.startDate);
    if (!start || Number.isNaN(start.getTime())) return 1;
    const days = Math.floor((new Date(`${todayISO()}T12:00:00`) - start) / 86400000);
    if (days < 0) return 1;
    return (Math.floor(days / 7) % 44) + 1;
  }
  function selectedWeek() { return Math.max(1, Math.min(44, Number(state.ui.week) || currentWeek())); }
  function weekLabel(w) { return `Week ${String(w).padStart(2,'0')}`; }
  function weekRows(w) { return program.exercises.filter(x => x.week === Number(w)); }
  function uniqueDays(w) { return [...new Set(weekRows(w).map(x => x.day))]; }
  function dayTitle(day) { return String(day || '').replace(/^\w+day\s+[—–-]\s*/,''); }
  function deload(w) { return program.deloadWeeks.includes(Number(w)); }
  function phaseForWeek(w) { return state.checkins[w]?.phase || state.settings.phase || 'Bulk'; }
  function getPrescription(row, w) {
    const isDeload = deload(w) || row.weekType === 'Deload';
    const cut = phaseForWeek(w) === 'Cut';
    return {
      sets: isDeload ? row.deloadSets : (cut ? row.cutSets : row.sets),
      rir: isDeload ? row.deloadRir : (cut ? row.cutRir : row.rir),
      reps: row.reps,
      type: isDeload ? 'Deload' : (cut ? 'Cut' : 'Standard')
    };
  }
  function maxSets(value) {
    const n = (String(value || '').match(/\d+/g) || ['1']).map(Number);
    return Math.max(1, Math.min(5, ...[Math.max(...n)]));
  }
  function automaticExerciseStatus(row, entry) {
    if (!loggedSetCount(entry)) return entry?.status || 'Planned';
    const required = maxSets(getPrescription(row, row.week).sets);
    const completed = Array.from({ length: required }, (_, i) => Number(entry.sets?.[i]?.reps) > 0).filter(Boolean).length;
    return completed === required ? 'Done' : 'Partial';
  }
  function statusOf(id) {
    const entry = state.logs[id];
    const row = program?.exercises?.find(exercise => exercise.id === id);
    return row ? automaticExerciseStatus(row, entry) : entry?.status || 'Planned';
  }
  function loggedSetCount(entry) { return (entry?.sets || []).filter(s => s && (s.reps !== '' && s.reps != null || s.load !== '' && s.load != null)).length; }
  function setCountForWeek(w) {
    return Object.entries(state.logs).filter(([id, v]) => id.startsWith(`${w}:`)).reduce((n, [,v]) => n + loggedSetCount(v), 0);
  }
  function groupedDayStatus(w, day) {
    const rows = weekRows(w).filter(r => r.day === day);
    if (!rows.length) return 'Planned';
    const statuses = rows.map(r => statusOf(r.id));
    if (statuses.every(s => s === 'Done')) return 'Done';
    if (statuses.every(s => s === 'Skipped')) return 'Skipped';
    if (statuses.some(s => s === 'Done' || s === 'Partial' || s === 'Skipped')) return 'Partial';
    return 'Planned';
  }
  function weekStats(w) {
    const days = uniqueDays(w);
    const counts = { done: 0, partial: 0, skipped: 0, planned: 0 };
    days.forEach(d => { const s = groupedDayStatus(w,d).toLowerCase(); counts[s] = (counts[s] || 0) + 1; });
    return { ...counts, total: days.length, sets: setCountForWeek(w) };
  }
  function muscleOf(name) {
    const n = String(name).toLowerCase();
    if (n.includes('rear delt') || n.includes('face pull') || n.includes('reverse pec')) return 'Rear delts';
    if (n.includes('lateral raise')) return 'Side delts';
    if (n.includes('calf')) return 'Calves';
    if (n.includes('crunch') || n.includes('hanging leg') || n.includes('captain')) return 'Abs';
    if (n.includes('curl') && !n.includes('leg curl')) return 'Biceps';
    if (n.includes('pushdown') || n.includes('triceps') || n.includes('overhead cable') || n.includes('overhead db')) return 'Triceps';
    if (n.includes('leg curl') || n.includes('romanian deadlift') || n.includes('rdl')) return 'Hamstrings';
    if (n.includes('squat') || n.includes('leg press') || n.includes('leg extension') || n.includes('lunge') || n.includes('split squat')) return 'Quads';
    if (n.includes('shrug')) return 'Traps';
    if (n.includes('row') || n.includes('pulldown') || n.includes('pull-up') || n.includes('pullover')) return 'Back';
    if (n.includes('bench') || n.includes('chest') || n.includes('pec') || (n.includes('press') && !n.includes('shoulder'))) return 'Chest';
    return 'Shoulders';
  }
  function muscleSets(w) {
    const out = {};
    weekRows(w).forEach(row => {
      const sets = state.logs[row.id]?.sets || [];
      const count = loggedSetCount({ sets });
      const muscle = muscleOf(row.exercise);
      out[muscle] = (out[muscle] || 0) + count;
    });
    return out;
  }
  function shortDate(iso) {
    if (!iso) return 'Date not set';
    const d = parseLocalDate(iso);
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { month:'short', day:'numeric' }) : 'Date not set';
  }
  function weekStart(w) {
    if (!state.settings.startDate) return '';
    const d = parseLocalDate(state.settings.startDate);
    if (!d) return '';
    d.setDate(d.getDate() + (Number(w)-1)*7);
    return isoDate(d);
  }
  function sessionDate(w, day) {
    const k = `${w}|${day}`;
    if (state.sessionDates[k]) return state.sessionDates[k];
    const d0 = weekStart(w);
    if (!d0) return '';
    const d = parseLocalDate(d0);
    const idx = Math.max(0, uniqueDays(w).indexOf(day));
    d.setDate(d.getDate() + idx);
    return isoDate(d);
  }
  function activeBlock(w) { return weekRows(w)[0]?.block || 'Block 1'; }
  function updateShell() {
    const w = currentWeek();
    const navWeek = document.querySelector('#nav-week');
    const sw = document.querySelector('#sidebar-week');
    const progress = document.querySelector('#sidebar-progress');
    const block = document.querySelector('#sidebar-block');
    if (navWeek) navWeek.textContent = `W${String(w).padStart(2,'0')}`;
    if (sw) sw.textContent = `${String(w).padStart(2,'0')} / 44`;
    if (progress) progress.style.width = `${Math.max(0, Math.min(100, (w-1)/44*100))}%`;
    if (block) block.textContent = `${activeBlock(w)} · ${deload(w) ? 'Deload' : phaseForWeek(w)}`;
    document.querySelectorAll('[data-page]').forEach(b => {
      b.classList.toggle('active', b.dataset.page === state.ui.page);
    });
    const name = { overview:'Overview', training:'Training log', analytics:'Analytics', checkins:'Weekly check-in', program:'Program guide' }[state.ui.page] || 'Overview';
    const pageName = document.querySelector('#page-name');
    if (pageName) pageName.textContent = name;
  }
  function pageHead(eyebrow, title, subtitle, right='') {
    return `<div class="page-head"><div><div class="eyebrow">${esc(eyebrow)}</div><h1 class="page-title">${esc(title)}</h1><p class="page-subtitle">${esc(subtitle)}</p></div>${right}</div>`;
  }
  function chartEmpty(title, help) {
    return `<div class="chart-empty"><strong>${esc(title)}</strong><span>${esc(help)}</span></div>`;
  }
  function svgLineChart(points, unit='') {
    const valid = points.filter(p => Number.isFinite(Number(p.value)));
    if (!valid.length) return chartEmpty('Your trend starts here', 'Log a few sessions or check-ins to see the line take shape.');
    const W=520,H=190,L=42,R=12,T=13,B=29,plotW=W-L-R,plotH=H-T-B;
    let min=Math.min(...valid.map(p=>Number(p.value))), max=Math.max(...valid.map(p=>Number(p.value)));
    if (min===max) { min-=Math.max(1,Math.abs(min)*.06); max+=Math.max(1,Math.abs(max)*.06); }
    const pad=(max-min)*.13; min-=pad; max+=pad;
    const y=v=>T+(max-Number(v))/(max-min)*plotH;
    const x=i=>L+(valid.length===1?plotW/2:i/(valid.length-1)*plotW);
    const ticks=4;
    let grid='';
    for(let i=0;i<=ticks;i++){const val=max-(max-min)*i/ticks, yy=T+plotH*i/ticks;grid+=`<line x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}" stroke="#edf0eb"/><text x="${L-8}" y="${yy+3}" text-anchor="end" font-size="8" fill="#98a198">${esc(val.toFixed(0))}</text>`;}
    const coords=valid.map((p,i)=>`${x(i)},${y(p.value)}`).join(' ');
    const area=`${L},${T+plotH} ${coords} ${W-R},${T+plotH}`;
    let labels='';
    valid.forEach((p,i)=>{ if(valid.length<=6 || i===0 || i===valid.length-1 || i%Math.ceil(valid.length/5)===0) labels+=`<text x="${x(i)}" y="${H-7}" text-anchor="middle" font-size="8" fill="#98a198">${esc(p.label)}</text>`;});
    const dots=valid.map((p,i)=>`<circle cx="${x(i)}" cy="${y(p.value)}" r="3.2" fill="#fff" stroke="#628265" stroke-width="2"><title>${esc(p.label)}: ${esc(Number(p.value).toFixed(1))} ${esc(unit)}</title></circle>`).join('');
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend chart">${grid}<polygon points="${area}" fill="#eaf1e6" opacity=".72"/><polyline points="${coords}" fill="none" stroke="#658768" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}${labels}</svg>`;
  }
  function completionChart(weeks) {
    const hasLogs=weeks.some(w=>weekStats(w).done+weekStats(w).partial+weekStats(w).skipped>0);
    if(!hasLogs) return chartEmpty('No sessions logged yet','Mark a workout complete to start tracking consistency.');
    const W=520,H=184,L=32,R=9,T=14,B=28,plotW=W-L-R,plotH=H-T-B,step=plotW/weeks.length,barW=Math.min(23,step*.55);
    let bars='',grid='';
    [0,.5,1].forEach(v=>{const y=T+plotH*(1-v);grid+=`<line x1="${L}" y1="${y}" x2="${W-R}" y2="${y}" stroke="#edf0eb"/><text x="${L-7}" y="${y+3}" text-anchor="end" font-size="8" fill="#98a198">${Math.round(v*5)}</text>`;});
    weeks.forEach((w,i)=>{const s=weekStats(w),val=s.done+s.partial*.5,hh=val/5*plotH,x=L+i*step+(step-barW)/2,y=T+plotH-hh;bars+=`<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(2,hh)}" rx="4" fill="${deload(w)?'#c5d4c0':'#668768'}"><title>Week ${w}: ${s.done} complete, ${s.partial} partial</title></rect><text x="${x+barW/2}" y="${H-7}" text-anchor="middle" font-size="8" fill="#98a198">${w}</text>`;});
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Workout completion by week">${grid}${bars}</svg>`;
  }
  function recentWeeks(limit=8) {
    const end=currentWeek();
    return Array.from({length:Math.min(limit,Math.max(1,end))},(_,i)=>Math.max(1,end-Math.min(limit,end)+1+i));
  }
  function checkinPoints() {
    return Object.entries(state.checkins).map(([w,v])=>({week:Number(w),weight:Number(v.weight),value:Number(v.weight)}))
      .filter(p=>Number.isFinite(p.value)&&p.value>0).sort((a,b)=>a.week-b.week).slice(-12)
      .map(p=>({label:`W${p.week}`,value:p.value}));
  }
  function strengthPoints(exercise) {
    const records=[];
    program.exercises.forEach(row=>{
      if(row.exercise!==exercise) return;
      const entry=state.logs[row.id];
      (entry?.sets||[]).forEach((s,index)=>{
        const load=Number(s.load), reps=Number(s.reps);
        if(load>0&&reps>0) records.push({week:row.week,index,value:load*(1+reps/30)});
      });
    });
    return records.sort((a,b)=>a.week-b.week).slice(-12).map(x=>({label:`W${x.week}`,value:x.value}));
  }
  function volumeBars(w) {
    const logged=muscleSets(w);
    const muscles=Object.keys(program.volumeTargets);
    const max=Math.max(12,...muscles.map(m=>Number(String(program.volumeTargets[m]).match(/\d+/)?.[0]||0)));
    return `<div class="bar-chart">${muscles.map(m=>{const val=logged[m]||0,goal=Number(String(program.volumeTargets[m]).match(/\d+/)?.[0]||0),pct=Math.min(100,val/max*100);return `<div class="bar-row"><span class="bar-label">${esc(m)}</span><div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><span class="bar-target">Target ${esc(program.volumeTargets[m])} sets</span></div><span class="bar-value">${val} sets</span></div>`;}).join('')}</div>`;
  }
  function nextMilestone(w) {
    return program.milestones.find(m=>m.week>=w&&m.week<=44&&!state.milestones[`w${m.week}`])
      || program.milestones.find(m=>m.week===45&&!state.milestones[`w${m.week}`])
      || null;
  }
  function renderOverview() {
    const w=currentWeek(), stats=weekStats(w), weekPlan=weekRows(w), days=uniqueDays(w);
    const check=state.checkins[w]||{};
    const recent=recentWeeks(8);
    const upcoming=nextMilestone(w);
    const phase=phaseForWeek(w);
    const weekType=deload(w)?'Deload week':`${activeBlock(w)} · ${phase}`;
    const bodyWeight=check.weight?`${esc(check.weight)} <small>${esc(state.settings.bodyUnit)}</small>`:'—';
    const startLine=state.settings.startDate?`Cycle began ${shortDate(state.settings.startDate)} · ${weekType}`:'Set a start date to align dates and milestones · Previewing Week 01';
    const setup=state.settings.startDate?'':`<div class="setup-alert"><div class="alert-text"><strong>Set up your cycle.</strong> Add your start date and preferred units to align the 44-week schedule. Your training data stays in this browser.</div><div class="alert-actions"><button class="button button-primary button-small" data-action="settings">Set up cycle</button><button class="button button-quiet button-small" data-page="program">Read program rules</button></div></div>`;
    const dayRows=days.map((day,i)=>{
      const status=groupedDayStatus(w,day), total=weekPlan.filter(r=>r.day===day).length;
      const className=status.toLowerCase();
      const badge=status==='Planned'?`${total} exercises`:status;
      return `<div class="schedule-row"><div class="day-icon">${String(i+1).padStart(2,'0')}</div><div class="schedule-info"><strong>${esc(dayTitle(day))}</strong><span>${esc(day.split('—')[0].trim())} · ${total} planned movements</span></div><span class="schedule-status ${className}">${esc(badge)}</span></div>`;
    }).join('');
    app.innerHTML=`
      <section class="hero"><div class="hero-content"><div class="hero-chip"><b></b> THE CONSOLIDATED HYPERTROPHY PROGRAM</div><h1>Strong work.<br>Logged for the long game.</h1><p>${esc(startLine)}<br>Double progression, five training days, and 44 weeks of clear direction.</p><div class="hero-actions"><button class="button button-light" data-page="training">Start today’s workout <span aria-hidden="true">↗</span></button><button class="button button-quiet" data-action="settings">Cycle settings</button></div></div><div class="hero-side"><strong>${String(w).padStart(2,'0')}<span style="font-size:14px;color:#acb7ae"> / 44</span></strong><span>${esc(weekType)}</span></div></section>
      ${setup}
      <div class="stat-grid">
        <article class="stat-card"><div class="stat-top"><span>Sessions completed</span><span class="stat-icon">↗</span></div><div class="stat-value">${stats.done}<small> / ${stats.total}</small></div><div class="stat-foot ${stats.done?'good':''}">${stats.partial?`${stats.partial} partial session${stats.partial===1?'':'s'} · `:''}${deload(w)?'Deload pace':'Target five sessions this week'}</div></article>
        <article class="stat-card"><div class="stat-top"><span>Work sets logged</span><span class="stat-icon">▤</span></div><div class="stat-value">${stats.sets}</div><div class="stat-foot">${stats.sets?'Across this week’s exercise log':'Enter load and reps after each set'}</div></article>
        <article class="stat-card"><div class="stat-top"><span>Weekly average weight</span><span class="stat-icon">◉</span></div><div class="stat-value">${bodyWeight}</div><div class="stat-foot">${check.weight?'From this week’s check-in':`Unit: ${esc(state.settings.bodyUnit)} · no check-in yet`}</div></article>
        <article class="stat-card"><div class="stat-top"><span>Cycle progress</span><span class="stat-icon">⌁</span></div><div class="stat-value">${Math.round((w-1)/44*100)}<small>%</small></div><div class="stat-foot">${esc(activeBlock(w))} · ${deload(w)?'scheduled deload':'weeks 1–10 build'}</div></article>
      </div>
      <div class="two-col">
        <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Training consistency</h2><p class="panel-sub">Completed sessions by week · partial sessions count as half</p></div><button class="panel-action" data-page="analytics">Full analytics ↗</button></div><div class="chart-wrap">${completionChart(recent)}</div><div class="chart-legend"><span><i class="legend-dot"></i>Completed sessions</span><span><i class="legend-dot gray"></i>Deload week</span></div></section>
        <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Muscle-group volume</h2><p class="panel-sub">Logged working sets this week against Block 1 reference targets</p></div></div>${volumeBars(w)}</section>
      </div>
      <div class="two-col">
        <section class="panel"><div class="panel-head"><div><h2 class="panel-title">This week at a glance</h2><p class="panel-sub">${weekPlan.length} planned exercise entries · ${deload(w)?'reduced sets, easy effort':'log every working set'}</p></div><button class="panel-action" data-page="training">Open log ↗</button></div><div class="schedule-list">${dayRows}</div></section>
        <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Next milestone</h2><p class="panel-sub">A useful checkpoint from your plan</p></div><button class="panel-action" data-page="program">All milestones ↗</button></div>${upcoming?`<div class="upcoming"><div class="milestone-mark">${upcoming.week===45?'↻':'✦'}</div><div><strong>${upcoming.week===45?'Next cycle':'Week '+upcoming.week} · ${esc(activeBlock(Math.min(upcoming.week,44)))}</strong><p>${esc(upcoming.title)}</p></div></div>`:`<div class="empty-state">All 44-week milestones are marked complete.</div>`}<div class="divider"></div><div class="notice-box"><strong>Progression cue</strong><br>Keep the load until every working set reaches the top of its rep range. Then make the smallest jump and build reps again.</div></section>
      </div>`;
  }
  function weekOptions(selected) {
    return Array.from({length:44},(_,i)=>`<option value="${i+1}" ${i+1===Number(selected)?'selected':''}>${weekLabel(i+1)}${program.deloadWeeks.includes(i+1)?' · Deload':''}</option>`).join('');
  }
  function previousLoggedRow(row, w) {
    const candidates=program.exercises.filter(candidate=>candidate.week<Number(w)&&candidate.exercise===row.exercise);
    candidates.sort((a,b)=>Number(b.day===row.day)-Number(a.day===row.day)||b.week-a.week);
    return candidates.find(candidate=>loggedSetCount(state.logs[candidate.id])>0)||null;
  }
  function renderExerciseCard(row, index, w) {
    const entry=state.logs[row.id]||{status:'Planned',sets:[]};
    const status=statusOf(row.id);
    const rx=getPrescription(row,w), count=maxSets(rx.sets);
    const isOpen=state.ui.quickLog!==false||state.ui.openExercise===row.id;
    const skipButton=(status==='Planned'||status==='Skipped')&&!loggedSetCount(entry)?`<button type="button" class="skip-exercise" data-action="toggle-skip" data-id="${esc(row.id)}">${status==='Skipped'?'Undo skip':'Skip'}</button>`:'';
    const sets=Array.from({length:count},(_,i)=>entry.sets?.[i]||{});
    const setRows=sets.map((s,i)=>`<div class="set-label">Set ${i+1}</div><input class="input" type="number" inputmode="decimal" step="any" min="0" placeholder="${esc(state.settings.loadUnit)}" aria-label="Set ${i+1} load" data-set="${i}" data-field="load" value="${esc(s.load??'')}"><input class="input" type="number" inputmode="numeric" step="1" min="0" placeholder="reps" aria-label="Set ${i+1} reps" data-set="${i}" data-field="reps" value="${esc(s.reps??'')}"><input class="input" type="number" inputmode="numeric" step="1" min="0" max="10" placeholder="RIR" aria-label="Set ${i+1} reps in reserve" data-set="${i}" data-field="rir" value="${esc(s.rir??'')}">`).join('');
    const toggle=state.ui.quickLog===false?`<button class="expand-button" data-action="toggle-exercise" data-id="${esc(row.id)}" aria-label="${isOpen?'Hide':'Show'} set log">${isOpen?'−':'+'}</button>`:'';
    return `<article class="exercise-card" data-card="${esc(row.id)}"><div class="exercise-main"><div class="exercise-index">${String(index+1).padStart(2,'0')}</div><div class="exercise-content"><div class="exercise-title-row"><span class="exercise-title">${esc(row.exercise)}</span><span class="status-pill ${esc(status)}">${esc(status)}</span></div><div class="exercise-meta"><span>${esc(rx.sets)} sets · ${esc(rx.reps)} reps</span><span>${esc(rx.rir)} RIR</span><span>Rest ${esc(row.rest||'—')}</span><span>${esc(muscleOf(row.exercise))}</span></div><p class="exercise-cue">${esc(row.cue||'Log load, reps, and RIR for each working set.')}</p></div><div class="exercise-controls">${skipButton}${toggle}</div></div>${isOpen?`<div class="exercise-details"><div class="set-grid"><div></div><div class="set-grid-head">Load (${esc(state.settings.loadUnit)})</div><div class="set-grid-head">Reps</div><div class="set-grid-head">RIR <span>(optional)</span></div>${setRows}</div><div class="exercise-foot"><small>Autosaves as you type. Enter reps for each set to mark this exercise done; RIR is optional.</small><small>Progression: reach the top of the rep range on all sets before adding load.</small></div></div>`:''}</article>`;
  }
  function renderTraining() {
    const w=selectedWeek(), rows=weekRows(w), days=uniqueDays(w);
    const weekday=new Date().getDay(), todayIndex=weekday>=1&&weekday<=5?weekday-1:0;
    const chosen=state.ui.day==='all'?(days[todayIndex]||days[0]):state.ui.day;
    const list=rows.filter(r=>r.day===chosen);
    const stat=weekStats(w), phase=phaseForWeek(w), isDeload=deload(w);
    const right=`<div class="page-controls"><select id="week-select" class="select compact" aria-label="Select program week">${weekOptions(w)}</select><button class="button button-quiet button-small" data-action="current-week">Current week</button></div>`;
    const tabs=days.map((d,i)=>`<button class="day-tab ${d===chosen?'active':''}" data-day="${esc(d)}"><span>${['MON','TUE','WED','THU','FRI'][i]||'DAY'}</span> · ${esc(dayTitle(d))}</button>`).join('');
    const dayStat=groupedDayStatus(w,chosen);
    const helper=isDeload?'Deload: about half the sets, 10–20% lighter, 3–4+ RIR. No failure or PRs.':phase==='Cut'?'Cut phase: keep compounds, trim isolation sets, and hold 1–2 RIR.':'Standard block: compound lifts at 1–2 RIR; isolations usually 0–1 RIR.';
    const suggestedDate=sessionDate(w,chosen)||(weekday>=1&&weekday<=5&&days.indexOf(chosen)===todayIndex?todayISO():'');
    const canCopy=list.some(row=>previousLoggedRow(row,w));
    app.innerHTML=`${pageHead('TRAINING LOG',`${weekLabel(w)} · ${activeBlock(w)}`,`${isDeload?'Scheduled deload week':phase+' phase'} · ${rows.length} exercise entries across five training days`,right)}
      <section class="panel"><div class="panel-head"><div><h2 class="panel-title">${esc(weekLabel(w))} training plan</h2><p class="panel-sub">${esc(helper)}</p></div><div class="toolbar-right"><span class="schedule-status ${dayStat.toLowerCase()}">${esc(dayStat)}</span></div></div><div class="day-tabs">${tabs}</div><div class="training-toolbar"><div class="training-summary">${list.length} movements · ${esc(phase)} prescriptions${isDeload?' · deload overrides':''}</div><div class="toolbar-right"><label class="training-summary" for="session-date">Session date</label><input id="session-date" class="input" type="date" style="width:auto;min-width:135px" value="${esc(suggestedDate)}" data-change="session-date" data-week="${w}" data-day="${esc(chosen)}">${canCopy?`<button class="button button-outline button-small" data-action="copy-last-session" data-week="${w}" data-day="${esc(chosen)}">Copy previous numbers</button>`:''}<button class="button button-quiet button-small" data-action="toggle-quick-log">${state.ui.quickLog===false?'Quick log all exercises':'Hide set inputs'}</button><button class="button button-primary button-small" data-action="mark-day" data-week="${w}" data-day="${esc(chosen)}">Finish workout</button></div></div><p class="quick-log-note">Entries autosave locally as you type; device sync waits until you pause. Exercise status updates from your reps. ${canCopy?'Copy previous numbers to prefill, then adjust to match today’s performance.':''}</p><div class="exercise-list">${list.map((r,i)=>renderExerciseCard(r,i,w)).join('')}</div></section>
      <div class="two-col"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Week summary</h2><p class="panel-sub">Enter reps for each planned set and statuses update automatically; tap Skip only when you miss a movement.</p></div></div><div class="goal-strip"><div class="goal-item"><span>Completed</span><strong>${stat.done} / ${stat.total} sessions</strong></div><div class="goal-item"><span>Partial</span><strong>${stat.partial} sessions</strong></div><div class="goal-item"><span>Logged work sets</span><strong>${stat.sets}</strong></div><div class="goal-item"><span>Cycle week</span><strong>${String(w).padStart(2,'0')} / 44</strong></div></div></section><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Log note</h2><p class="panel-sub">Remember</p></div></div><p class="page-subtitle">Write down every work set. Missed sessions are skipped, not doubled. If you miss a week or more, repeat the last completed week 5–10% lighter.</p></section></div>`;
  }
  function renderCheckins() {
    const w=selectedWeek(), v=state.checkins[w]||{}, phase=v.phase||state.settings.phase||'Bulk';
    const targets=phase==='Cut'?[
      ['Calories','−300 to −500 kcal/day'],['Protein','2.2–2.6 g/kg/day'],['Rate','0.5–1% loss/week'],['Recovery','Sleep 7–9 h']
    ]:phase==='Maintenance'?[
      ['Calories','Around maintenance'],['Protein','1.6–2.2 g/kg/day'],['Fat','At least 0.6–0.8 g/kg'],['Recovery','Sleep 7–9 h']
    ]:[['Calories','+200–300 kcal/day'],['Protein','1.6–2.2 g/kg/day'],['Rate','0.25–0.5% gain/week'],['Recovery','Sleep 7–9 h']];
    const field=(name,label,unit,help='',step='any')=>`<div class="field"><label for="ci-${name}">${label}${unit?` <span style="font-weight:500;color:#87928a">(${unit})</span>`:''}</label><input class="input" id="ci-${name}" name="${name}" type="number" inputmode="decimal" step="${step}" min="0" value="${esc(v[name]??'')}"><span class="field-help">${help}</span></div>`;
    app.innerHTML=`${pageHead('WEEKLY REVIEW',`${weekLabel(w)} check-in`,'Capture the weekly averages that help explain training performance.',`<div class="page-controls"><select id="week-select" class="select compact" aria-label="Select check-in week">${weekOptions(w)}</select></div>`)}
      <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Targets for ${esc(phase.toLowerCase())}</h2><p class="panel-sub">Use the program’s reference ranges; adjust based on your context and recovery.</p></div></div><div class="goal-strip">${targets.map(t=>`<div class="goal-item"><span>${esc(t[0])}</span><strong>${esc(t[1])}</strong></div>`).join('')}</div></section>
      <form id="checkin-form" class="panel" style="margin-top:14px"><div class="panel-head"><div><h2 class="panel-title">Body, nutrition & recovery</h2><p class="panel-sub">Enter weekly averages where possible; leave unknown values blank.</p></div><span class="schedule-status">${state.settings.startDate?`Week starting ${esc(shortDate(weekStart(w)))}`:'Cycle start date not set'}</span></div>
        <input type="hidden" name="week" value="${w}"><div class="checkin-grid">
          ${field('weight','Average bodyweight',state.settings.bodyUnit,'Weekly average, ideally several morning weigh-ins')}
          ${field('waist','Waist circumference',state.settings.bodyUnit,'Measure consistently, e.g. at the navel')}
          ${field('calories','Average calories','kcal/day','')}
          ${field('protein','Protein','g/kg/day','Bulk: 1.6–2.2 · Cut: 2.2–2.6')}
          ${field('fat','Fat','g/kg/day','Bulk target: at least 0.6–0.8')}
          ${field('sleep','Average sleep','hours/night','Program target: 7–9 hours')}
          ${field('steps','Average steps','steps/day','Program target: 7,000–10,000','1')}
          ${field('creatine','Creatine','days / 7','Program reference: 3–5 g/day','1')}
          ${field('cardio','Cardio sessions','sessions/week','Cut reference: 2–3 easy sessions','1')}
          <div class="field"><label for="ci-phase">Nutrition phase</label><select id="ci-phase" class="select" name="phase"><option ${phase==='Bulk'?'selected':''}>Bulk</option><option ${phase==='Cut'?'selected':''}>Cut</option><option ${phase==='Maintenance'?'selected':''}>Maintenance</option></select><span class="field-help">Changes prescriptions for this week and future weeks until updated.</span></div>
          <div class="field wide"><label for="ci-notes">Pain, recovery & notes</label><textarea class="textarea" id="ci-notes" name="notes" placeholder="Energy, appetite, joint comfort, stalls, or anything worth remembering…">${esc(v.notes||'')}</textarea></div>
        </div><div class="form-actions"><button class="button button-primary" type="submit">Save week ${w} check-in</button></div></form>
      <section class="panel" style="margin-top:14px"><div class="panel-head"><div><h2 class="panel-title">Recent weigh-in trend</h2><p class="panel-sub">Weekly average bodyweight · ${esc(state.settings.bodyUnit)}</p></div><button class="panel-action" data-page="analytics">More analytics ↗</button></div>${svgLineChart(checkinPoints(),state.settings.bodyUnit)}<p class="footnote">The program targets approximately 0.25–0.5% bodyweight gain per week in a surplus, or 0.5–1% loss per week during a cut. Trends matter more than one weigh-in.</p></section>`;
  }
  function renderAnalytics() {
    const points=checkinPoints(), exercises=[...new Set(program.exercises.filter(r=>['Incline DB Bench Press (30°)','Flat Barbell Bench Press','Smith Machine Squat (natural stance/depth)','Barbell Romanian Deadlift'].includes(r.exercise)).map(r=>r.exercise))];
    if(!exercises.includes(state.ui.strengthExercise)) state.ui.strengthExercise=exercises[0]||'';
    const strength=strengthPoints(state.ui.strengthExercise);
    const recent=recentWeeks(12);
    const rows=Object.entries(state.checkins).map(([w,c])=>({w:Number(w),...c})).filter(x=>Number(x.weight)>0).sort((a,b)=>a.w-b.w).slice(-8);
    const body=rows.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Week</th><th>Avg bodyweight</th><th>Change from prior logged week</th><th>Sleep</th><th>Avg steps</th></tr></thead><tbody>${rows.map((r,i)=>{const prev=rows[i-1],delta=prev&&Number(prev.weight)?(Number(r.weight)-Number(prev.weight))/Number(prev.weight)*100:null;return `<tr><td>Week ${r.w}</td><td>${esc(r.weight)} ${esc(state.settings.bodyUnit)}</td><td class="${delta==null?'':delta>=0?'positive':'negative'}">${delta==null?'—':`${delta>=0?'+':''}${delta.toFixed(2)}%`}</td><td>${esc(r.sleep||'—')} h</td><td>${r.steps?Number(r.steps).toLocaleString():'—'}</td></tr>`;}).join('')}</tbody></table></div>`:chartEmpty('No weekly check-ins yet','Add an average bodyweight to start the trend table.');
    app.innerHTML=`${pageHead('PROGRESS INSIGHTS','Analytics','Trends are calculated from the workouts and weekly check-ins you log.',`<div class="page-controls"><select id="week-select" class="select compact" aria-label="Choose a week">${weekOptions(selectedWeek())}</select></div>`)}
      <div class="analytics-grid">
        <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Bodyweight trend</h2><p class="panel-sub">Weekly average · ${esc(state.settings.bodyUnit)}</p></div><span class="schedule-status">${points.length} data points</span></div>${svgLineChart(points,state.settings.bodyUnit)}</section>
        <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Training consistency</h2><p class="panel-sub">Completed sessions per week out of five</p></div></div>${completionChart(recent)}</section>
        <section class="panel span-two"><div class="panel-head"><div><h2 class="panel-title">Strength progression</h2><p class="panel-sub">Estimated 1RM from logged load × reps, using the Epley estimate</p></div><select id="strength-exercise" class="select compact" aria-label="Choose a lift">${exercises.map(e=>`<option ${e===state.ui.strengthExercise?'selected':''}>${esc(e)}</option>`).join('')}</select></div>${svgLineChart(strength,state.settings.loadUnit)}<p class="footnote">An estimate, not a tested max. Compare only the same lift, equipment, range of motion, and unit. Dumbbell loads reflect the value you enter.</p></section>
        <section class="panel span-two"><div class="panel-head"><div><h2 class="panel-title">Latest logged muscle-group volume</h2><p class="panel-sub">Direct sets from entered work sets in ${weekLabel(selectedWeek())}; targets are the workbook’s Block 1 reference.</p></div></div>${volumeBars(selectedWeek())}</section>
        <section class="panel span-two"><div class="panel-head"><div><h2 class="panel-title">Weekly check-in history</h2><p class="panel-sub">Weight trend, sleep and daily steps</p></div></div>${body}</section>
      </div>`;
  }
  function renderMilestones() {
    return `<section class="panel"><div class="panel-head"><div><h2 class="panel-title">Block transitions & milestones</h2><p class="panel-sub">Mark decisions as complete when you have reviewed or completed them.</p></div></div><div class="milestone-list">${program.milestones.map(m=>{const done=!!state.milestones[`w${m.week}`];return `<div class="milestone-row"><div class="milestone-week">${m.week===45?'NEXT':`W${m.week}`}</div><div class="milestone-copy"><strong>${esc(m.title)}</strong><span>${m.week===45?'Next cycle':`Planned for week ${m.week}`}</span></div><button class="milestone-toggle ${done?'done':''}" data-action="toggle-milestone" data-week="${m.week}">${done?'Completed':'Mark done'}</button></div>`;}).join('')}</div></section>`;
  }
  function renderProgram() {
    const ref=program.reference.map(r=>`<article class="guide-card"><h3>${esc(r.topic)}</h3><p>${esc(r.text)}</p></article>`).join('');
    const targets=Object.entries(program.volumeTargets).map(([m,v])=>`<div class="goal-item"><span>${esc(m)}</span><strong>${esc(v)} sets / week</strong></div>`).join('');
    app.innerHTML=`${pageHead('PROGRAM REFERENCE','The 44-week plan','All block swaps, training rules, nutrition targets, and milestone checkpoints in one place.',`<button class="button button-primary" data-page="training">Open training log ↗</button>`)}
      <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Four-block rotation</h2><p class="panel-sub">Ten weeks of training followed by a deload; repeat the loop after Week 44.</p></div></div><div class="block-roadmap"><div class="block-card"><strong>Block 1</strong><span>Weeks 1–10</span><small>Foundational exercise selections</small></div><div class="block-card"><strong>Deload</strong><span>Week 11</span><small>Half sets · 10–20% lighter</small></div><div class="block-card"><strong>Block 2</strong><span>Weeks 12–21</span><small>Stretch and contraction swaps</small></div><div class="block-card"><strong>Deload</strong><span>Week 22</span><small>Reset before Block 3</small></div><div class="block-card"><strong>Block 3</strong><span>Weeks 23–32</span><small>Fresh accessory selections</small></div><div class="block-card"><strong>Deload</strong><span>Week 33</span><small>Reset before Block 4</small></div><div class="block-card"><strong>Block 4</strong><span>Weeks 34–43</span><small>Accessory swaps; main lifts stay</small></div><div class="block-card"><strong>Deload</strong><span>Week 44</span><small>Then repeat from Week 1</small></div></div></section>
      <section class="panel" style="margin-top:14px"><div class="panel-head"><div><h2 class="panel-title">Weekly training split</h2><p class="panel-sub">Five sessions · two full rest days · about 60–75 minutes per session</p></div></div><div class="split-grid">${program.trainingDays.map(day=>`<div class="split-day"><strong>${esc(day.split('—')[0].trim())}</strong><span>${esc(day.split('—').slice(1).join('—').trim())}</span></div>`).join('')}</div></section>
      <section class="panel" style="margin-top:14px"><div class="panel-head"><div><h2 class="panel-title">Block 1 weekly hard-set targets</h2><p class="panel-sub">Reference ranges from the program brief; later blocks carry the same general structure.</p></div></div><div class="goal-strip">${targets}</div></section>
      <section class="panel" style="margin-top:14px"><div class="panel-head"><div><h2 class="panel-title">Rules & practical guidance</h2><p class="panel-sub">The program’s operating notes from the workbook reference tab.</p></div></div><div class="guide-grid">${ref}</div></section>
      <section class="panel" style="margin-top:14px"><div class="panel-head"><div><h2 class="panel-title">Milestones</h2><p class="panel-sub">Transition checkpoints and decisions</p></div></div><div class="milestone-list">${renderMilestones().match(/<div class="milestone-list">([\s\S]*?)<\/div><\/section>/)?.[1]||''}</div></section>
      <p class="footnote">Exercise entries, rep ranges, set prescriptions, rest guidance, and movement cues are loaded for each week in the Training log. Cutting prescriptions and scheduled deload sets are selectable there without changing the source plan.</p>`;
  }
  function render() {
    updateShell();
    switch(state.ui.page) {
      case 'training': renderTraining(); break;
      case 'analytics': renderAnalytics(); break;
      case 'checkins': renderCheckins(); break;
      case 'program': renderProgram(); break;
      default: state.ui.page='overview'; renderOverview();
    }
    updateShell();
  }
  function showToast(message) {
    const el=document.querySelector('#toast');
    if(!el) return;
    el.textContent=message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),2400);
  }
  function openSettings() {
    modalRoot.innerHTML=`<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div class="modal-head"><div><h2 id="settings-title">Cycle settings</h2><p>Set up your schedule and preferred units.</p></div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></div><form id="settings-form" class="modal-form"><div class="field"><label for="setting-start">Program start date</label><input class="input" id="setting-start" name="startDate" type="date" value="${esc(state.settings.startDate)}"><span class="field-help">Use the first day of Week 1; the schedule follows Monday to Friday.</span></div><div class="checkin-grid"><div class="field"><label for="setting-load">Training load unit</label><select class="select" id="setting-load" name="loadUnit"><option ${state.settings.loadUnit==='kg'?'selected':''}>kg</option><option ${state.settings.loadUnit==='lb'?'selected':''}>lb</option></select></div><div class="field"><label for="setting-body">Bodyweight unit</label><select class="select" id="setting-body" name="bodyUnit"><option ${state.settings.bodyUnit==='kg'?'selected':''}>kg</option><option ${state.settings.bodyUnit==='lb'?'selected':''}>lb</option></select></div><div class="field wide"><label for="setting-phase">Current nutrition phase</label><select class="select" id="setting-phase" name="phase"><option ${state.settings.phase==='Bulk'?'selected':''}>Bulk</option><option ${state.settings.phase==='Cut'?'selected':''}>Cut</option><option ${state.settings.phase==='Maintenance'?'selected':''}>Maintenance</option></select><span class="field-help">Check-ins can record phase changes by week.</span></div></div><div class="notice-box">Your workout logs and check-ins are stored only in this browser’s local storage. They are not uploaded to the hosted app. Export a backup before moving to another browser or device.</div><div class="modal-actions"><button type="button" class="button button-quiet button-small" data-action="import">Import backup</button><button type="submit" class="button button-primary">Save settings</button></div><input id="backup-file" type="file" accept="application/json,.json" hidden></form></section></div>`;
    const syncPanel = document.createElement('section');
    syncPanel.className = 'sync-panel';
    syncPanel.innerHTML = `<div class="sync-panel-head"><div><h3>Private device sync</h3><p>Keep this tracker in sync across your devices using your private RepState account.</p></div><span class="schedule-status ${syncInfo.loggedIn?'done':''}">${syncInfo.loggedIn?'Connected':'Optional'}</span></div>${syncInfo.loggedIn?`<p class="sync-account">Signed in as <strong>${esc(syncInfo.username)}</strong></p><div class="modal-actions"><button type="button" class="button button-outline button-small" data-action="sync-now">Sync now</button><button type="button" class="button button-quiet button-small" data-action="sync-logout">Sign out</button></div><div class="checkin-grid"><div class="field"><label for="sync-current-password">Current password</label><input class="input" id="sync-current-password" type="password" autocomplete="current-password" placeholder="Current password"></div><div class="field"><label for="sync-new-password">New password</label><input class="input" id="sync-new-password" type="password" autocomplete="new-password" minlength="10" maxlength="256" placeholder="At least 10 characters"></div></div><div class="modal-actions"><button type="button" class="button button-outline button-small" data-action="password-change">Change password</button></div>`:`<p class="field-help">${syncInfo.authMode==='register'?'Create an account with only a username and password. No email or profile details are needed.':'Sign in with your username and password. If you used RepState’s earlier email login, enter that same value as your username.'}</p><div class="checkin-grid"><div class="field"><label for="sync-username">Username</label><input class="input" id="sync-username" type="text" autocomplete="username" maxlength="254" value="${esc(syncInfo.lastUsername)}" placeholder="Choose or enter a username"></div><div class="field"><label for="sync-password">Password</label><input class="input" id="sync-password" type="password" autocomplete="${syncInfo.authMode==='register'?'new-password':'current-password'}" ${syncInfo.authMode==='register'?'minlength="10"':''} maxlength="256" placeholder="${syncInfo.authMode==='register'?'At least 10 characters':'Enter your password'}"></div></div><div class="modal-actions"><button type="button" class="button button-primary" data-action="${syncInfo.authMode==='register'?'sync-register':'sync-login'}">${syncInfo.authMode==='register'?'Create account and sync':'Sign in and sync'}</button><button type="button" class="button button-quiet button-small" data-action="sync-mode">${syncInfo.authMode==='register'?'Already have an account? Sign in':'Create an account'}</button></div>`}`;
    const form = modalRoot.querySelector('.modal-form');
    form?.querySelector('.notice-box')?.before(syncPanel);
    const localNotice = form?.querySelector('.notice-box');
    if (localNotice) localNotice.textContent = syncInfo.loggedIn ? 'A local copy stays on this device; changes also sync to your private RepState account. Keep exporting backups for extra protection.' : 'Until you sign in to private sync, workout logs and check-ins remain only in this browser. Export a backup before changing browsers or devices.';
    modalRoot.querySelector('#setting-start')?.focus();
  }
  function closeModal() { modalRoot.innerHTML=''; }
  function downloadBackup() {
    const blob=new Blob([JSON.stringify({app:'RepState',version:1,exportedAt:new Date().toISOString(),state},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`repstate-backup-${todayISO()}.json`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);showToast('Backup exported.');
  }
  function importBackup(file) {
    const reader=new FileReader();
    reader.onload=()=>{try{const data=JSON.parse(reader.result);const incoming=data.state||data;if(!incoming||typeof incoming!=='object'||!incoming.settings||typeof incoming.logs!=='object'||typeof incoming.checkins!=='object')throw Error('Unexpected backup format');state={...defaults,...incoming,settings:{...defaults.settings,...incoming.settings},ui:{...defaults.ui,...incoming.ui}};persist();closeModal();render();showToast('Backup imported.');}catch(e){showToast('That file is not a RepState backup.');}};
    reader.readAsText(file);
  }
  function sameJSON(a,b) { return JSON.stringify(a)===JSON.stringify(b); }
  function syncData(source=state) {
    return {
      settings: { ...defaults.settings, ...(source.settings||{}) },
      logs: source.logs||{}, checkins: source.checkins||{}, sessionDates: source.sessionDates||{},
      milestones: source.milestones||{}, syncMeta: source.syncMeta||{}
    };
  }
  function hasMeaningfulSyncData(data) {
    return Object.keys(data.logs||{}).length>0 || Object.keys(data.checkins||{}).length>0 ||
      Object.keys(data.sessionDates||{}).length>0 || Object.keys(data.milestones||{}).length>0 ||
      Object.keys(data.settings||{}).some(key=>data.settings[key]!==defaults.settings[key]);
  }
  function mergeSyncData(base,local,remote) {
    const merged={}, meta={};
    ['settings','logs','checkins','sessionDates','milestones'].forEach(section=>{
      const b=base?.[section]||{}, l=local?.[section]||{}, r=remote?.[section]||{};
      merged[section]={}; meta[section]={};
      new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)]).forEach(key=>{
        const lv=l[key], rv=r[key], bv=b[key];
        const lc=!sameJSON(lv,bv), rc=!sameJSON(rv,bv);
        let source;
        if(lc&&rc&&!sameJSON(lv,rv)) {
          const lt=Number(local?.syncMeta?.[section]?.[key]||0), rt=Number(remote?.syncMeta?.[section]?.[key]||0);
          source=lt===rt?(lv!==undefined?'local':'remote'):(lt>rt?'local':'remote');
        } else source=lc?'local':'remote';
        const value=source==='local'?lv:rv;
        if(value!==undefined) merged[section][key]=value;
        const stamp=Number((source==='local'?local:remote)?.syncMeta?.[section]?.[key]||0);
        if(stamp) meta[section][key]=stamp;
      });
    });
    merged.syncMeta=meta;
    return merged;
  }
  function applySyncData(data) {
    state.settings={...defaults.settings,...(data.settings||{})};
    state.logs=data.logs||{}; state.checkins=data.checkins||{}; state.sessionDates=data.sessionDates||{};
    state.milestones=data.milestones||{}; state.syncMeta=data.syncMeta||{};
    stateSnapshot=JSON.parse(JSON.stringify(state));
    localStorage.setItem(currentStorageKey(),JSON.stringify(state));
  }
  function refreshPrivacyStatus() {
    const note=document.querySelector('.privacy-note span:last-child');
    if(note) note.innerHTML=syncInfo.loggedIn?'Synced to your private account<br><small>Available on your devices</small>':'Saved on this device<br><small>Your logs stay in this browser</small>';
  }
  function accountStorageKey(username) { return `${STORAGE_KEY}_user_${encodeURIComponent(String(username).toLowerCase())}`; }
  function currentStorageKey() { return activeUsername ? accountStorageKey(activeUsername) : STORAGE_KEY; }
  function syncBaseStorageKey() { return `${currentStorageKey()}_sync_base_v1`; }
  function activateAccount(username, legacy=false) {
    const key=accountStorageKey(username), saved=localStorage.getItem(key);
    activeUsername=username;
    if(saved) state=loadState(key);
    else if(legacy) {
      state=loadState(STORAGE_KEY);
      const oldBase=localStorage.getItem(SYNC_BASE_KEY);
      if(oldBase) localStorage.setItem(`${key}_sync_base_v1`,oldBase);
      localStorage.setItem(key,JSON.stringify(state));
    } else {
      state=structuredClone(defaults);
      localStorage.setItem(key,JSON.stringify(state));
    }
    stateSnapshot=JSON.parse(JSON.stringify(state));
  }
  function queueSync() {
    if(!syncInfo.loggedIn) return;
    if(syncInfo.busy) { syncInfo.pending=true; return; }
    clearTimeout(syncInfo.timer);
    syncInfo.timer=setTimeout(()=>syncNow(false),1800);
  }
  function isWorkoutInputFocused() { return !!document.activeElement?.matches('[data-set][data-field]'); }
  async function syncNow(announce=false) {
    if(!syncInfo.loggedIn||syncInfo.busy) return;
    if(isWorkoutInputFocused()) { syncInfo.pending=true; return; }
    const revisionAtStart=localEditRevision;
    syncInfo.busy=true; syncInfo.pending=false; setSavedStatus('Syncing…',true);
    let succeeded=false;
    try {
      const response=await fetch('/api/state',{credentials:'same-origin',cache:'no-store'});
      if(response.status===401) { syncInfo.loggedIn=false; setSavedStatus('Saved locally · sign in to sync'); refreshPrivacyStatus(); return; }
      if(!response.ok) throw new Error('Sync service unavailable');
      let remote=await response.json();
      const local=syncData(state);
      let baseRecord=null;
      try { baseRecord=JSON.parse(localStorage.getItem(syncBaseStorageKey())||'null'); } catch(_) {}
      let merged;
      if(!remote.state) merged=local;
      else if(!hasMeaningfulSyncData(local)&&hasMeaningfulSyncData(remote.state)) merged=remote.state;
      else merged=mergeSyncData(baseRecord?.state||{},local,remote.state);
      if(!remote.state||!sameJSON(merged,remote.state)) {
        let put=await fetch('/api/state',{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:merged,revision:remote.revision||0})});
        if(put.status===409) {
          const conflict=await put.json();
          merged=conflict.state?mergeSyncData(baseRecord?.state||{},local,conflict.state):local;
          put=await fetch('/api/state',{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:merged,revision:conflict.revision||0})});
        }
        if(!put.ok) throw new Error('Sync update failed');
        const saved=await put.json(); remote={...remote,revision:saved.revision,updatedAt:saved.updatedAt};
      }
      const localChanged=!sameJSON(syncData(state),merged);
      if(localEditRevision!==revisionAtStart||isWorkoutInputFocused()) {
        syncInfo.pending=true;
        setSavedStatus('Saved locally · sync waiting for pause');
        if(announce) showToast('Your local entries are safe. Sync will resume when you finish editing.');
        return;
      }
      if(localChanged) { applySyncData(merged); render(); }
      localStorage.setItem(syncBaseStorageKey(),JSON.stringify({state:merged,revision:remote.revision||0}));
      setSavedStatus('Synced across devices'); succeeded=true;
      if(announce) showToast('Your tracker is synced across devices.');
    } catch(_) {
      setSavedStatus('Saved locally · sync unavailable');
      if(announce) showToast('Sync could not complete. Your local changes are still saved.');
    } finally {
      syncInfo.busy=false;
      if(syncInfo.pending&&!isWorkoutInputFocused()) { syncInfo.pending=false; queueSync(); }
      if(succeeded) refreshPrivacyStatus();
    }
  }
  async function acceptSyncLogin(result, enteredUsername) {
    syncInfo.username=result.username||enteredUsername;
    syncInfo.lastUsername=syncInfo.username;
    syncInfo.legacy=!!result.legacy;
    activateAccount(syncInfo.username,syncInfo.legacy);
    syncInfo.loggedIn=true;
    const input=document.querySelector('#sync-password'); if(input) input.value='';
    refreshPrivacyStatus(); await syncNow(true); closeModal(); openSettings();
  }
  async function loginSync() {
    const username=document.querySelector('#sync-username')?.value.trim()||'';
    const password=document.querySelector('#sync-password')?.value||'';
    if(!username||!password) { showToast('Enter your username and password.'); return; }
    setSavedStatus('Signing in…',true);
    try {
      const response=await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
      if(!response.ok) { setSavedStatus('Saved locally'); showToast(response.status===429?'Too many sign-in attempts. Wait a few minutes and try again.':'The username or password was not accepted.'); return; }
      await acceptSyncLogin(await response.json(),username);
    } catch(_) { setSavedStatus('Saved locally · sync unavailable'); showToast('Could not reach the sync service. Your local data is safe.'); }
  }
  async function registerSync() {
    const username=document.querySelector('#sync-username')?.value.trim()||'';
    const password=document.querySelector('#sync-password')?.value||'';
    if(!username||!password) { showToast('Enter a username and password to create your account.'); return; }
    if(password.length<10) { showToast('Choose a password with at least 10 characters.'); return; }
    setSavedStatus('Creating account…',true);
    try {
      const response=await fetch('/api/register',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
      if(!response.ok) {
        setSavedStatus('Saved locally');
        const message=response.status===409?'That username is already in use. Choose another or sign in.':response.status===429?'Too many account attempts. Wait a little and try again.':response.status===400?'Use 3–32 letters, numbers, dots, underscores, or hyphens for the username, and at least 10 characters for the password.':'Account creation failed. Please check the details and try again.';
        showToast(message); return;
      }
      await acceptSyncLogin(await response.json(),username);
    } catch(_) { setSavedStatus('Saved locally · sync unavailable'); showToast('Could not reach the sync service. Your local data is safe.'); }
  }
  async function changeSyncPassword() {
    const currentPassword=document.querySelector('#sync-current-password')?.value||'';
    const newPassword=document.querySelector('#sync-new-password')?.value||'';
    if(!currentPassword||!newPassword) { showToast('Enter your current password and a new password.'); return; }
    if(newPassword.length<10) { showToast('Choose a password with at least 10 characters.'); return; }
    setSavedStatus('Updating password…',true);
    try {
      const response=await fetch('/api/password',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword,newPassword})});
      if(!response.ok) { setSavedStatus('Saved locally'); showToast(response.status===401?'The current password was not accepted.':response.status===429?'Too many attempts. Wait a little and try again.':'The new password must be at least 10 characters.'); return; }
      showToast('Password changed. This device remains signed in.'); openSettings();
    } catch(_) { setSavedStatus('Saved locally · sync unavailable'); showToast('Could not reach the sync service.'); }
  }
  async function logoutSync() {
    try { await fetch('/api/logout',{method:'POST',credentials:'same-origin'}); } catch(_) {}
    syncInfo.loggedIn=false; syncInfo.username=''; syncInfo.authMode='login'; setSavedStatus('Saved locally'); refreshPrivacyStatus();
    closeModal(); openSettings(); showToast('Sync signed out. Your local data remains on this device.');
  }
  async function restoreSyncSession() {
    try {
      const response=await fetch('/api/session',{credentials:'same-origin',cache:'no-store'});
      if(!response.ok) return;
      const result=await response.json();
      if(result.authenticated) { syncInfo.username=result.username||''; syncInfo.lastUsername=syncInfo.username; syncInfo.legacy=!!result.legacy; activateAccount(syncInfo.username,syncInfo.legacy); syncInfo.loggedIn=true; refreshPrivacyStatus(); await syncNow(false); }
    } catch(_) { /* Local-only use remains available if the service is offline. */ }
  }
  function clickAction(target, clickedTarget=target) {
    const action=target.dataset.action;
    if(!action) return;
    if(action==='settings') return openSettings();
    if(action==='sync-login') return loginSync();
    if(action==='sync-register') return registerSync();
    if(action==='sync-mode') { syncInfo.authMode=syncInfo.authMode==='login'?'register':'login'; return openSettings(); }
    if(action==='password-change') return changeSyncPassword();
    if(action==='sync-now') return syncNow(true);
    if(action==='sync-logout') return logoutSync();
    if(action==='close-modal') { if(clickedTarget===target || clickedTarget.closest('.modal-close')) closeModal(); return; }
    if(action==='export') return downloadBackup();
    if(action==='import') return document.querySelector('#backup-file')?.click();
    if(action==='toggle-exercise') { state.ui.openExercise=state.ui.openExercise===target.dataset.id?null:target.dataset.id; return render(); }
    if(action==='toggle-skip') {
      const id=target.dataset.id,entry=state.logs[id]||{status:'Planned',sets:[]};
      if(loggedSetCount(entry)) return;
      state.logs[id]={...entry,status:statusOf(id)==='Skipped'?'Planned':'Skipped'};persist();render();return;
    }
    if(action==='current-week') {state.ui.week=currentWeek();state.ui.day='all';persist();render();return;}
    if(action==='toggle-quick-log') {state.ui.quickLog=state.ui.quickLog===false;state.ui.openExercise=null;persist();render();return;}
    if(action==='copy-last-session') {
      const w=Number(target.dataset.week),day=target.dataset.day;let copied=0;
      weekRows(w).filter(row=>row.day===day).forEach(row=>{
        const current=state.logs[row.id]||{status:'Planned',sets:[]};if(loggedSetCount(current)>0)return;
        const previous=previousLoggedRow(row,w);if(!previous)return;
        const source=state.logs[previous.id]?.sets||[];if(!source.length)return;
        const rx=getPrescription(row,w),count=maxSets(rx.sets);
        const sets=Array.from({length:count},(_,i)=>({...((source[i]&&Object.keys(source[i]).length)?source[i]:source[source.length-1])}));
        state.logs[row.id]={...current,sets};copied++;
      });
      persist();render();showToast(copied?`Copied numbers for ${copied} exercise${copied===1?'':'s'}. Review and adjust today’s sets.`:'No previous set numbers found.');return;
    }
    if(action==='mark-day') {const w=Number(target.dataset.week),day=target.dataset.day;weekRows(w).filter(r=>r.day===day).forEach(r=>state.logs[r.id]={...(state.logs[r.id]||{}),status:'Done'});persist();render();showToast('Day marked complete. Add set details when ready.');return;}
    if(action==='toggle-milestone') {const k=`w${target.dataset.week}`;state.milestones[k]=!state.milestones[k];persist();render();return;}
    if(action==='reset') {if(confirm('Clear all RepState workouts, check-ins, and settings from this browser? This cannot be undone unless you have a backup.')){localStorage.removeItem(currentStorageKey());localStorage.removeItem(syncBaseStorageKey());state=structuredClone(defaults);stateSnapshot=JSON.parse(JSON.stringify(state));closeModal();render();showToast('Local data cleared.');}return;}
  }
  document.addEventListener('click', e=>{
    const pageButton=e.target.closest('[data-page]');
    if(pageButton){const page=pageButton.dataset.page;if(page){state.ui.page=page;state.ui.day='all';persist();document.querySelector('#sidebar')?.classList.remove('open');render();window.scrollTo({top:0,behavior:'smooth'});}return;}
    const action=e.target.closest('[data-action]');if(action){clickAction(action,e.target);return;}
    const day=e.target.closest('[data-day]');if(day){state.ui.day=day.dataset.day;persist();render();return;}
    if(e.target.id==='mobile-menu'){document.querySelector('#sidebar')?.classList.toggle('open');return;}
  });
  document.addEventListener('input', e=>{
    const el=e.target;
    if(!el.matches('[data-set][data-field]'))return;
    const card=el.closest('.exercise-card'),id=card?.dataset.card,index=Number(el.dataset.set),field=el.dataset.field;
    if(!id||!['load','reps','rir'].includes(field))return;
    const entry=state.logs[id]||{status:'Planned',sets:[]};
    const sets=[...(entry.sets||[])];sets[index]={...(sets[index]||{}),[field]:el.value};
    const updated={...entry,sets};
    const row=program.exercises.find(exercise=>exercise.id===id);
    const status=loggedSetCount(updated)?(row?automaticExerciseStatus(row,updated):'Partial'):'Planned';
    state.logs[id]={...entry,status,sets};
    const pill=card.querySelector('.status-pill');if(pill){pill.textContent=status;pill.className=`status-pill ${status}`;}
    const skip=card.querySelector('[data-action="toggle-skip"]');
    if(skip){skip.hidden=!!loggedSetCount(updated)||!['Planned','Skipped'].includes(status);skip.textContent=status==='Skipped'?'Undo skip':'Skip';}
    persist();
  });
  document.addEventListener('focusout', e=>{
    if(!e.target.matches('[data-set][data-field]'))return;
    setTimeout(()=>{if(!isWorkoutInputFocused()&&syncInfo.pending){syncInfo.pending=false;queueSync();}},0);
  });
  document.addEventListener('change', e=>{
    const el=e.target;
    if(el.id==='week-select'){state.ui.week=Number(el.value);state.ui.day='all';persist();render();return;}
    if(el.id==='strength-exercise'){state.ui.strengthExercise=el.value;persist();render();return;}
    if(el.dataset.change==='session-date'){state.sessionDates[`${el.dataset.week}|${el.dataset.day}`]=el.value;persist();showToast('Session date saved.');return;}
    if(el.id==='backup-file'&&el.files?.[0]){importBackup(el.files[0]);el.value='';}
  });
  document.addEventListener('submit', e=>{
    if(e.target.id==='settings-form'){
      e.preventDefault();const f=new FormData(e.target);
      state.settings={...state.settings,startDate:String(f.get('startDate')||''),loadUnit:String(f.get('loadUnit')||'kg'),bodyUnit:String(f.get('bodyUnit')||'kg'),phase:String(f.get('phase')||'Bulk')};
      state.ui.week=null;persist();closeModal();render();showToast('Cycle settings saved.');return;
    }
    if(e.target.id==='checkin-form'){
      e.preventDefault();const f=new FormData(e.target),w=Number(f.get('week'));
      const check={};['weight','waist','calories','protein','fat','sleep','steps','creatine','cardio'].forEach(k=>check[k]=String(f.get(k)||''));
      check.phase=String(f.get('phase')||'Bulk');check.notes=String(f.get('notes')||'');check.updatedAt=new Date().toISOString();
      state.checkins[w]=check;state.settings.phase=check.phase;persist();render();showToast(`Week ${w} check-in saved.`);return;
    }
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Enter'&&e.target.id==='sync-password'){e.preventDefault();syncInfo.authMode==='register'?registerSync():loginSync();return;}
    if(e.key==='Enter'&&e.target.id==='sync-new-password'){e.preventDefault();changeSyncPassword();return;}
    if(e.key==='Enter'&&e.target.matches('[data-set][data-field]')){
      e.preventDefault();const fields=[...document.querySelectorAll('.exercise-list [data-set][data-field]')];
      const next=fields[fields.indexOf(e.target)+1];if(next)next.focus();else document.querySelector('[data-action=mark-day]')?.focus();return;
    }
    if(e.key==='Escape'&&modalRoot.innerHTML)closeModal();
  });
  async function boot(){
    try{
      const response=await fetch('/program.json',{cache:'no-store'});
      if(!response.ok)throw new Error('Program data not available');
      program=await response.json();
      program.exercises.forEach((r,i)=>r.id=`${r.week}:${i}`);
      state.ui.week=state.ui.week||currentWeek();
      render();
      await restoreSyncSession();
      window.setInterval(()=>{if(syncInfo.loggedIn&&!document.hidden)syncNow(false);},30000);
      window.addEventListener('focus',()=>{if(syncInfo.loggedIn)syncNow(false);});
      document.addEventListener('visibilitychange',()=>{if(syncInfo.loggedIn&&!document.hidden)syncNow(false);});
    }catch(error){app.innerHTML=`<section class="panel"><h1 class="panel-title">Couldn’t load the program</h1><p class="page-subtitle">Refresh this page to retry. ${esc(error.message)}</p></section>`;}
  }
  boot();
})();
