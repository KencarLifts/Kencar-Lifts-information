(() => {
  'use strict';

  const DB = {
    elevators: 'elevators',
    users: 'users',
    activity: 'activity',
    orders: 'orders',
    installations: 'installations',
    maintenance: 'maintenance'
  };
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  const store = Object.fromEntries(Object.values(DB).map(key => [key, []]));
  const versions = Object.fromEntries(Object.values(DB).map(key => [key, 0]));
  const writeQueues = {};
  const pendingWrites = {};
  let csrfToken = '';
  let lastSessionTouch = 0;
  let syncTimer = null;

  const elevatorSections = [
    { title: 'Identification & Location', fields: [
      ['factoryNO','FactoryNO','text',true], ['address','Address','text'], ['gpsLongitude','GPS longitude','number'], ['gpsLatitude','GPS latitude','number'],
      ['location','Location','text'], ['inUsedYear','In-used year','number'], ['elevatorModel','Elevator model','text'], ['elevatorType','Elevator type','select',false,['Passenger','Freight','Hospital','Panoramic','Home','Escalator','Other']],
      ['floorStationDoor','Floor / station / door','text'], ['iotCode','IoT code','text'], ['remoteCall','Remote call','url'], ['elevatorStatus','Elevator Status','select',true,['Online','Offline']]
    ]},
    { title: 'Technical Parameters', fields: [
      ['ratedLoadKg','Rated load [kg]','number'], ['ratedSpeedMs','Rated speed [m/s]','number'], ['shaftWidth','Shaft width [mm]','number'], ['shaftDepth','Shaft depth [mm]','number'],
      ['cabinWidth','Cabin width [mm]','number'], ['cabinDepth','Cabin depth [mm]','number'], ['pitDepth','Pit depth [mm]','number'], ['overhead','Overhead [mm]','number'],
      ['travelDistance','Travel distance [m]','number'], ['ratedPowerKw','Rated power [kW]','number'], ['doorWidthMm','Door width [mm]','number']
    ]},
    { title: 'Certification & Inspection', fields: [
      ['fullCertificateDate','Full elevator certificate date','date'], ['certificateNumber','Certificate number','text'], ['inspectionOrganization','Inspection organization','text'],
      ['useOccasion','Use occasion','text'], ['useType','Use type','select',true,['Commercial','Domestic']], ['lastAnnualInspectionDate','Last annual inspection date','date'], ['nextAnnualInspectionDate','Next annual inspection date','date']
    ]},
    { title: 'Manufacturing, Order & Installation', fields: [
      ['manufacturerName','Manufacturer name','text'], ['scheduleInstallTime','Schedule install time','date'], ['installationEndDate','Installation end date','date'], ['commissioningDate','Commissioning date','date'],
      ['handoverDate','Handover date','date'], ['quotationNumber','Quotation number','text'], ['contractNumber','Contract number','text'], ['orderDate','Order date','date'],
      ['productionScheduleTime','Production schedule time','date']
    ]},
    { title: 'Maintenance & Property', fields: [
      ['firstUpkeepDate','First upkeep date','date'], ['propertyContact','Property contact','text'], ['servicesPerYear','Services per year','number'],
      ['lastMaintenanceContractDate','Last maintenance contract date','date']
    ]},
    { title: 'Audit', fields: [
      ['lastUpdatePerson','LastUpdatePerson','text'], ['lastUpdateTime','LastUpdateTime','datetime-local']
    ]}
  ];

  const isTechnician = () => currentUser?.role === 'Technician';
  const isManagerOrAdministrator = () => currentUser?.role === 'Manager' || currentUser?.role === 'Administrator';
  const canViewAssignedMaintenanceRecord = () => true;
  const canEditPage = page => !isTechnician() || page === 'maintenance';
  const technicianHiddenPages = new Set(['orders','installation','users','activity']);
  function canAccessRemoteCall() {
    if (!currentUser) return false;
    if (currentUser.role === 'Administrator' || currentUser.role === 'Manager') return true;
    if (currentUser.role !== 'Technician') return false;
    return Boolean(read(DB.users).find(u => u.id === currentUser.id)?.remoteCallAccess);
  }
  const canViewPage = page => page === 'remote' ? canAccessRemoteCall() : !(isTechnician() && technicianHiddenPages.has(page));
  function applyRoleNavigation() {
    $$('.nav-item[data-page]').forEach(item => { item.hidden = !canViewPage(item.dataset.page); });
    const remoteMenuControl = $('#remoteMenuControl');
    if (remoteMenuControl) remoteMenuControl.classList.toggle('hidden', !canAccessRemoteCall());
  }

  const pageMeta = {
    dashboard: ['Dashboard','Fleet overview and operational status'],
    elevators: ['Elevators','Manage elevator master data'],
    orders: ['Order Process','Quotation, contract, order and production tracking'],
    installation: ['Installation','Installation milestones and commissioning'],
    maintenance: ['Maintenance & Service','Service records, inspections and upcoming generated jobs'],
    remote: ['Remote Call','Open the configured remote interface for an elevator'],
    users: ['User Management','Accounts, roles and approvals'],
    activity: ['Activity Log','Security and change history']
  };

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const nowIso = () => new Date().toISOString();
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmtDate = v => v ? new Intl.DateTimeFormat('en-GB',{year:'numeric',month:'short',day:'2-digit'}).format(new Date(v)) : '—';
  const fmtDateTime = v => v ? new Intl.DateTimeFormat('en-GB',{year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(v)) : '—';
  const clone = value => JSON.parse(JSON.stringify(value));
  const read = (key, fallback=[]) => store[key] ?? fallback;

  async function api(path, options={}) {
    const opts={credentials:'same-origin',cache:'no-store',...options,headers:{...(options.headers||{})}};
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type']='application/json';
      opts.body=JSON.stringify(opts.body);
    }
    if (opts.method && !['GET','HEAD'].includes(opts.method.toUpperCase()) && csrfToken) opts.headers['X-CSRF-Token']=csrfToken;
    const response=await fetch(path,opts);
    let body={};
    try { body=await response.json(); } catch {}
    if (!response.ok) {
      const error=new Error(body.error||`Request failed (${response.status})`);
      error.status=response.status; error.payload=body; throw error;
    }
    return body;
  }

  function sanitizeUsersForCache(users) {
    return (users||[]).map(({password,...u})=>u);
  }

  function write(key, value) {
    const outgoing=clone(value);
    store[key]=key===DB.users ? sanitizeUsersForCache(outgoing) : clone(outgoing);
    if (!currentUser || key===DB.activity) return Promise.resolve();
    pendingWrites[key]=(pendingWrites[key]||0)+1;
    const previous=writeQueues[key]||Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      try {
        const result=await api(`/api/state/${encodeURIComponent(key)}`,{method:'PUT',body:{data:outgoing,expectedVersion:versions[key]||0}});
        versions[key]=result.version;
        store[key]=key===DB.users ? sanitizeUsersForCache(result.data||[]) : clone(result.data||[]);
      } catch (err) {
        if (err.status===409 && err.payload) {
          versions[key]=err.payload.version||versions[key];
          store[key]=key===DB.users ? sanitizeUsersForCache(err.payload.data||[]) : clone(err.payload.data||[]);
          toast(err.message,'error');
          renderCurrentPage();
        } else if (err.status===401) {
          forceLoggedOut('Session expired. Please sign in again.');
        } else {
          toast(err.message||'Server update failed.','error');
        }
      } finally {
        pendingWrites[key]=Math.max(0,(pendingWrites[key]||1)-1);
      }
    });
    writeQueues[key]=task;
    return task;
  }

  async function loadServerState({render=false}={}) {
    const result=await api('/api/state');
    let changed=false;
    for (const [key,data] of Object.entries(result.datasets||{})) {
      if (!(key in store) || (pendingWrites[key]||0)>0) continue;
      const next=key===DB.users ? sanitizeUsersForCache(data||[]) : clone(data||[]);
      if (JSON.stringify(store[key])!==JSON.stringify(next)) { store[key]=next; changed=true; }
      if (result.versions && key in result.versions) versions[key]=result.versions[key];
    }
    if (render && changed) renderCurrentPage();
    return result;
  }

  function renderCurrentPage() {
    if (!currentUser || $('#appView').classList.contains('hidden')) return;
    applyRoleNavigation();
    const page=document.querySelector('.page.active')?.id?.replace('page-','')||'dashboard';
    if (page==='dashboard') renderDashboard();
    else if (page==='elevators') renderElevators();
    else if (page==='orders') renderWorkflow('orders');
    else if (page==='installation') renderWorkflow('installation');
    else if (page==='maintenance') renderWorkflow('maintenance');
    else if (page==='remote') {
      const elevators=read(DB.elevators).slice().sort((a,b)=>String(a.factoryNO||'').localeCompare(String(b.factoryNO||'')));
      const selected=elevators.find(e=>e.id===selectedRemoteElevatorId)||null;
      renderRemoteMenuControl(elevators,selected,normalizeRemoteCallUrl(selected?.remoteCall));
    }
    else if (page==='users') renderUsers();
    else if (page==='activity') renderActivity();
  }

  const canViewElevatorCode = () => currentUser && (currentUser.role === 'Administrator' || currentUser.role === 'Manager');
  function calculateElevatorCode(factoryNO) {
    const digits = String(factoryNO ?? '').replace(/\D/g, '');
    if (digits.length < 5) return '';
    const firstTwo = Number(digits.slice(0, 2));
    const lastThree = Number(digits.slice(-3));
    return String(2000 + firstTwo + lastThree);
  }
  function parseDateOnly(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
    const [y,m,d] = String(value).split('-').map(Number);
    const date = new Date(Date.UTC(y,m-1,d));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  function toDateOnly(date) {
    return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0,10) : '';
  }
  function addCalendarMonths(value, months) {
    const source = parseDateOnly(value); if (!source) return '';
    const day = source.getUTCDate();
    const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return toDateOnly(target);
  }
  function addCalendarDays(value, days) {
    const date = parseDateOnly(value); if (!date) return '';
    date.setUTCDate(date.getUTCDate() + days);
    return toDateOnly(date);
  }
  function calculateNextInspectionDate(lastDate, useType) {
    if (!lastDate || !useType) return '';
    if (useType === 'Commercial') return addCalendarMonths(lastDate, 6);
    if (useType === 'Domestic') return addCalendarMonths(lastDate, 12);
    return '';
  }
  function calculateNextServiceDate(baseDate, servicesPerYear) {
    const n = Number(servicesPerYear);
    if (!baseDate || !Number.isFinite(n) || n <= 0) return '';
    const months = 12 / n;
    if (Number.isInteger(months)) return addCalendarMonths(baseDate, months);
    return addCalendarDays(baseDate, Math.round(365.2425 / n));
  }
  function latestDateValue(...values) {
    return values.filter(v => parseDateOnly(v)).sort().at(-1) || '';
  }
  function preventiveMaintenanceBase(elevator, maintenanceRecords=[]) {
    const latestServiceDate = maintenanceRecords
      .filter(m => m.elevatorId === elevator?.id && parseDateOnly(m.serviceDate) && (!m.sourceJobId || m.result === 'Completed'))
      .map(m => m.serviceDate)
      .sort()
      .at(-1) || '';
    const contractDate = parseDateOnly(elevator?.lastMaintenanceContractDate) ? elevator.lastMaintenanceContractDate : '';
    const date = latestDateValue(latestServiceDate, contractDate);
    const source = date && date === latestServiceDate && date === contractDate
      ? 'Latest Service date / Last maintenance contract date'
      : date === latestServiceDate
        ? 'Latest Service date'
        : date === contractDate
          ? 'Last maintenance contract date'
          : '';
    return { date, source, latestServiceDate, contractDate };
  }
  function daysFromToday(dateValue) {
    const due = parseDateOnly(dateValue); if (!due) return null;
    const now = new Date();
    const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    return Math.round((due - today) / 86400000);
  }
  function jobStatus(dueDate) {
    const days = daysFromToday(dueDate);
    if (days === null) return 'Scheduled';
    if (days < 0) return 'Overdue';
    if (days === 0) return 'Due Today';
    if (days <= 30) return 'Due Soon';
    return 'Scheduled';
  }

  let currentUser = null;
  let deferredInstallPrompt = null;
  let sessionDeadline = 0;
  let sessionTimer = null;
  let selectedRemoteElevatorId = '';

  function logActivity(action, target='', detail='') {
    if (!currentUser) return;
    const logs = read(DB.activity);
    logs.unshift({id:uid('log'),time:nowIso(),user:currentUser.name,role:currentUser.role,action,target,detail});
    store[DB.activity]=logs.slice(0,1000);
    api('/api/activity',{method:'POST',body:{action,target,detail}}).catch(err=>{
      if (err.status===401) forceLoggedOut('Session expired. Please sign in again.');
    });
  }

  function toast(message, type='success') {
    const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = message;
    $('#toastRegion').appendChild(el); setTimeout(() => el.remove(), 3200);
  }

  function startSession(expiresAt=Date.now()+SESSION_TIMEOUT_MS) {
    sessionDeadline = Number(expiresAt)||Date.now()+SESSION_TIMEOUT_MS;
    clearInterval(sessionTimer);
    sessionTimer = setInterval(() => {
      const left = sessionDeadline - Date.now();
      if (left <= 0) return forceLoggedOut('Session expired due to inactivity.');
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      $('#sessionRemaining').textContent = `${m}:${String(s).padStart(2,'0')}`;
    }, 1000);
  }

  function refreshSession() {
    if (!currentUser) return;
    const now=Date.now();
    sessionDeadline = now + SESSION_TIMEOUT_MS;
    if (now-lastSessionTouch<60_000) return;
    lastSessionTouch=now;
    api('/api/session/touch',{method:'POST',body:{}}).then(result=>{
      if(result.expiresAt) sessionDeadline=result.expiresAt;
    }).catch(err=>{
      if(err.status===401) forceLoggedOut('Session expired. Please sign in again.');
    });
  }

  async function tryRestoreSession() {
    try {
      const session=await api('/api/session');
      if (!session.authenticated) return false;
      currentUser=session.user; csrfToken=session.csrfToken||''; sessionDeadline=session.expiresAt||Date.now()+SESSION_TIMEOUT_MS;
      await loadServerState();
      showApp(); startSession(sessionDeadline); startSharedSync();
      return true;
    } catch { return false; }
  }

  async function login(email, password) {
    $('#loginError').textContent='';
    try {
      const result=await api('/api/login',{method:'POST',body:{email,password}});
      currentUser=result.user; csrfToken=result.csrfToken||''; sessionDeadline=result.expiresAt||Date.now()+SESSION_TIMEOUT_MS;
      await loadServerState();
      showApp(); startSession(sessionDeadline); startSharedSync();
    } catch(err) {
      $('#loginError').textContent=err.message||'Unable to sign in.';
    }
  }

  function stopSharedSync(){ if(syncTimer){clearInterval(syncTimer);syncTimer=null;} }
  function startSharedSync(){
    stopSharedSync();
    syncTimer=setInterval(()=>{if(currentUser)loadServerState({render:true}).catch(err=>{if(err.status===401)forceLoggedOut('Session expired. Please sign in again.');});},4000);
  }

  function forceLoggedOut(message='Signed out.') {
    currentUser=null; csrfToken=''; clearInterval(sessionTimer); sessionTimer=null; stopSharedSync();
    Object.keys(store).forEach(k=>store[k]=[]);
    $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden');
    if(message)toast(message,message.toLowerCase().includes('expired')?'error':'success');
  }

  async function logout(message='Signed out.') {
    try { if(currentUser) await api('/api/logout',{method:'POST',body:{}}); } catch {}
    forceLoggedOut(message);
  }

  function showApp() {
    $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
    $('#currentUserName').textContent = currentUser.name;
    $('#currentUserRole').textContent = currentUser.role;
    $('#userAvatar').textContent = currentUser.name.slice(0,1).toUpperCase();
    applyRoleNavigation();
    renderAll(); showPage('dashboard');
  }

  function showPage(page) {
    if (!pageMeta[page] || !canViewPage(page)) page = 'dashboard';
    $$('.page').forEach(p => p.classList.remove('active'));
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
    const target = $(`#page-${page}`);
    if (!target) return;
    target.classList.add('active');
    $('#pageTitle').textContent = pageMeta[page][0]; $('#pageSubtitle').textContent = pageMeta[page][1];
    $('#sidebar').classList.remove('open');
    if (page === 'dashboard') renderDashboard();
    if (page === 'elevators') renderElevators();
    if (page === 'orders') renderWorkflow('orders');
    if (page === 'installation') renderWorkflow('installation');
    if (page === 'maintenance') renderWorkflow('maintenance');
    if (page === 'remote') renderRemoteCall();
    if (page === 'users') renderUsers();
    if (page === 'activity') renderActivity();
  }

  function renderAll() {
    renderDashboard();
    renderElevators();
    renderWorkflow('maintenance');
    if (canAccessRemoteCall()) renderRemoteCall(); else if ($('#page-remote')) $('#page-remote').innerHTML='';
    if (!isTechnician()) {
      renderWorkflow('orders');
      renderWorkflow('installation');
      renderUsers();
      renderActivity();
    } else {
      if ($('#page-orders')) $('#page-orders').innerHTML = '';
      if ($('#page-installation')) $('#page-installation').innerHTML = '';
      if ($('#page-users')) $('#page-users').innerHTML = '';
      if ($('#page-activity')) $('#page-activity').innerHTML = '';
    }
  }

  function renderDashboard() {
    const elevators = read(DB.elevators), online = elevators.filter(e => e.elevatorStatus === 'Online').length, offline = elevators.length - online;
    const inspectionsDue = elevators.filter(e => { const due=calculateNextInspectionDate(e.lastAnnualInspectionDate,e.useType)||e.nextAnnualInspectionDate; return due && new Date(due) <= new Date(Date.now()+90*86400000); }).length;
    const maint = buildNextJobs().filter(j => j.type==='Preventive maintenance' && daysFromToday(j.dueDate) >= 0).slice(0,5);
    const elevatorById = Object.fromEntries(elevators.map(e=>[e.id,e]));
    $('#page-dashboard').innerHTML = `
      <div class="grid stats-grid">
        ${statCard('Total Elevators',elevators.length,'↕')}${statCard('Online',online,'●')}${statCard('Offline',offline,'○')}
      </div>
      <div class="grid dashboard-grid">
        <div class="card"><div class="card-head"><div><h3>Fleet Status</h3><p>Current connectivity and inspection overview</p></div><button class="btn ghost small" data-goto="elevators">View fleet</button></div>
          <div class="kpi-small"><div class="mini"><span>Availability</span><b>${elevators.length ? Math.round(online/elevators.length*100) : 0}%</b></div><div class="mini"><span>Online</span><b>${online}</b></div><div class="mini"><span>Offline</span><b>${offline}</b></div><div class="mini"><span>Inspection ≤ 90d</span><b>${inspectionsDue}</b></div></div>
          <div class="table-wrap"><table><thead><tr><th>Factory No.</th><th>Location</th><th>Model</th><th>Status</th><th>Next Inspection</th></tr></thead><tbody>${elevators.slice(0,7).map(e=>`<tr><td><b>${esc(e.factoryNO)}</b></td><td>${esc(e.location||e.address||'—')}</td><td>${esc(e.elevatorModel||'—')}</td><td>${statusBadge(e.elevatorStatus)}</td><td>${fmtDate(calculateNextInspectionDate(e.lastAnnualInspectionDate,e.useType)||e.nextAnnualInspectionDate)}</td></tr>`).join('') || `<tr><td colspan="5"><div class="empty">No elevators yet.</div></td></tr>`}</tbody></table></div>
        </div>
        <div class="card"><div class="card-head"><div><h3>Upcoming Service</h3><p>Next planned maintenance visits</p></div></div>
          <div class="timeline">${maint.length ? maint.map(m=>`<div class="timeline-item"><div class="timeline-dot"></div><div class="timeline-content"><b>${esc(elevatorById[m.elevatorId]?.factoryNO||'Unknown elevator')}</b><p>${fmtDate(m.dueDate)} · Preventive maintenance</p></div></div>`).join('') : `<div class="empty"><strong>No upcoming service</strong>Add a service record and set Services per year on the elevator.</div>`}</div>
        </div>
      </div>`;
  }
  function statCard(label,value,icon){return `<div class="stat-card"><div><div class="label">${label}</div><div class="value">${value}</div></div><div class="stat-icon">${icon}</div></div>`}
  function statusBadge(s='Offline'){ const cls = s.toLowerCase().replace(/\s+/g,'-'); return `<span class="status ${cls}">${esc(s)}</span>`; }

  function renderElevators() {
    const readOnly = !canEditPage('elevators');
    $('#page-elevators').innerHTML = `
      ${readOnly?'<div class="readonly-note">Technician access: elevator master data is view-only. Maintenance & Service is the only editable page.</div>':''}
      <div class="toolbar">
        <div class="search"><input id="elevatorSearch" type="search" placeholder="Search factory no., address, location, model, IoT code…" /></div>
        <select id="statusFilter"><option value="">All statuses</option><option>Online</option><option>Offline</option></select>
        <div class="spacer"></div>
        ${isTechnician()?'':'<button id="exportBtn" class="btn ghost">⇩ Export JSON</button>'}
        ${readOnly?'':`<button id="importBtn" class="btn ghost">⇧ Import JSON</button><button id="addElevatorBtn" class="btn primary">＋ Add Elevator</button>`}
      </div>
      <div id="elevatorTable"></div>`;
    $('#elevatorSearch').addEventListener('input', drawElevatorTable); $('#statusFilter').addEventListener('change', drawElevatorTable);
    if ($('#addElevatorBtn')) $('#addElevatorBtn').addEventListener('click', () => openElevatorModal());
    if ($('#importBtn')) $('#importBtn').addEventListener('click', () => $('#jsonFileInput').click());
    if ($('#exportBtn')) $('#exportBtn').addEventListener('click', exportElevators);
    drawElevatorTable();
  }

  function drawElevatorTable() {
    const q = ($('#elevatorSearch')?.value || '').toLowerCase(), status = $('#statusFilter')?.value || '';
    let elevators = read(DB.elevators).filter(e => {
      if (status && e.elevatorStatus !== status) return false;
      if (!q) return true;
      const searchableValues = Object.entries(e).filter(([key])=>!isTechnician() || key!=='remoteCall').map(([,value])=>value);
      const searchable = searchableValues.some(v => String(v??'').toLowerCase().includes(q));
      return searchable || (canViewElevatorCode() && calculateElevatorCode(e.factoryNO).toLowerCase().includes(q));
    });
    const showCode = canViewElevatorCode();
    const columnCount = showCode ? 9 : 8;
    $('#elevatorTable').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Factory No.</th>${showCode?'<th>Elevator Code</th>':''}<th>Location</th><th>Use Type</th><th>Type / Model</th><th>IoT Code</th><th>Status</th><th>Last Update</th><th>Actions</th></tr></thead><tbody>${elevators.map(e=>`
      <tr><td><b>${esc(e.factoryNO)}</b><div class="muted">${esc(e.address||'')}</div></td>${showCode?`<td><b>${esc(calculateElevatorCode(e.factoryNO)||'—')}</b></td>`:''}<td>${esc(e.location||'—')}</td><td>${esc(e.useType||'—')}</td><td>${esc(e.elevatorType||'—')}<div class="muted">${esc(e.elevatorModel||'')}</div></td><td>${esc(e.iotCode||'—')}</td><td>${statusBadge(e.elevatorStatus)}${canEditPage('elevators')?`<br><button class="btn ghost small" data-toggle-status="${e.id}" style="margin-top:5px">Toggle</button>`:''}</td><td>${fmtDateTime(e.lastUpdateTime)}</td><td><div class="actions"><button class="btn ghost small" data-edit-elevator="${e.id}">${canEditPage('elevators')?'Edit':'View'}</button>${canEditPage('elevators')?`<button class="btn danger small" data-delete-elevator="${e.id}">Delete</button>`:''}</div></td></tr>`).join('') || `<tr><td colspan="${columnCount}"><div class="empty"><strong>No matching elevators</strong>Change the search/filter${canEditPage('elevators')?' or add a new elevator':''}.</div></td></tr>`}</tbody></table></div>`;
  }

  function fieldHtml(field, value, canEdit=true) {
    const [key,label,type,required,options] = field;
    const disabled = canEdit ? '' : 'disabled'; const req = required ? 'required' : '';
    if (type === 'select') return `<label class="${required?'required':''}">${esc(label)}<select name="${key}" ${req} ${disabled}>${options.map(o=>`<option ${String(value??'')===o?'selected':''}>${esc(o)}</option>`).join('')}</select></label>`;
    return `<label class="${required?'required':''}">${esc(label)}<input name="${key}" type="${type}" value="${esc(value??'')}" ${req} ${disabled} ${type==='number'?'step="any"':''}/></label>`;
  }

  function openElevatorModal(id=null) {
    const elevators = read(DB.elevators), existing = elevators.find(e=>e.id===id) || {elevatorStatus:'Online'};
    const readOnly = !canEditPage('elevators');
    if (readOnly && !id) return toast('Technicians cannot add elevator records.','error');
    openModal(readOnly?'View Elevator':(id?'Edit Elevator':'Add Elevator'), id?existing.factoryNO:'Create a new elevator record', `
      ${readOnly ? '<div class="readonly-note">Technician access: elevator master data is view-only. Make service changes from Maintenance & Service.</div>' : ''}
      <form id="elevatorForm">${elevatorSections.map(sec=>`<div class="form-section"><h4>${sec.title}</h4><div class="form-grid">${sec.fields.map(f=>{
        if (f[0] === 'remoteCall' && isTechnician()) return '';
        let val = existing[f[0]]; if (!readOnly && f[0]==='lastUpdatePerson') val = currentUser.name; if (!readOnly && f[0]==='lastUpdateTime') val = new Date().toISOString().slice(0,16);
        if (f[0]==='nextAnnualInspectionDate') val = calculateNextInspectionDate(existing.lastAnnualInspectionDate, existing.useType) || existing.nextAnnualInspectionDate || '';
        const canEdit = !readOnly && f[0] !== 'nextAnnualInspectionDate';
        const baseField = fieldHtml(f,val,canEdit);
        if (f[0] === 'factoryNO' && canViewElevatorCode()) {
          return `${baseField}<label>Elevator Code<input id="elevatorCodeField" type="text" value="${esc(calculateElevatorCode(val))}" readonly disabled/><span class="muted">Calculated as 2000 + first 2 digits + last 3 digits of FactoryNO.</span></label>`;
        }
        if (f[0] === 'nextAnnualInspectionDate') return `<label>Next annual inspection date<input name="nextAnnualInspectionDate" type="date" value="${esc(val)}" readonly disabled><span class="muted">Automatically calculated: Commercial = +6 months; Domestic = +12 months.</span></label>`;
        return baseField;
      }).join('')}</div></div>`).join('')}</form>`,
      readOnly ? `<button class="btn primary" data-modal-cancel>Close</button>` : `<button class="btn ghost" data-modal-cancel>Cancel</button><button class="btn primary" id="saveElevatorBtn">${id?'Save Changes':'Add Elevator'}</button>`);
    if (readOnly) return;
    if (canViewElevatorCode()) {
      const factoryInput = $('#elevatorForm [name="factoryNO"]');
      const codeInput = $('#elevatorCodeField');
      if (factoryInput && codeInput) factoryInput.addEventListener('input', () => { codeInput.value = calculateElevatorCode(factoryInput.value); });
    }
    const lastInspectionInput = $('#elevatorForm [name="lastAnnualInspectionDate"]');
    const useTypeInput = $('#elevatorForm [name="useType"]');
    const nextInspectionInput = $('#elevatorForm [name="nextAnnualInspectionDate"]');
    const refreshNextInspection = () => { if(nextInspectionInput) nextInspectionInput.value = calculateNextInspectionDate(lastInspectionInput?.value, useTypeInput?.value); };
    if(lastInspectionInput) lastInspectionInput.addEventListener('change', refreshNextInspection);
    if(useTypeInput) useTypeInput.addEventListener('change', refreshNextInspection);
    $('#saveElevatorBtn').addEventListener('click', () => {
      const form = $('#elevatorForm'); if (!form.reportValidity()) return;
      const data = Object.fromEntries(new FormData(form).entries());
      data.nextAnnualInspectionDate = calculateNextInspectionDate(data.lastAnnualInspectionDate || existing.lastAnnualInspectionDate, data.useType || existing.useType);
      data.lastUpdatePerson = currentUser.name; data.lastUpdateTime = new Date().toISOString().slice(0,16);
      if (id) { const idx=elevators.findIndex(e=>e.id===id); elevators[idx]={...existing,...data,id}; logActivity('Updated elevator',data.factoryNO,'Master data'); }
      else { if (elevators.some(e=>e.factoryNO.toLowerCase()===data.factoryNO.toLowerCase())) return toast('FactoryNO must be unique.','error'); data.id=uid('elv'); elevators.unshift(data); logActivity('Added elevator',data.factoryNO); }
      write(DB.elevators,elevators); closeModal(); renderAll(); showPage('elevators'); toast(id?'Elevator updated.':'Elevator added.');
    });
  }

  function toggleElevatorStatus(id) {
    if (!canEditPage('elevators')) return toast('Elevator status is view-only for technicians.','error');
    const elevators=read(DB.elevators), e=elevators.find(x=>x.id===id); if(!e)return;
    e.elevatorStatus=e.elevatorStatus==='Online'?'Offline':'Online'; e.lastUpdatePerson=currentUser.name; e.lastUpdateTime=new Date().toISOString().slice(0,16);
    write(DB.elevators,elevators); logActivity('Toggled elevator status',e.factoryNO,e.elevatorStatus); renderAll(); showPage('elevators'); toast(`${e.factoryNO} is now ${e.elevatorStatus}.`);
  }

  function deleteElevator(id) {
    if (!canEditPage('elevators')) return toast('Technicians cannot delete elevator records.','error');
    const elevators=read(DB.elevators), e=elevators.find(x=>x.id===id); if(!e)return;
    confirmModal('Delete Elevator',`Delete ${e.factoryNO}? This removes the elevator master record. Workflow history is retained.`,()=>{
      write(DB.elevators,elevators.filter(x=>x.id!==id)); logActivity('Deleted elevator',e.factoryNO); renderAll(); showPage('elevators'); toast('Elevator deleted.');
    });
  }

  function exportElevators() {
    if (isTechnician()) return toast('JSON export is not available for technician accounts.','error');
    const source = read(DB.elevators);
    const elevators = canViewElevatorCode()
      ? source.map(e => ({...e, elevatorCode: calculateElevatorCode(e.factoryNO)}))
      : source.map(({elevatorCode, ...e}) => e);
    const payload={schema:'liftops-elevators-v1',exportedAt:nowIso(),elevators};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}), a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`liftops-elevators-${new Date().toISOString().slice(0,10)}.json`; a.click(); URL.revokeObjectURL(a.href);
    logActivity('Exported elevators','JSON',`${payload.elevators.length} records`); renderActivity(); toast('Elevators exported to JSON.');
  }

  async function importElevators(file) {
    if (!canEditPage('elevators')) { if ($('#jsonFileInput')) $('#jsonFileInput').value=''; return toast('Technicians cannot import elevator records.','error'); }
    if (!file) return;
    try {
      const parsed=JSON.parse(await file.text()), incoming=Array.isArray(parsed)?parsed:parsed.elevators;
      if(!Array.isArray(incoming)) throw new Error('Expected an array or an object with an elevators array.');
      const current=read(DB.elevators), byFactory=new Map(current.map(e=>[String(e.factoryNO).toLowerCase(),e])); let added=0,updated=0,skipped=0;
      incoming.forEach(raw=>{ if(!raw || !raw.factoryNO){skipped++;return;} const key=String(raw.factoryNO).toLowerCase(), old=byFactory.get(key); const {elevatorCode: _ignoredElevatorCode, nextAnnualInspectionDate: _ignoredNextInspection, ...imported} = raw; const clean={...imported,elevatorStatus:raw.elevatorStatus==='Offline'?'Offline':'Online',lastUpdatePerson:currentUser.name,lastUpdateTime:new Date().toISOString().slice(0,16)}; const importedUseType=String(clean.useType||'').toLowerCase(); clean.useType=importedUseType==='commercial'||importedUseType==='commersial'?'Commercial':importedUseType==='domestic'?'Domestic':''; clean.nextAnnualInspectionDate=calculateNextInspectionDate(clean.lastAnnualInspectionDate,clean.useType);
        if(old){Object.assign(old,clean,{id:old.id});updated++;} else {current.push({...clean,id:raw.id||uid('elv')});added++;}
      });
      write(DB.elevators,current); logActivity('Imported elevators','JSON',`${added} added, ${updated} updated, ${skipped} skipped`); renderAll(); showPage('elevators'); toast(`Import complete: ${added} added, ${updated} updated.`);
    } catch(err){ toast(`Import failed: ${err.message}`,'error'); }
    finally { $('#jsonFileInput').value=''; }
  }

  function normalizeRemoteCallUrl(value) {
    try {
      const url=new URL(String(value||'').trim());
      return (url.protocol==='http:'||url.protocol==='https:') ? url.href : '';
    } catch { return ''; }
  }

  function renderRemoteMenuControl(elevators, selected, url) {
    const control=$('#remoteMenuControl'); if(!control)return;
    if(!canAccessRemoteCall()){control.classList.add('hidden');control.innerHTML='';return;}
    control.classList.remove('hidden');
    const menuLinkHtml=url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${esc(url)}</a><a class="btn ghost small full" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open remote interface ↗</a>`
      : `<span>${selected?'No valid Remote call URL configured.':'Choose an elevator to load its remote interface.'}</span>`;
    control.innerHTML=`
      <label class="remote-menu-label">Elevator
        <select id="remoteElevatorSelect"><option value="">Select elevator</option>${elevators.map(e=>`<option value="${esc(e.id)}" ${selected?.id===e.id?'selected':''}>${esc(e.factoryNO)} — ${esc(e.location||e.address||'')}</option>`).join('')}</select>
      </label>
      <div class="remote-menu-link">${menuLinkHtml}</div>`;
    $('#remoteElevatorSelect').addEventListener('change',e=>{
      selectedRemoteElevatorId=e.target.value;
      if(document.querySelector('#page-remote.active')) renderRemoteCall(selectedRemoteElevatorId);
      else showPage('remote');
    });
  }

  function renderRemoteCall(selectedId='') {
    const page=$('#page-remote'); if(!page)return;
    if(!canAccessRemoteCall()){page.innerHTML='';const control=$('#remoteMenuControl');if(control){control.innerHTML='';control.classList.add('hidden');}return;}
    const elevators=read(DB.elevators).slice().sort((a,b)=>String(a.factoryNO||'').localeCompare(String(b.factoryNO||'')));
    const requested=selectedId || selectedRemoteElevatorId;
    const selected=elevators.find(e=>e.id===requested)||null;
    selectedRemoteElevatorId=selected?.id||'';
    const url=normalizeRemoteCallUrl(selected?.remoteCall);
    const mixedContent=Boolean(url && location.protocol==='https:' && url.startsWith('http:'));
    renderRemoteMenuControl(elevators, selected, url);
    page.innerHTML=`
      <div class="remote-call-stage">
        ${selected&&!url?`<div class="remote-stage-note">No valid Remote call URL is configured for <b>${esc(selected.factoryNO)}</b>. A Manager or Administrator can add it from Elevators → Edit Elevator.</div>`:''}
        ${mixedContent?'<div class="remote-stage-note">This Remote call uses HTTP while LiftOps is running on HTTPS. Android/Chrome may block the embedded view; use the Open remote interface button in the menu.</div>':''}
        <div class="remote-frame-shell">${url?`<iframe class="remote-frame" src="${esc(url)}" title="Remote call for ${esc(selected?.factoryNO||'elevator')}" referrerpolicy="no-referrer"></iframe>`:`<div class="remote-frame-empty"><strong>No remote interface loaded</strong><span>Select an elevator from the Remote Call menu.</span></div>`}</div>
      </div>`;
  }

  const workflowConfig = {
    orders: { key:DB.orders, title:'Order Record', fields:[['quotationNumber','Quotation number','text'],['contractNumber','Contract number','text'],['orderDate','Order date','date'],['productionScheduleTime','Production schedule time','date'],['status','Status','select',['Pending','In Progress','Completed']],['notes','Notes','textarea']] },
    installation: { key:DB.installations, title:'Installation Record', fields:[['scheduleInstallTime','Schedule install time','date'],['installationEndDate','Installation end date','date'],['commissioningDate','Commissioning date','date'],['handoverDate','Handover date','date'],['status','Status','select',['Pending','In Progress','Completed']],['notes','Notes','textarea']] },
    maintenance: { key:DB.maintenance, title:'Maintenance / Service Record', fields:[['serviceDate','Service date','date'],['serviceType','Service type','select',['Preventive inspection','Preventive maintenance','Corrective maintenance','Inspection support','Call-out','Modernization','Other']],['technician','Technician','technician-list'],['result','Result','select',['Pending','In Progress','Completed']],['nextServiceDate','Next service date','date'],['notes','Notes','textarea']] }
  };

  function maintenanceJobsSectionHtml() {
    const jobs=buildNextJobs();
    const overdue=jobs.filter(j=>j.status==='Overdue').length;
    const dueSoon=jobs.filter(j=>j.status==='Due Soon'||j.status==='Due Today').length;
    return `<div class="form-section maintenance-jobs-section">
      <div class="card-head"><div><h3>Automatic Generated Services</h3><p>Shared, automatically generated inspection-support and preventive-maintenance work. These services are not assigned to a technician.</p></div></div>
      <div class="grid stats-grid">${statCard('Generated Services',jobs.length,'☷')}${statCard('Due Next 30 Days',dueSoon,'◷')}${statCard('Overdue',overdue,'!')}</div>
      <div class="toolbar"><div class="search"><input id="jobSearch" type="search" placeholder="Search factory no., location or job type…"></div><select id="jobTypeFilter"><option value="">All job types</option><option>Inspection support</option><option>Preventive maintenance</option></select><select id="jobStatusFilter"><option value="">All statuses</option><option>Overdue</option><option>Due Today</option><option>Due Soon</option><option>Scheduled</option></select></div>
      <div class="card" style="margin-bottom:16px"><div class="card-head"><div><h3>Automatic scheduling rules</h3><p>Inspection support is derived from Last annual inspection date + Use type. Preventive maintenance uses the newer of the latest Service date or Last maintenance contract date, then applies Services per year.</p></div></div></div>
      <div id="nextJobsTable"></div>
    </div>`;
  }

  function bindMaintenanceJobs() {
    if ($('#jobSearch')) $('#jobSearch').addEventListener('input',drawNextJobs);
    if ($('#jobTypeFilter')) $('#jobTypeFilter').addEventListener('change',drawNextJobs);
    if ($('#jobStatusFilter')) $('#jobStatusFilter').addEventListener('change',drawNextJobs);
    drawNextJobs();
  }

  function renderWorkflow(type) {
    const cfg=workflowConfig[type], records=read(cfg.key), elevators=read(DB.elevators), map=Object.fromEntries(elevators.map(e=>[e.id,e]));
    const page = type==='orders'?'orders':type;
    if (!canViewPage(page)) {
      const hiddenPage=$(`#page-${page}`); if(hiddenPage) hiddenPage.innerHTML='';
      return;
    }
    const readOnly = !canEditPage(page);
    $(`#page-${page}`).innerHTML = `${readOnly?'<div class="readonly-note">Technician access: this page is view-only. Maintenance & Service is the only editable page.</div>':''}<div class="toolbar"><div class="search"><input data-workflow-search="${type}" type="search" placeholder="Search elevator or record…"></div><div class="spacer"></div>${readOnly?'':`<button class="btn primary" data-add-workflow="${type}">＋ Add ${type==='maintenance'?'Service Record':'Record'}</button>`}</div>
      <div class="table-wrap"><table><thead><tr><th>Elevator</th>${type==='orders'?'<th>Quotation</th><th>Contract</th><th>Order Date</th><th>Production</th>':type==='installation'?'<th>Scheduled</th><th>Install End</th><th>Commissioning</th><th>Handover</th>':'<th>Service Date</th><th>Type</th><th>Technician</th><th>Next Service</th>'}<th>Status</th><th>Actions</th></tr></thead><tbody id="${type}Rows"></tbody></table></div>
      ${type==='maintenance'?maintenanceJobsSectionHtml():''}`;
    drawWorkflowRows(type,'');
    $(`[data-workflow-search="${type}"]`).addEventListener('input',e=>drawWorkflowRows(type,e.target.value));
    if(type==='maintenance') bindMaintenanceJobs();
  }

  function drawWorkflowRows(type,q='') {
    const cfg=workflowConfig[type], elevators=read(DB.elevators), map=Object.fromEntries(elevators.map(e=>[e.id,e]));
    const readOnly = !canEditPage(type==='orders'?'orders':type);
    let records=read(cfg.key);
    if(type==='maintenance') records=records.filter(canViewAssignedMaintenanceRecord);
    records=records.filter(r=>{const text=JSON.stringify(r)+' '+(map[r.elevatorId]?.factoryNO||'')+' '+(map[r.elevatorId]?.location||''); return text.toLowerCase().includes(q.toLowerCase())});
    const cells = r => type==='orders' ? `<td>${esc(r.quotationNumber||'—')}</td><td>${esc(r.contractNumber||'—')}</td><td>${fmtDate(r.orderDate)}</td><td>${fmtDate(r.productionScheduleTime)}</td>` : type==='installation' ? `<td>${fmtDate(r.scheduleInstallTime)}</td><td>${fmtDate(r.installationEndDate)}</td><td>${fmtDate(r.commissioningDate)}</td><td>${fmtDate(r.handoverDate)}</td>` : `<td>${fmtDate(r.serviceDate)}</td><td>${esc(r.serviceType||'—')}</td><td>${esc(r.technician||'—')}</td><td>${r.serviceType==='Preventive inspection'?fmtDate(calculateNextServiceDate(latestDateValue(r.serviceDate,map[r.elevatorId]?.lastMaintenanceContractDate),map[r.elevatorId]?.servicesPerYear)||r.nextServiceDate):'—'}</td>`;
    const el=$(`#${type}Rows`); if(!el)return; el.innerHTML=records.map(r=>`<tr><td><b>${esc(map[r.elevatorId]?.factoryNO||'Deleted elevator')}</b><div class="muted">${esc(map[r.elevatorId]?.location||'')}</div></td>${cells(r)}<td>${statusBadge(r.status||r.result||'Pending')}</td><td><div class="actions"><button class="btn ghost small" data-edit-workflow="${type}:${r.id}">${readOnly?'View':'Edit'}</button>${readOnly?'':`<button class="btn danger small" data-delete-workflow="${type}:${r.id}">Delete</button>`}</div></td></tr>`).join('') || `<tr><td colspan="7"><div class="empty"><strong>No records</strong>${readOnly?'No records are available to view.':`Add the first ${type} record.`}</div></td></tr>`;
  }

  function maintenanceTechnicianOptions(currentValue='') {
    if (isTechnician()) return [{value:currentUser.name,label:`${currentUser.name} — logged in`}];
    const users=read(DB.users);
    const options=users.map(u=>({value:u.name,label:`${u.name} — ${u.role}${u.status && u.status!=='Approved'?` (${u.status})`:''}`}));
    if (currentValue && !options.some(o=>o.value===currentValue)) options.unshift({value:currentValue,label:`${currentValue} — recorded`});
    return options;
  }

  function workflowInput(field,val='',typeContext='',editable=true) {
    const [key,label,type,options]=field;
    const disabled=editable?'':'disabled';
    if(typeContext==='maintenance' && key==='technician') {
      const technicianOptions=maintenanceTechnicianOptions(val);
      return `<label>${label}<select name="${key}" ${disabled}>${technicianOptions.map(o=>`<option value="${esc(o.value)}" ${o.value===val||(!val&&isTechnician()&&o.value===currentUser.name)?'selected':''}>${esc(o.label)}</option>`).join('')}</select>${isTechnician()?'<span class="muted">Technician accounts can only assign the logged-in technician.</span>':'<span class="muted">Select an account name.</span>'}</label>`;
    }
    if(type==='select') return `<label>${label}<select name="${key}" ${disabled}>${options.map(o=>`<option ${o===val?'selected':''}>${o}</option>`).join('')}</select></label>`;
    if(type==='textarea') return `<label class="span-3">${label}<textarea name="${key}" ${disabled}>${esc(val)}</textarea></label>`;
    if(typeContext==='maintenance' && key==='nextServiceDate') return `<label data-next-service-field class="${val ? '' : 'hidden'}">${label}<input name="${key}" type="date" value="${esc(val)}" disabled><span class="muted">Calculated from the newer of Service date or Last maintenance contract date, using the elevator's Services per year.</span></label>`;
    return `<label>${label}<input name="${key}" type="${type}" value="${esc(val)}" ${disabled}></label>`;
  }

  function openWorkflowModal(type,id=null) {
    const cfg=workflowConfig[type], records=read(cfg.key), rec=records.find(r=>r.id===id)||{}, elevators=read(DB.elevators);
    const page=type==='orders'?'orders':type, readOnly=!canEditPage(page);
    if(readOnly && !id) return toast('Technicians can only add records on Maintenance & Service.','error');
    const initialElevator = elevators.find(e=>e.id===rec.elevatorId);
    if(type==='maintenance') rec.nextServiceDate = rec.serviceType==='Preventive inspection' ? (calculateNextServiceDate(latestDateValue(rec.serviceDate, initialElevator?.lastMaintenanceContractDate), initialElevator?.servicesPerYear) || rec.nextServiceDate || '') : '';
    openModal(readOnly?`View ${cfg.title}`:(id?`Edit ${cfg.title}`:`Add ${cfg.title}`), readOnly?'Technician access: view-only.':'Link the record to an elevator and track its operational progress.', `<form id="workflowForm"><div class="form-grid"><label class="required">Elevator<select name="elevatorId" required ${readOnly?'disabled':''}><option value="">Select elevator</option>${elevators.map(e=>`<option value="${e.id}" ${e.id===rec.elevatorId?'selected':''}>${esc(e.factoryNO)} — ${esc(e.location||e.address||'')}</option>`).join('')}</select></label>${cfg.fields.map(f=>workflowInput(f,rec[f[0]]||'',type,!readOnly)).join('')}</div></form>`, readOnly?`<button class="btn primary" data-modal-cancel>Close</button>`:`<button class="btn ghost" data-modal-cancel>Cancel</button><button id="saveWorkflowBtn" class="btn primary">Save Record</button>`);
    if(readOnly) return;
    if(type==='maintenance') {
      const elevatorInput=$('#workflowForm [name="elevatorId"]'), serviceDateInput=$('#workflowForm [name="serviceDate"]'), serviceTypeInput=$('#workflowForm [name="serviceType"]'), nextServiceInput=$('#workflowForm [name="nextServiceDate"]'), nextServiceField=$('#workflowForm [data-next-service-field]');
      const refreshNextService=()=>{
        const isPreventiveInspection=serviceTypeInput?.value==='Preventive inspection';
        if(nextServiceField)nextServiceField.classList.toggle('hidden',!isPreventiveInspection);
        if(!isPreventiveInspection){if(nextServiceInput)nextServiceInput.value='';return;}
        const elevator=elevators.find(e=>e.id===elevatorInput?.value);
        const baseDate=latestDateValue(serviceDateInput?.value,elevator?.lastMaintenanceContractDate);
        if(nextServiceInput)nextServiceInput.value=calculateNextServiceDate(baseDate,elevator?.servicesPerYear);
      };
      if(elevatorInput)elevatorInput.addEventListener('change',refreshNextService);
      if(serviceDateInput)serviceDateInput.addEventListener('change',refreshNextService);
      if(serviceTypeInput)serviceTypeInput.addEventListener('change',refreshNextService);
      refreshNextService();
    }
    $('#saveWorkflowBtn').onclick=()=>{const form=$('#workflowForm');if(!form.reportValidity())return;const data=Object.fromEntries(new FormData(form).entries()); const e=elevators.find(x=>x.id===data.elevatorId); if(type==='maintenance'){if(isTechnician())data.technician=currentUser.name;else{const allowedNames=read(DB.users).map(u=>u.name);if(data.technician&&!allowedNames.includes(data.technician)&&data.technician!==rec.technician)return toast('Select a valid account name for Technician.','error');}data.nextServiceDate=data.serviceType==='Preventive inspection'?calculateNextServiceDate(latestDateValue(data.serviceDate,e?.lastMaintenanceContractDate),e?.servicesPerYear):'';} if(id){const i=records.findIndex(r=>r.id===id);records[i]={...records[i],...data};}else records.unshift({...data,id:uid(type.slice(0,3))}); write(cfg.key,records); logActivity(id?'Updated workflow record':'Added workflow record',e?.factoryNO||type,cfg.title); closeModal();renderWorkflow(type);renderDashboard();if(!isTechnician())renderActivity();toast('Record saved.');};
  }

  function deleteWorkflow(type,id){const page=type==='orders'?'orders':type;if(!canEditPage(page))return toast('Technicians can only delete records on Maintenance & Service.','error');const cfg=workflowConfig[type],records=read(cfg.key),rec=records.find(r=>r.id===id);if(!rec)return;confirmModal('Delete Record','Delete this workflow record?',()=>{write(cfg.key,records.filter(r=>r.id!==id));logActivity('Deleted workflow record',cfg.title,id);renderWorkflow(type);if(!isTechnician())renderActivity();toast('Record deleted.');});}

  function buildNextJobs() {
    const elevators=read(DB.elevators), maintenance=read(DB.maintenance), jobs=[];
    const completedGeneratedJobIds=new Set(maintenance.filter(m=>m.sourceJobId && m.result==='Completed').map(m=>m.sourceJobId));
    const addJob=job=>{if(!completedGeneratedJobIds.has(job.id))jobs.push(job);};
    elevators.forEach(e=>{
      const inspectionDue=calculateNextInspectionDate(e.lastAnnualInspectionDate,e.useType);
      if(inspectionDue) addJob({id:`inspection:${e.id}:${inspectionDue}`,elevatorId:e.id,type:'Inspection support',dueDate:inspectionDue,basis:`${e.useType} · ${fmtDate(e.lastAnnualInspectionDate)} + ${e.useType==='Commercial'?'6':'12'} months`,status:jobStatus(inspectionDue)});
      const base=preventiveMaintenanceBase(e,maintenance);
      const serviceDue=calculateNextServiceDate(base.date,e.servicesPerYear);
      if(serviceDue) addJob({id:`maintenance:${e.id}:${serviceDue}`,elevatorId:e.id,type:'Preventive maintenance',dueDate:serviceDue,basis:`${esc(base.source)}: ${fmtDate(base.date)} · ${esc(e.servicesPerYear||'—')} service${Number(e.servicesPerYear)===1?'':'s'}/year`,status:jobStatus(serviceDue)});
    });
    return jobs.sort((a,b)=>a.dueDate.localeCompare(b.dueDate)||a.type.localeCompare(b.type));
  }

  function drawNextJobs() {
    const table=$('#nextJobsTable'); if(!table)return;
    const q=($('#jobSearch')?.value||'').toLowerCase(), type=$('#jobTypeFilter')?.value||'', status=$('#jobStatusFilter')?.value||'';
    const elevators=read(DB.elevators), map=Object.fromEntries(elevators.map(e=>[e.id,e]));
    const jobs=buildNextJobs().filter(j=>{const e=map[j.elevatorId]||{};const text=`${j.type} ${j.status} ${j.dueDate} ${j.basis} ${e.factoryNO||''} ${e.location||''} ${e.address||''}`.toLowerCase();return (!type||j.type===type)&&(!status||j.status===status)&&(!q||text.includes(q));});
    table.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Due Date</th><th>Generated Service</th><th>Elevator</th><th>Location</th><th>Scheduling Basis</th><th>Status</th></tr></thead><tbody>${jobs.map(j=>{const e=map[j.elevatorId]||{};return `<tr><td><b>${fmtDate(j.dueDate)}</b></td><td>${esc(j.type)}</td><td><b>${esc(e.factoryNO||'Deleted elevator')}</b></td><td>${esc(e.location||e.address||'—')}</td><td>${j.basis}</td><td>${statusBadge(j.status)}</td></tr>`}).join('')||`<tr><td colspan="6"><div class="empty"><strong>No generated services</strong>Set Use type + Last annual inspection date for inspection support, and set a Service date or Last maintenance contract date together with Services per year for preventive maintenance.</div></td></tr>`}</tbody></table></div>`;
  }

  function renderUsers() {
    if (isTechnician()) { if ($('#page-users')) $('#page-users').innerHTML=''; return; }
    $('#page-users').innerHTML=`<div class="toolbar"><div class="search"><input id="userSearch" type="search" placeholder="Search users…"></div><div class="spacer"></div><button id="addUserBtn" class="btn primary">＋ Add User</button></div><div id="userTable"></div>`;
    $('#userSearch').oninput=drawUsers; $('#addUserBtn').onclick=()=>openUserModal(); drawUsers();
  }

  function drawUsers(){
    const q=($('#userSearch')?.value||'').toLowerCase(); let users=read(DB.users);
    if(currentUser.role==='Manager')users=users.filter(u=>u.role==='Technician');
    users=users.filter(u=>JSON.stringify(u).toLowerCase().includes(q));
    $('#userTable').innerHTML=`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Remote Call</th><th>Created</th><th>Actions</th></tr></thead><tbody>${users.map(u=>{
      const remoteAccess=u.role==='Technician'
        ? `<div class="actions"><span class="pill">${u.remoteCallAccess?'Enabled':'Disabled'}</span><button class="btn ${u.remoteCallAccess?'danger':'secondary'} small" data-toggle-remote-access="${esc(u.id)}">${u.remoteCallAccess?'Revoke':'Grant'} access</button></div>`
        : '<span class="muted">Included with role</span>';
      return `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td><span class="pill">${esc(u.role)}</span></td><td>${statusBadge(u.status)}</td><td>${remoteAccess}</td><td>${fmtDate(u.createdAt)}</td><td><div class="actions">${canApprove(u)?`<button class="btn secondary small" data-approve-user="${u.id}">Approve</button>`:''}<button class="btn ghost small" data-edit-user="${u.id}">Edit</button>${u.id!==currentUser.id?`<button class="btn danger small" data-delete-user="${u.id}">Delete</button>`:''}</div></td></tr>`;
    }).join('')}</tbody></table></div>`;
  }

  function canApprove(u){return !isTechnician() && u.status==='Pending' && ((currentUser.role==='Administrator'&&u.role==='Manager') || (currentUser.role==='Manager'&&u.role==='Technician') || (currentUser.role==='Administrator'&&u.role==='Technician'));}

  function toggleRemoteCallAccess(id){
    if(isTechnician())return toast('You do not have permission to change Remote Call access.','error');
    const users=read(DB.users),u=users.find(x=>x.id===id);
    if(!u||u.role!=='Technician')return toast('Remote Call access can be changed only for Technician accounts.','error');
    u.remoteCallAccess=!Boolean(u.remoteCallAccess); write(DB.users,users);
    logActivity(u.remoteCallAccess?'Granted Remote Call access':'Revoked Remote Call access',u.email,u.name);
    renderUsers(); renderActivity(); toast(`Remote Call access ${u.remoteCallAccess?'granted to':'revoked from'} ${u.name}.`);
  }

  function openUserModal(id=null){
    if(isTechnician())return toast('User Management is not available for technicians.','error');
    const users=read(DB.users),u=users.find(x=>x.id===id)||{status:'Pending',role:currentUser.role==='Manager'?'Technician':'Manager'};
    const roles=currentUser.role==='Administrator'?['Administrator','Manager','Technician']:['Technician'];
    const passwordLabel=id?'New password (leave blank to keep current password)':'Password';
    openModal(id?'Edit User':'Add User','Accounts are stored in the shared database. Passwords are hashed on the server.',`<form id="userForm"><div class="form-grid"><label class="required">Name<input name="name" value="${esc(u.name||'')}" required></label><label class="required">Email<input name="email" type="email" value="${esc(u.email||'')}" required></label><label class="${id?'':'required'}">${passwordLabel}<input name="password" type="password" ${id?'':'required'} autocomplete="new-password"></label><label>Role<select name="role">${roles.map(r=>`<option ${r===u.role?'selected':''}>${r}</option>`).join('')}</select></label><label>Status<select name="status"><option ${u.status==='Pending'?'selected':''}>Pending</option><option ${u.status==='Approved'?'selected':''}>Approved</option><option ${u.status==='Rejected'?'selected':''}>Rejected</option></select></label></div></form>`,`<button class="btn ghost" data-modal-cancel>Cancel</button><button id="saveUserBtn" class="btn primary">Save User</button>`);
    $('#saveUserBtn').onclick=()=>{
      const form=$('#userForm');if(!form.reportValidity())return;const data=Object.fromEntries(new FormData(form).entries());
      if(users.some(x=>x.id!==id&&x.email.toLowerCase()===data.email.toLowerCase()))return toast('Email already exists.','error');
      if(id){const i=users.findIndex(x=>x.id===id);const old=users[i];const next={...old,...data,remoteCallAccess:data.role==='Technician'?Boolean(old.remoteCallAccess):false};if(!data.password)delete next.password;users[i]=next;}
      else users.push({...data,id:uid('usr'),remoteCallAccess:false,createdAt:nowIso()});
      write(DB.users,users);logActivity(id?'Updated user':'Added user',data.email,`${data.role} / ${data.status}`);closeModal();renderUsers();renderActivity();toast('User saved to the shared database.');
    };
  }

  function approveUser(id){if(isTechnician())return toast('User Management is view-only for technicians.','error');const users=read(DB.users),u=users.find(x=>x.id===id);if(!u||!canApprove(u))return toast('You do not have permission to approve this account.','error');u.status='Approved';u.approvedBy=currentUser.name;u.approvedAt=nowIso();write(DB.users,users);logActivity('Approved account',u.email,u.role);renderUsers();renderActivity();toast(`${u.name} approved.`);}
  function deleteUser(id){if(isTechnician())return toast('User Management is view-only for technicians.','error');const users=read(DB.users),u=users.find(x=>x.id===id);if(!u||u.id===currentUser.id)return;confirmModal('Delete User',`Delete ${u.name}?`,()=>{write(DB.users,users.filter(x=>x.id!==id));logActivity('Deleted user',u.email,u.role);renderUsers();renderActivity();toast('User deleted.');});}

  function renderActivity(){if(isTechnician()){if($('#page-activity'))$('#page-activity').innerHTML='';return;}const logs=read(DB.activity);$('#page-activity').innerHTML=`<div class="toolbar"><div class="search"><input id="activitySearch" type="search" placeholder="Search activity…"></div><div class="spacer"></div><button id="clearLogsBtn" class="btn ghost" ${currentUser.role!=='Administrator'?'disabled':''}>Clear log</button></div><div id="activityTable"></div>`;$('#activitySearch').oninput=drawActivity;$('#clearLogsBtn').onclick=()=>{if(currentUser.role!=='Administrator')return;confirmModal('Clear Activity Log','Remove all stored activity entries?',async()=>{try{await api('/api/activity',{method:'DELETE',body:{}});await loadServerState();renderActivity();toast('Activity log cleared.');}catch(err){toast(err.message,'error');}});};drawActivity();}
  function drawActivity(){const q=($('#activitySearch')?.value||'').toLowerCase(),logs=read(DB.activity).filter(l=>JSON.stringify(l).toLowerCase().includes(q));$('#activityTable').innerHTML=`<div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody>${logs.map(l=>`<tr><td>${fmtDateTime(l.time)}</td><td><b>${esc(l.user)}</b></td><td>${esc(l.role)}</td><td>${esc(l.action)}</td><td>${esc(l.target||'—')}</td><td>${esc(l.detail||'—')}</td></tr>`).join('')||`<tr><td colspan="6"><div class="empty">No activity yet.</div></td></tr>`}</tbody></table></div>`;}

  function openModal(title,subtitle,body,footer=''){ $('#modalTitle').textContent=title;$('#modalSubtitle').textContent=subtitle||'';$('#modalBody').innerHTML=body;$('#modalFooter').innerHTML=footer;$('#modalBackdrop').classList.remove('hidden'); $$('[data-modal-cancel]').forEach(b=>b.onclick=closeModal); }
  function closeModal(){ $('#modalBackdrop').classList.add('hidden'); }
  function confirmModal(title,message,onConfirm){openModal(title,'',`<p>${esc(message)}</p>`,`<button class="btn ghost" data-modal-cancel>Cancel</button><button id="confirmActionBtn" class="btn danger">Confirm</button>`);$('#confirmActionBtn').onclick=()=>{closeModal();onConfirm();};}

  function installButtons(){ return [$('#installAppBtn'),$('#loginInstallAppBtn')].filter(Boolean); }
  function isStandaloneMode(){ return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true; }
  function isAndroidDevice(){ return /Android/i.test(navigator.userAgent || ''); }
  function updateInstallControls(){
    const shouldShow = !isStandaloneMode() && (Boolean(deferredInstallPrompt) || isAndroidDevice());
    installButtons().forEach(btn=>btn.classList.toggle('hidden',!shouldShow));
  }
  async function requestAppInstall(){
    if(isStandaloneMode()) return toast('LiftOps is already installed on this device.');
    if(deferredInstallPrompt){
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt=null;
      updateInstallControls();
      return;
    }
    if(isAndroidDevice()){
      openModal('Install LiftOps','Add a shortcut to the Android Home screen',`<div class="stack"><p>Open this site in Chrome, tap the <b>⋮</b> menu, then choose <b>Install app</b> or <b>Add to Home screen</b>.</p><p class="muted">Android PWA installation requires HTTPS, except when testing on localhost.</p></div>`,`<button class="btn primary" data-modal-cancel>Done</button>`);
      return;
    }
    toast('Use your browser menu and choose Install app / Add to Home screen.');
  }

  function registerEvents(){
    $('#loginForm').addEventListener('submit',e=>{e.preventDefault();login($('#loginEmail').value.trim(),$('#loginPassword').value)});
    $('#logoutBtn').onclick=()=>logout(); $('#menuBtn').onclick=()=>$('#sidebar').classList.toggle('open'); $('#modalClose').onclick=closeModal;
    $('#modalBackdrop').addEventListener('click',e=>{if(e.target===$('#modalBackdrop'))closeModal();});
    $('#jsonFileInput').addEventListener('change',e=>importElevators(e.target.files[0]));
    $('#mainNav').addEventListener('click',e=>{const b=e.target.closest('[data-page]');if(b)showPage(b.dataset.page)});
    document.body.addEventListener('click',e=>{
      const go=e.target.closest('[data-goto]');if(go)showPage(go.dataset.goto);
      const edit=e.target.closest('[data-edit-elevator]');if(edit)openElevatorModal(edit.dataset.editElevator);
      const del=e.target.closest('[data-delete-elevator]');if(del)deleteElevator(del.dataset.deleteElevator);
      const tog=e.target.closest('[data-toggle-status]');if(tog)toggleElevatorStatus(tog.dataset.toggleStatus);
      const addW=e.target.closest('[data-add-workflow]');if(addW)openWorkflowModal(addW.dataset.addWorkflow);
      const editW=e.target.closest('[data-edit-workflow]');if(editW){const [t,id]=editW.dataset.editWorkflow.split(':');openWorkflowModal(t,id)}
      const delW=e.target.closest('[data-delete-workflow]');if(delW){const [t,id]=delW.dataset.deleteWorkflow.split(':');deleteWorkflow(t,id)}
      const app=e.target.closest('[data-approve-user]');if(app)approveUser(app.dataset.approveUser);
      const eu=e.target.closest('[data-edit-user]');if(eu)openUserModal(eu.dataset.editUser);
      const du=e.target.closest('[data-delete-user]');if(du)deleteUser(du.dataset.deleteUser);
      const remoteAccess=e.target.closest('[data-toggle-remote-access]');if(remoteAccess)toggleRemoteCallAccess(remoteAccess.dataset.toggleRemoteAccess);
    });
    ['click','keydown','touchstart'].forEach(ev=>document.addEventListener(ev,refreshSession,{passive:true}));
    window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;updateInstallControls();});
    window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;updateInstallControls();toast('LiftOps was added to your Home screen.');});
    installButtons().forEach(btn=>btn.onclick=requestAppInstall);
    updateInstallControls();
  }

  registerEvents();
  if ('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
  tryRestoreSession();
})();
