// ===== Supabase Init =====
const { createClient } = supabase;
const sb = createClient(
  'https://gtgjwriutlyhvfoyucsq.supabase.co',
  'sb_publishable_X_FP_x4U_Fj54ImuOFXOGQ_V2x6iKOv'
);

// ===== State =====
const today = new Date();
let viewYear  = today.getFullYear();
let viewMonth = today.getMonth();
let startDate = null;
let filters   = { ort: true, iud: true, isl: true, cat: true };
let currentUser = null;

let coDays = new Set();
let cmDays = new Set();
let editMode = null;

// ===== Dark Mode =====
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('lazyshift-theme', next);
}

(function initTheme() {
  const saved = localStorage.getItem('lazyshift-theme') || 'light';
  applyTheme(saved);
})();

// ===== Official monthly working hour norms =====
const NORMA = {
  2025: [168, 160, 168, 168, 160, 168, 184, 168, 176, 184, 160, 160],
  2026: [144, 160, 176, 160, 160, 168, 184, 168, 176, 176, 160, 168],
};

function getNorma(year, month) {
  if (NORMA[year]) return NORMA[year][month];
  let wd = 0;
  const days = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const dow = new Date(year, month, d).getDay();
    if (dow !== 0 && dow !== 6) wd++;
  }
  return wd * 8;
}

// ===== Shift patterns =====
const PATTERNS = {
  '12/24-12/48': {
    ore: 12,
    zile: [
      { type: 'zi',     label: 'D' },
      { type: 'noapte', label: 'N' },
      { type: 'liber',  label: '' },
      { type: 'liber',  label: '' },
    ]
  },
  '12/24': {
    ore: 12,
    zile: [
      { type: 'zi',     label: 'D' },
      { type: 'liber',  label: '' },
      { type: 'noapte', label: 'N' },
      { type: 'liber',  label: '' },
    ]
  },
  '12/24-24/72': {
    ore: 12,
    zile: [
      { type: 'zi',     label: 'D' },
      { type: 'noapte', label: 'N' },
      { type: 'liber',  label: '' },
      { type: 'liber',  label: '' },
      { type: 'liber',  label: '' },
      { type: 'liber',  label: '' },
    ]
  },
  '8/3-morning': {
    ore: 8,
    zile: [
      { type: 'zi',    label: 'M' },
      { type: 'zi',    label: 'M' },
      { type: 'zi',    label: 'M' },
      { type: 'zi',    label: 'M' },
      { type: 'zi',    label: 'M' },
      { type: 'liber', label: '' },
      { type: 'liber', label: '' },
    ]
  },
  '8/3-afternoon': {
    ore: 8,
    zile: [
      { type: 'noapte', label: 'A' },
      { type: 'noapte', label: 'A' },
      { type: 'noapte', label: 'A' },
      { type: 'noapte', label: 'A' },
      { type: 'noapte', label: 'A' },
      { type: 'liber',  label: '' },
      { type: 'liber',  label: '' },
    ]
  },
  '8/3-night': {
    ore: 8,
    zile: [
      { type: 'noapte', label: 'N' },
      { type: 'noapte', label: 'N' },
      { type: 'noapte', label: 'N' },
      { type: 'noapte', label: 'N' },
      { type: 'noapte', label: 'N' },
      { type: 'liber',  label: '' },
      { type: 'liber',  label: '' },
    ]
  },
  '8/3-rotating': {
    ore: 8,
    zile: [
      { type: 'zi',     label: 'M' },
      { type: 'zi',     label: 'M' },
      { type: 'zi',     label: 'M' },
      { type: 'zi',     label: 'M' },
      { type: 'zi',     label: 'M' },
      { type: 'noapte', label: 'A' },
      { type: 'noapte', label: 'A' },
      { type: 'noapte', label: 'A' },
      { type: 'noapte', label: 'A' },
      { type: 'noapte', label: 'A' },
      { type: 'noapte', label: 'N' },
      { type: 'noapte', label: 'N' },
      { type: 'noapte', label: 'N' },
      { type: 'noapte', label: 'N' },
      { type: 'noapte', label: 'N' },
      { type: 'liber',  label: '' },
      { type: 'liber',  label: '' },
      { type: 'liber',  label: '' },
      { type: 'liber',  label: '' },
      { type: 'liber',  label: '' },
      { type: 'liber',  label: '' },
    ]
  },
  '24/48': {
    ore: 24,
    zile: [
      { type: 'zi',    label: '24' },
      { type: 'liber', label: '' },
      { type: 'liber', label: '' },
    ]
  },
  '24/72': {
    ore: 24,
    zile: [
      { type: 'zi',    label: '24' },
      { type: 'liber', label: '' },
      { type: 'liber', label: '' },
      { type: 'liber', label: '' },
    ]
  },
};

// ===== CUSTOM SHIFT =====
let customDays = new Set();
let customOrePerZi = 12;

function isCustomMode() {
  return document.getElementById('shift-type').value === 'custom';
}

function getCustomOre() {
  return parseInt(document.getElementById('custom-hours-input')?.value) || 12;
}

// ===== Public holidays 2026 =====
const LEGAL_HOLIDAYS = {
  '2026-1-1':  "New Year's Day",
  '2026-1-2':  "New Year's Day",
  '2026-1-24': 'Unification Day',
  '2026-4-10': 'Good Friday',
  '2026-4-12': 'Easter Sunday',
  '2026-4-13': 'Easter Monday',
  '2026-5-1':  'Labour Day',
  '2026-6-1':  "Children's Day",
  '2026-6-7':  'Pentecost Sunday',
  '2026-6-8':  'Pentecost Monday',
  '2026-8-15': 'Assumption Day',
  '2026-11-30':"St. Andrew's Day",
  '2026-12-1': 'National Day',
  '2026-12-25':'Christmas Day',
  '2026-12-26':'Christmas Day',
};

// ===== Religious / cultural holidays 2026 =====
const HOLIDAYS = {
  '2026-1-6':  { name: 'Epiphany',         type: 'ort' },
  '2026-1-7':  { name: "St. John's Day",   type: 'ort' },
  '2026-2-24': { name: 'Dragobete',        type: 'ort' },
  '2026-3-8':  { name: "Women's Day",      type: 'ort' },
  '2026-4-5':  { name: 'Palm Sunday',      type: 'ort' },
  '2026-4-11': { name: 'Holy Saturday',    type: 'ort' },
  '2026-5-21': { name: 'Ascension',        type: 'ort' },
  '2026-2-2':  { name: 'Tu BiShvat',      type: 'iud' },
  '2026-3-2':  { name: 'Fast of Esther',   type: 'iud' },
  '2026-3-3':  { name: 'Purim',            type: 'iud' },
  '2026-4-1':  { name: 'Passover',         type: 'iud' },
  '2026-4-2':  { name: 'Passover',         type: 'iud' },
  '2026-4-3':  { name: 'Passover',         type: 'iud' },
  '2026-4-4':  { name: 'Passover',         type: 'iud' },
  '2026-4-7':  { name: 'Passover',         type: 'iud' },
  '2026-4-8':  { name: 'Passover',         type: 'iud' },
  '2026-5-22': { name: 'Shavuot',          type: 'iud' },
  '2026-7-29': { name: "Tisha B'Av",       type: 'iud' },
  '2026-9-11': { name: 'Rosh Hashana',     type: 'iud' },
  '2026-9-12': { name: 'Rosh Hashana',     type: 'iud' },
  '2026-9-20': { name: 'Yom Kippur',       type: 'iud' },
  '2026-9-25': { name: 'Sukkot',           type: 'iud' },
  '2026-10-1': { name: 'Simhat Torah',     type: 'iud' },
  '2026-12-15':{ name: 'Hanukkah',         type: 'iud' },
  '2026-12-16':{ name: 'Hanukkah',         type: 'iud' },
  '2026-12-17':{ name: 'Hanukkah',         type: 'iud' },
  '2026-12-18':{ name: 'Hanukkah',         type: 'iud' },
  '2026-12-19':{ name: 'Hanukkah',         type: 'iud' },
  '2026-12-20':{ name: 'Hanukkah',         type: 'iud' },
  '2026-12-21':{ name: 'Hanukkah',         type: 'iud' },
  '2026-12-22':{ name: 'Hanukkah',         type: 'iud' },
  '2026-3-19': { name: 'Eid al-Fitr',      type: 'isl' },
  '2026-3-20': { name: 'Eid al-Fitr',      type: 'isl' },
  '2026-5-26': { name: 'Day of Arafah',    type: 'isl' },
  '2026-5-27': { name: 'Eid al-Adha',      type: 'isl' },
  '2026-5-28': { name: 'Eid al-Adha',      type: 'isl' },
  '2026-6-16': { name: 'Islamic New Year', type: 'isl' },
  '2026-6-25': { name: 'Ashura',           type: 'isl' },
  '2026-8-25': { name: 'Mawlid al-Nabi',   type: 'isl' },
  // Catholic
  '2026-1-1':  { name: "New Year's Day",   type: 'cat' },
  '2026-1-6':  { name: 'Epiphany',         type: 'cat' },
  '2026-2-2':  { name: 'Candlemas',        type: 'cat' },
  '2026-2-14': { name: "Valentine's Day",  type: 'cat' },
  '2026-3-19': { name: "St. Joseph's Day", type: 'cat' },
  '2026-4-2':  { name: 'Holy Thursday',    type: 'cat' },
  '2026-4-3':  { name: 'Good Friday',      type: 'cat' },
  '2026-4-4':  { name: 'Holy Saturday',    type: 'cat' },
  '2026-4-5':  { name: 'Easter Sunday',    type: 'cat' },
  '2026-4-6':  { name: 'Easter Monday',    type: 'cat' },
  '2026-5-14': { name: 'Ascension',        type: 'cat' },
  '2026-5-24': { name: 'Pentecost Sunday', type: 'cat' },
  '2026-5-25': { name: 'Pentecost Monday', type: 'cat' },
  '2026-6-11': { name: 'Corpus Christi',   type: 'cat' },
  '2026-8-15': { name: 'Assumption Day',   type: 'cat' },
  '2026-11-1': { name: "All Saints' Day",  type: 'cat' },
  '2026-11-2': { name: "All Souls' Day",   type: 'cat' },
  '2026-12-8': { name: 'Immaculate Conception', type: 'cat' },
  '2026-12-24':{ name: 'Christmas Eve',    type: 'cat' },
  '2026-12-25':{ name: 'Christmas Day',    type: 'cat' },
  '2026-12-26':{ name: 'St. Stephen\'s Day', type: 'cat' },
};

// ===== Utilities =====
function dayKey(y, m, d) { return y + '-' + m + '-' + d; }

function dayDiff(a, b) {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86400000);
}

function getPattern() {
  const val = document.getElementById('shift-type').value;
  if (val === 'custom') return null;
  return PATTERNS[val];
}

function getShift(dateObj) {
  if (isCustomMode()) {
    const key = dayKey(dateObj.getFullYear(), dateObj.getMonth() + 1, dateObj.getDate());
    if (customDays.has(key)) return { type: 'zi', label: 'W' };
    return { type: 'liber', label: '' };
  }
  if (!startDate) return null;
  const pat  = getPattern();
  const diff = dayDiff(startDate, dateObj);
  const idx  = ((diff % pat.zile.length) + pat.zile.length) % pat.zile.length;
  return pat.zile[idx];
}

function getOrePerZi() {
  if (isCustomMode()) return getCustomOre();
  return getPattern().ore;
}

function getLegalHoliday(year, month, day) {
  return LEGAL_HOLIDAYS[dayKey(year, month, day)] || null;
}

function getHoliday(year, month, day) {
  const h = HOLIDAYS[dayKey(year, month, day)];
  if (!h || !filters[h.type]) return null;
  return h;
}

// ===== Serialize AL/SL sets =====
function serializeSet(s) { return JSON.stringify([...s]); }
function deserializeSet(str) {
  try { return new Set(JSON.parse(str)); }
  catch { return new Set(); }
}

// ===== Supabase: save =====
async function saveSettings() {
  if (!currentUser) return;
  const shiftType = document.getElementById('shift-type').value;
  const startStr = startDate
    ? `${startDate.getFullYear()}-${String(startDate.getMonth()+1).padStart(2,'0')}-${String(startDate.getDate()).padStart(2,'0')}`
    : null;
  await sb.from('user_settings').upsert({
    user_id:     currentUser.id,
    start_date:  startStr,
    tura_type:   shiftType,
    co_days:     serializeSet(coDays),
    cm_days:     serializeSet(cmDays),
    custom_days: serializeSet(customDays),
    custom_ore:  getCustomOre(),
  }, { onConflict: 'user_id' });
}

// ===== Supabase: load =====
async function loadSettings() {
  if (!currentUser) return;
  const { data } = await sb
    .from('user_settings')
    .select('*')
    .eq('user_id', currentUser.id)
    .single();
  if (data) {
    if (data.tura_type) {
      document.getElementById('shift-type').value = data.tura_type;
      updateShiftTypeUI();
    }
    if (data.start_date) {
      const parts = data.start_date.split('-');
      startDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      document.getElementById('start-info').textContent =
        'Day shift start: ' +
        startDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) +
        ' · pattern extends in both directions';
    }
    if (data.co_days)     coDays     = deserializeSet(data.co_days);
    if (data.cm_days)     cmDays     = deserializeSet(data.cm_days);
    if (data.custom_days) customDays = deserializeSet(data.custom_days);
    if (data.custom_ore) {
      const inp = document.getElementById('custom-hours-input');
      if (inp) inp.value = data.custom_ore;
    }
  }
  recalc();
}

// ===== Edit Mode =====
function setEditMode(mode) {
  editMode = editMode === mode ? null : mode;
  updateEditModeUI();
}

function updateEditModeUI() {
  const btnAl = document.getElementById('btn-edit-co');
  const btnSl = document.getElementById('btn-edit-cm');
  const hint  = document.getElementById('edit-hint');
  btnAl.classList.toggle('active-edit-co', editMode === 'co');
  btnSl.classList.toggle('active-edit-cm', editMode === 'cm');
  if (editMode === 'co') {
    hint.textContent = '✏️ Click any day to mark/unmark Annual Leave (8h/day)';
    hint.style.display = 'block';
  } else if (editMode === 'cm') {
    hint.textContent = '✏️ Click any day to mark/unmark Sick Leave (8h/day)';
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
}

// ===== Day click =====
function handleDayClick(y, m, d) {
  const key = dayKey(y, m + 1, d);

  if (editMode === 'co') {
    if (cmDays.has(key)) cmDays.delete(key);
    coDays.has(key) ? coDays.delete(key) : coDays.add(key);
    recalc(); saveSettings(); return;
  }

  if (editMode === 'cm') {
    if (coDays.has(key)) coDays.delete(key);
    cmDays.has(key) ? cmDays.delete(key) : cmDays.add(key);
    recalc(); saveSettings(); return;
  }

  if (isCustomMode()) {
    if (coDays.has(key) || cmDays.has(key)) return;
    customDays.has(key) ? customDays.delete(key) : customDays.add(key);
    recalc(); saveSettings(); return;
  }

  setStart(y, m, d);
}

// ===== Set start day =====
function setStart(y, m, d) {
  startDate = new Date(y, m, d);
  document.getElementById('start-info').textContent =
    'Day shift start: ' +
    startDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) +
    ' · pattern extends in both directions';
  recalc();
  saveSettings();
}

// ===== Shift type UI =====
function updateShiftTypeUI() {
  const val = document.getElementById('shift-type').value;
  const customPanel = document.getElementById('custom-panel');
  const startInfo   = document.getElementById('start-info');
  if (val === 'custom') {
    customPanel.style.display = 'block';
    startInfo.textContent = '👆 Click the days you work in the calendar to mark them.';
  } else {
    customPanel.style.display = 'none';
    if (!startDate) {
      startInfo.textContent = 'Click on a DAY shift to set the pattern.';
    }
  }
}

// ===== Recalculate =====
function recalc() {
  const year  = viewYear;
  const month = viewMonth;
  const days  = new Date(year, month + 1, 0).getDate();
  const oreZi = getOrePerZi();
  let oreLucrate = 0;
  let oreCoLuna  = 0;
  let oreCmLuna  = 0;

  for (let d = 1; d <= days; d++) {
    const dateObj = new Date(year, month, d);
    const sh  = getShift(dateObj);
    const key = dayKey(year, month + 1, d);

    if (coDays.has(key)) {
      oreCoLuna += 8;
    } else if (cmDays.has(key)) {
      oreCmLuna += 8;
    } else if (sh && (sh.type === 'zi' || sh.type === 'noapte')) {
      oreLucrate += oreZi;
    }
  }

  const totalPontat = oreLucrate + oreCoLuna + oreCmLuna;
  const norma = getNorma(year, month);
  const extra = totalPontat - norma;

  const showStats = isCustomMode() || !!startDate;
  if (showStats) {
    document.getElementById('ore-lucrate').textContent = totalPontat;
    document.getElementById('norma').textContent       = norma;
    const elExtra = document.getElementById('ore-extra');
    elExtra.textContent = (extra >= 0 ? '+' : '') + extra;
    elExtra.style.color = extra >= 0 ? '#1D9E75' : '#e53e3e';
  }

  updateAlBadge();
  renderCal();
}

function updateAlBadge() {
  const totalAl = coDays.size;
  const totalSl = cmDays.size;
  const spAl = document.querySelector('#btn-edit-co .co-count');
  const spSl = document.querySelector('#btn-edit-cm .cm-count');
  if (spAl) spAl.textContent = totalAl > 0 ? ` · ${totalAl}d` : '';
  if (spSl) spSl.textContent = totalSl > 0 ? ` · ${totalSl}d` : '';
}

// ===== Render calendar =====
function renderCal() {
  const year  = viewYear;
  const month = viewMonth;

  const lbl = new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  document.getElementById('month-label').textContent = lbl.charAt(0).toUpperCase() + lbl.slice(1);

  const firstDay = new Date(year, month, 1).getDay();
  const offset   = firstDay === 0 ? 6 : firstDay - 1;
  const days     = new Date(year, month + 1, 0).getDate();
  const names    = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  let html = names.map(n => `<div class="cal-day-name">${n}</div>`).join('');
  for (let i = 0; i < offset; i++) html += '<div class="day empty"></div>';

  for (let d = 1; d <= days; d++) {
    const dateObj = new Date(year, month, d);
    const sh      = getShift(dateObj);
    const hol     = getHoliday(year, month + 1, d);
    const legal   = getLegalHoliday(year, month + 1, d);
    const isToday = dateObj.toDateString() === today.toDateString();
    const isStart = startDate && dateObj.toDateString() === startDate.toDateString();
    const key     = dayKey(year, month + 1, d);
    const isAl    = coDays.has(key);
    const isSl    = cmDays.has(key);

    let cls = 'day';
    if (isAl)       cls += ' co';
    else if (isSl)  cls += ' cm';
    else if (sh)    cls += ' ' + sh.type;
    else            cls += ' liber';

    if (isToday) cls += ' today';
    if (isStart) cls += ' start-sel';
    if (legal)   cls += ' legal-holiday';

    if (isCustomMode() && !isAl && !isSl) cls += ' custom-clickable';

    const badge    = (!isAl && !isSl && sh && sh.label) ? `<span class="shift-badge">${sh.label}</span>` : '';
    const alBadge  = isAl ? `<span class="hol-name hol-co">AL</span>` : '';
    const slBadge  = isSl ? `<span class="hol-name hol-cm">SL</span>` : '';
    const legalBdg = legal ? `<span class="hol-name hol-legal" title="${legal}">PH</span>` : '';
    const holHtml  = hol   ? `<span class="hol-name hol-${hol.type}">${hol.name}</span>` : '';

    html += `<div class="${cls}" data-y="${year}" data-m="${month}" data-d="${d}">${d}${badge}${alBadge}${slBadge}${legalBdg}${holHtml}</div>`;
  }

  document.getElementById('cal').innerHTML = html;
  document.getElementById('cal').querySelectorAll('.day:not(.empty)').forEach(el => {
    el.addEventListener('click', () => {
      handleDayClick(parseInt(el.dataset.y), parseInt(el.dataset.m), parseInt(el.dataset.d));
    });
  });
}

// ===== Month navigation =====
function changeMonth(dir) {
  viewMonth += dir;
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  if (viewMonth < 0)  { viewMonth = 11; viewYear--; }
  recalc();
}

// ===== Filter toggles =====
function toggleFilter(type) {
  filters[type] = !filters[type];
  const btn = document.getElementById('btn-' + type);
  btn.className = filters[type] ? 'filter-btn active-' + type : 'filter-btn';
  recalc();
}

// ===== PRINT =====
function doPrint() {
  window.print();
}

// ===== PDF FREEMIUM =====
const PDF_EMAIL_KEY = 'lazyshift-pdf-email';
const PDF_DATE_KEY  = 'lazyshift-pdf-date';

function canExportPdfFree() {
  if (currentUser) return true;
  const email = localStorage.getItem(PDF_EMAIL_KEY);
  const dateStr = localStorage.getItem(PDF_DATE_KEY);
  if (email && dateStr) {
    const diffDays = (new Date() - new Date(dateStr)) / (1000 * 60 * 60 * 24);
    if (diffDays <= 365) return true;
    return false;
  }
  return false;
}

function isPdfEmailRegistered() {
  return !!localStorage.getItem(PDF_EMAIL_KEY);
}

function registerPdfEmail(email) {
  localStorage.setItem(PDF_EMAIL_KEY, email);
  localStorage.setItem(PDF_DATE_KEY, new Date().toISOString());
}

async function savePdfEmailToSupabase(email) {
  try {
    await sb.from('pdf_subscribers').upsert({ email, registered_at: new Date().toISOString() }, { onConflict: 'email' });
  } catch(e) { /* non-critical */ }
}

function tryExportPdf() {
  if (currentUser || canExportPdfFree()) {
    generateAndDownloadPdf();
    return;
  }
  showPdfModal();
}

function showPdfModal() {
  const alreadyExpired = isPdfEmailRegistered();
  document.getElementById('pdf-modal').style.display = 'flex';
  const sub = document.getElementById('pdf-modal-sub');
  if (alreadyExpired) {
    sub.textContent = 'Your free year has expired. Register your email again for another year of free PDF exports.';
  } else {
    sub.textContent = 'Enter your email address and get 1 year of free PDF exports.';
  }
}

function closePdfModal() {
  document.getElementById('pdf-modal').style.display = 'none';
}

async function confirmPdfEmail() {
  const email = document.getElementById('pdf-email-input').value.trim();
  if (!email || !email.includes('@')) {
    document.getElementById('pdf-modal-error').textContent = 'Please enter a valid email address.';
    document.getElementById('pdf-modal-error').style.display = 'block';
    return;
  }
  registerPdfEmail(email);
  await savePdfEmailToSupabase(email);
  closePdfModal();
  generateAndDownloadPdf();
}

function generateAndDownloadPdf() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', 'light');
  document.body.classList.add('printing-pdf');

  setTimeout(() => {
    window.print();
    setTimeout(() => {
      document.documentElement.setAttribute('data-theme', currentTheme);
      document.body.classList.remove('printing-pdf');
    }, 500);
  }, 100);
}

// ===== Event Listeners =====
document.getElementById('shift-type').addEventListener('change', () => {
  updateShiftTypeUI();
  recalc();
  saveSettings();
});

document.getElementById('prev-month').addEventListener('click', () => changeMonth(-1));
document.getElementById('next-month').addEventListener('click', () => changeMonth(1));
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => toggleFilter(btn.dataset.type));
});
document.getElementById('btn-edit-co').addEventListener('click', () => setEditMode('co'));
document.getElementById('btn-edit-cm').addEventListener('click', () => setEditMode('cm'));
document.getElementById('btn-clear-co').addEventListener('click', () => {
  if (coDays.size === 0 && cmDays.size === 0) return;
  if (!confirm('Delete all marked Annual Leave and Sick Leave days?')) return;
  coDays.clear(); cmDays.clear();
  editMode = null; updateEditModeUI();
  recalc(); saveSettings();
});

document.addEventListener('DOMContentLoaded', () => {
  const hoursInput = document.getElementById('custom-hours-input');
  if (hoursInput) {
    hoursInput.addEventListener('change', () => {
      recalc();
      saveSettings();
    });
  }
});

// ===== PWA Install =====
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('pwa-install-btn').style.display = 'block';
});
document.getElementById('pwa-install-btn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') document.getElementById('pwa-install-btn').style.display = 'none';
  deferredPrompt = null;
});

// ===== Reset Password =====
function showResetPassword() {
  document.getElementById('auth-overlay').style.display = 'none';
  document.getElementById('reset-email').value = document.getElementById('auth-email').value || '';
  document.getElementById('reset-error').style.display = 'none';
  document.getElementById('reset-sub').textContent = "Enter the email you registered with and we'll send you a reset link.";
  document.getElementById('reset-overlay').style.display = 'flex';
}

function closeResetPassword() {
  document.getElementById('reset-overlay').style.display = 'none';
  document.getElementById('auth-overlay').style.display = 'flex';
}

async function doResetPassword() {
  const email = document.getElementById('reset-email').value.trim();
  const errEl = document.getElementById('reset-error');
  errEl.style.display = 'none';

  if (!email || !email.includes('@')) {
    errEl.textContent = 'Please enter a valid email address.';
    errEl.style.display = 'block';
    return;
  }

  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });

  if (error) {
    errEl.textContent = 'Error sending email. Please try again.';
    errEl.style.display = 'block';
    return;
  }

  document.getElementById('reset-sub').textContent = '✅ Email sent! Check your inbox (and Spam folder). The link is valid for 1 hour.';
  document.getElementById('reset-email').style.display = 'none';
  document.querySelector('#reset-overlay .auth-btn:not(.ghost)').style.display = 'none';
}

function openAuth() {
  closeDropdown();
  document.getElementById('auth-overlay').style.display = 'flex';
}

function closeAuth() {
  document.getElementById('auth-overlay').style.display = 'none';
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
}

async function doLogin() {
  const email = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-pass').value;
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) { showAuthError('Incorrect email or password.'); return; }
  closeAuth();
}

async function doRegister() {
  const email = document.getElementById('auth-email').value.trim();
  const pass  = document.getElementById('auth-pass').value;
  if (pass.length < 6) { showAuthError('Password must be at least 6 characters.'); return; }
  const { error } = await sb.auth.signUp({ email, password: pass });
  if (error) { showAuthError('Error creating account. Please try again.'); return; }

  document.getElementById('auth-box-inner').innerHTML = `
    <div style="text-align:center; padding: 0.5rem 0;">
      <div style="font-size: 48px; margin-bottom: 1rem;">👷</div>
      <h2 class="auth-title" style="margin-bottom: 0.75rem;">You're officially a boss!</h2>
      <p class="auth-sub" style="margin-bottom: 1.25rem; line-height: 1.6;">
        If you use LazyShift, it means your shifts don't control you —
        <strong>you control them.</strong><br><br>
        Welcome to the crew! 💪
      </p>
      <button class="auth-btn" onclick="closeAuth(); location.reload();">Let's get to work!</button>
    </div>
  `;
}

async function doLogout() {
  closeDropdown();
  await sb.auth.signOut();
}

// ===== Dropdown =====
function toggleDropdown() {
  const dd = document.getElementById('user-dropdown');
  dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
}

function closeDropdown() {
  document.getElementById('user-dropdown').style.display = 'none';
}

document.addEventListener('click', (e) => {
  const dd  = document.getElementById('user-dropdown');
  const btn = document.getElementById('login-btn');
  const modal = document.getElementById('pdf-modal');
  if (!dd.contains(e.target) && !btn.contains(e.target)) closeDropdown();
  if (modal && e.target === modal) closePdfModal();
});

// ===== Update UI after auth =====
function updateUserBar(user) {
  const btn     = document.getElementById('login-btn');
  const notice  = document.getElementById('nav-notice');
  const prevBtn = document.getElementById('prev-month');
  const nextBtn = document.getElementById('next-month');
  const ddName  = document.getElementById('dropdown-name');
  const ddEmail = document.getElementById('dropdown-email');

  if (user) {
    currentUser = user;
    const name = user.email.split('@')[0];
    btn.textContent = '👤 ' + name;
    btn.className   = 'user-btn logged-in';
    btn.onclick     = toggleDropdown;
    ddName.textContent  = name;
    ddEmail.textContent = user.email;
    notice.style.display  = 'none';
    prevBtn.disabled = false;
    nextBtn.disabled = false;
  } else {
    currentUser = null;
    btn.textContent = 'Sign in';
    btn.className   = 'user-btn';
    btn.onclick     = openAuth;
    viewYear  = today.getFullYear();
    viewMonth = today.getMonth();
    notice.style.display  = 'none';
    prevBtn.disabled = false;
    nextBtn.disabled = false;
    recalc();
  }
}

// ===== Auth State =====
sb.auth.onAuthStateChange(async (event, session) => {
  const user = session?.user ?? null;
  updateUserBar(user);
  if (user) await loadSettings();
});

// ===== Init =====
(function checkPasswordReset() {
  const hash = window.location.hash;
  if (hash.includes('type=recovery')) {
    setTimeout(() => showNewPasswordForm(), 300);
  }
})();

function showNewPasswordForm() {
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('auth-box-inner').innerHTML = `
    <div style="font-size:36px; text-align:center; margin-bottom:0.5rem;">🔐</div>
    <h2 class="auth-title">New Password</h2>
    <p class="auth-sub">Choose a new password for your account.</p>
    <div id="newpass-error" class="auth-error" style="display:none"></div>
    <input type="password" id="new-pass-1" placeholder="New password" class="auth-input" />
    <input type="password" id="new-pass-2" placeholder="Confirm password" class="auth-input" />
    <button class="auth-btn" onclick="doSetNewPassword()">Save new password</button>
  `;
}

async function doSetNewPassword() {
  const p1 = document.getElementById('new-pass-1').value;
  const p2 = document.getElementById('new-pass-2').value;
  const errEl = document.getElementById('newpass-error');
  errEl.style.display = 'none';

  if (p1.length < 6) {
    errEl.textContent = 'Password must be at least 6 characters.';
    errEl.style.display = 'block';
    return;
  }
  if (p1 !== p2) {
    errEl.textContent = 'Passwords do not match.';
    errEl.style.display = 'block';
    return;
  }

  const { error } = await sb.auth.updateUser({ password: p1 });
  if (error) {
    errEl.textContent = 'Error saving password. Please try again.';
    errEl.style.display = 'block';
    return;
  }

  document.getElementById('auth-box-inner').innerHTML = `
    <div style="text-align:center; padding: 0.5rem 0;">
      <div style="font-size:48px; margin-bottom:1rem;">✅</div>
      <h2 class="auth-title" style="margin-bottom:0.75rem;">Password saved!</h2>
      <p class="auth-sub" style="margin-bottom:1.25rem;">You're now signed in. Welcome back!</p>
      <button class="auth-btn" onclick="closeAuth()">Let's go!</button>
    </div>
  `;
  history.replaceState(null, '', window.location.pathname);
}

updateShiftTypeUI();
recalc();
