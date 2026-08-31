// ============================================================
// SCHEMA VERSION
// ============================================================
// Lets future changes detect and migrate old data instead of silently
// breaking when a field is missing from data saved under an older shape.
const CURRENT_SCHEMA_VERSION = 3;

function getSchemaVersion() {
  return parseInt(localStorage.getItem('schemaVersion')) || 1;
}
function setSchemaVersion(v) {
  localStorage.setItem('schemaVersion', String(v));
}
// No migrations exist yet since this is the first versioned release.
// Future changes add steps here, e.g.: if (getSchemaVersion() < 4) { ...migrate...; setSchemaVersion(4); }
setSchemaVersion(CURRENT_SCHEMA_VERSION);

// ============================================================
// DATA LAYER
// ============================================================

function getDrills() {
  const raw = localStorage.getItem('drills');
  return raw ? JSON.parse(raw) : [];
}
function saveDrills(drills) {
  localStorage.setItem('drills', JSON.stringify(drills));
}
function getDrillById(id) {
  return getDrills().find((d) => String(d.id) === String(id)) || null;
}

// Fixed tag set covering practical range constraints (e.g. indoor ranges that
// prohibit movement). Not mutually exclusive - a drill can carry more than one.
const DRILL_TAGS = [
  { value: 'static', label: 'Static / No Movement' },
  { value: 'movement', label: 'Movement Required' },
  { value: 'indoor', label: 'Indoor Compatible' },
  { value: 'outdoor-only', label: 'Outdoor Only' },
];
function drillTagLabel(value) {
  const tag = DRILL_TAGS.find((t) => t.value === value);
  return tag ? tag.label : value;
}

function getSessions() {
  const raw = localStorage.getItem('sessions');
  return raw ? JSON.parse(raw) : [];
}
function saveSessions(sessions) {
  localStorage.setItem('sessions', JSON.stringify(sessions));
}

function getTemplates() {
  const raw = localStorage.getItem('templates');
  return raw ? JSON.parse(raw) : [];
}
function saveTemplates(templates) {
  localStorage.setItem('templates', JSON.stringify(templates));
}

function getActiveSessionId() {
  return localStorage.getItem('activeSessionId');
}
function setActiveSessionId(id) {
  if (id === null) {
    localStorage.removeItem('activeSessionId');
  } else {
    localStorage.setItem('activeSessionId', id);
  }
}
function findActiveSession() {
  const id = getActiveSessionId();
  if (!id) return null;
  return getSessions().find((s) => String(s.id) === String(id)) || null;
}

// ============================================================
// SCORING (generalized across scoring types)
// ============================================================

const POINTS_MINOR = { a: 5, c: 3, d: 1, m: 0, ns: -10 };
const POINTS_MAJOR = { a: 5, c: 4, d: 2, m: 0, ns: -10 };

// Builds the correct result object shape based on the drill's scoringType.
// This is the one place that needs to know about all three scoring types.
function buildStringResult(drill, timeSeconds, inputs) {
  const base = {
    id: Date.now(),
    timeSeconds,
    scoringType: drill.scoringType,
    loggedAt: new Date().toISOString(),
  };

  if (drill.scoringType === 'uspsa_zones') {
    const table = drill.powerFactor === 'major' ? POINTS_MAJOR : POINTS_MINOR;
    const hits = inputs.hits;
    const points =
      hits.a * table.a + hits.c * table.c + hits.d * table.d +
      hits.m * table.m + hits.ns * table.ns;
    const hitFactor = timeSeconds > 0 ? Math.round((points / timeSeconds) * 100) / 100 : 0;
    return { ...base, hits, points, hitFactor };
  }

  if (drill.scoringType === 'hit_miss') {
    const hitsCount = inputs.hitsCount;
    const missesCount = inputs.missesCount;
    const total = hitsCount + missesCount;
    const accuracyPercent = total > 0 ? Math.round((hitsCount / total) * 1000) / 10 : 0;
    const rate = timeSeconds > 0 ? Math.round((hitsCount / timeSeconds) * 100) / 100 : 0;
    return { ...base, hitsCount, missesCount, accuracyPercent, rate };
  }

  // time_only: no accuracy fields at all - time itself is the metric.
  return base;
}

// Storage stays ISO (YYYY-MM-DD) since it sorts correctly as plain text and
// is what JS Date parsing expects - only the display format changes here.
function formatDate(isoDateString) {
  if (!isoDateString) return '';
  const [year, month, day] = isoDateString.split('-');
  return `${month}/${day}/${year}`;
}

// Human-readable one-liner for a logged string, used in session, history, and PR views.
// Omits zero-value fields (e.g. no Misses, no No-Shoots) to keep it uncluttered.
function formatStringSummary(s) {
  if (s.scoringType === 'uspsa_zones') {
    const zoneParts = [];
    if (s.hits.a > 0) zoneParts.push(`A:${s.hits.a}`);
    if (s.hits.c > 0) zoneParts.push(`C:${s.hits.c}`);
    if (s.hits.d > 0) zoneParts.push(`D:${s.hits.d}`);
    if (s.hits.m > 0) zoneParts.push(`M:${s.hits.m}`);
    if (s.hits.ns > 0) zoneParts.push(`NS:${s.hits.ns}`);
    const zoneText = zoneParts.length > 0 ? zoneParts.join(' ') : 'No hits recorded';
    return `${s.timeSeconds}s — ${zoneText} — HF:${s.hitFactor}`;
  }
  if (s.scoringType === 'hit_miss') {
    const parts = [`${s.hitsCount} hits`];
    if (s.missesCount > 0) parts.push(`${s.missesCount} misses`); // only shown if there were any
    return `${s.timeSeconds}s — ${parts.join(' / ')} — ${s.accuracyPercent}% — Rate:${s.rate}/s`;
  }
  return `${s.timeSeconds}s`;
}

// ============================================================
// PERSONAL RECORDS (generalized)
// ============================================================

function getAllDrillStats() {
  const statsMap = {};

  getSessions().forEach((session) => {
    session.drillEntries.forEach((entry) => {
      if (!statsMap[entry.drillId]) {
        const drill = getDrillById(entry.drillId);
        statsMap[entry.drillId] = {
          drillId: entry.drillId,
          drillName: entry.drillName,
          scoringType: drill ? drill.scoringType : 'time_only',
          bestTime: null,
          bestHitFactor: null,
          bestRate: null,
          totalStrings: 0,
        };
      }
      const stat = statsMap[entry.drillId];

      entry.strings.forEach((s) => {
        stat.totalStrings++;
        if (stat.bestTime === null || s.timeSeconds < stat.bestTime) {
          stat.bestTime = s.timeSeconds;
        }
        if (s.scoringType === 'uspsa_zones' && (stat.bestHitFactor === null || s.hitFactor > stat.bestHitFactor)) {
          stat.bestHitFactor = s.hitFactor;
        }
        if (s.scoringType === 'hit_miss' && (stat.bestRate === null || s.rate > stat.bestRate)) {
          stat.bestRate = s.rate;
        }
      });
    });
  });

  return Object.values(statsMap);
}
function getDrillStat(drillId) {
  return getAllDrillStats().find((stat) => stat.drillId === drillId) || null;
}

// Shared PR check - a string counts as a PR if it matches the all-time best
// for its metric (time, hit factor, or rate depending on scoring type).
function isStringAPR(stat, s) {
  if (!stat) return false;
  const isBestTime = s.timeSeconds === stat.bestTime;
  const isBestHF = s.scoringType === 'uspsa_zones' && s.hitFactor === stat.bestHitFactor && s.hitFactor > 0;
  const isBestRate = s.scoringType === 'hit_miss' && s.rate === stat.bestRate && s.rate > 0;
  return isBestTime || isBestHF || isBestRate;
}

// The best string logged THIS SESSION for a given drill entry - independent
// of all-time PR status, which is checked separately via isStringAPR.
function getBestStringInEntry(entry, drill) {
  if (!entry.strings.length) return null;
  if (drill.scoringType === 'uspsa_zones') {
    return entry.strings.reduce((best, s) => (s.hitFactor > best.hitFactor ? s : best));
  }
  if (drill.scoringType === 'hit_miss') {
    return entry.strings.reduce((best, s) => (s.rate > best.rate ? s : best));
  }
  return entry.strings.reduce((best, s) => (s.timeSeconds < best.timeSeconds ? s : best)); // time_only: lowest wins
}

function renderPRList() {
  const stats = getAllDrillStats().sort((a, b) => a.drillName.localeCompare(b.drillName));
  const listEl = document.getElementById('pr-list');

  if (stats.length === 0) {
    listEl.innerHTML = `<p class="empty-state">No strings logged yet.</p>`;
    return;
  }

  listEl.innerHTML = stats.map((stat) => {
    const secondaryStat =
      stat.scoringType === 'uspsa_zones'
        ? `<div class="pr-stat"><span class="pr-label">Best Hit Factor</span><span class="pr-value">${stat.bestHitFactor}</span></div>`
        : stat.scoringType === 'hit_miss'
        ? `<div class="pr-stat"><span class="pr-label">Best Rate</span><span class="pr-value">${stat.bestRate}/s</span></div>`
        : '';

    return `
      <div class="pr-card">
        <h3>${stat.drillName}</h3>
        <div class="pr-row">
          <div class="pr-stat">
            <span class="pr-label">Best Time</span>
            <span class="pr-value">${stat.bestTime}s</span>
          </div>
          ${secondaryStat}
        </div>
        <p class="pr-count">${stat.totalStrings} string${stat.totalStrings === 1 ? '' : 's'} logged</p>
      </div>
    `;
  }).join('');
}

// ============================================================
// VIEW STATE
// ============================================================

let currentView = 'main'; // 'main', 'history', 'prs', 'historyDetail', 'drills', or 'templates'
let editingContext = null; // { entryIndex, stringId } while editing a logged string, else null
let openMenuStringId = null; // which string's three-dot menu is currently open, if any
let viewingSessionId = null; // which past session is open in historyDetail view, if any
let editingDrillId = null; // which drill (in the library) has its edit form open, if any
let currentDrillDetailId = null; // which drill's popup is open, if any
let currentDrillDetailTab = 'about'; // 'about', 'history', 'chart', or 'records'

function openDrillDetail(drillId) {
  currentDrillDetailId = drillId;
  currentDrillDetailTab = 'about';
  document.getElementById('drill-detail-overlay').classList.remove('hidden');
  document.querySelectorAll('.drill-detail-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === 'about');
  });
  renderDrillDetailContent();
}

function closeDrillDetail() {
  currentDrillDetailId = null;
  document.getElementById('drill-detail-overlay').classList.add('hidden');
}

function switchDrillDetailTab(tab) {
  currentDrillDetailTab = tab;
  document.querySelectorAll('.drill-detail-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  renderDrillDetailContent();
}

// Every string ever logged for a drill, across every session, with session
// context attached - the shared data source for the History, Chart, and Records tabs.
function getAllStringsForDrill(drillId) {
  const results = [];
  getSessions().forEach((session) => {
    session.drillEntries.forEach((entry) => {
      if (String(entry.drillId) !== String(drillId)) return;
      entry.strings.forEach((s) => {
        results.push({ ...s, sessionName: session.name || 'Untitled Session', sessionDate: session.date });
      });
    });
  });
  results.sort((a, b) => new Date(a.loggedAt) - new Date(b.loggedAt)); // chronological, oldest first
  return results;
}

function renderDrillDetailContent() {
  const drill = getDrillById(currentDrillDetailId);
  const nameEl = document.getElementById('drill-detail-name');
  const contentEl = document.getElementById('drill-detail-content');

  if (!drill) {
    contentEl.innerHTML = `<p class="empty-state">Drill not found.</p>`;
    return;
  }
  nameEl.textContent = drill.name;

  if (currentDrillDetailTab === 'about') contentEl.innerHTML = renderDrillDetailAbout(drill);
  else if (currentDrillDetailTab === 'history') contentEl.innerHTML = renderDrillDetailHistory(drill);
  else if (currentDrillDetailTab === 'chart') contentEl.innerHTML = renderDrillDetailChart(drill);
  else if (currentDrillDetailTab === 'records') contentEl.innerHTML = renderDrillDetailRecords(drill);
}

function renderDrillDetailAbout(drill) {
  const rows = [];
  rows.push(`<div class="detail-row"><span class="detail-label">Discipline</span><span class="detail-value">${drill.discipline === 'rifle' ? 'Rifle' : 'Pistol'}</span></div>`);

  const scoringLabel = drill.scoringType === 'uspsa_zones'
    ? `USPSA Zones (${drill.powerFactor === 'major' ? 'Major' : 'Minor'})`
    : drill.scoringType === 'hit_miss' ? 'Hits vs Misses' : 'Time Only';
  rows.push(`<div class="detail-row"><span class="detail-label">Scoring</span><span class="detail-value">${scoringLabel}</span></div>`);

  if (drill.roundCount) rows.push(`<div class="detail-row"><span class="detail-label">Round Count</span><span class="detail-value">${drill.roundCount}</span></div>`);
  if (drill.targetCount) rows.push(`<div class="detail-row"><span class="detail-label">Target Count</span><span class="detail-value">${drill.targetCount}</span></div>`);
  if (drill.parTime) rows.push(`<div class="detail-row"><span class="detail-label">Par Time</span><span class="detail-value">${drill.parTime}s</span></div>`);
  if (drill.tags && drill.tags.length > 0) {
    rows.push(`<div class="detail-row"><span class="detail-label">Tags</span><span class="detail-value">${drill.tags.map(drillTagLabel).join(', ')}</span></div>`);
  }

  return `<div class="detail-about">${rows.join('')}</div><p class="detail-note">Diagram support coming in a future update.</p>`;
}

function renderDrillDetailHistory(drill) {
  const strings = [...getAllStringsForDrill(drill.id)].reverse(); // most recent first
  if (strings.length === 0) return `<p class="empty-state">No strings logged for this drill yet.</p>`;

  return `<div class="detail-history-list">${strings.map((s) => `
    <div class="detail-history-row">
      <span class="detail-history-date">${formatDate(s.sessionDate)} &middot; ${s.sessionName}</span>
      <span class="detail-history-line">${formatStringSummary(s)}</span>
    </div>
  `).join('')}</div>`;
}

function renderDrillDetailRecords(drill) {
  const stat = getDrillStat(drill.id);
  if (!stat) return `<p class="empty-state">No strings logged for this drill yet.</p>`;

  const summaryParts = [`<div class="detail-row"><span class="detail-label">Best Time</span><span class="detail-value">${stat.bestTime}s</span></div>`];
  if (drill.scoringType === 'uspsa_zones') {
    summaryParts.push(`<div class="detail-row"><span class="detail-label">Best Hit Factor</span><span class="detail-value">${stat.bestHitFactor}</span></div>`);
  }
  if (drill.scoringType === 'hit_miss') {
    summaryParts.push(`<div class="detail-row"><span class="detail-label">Best Rate</span><span class="detail-value">${stat.bestRate}/s</span></div>`);
  }

  const strings = getAllStringsForDrill(drill.id);
  // Ranks by the metric that matters for this scoring type - for time_only, lower is better, so negate for a descending sort.
  const metricFor = (s) => drill.scoringType === 'uspsa_zones' ? s.hitFactor
    : drill.scoringType === 'hit_miss' ? s.rate
    : -s.timeSeconds;
  const ranked = [...strings].sort((a, b) => metricFor(b) - metricFor(a)).slice(0, 5);

  const rankedHtml = ranked.map((s, i) => `
    <div class="detail-history-row">
      <span class="detail-history-date">#${i + 1} &middot; ${formatDate(s.sessionDate)}</span>
      <span class="detail-history-line">${formatStringSummary(s)}</span>
    </div>
  `).join('');

  return `<div class="detail-about">${summaryParts.join('')}</div><h4 class="detail-subheading">Top Attempts</h4>${rankedHtml || '<p class="empty-state">Not enough data yet.</p>'}`;
}

function renderDrillDetailChart(drill) {
  const strings = getAllStringsForDrill(drill.id); // already chronological, oldest first
  if (strings.length < 2) return `<p class="empty-state">Log at least 2 strings for this drill to see a trend chart.</p>`;

  let metricLabel, betterDirection, values;
  if (drill.scoringType === 'uspsa_zones') {
    metricLabel = 'Hit Factor'; betterDirection = 'up'; values = strings.map((s) => s.hitFactor);
  } else if (drill.scoringType === 'hit_miss') {
    metricLabel = 'Rate (hits/sec)'; betterDirection = 'up'; values = strings.map((s) => s.rate);
  } else {
    metricLabel = 'Time (seconds)'; betterDirection = 'down'; values = strings.map((s) => s.timeSeconds);
  }

  const directionNote = betterDirection === 'up' ? 'Higher is better' : 'Lower is better';
  return `<p class="chart-metric-label">${metricLabel} &middot; ${directionNote}</p>${buildLineChartSvg(values)}`;
}

// Dependency-free SVG line chart - no external chart library, so the drill
// popup keeps working offline at the range like everything else in this app.
function buildLineChartSvg(values) {
  const width = 280;
  const height = 140;
  const padding = 24;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1; // avoid divide-by-zero if every value is identical

  const points = values.map((v, i) => {
    const x = padding + (i / (values.length - 1)) * (width - padding * 2);
    const y = height - padding - ((v - min) / range) * (height - padding * 2);
    return { x, y };
  });

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const dots = points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#4da6ff" />`).join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" class="drill-chart-svg">
      <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#333" stroke-width="1" />
      <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#333" stroke-width="1" />
      <path d="${pathD}" fill="none" stroke="#4da6ff" stroke-width="2" />
      ${dots}
      <text x="${padding}" y="${padding - 6}" fill="#888" font-size="9">${max}</text>
      <text x="${padding}" y="${height - padding + 12}" fill="#888" font-size="9">${min}</text>
    </svg>
  `;
}
let editingTemplateId = null; // null = creating a new template; else id of template being edited
let pendingTemplateDrillIds = []; // ordered drill ids being assembled into a template

// Resolves to whichever session the editing controls should currently act on -
// the live active session normally, or a past session while viewing its detail.
// This lets logString/updateString/deleteString/etc. work unchanged in both contexts.
function getEditableSession() {
  if (currentView === 'historyDetail' && viewingSessionId) {
    return getSessions().find((s) => String(s.id) === String(viewingSessionId)) || null;
  }
  return findActiveSession();
}

function openHistorySession(sessionId) {
  viewingSessionId = sessionId;
  currentView = 'historyDetail';
  renderApp();
}

function closeHistorySession() {
  viewingSessionId = null;
  currentView = 'history';
  renderApp();
}

function showDrillLibrary() {
  currentView = 'drills';
  renderApp();
}
function hideDrillLibrary() {
  editingDrillId = null;
  currentView = 'main';
  renderApp();
}

function startEditDrill(drillId) {
  editingDrillId = drillId;
  renderApp();
}
function cancelEditDrill() {
  editingDrillId = null;
  renderApp();
}

function saveDrillEdits(drillId) {
  const card = document.querySelector(`.drill-lib-card[data-drill-id="${drillId}"]`);
  if (!card) return;

  const newName = card.querySelector('.edit-drill-name').value.trim();
  if (!newName) {
    alert('Drill name cannot be empty.');
    return;
  }

  const drills = getDrills();
  const drill = drills.find((d) => String(d.id) === String(drillId));
  if (!drill) return;

  const oldName = drill.name;
  drill.name = newName;
  drill.discipline = card.querySelector('.edit-drill-discipline').value;
  drill.scoringType = card.querySelector('.edit-drill-scoring-type').value;
  drill.powerFactor = card.querySelector('.edit-drill-power-factor').value;
  drill.roundCount = parseInt(card.querySelector('.edit-drill-round-count').value) || null;
  drill.targetCount = parseInt(card.querySelector('.edit-drill-target-count').value) || null;
  drill.parTime = parseFloat(card.querySelector('.edit-drill-par-time').value) || null;
  drill.tags = Array.from(card.querySelectorAll('.edit-drill-tags input:checked')).map((cb) => cb.value);

  saveDrills(drills);

  // Keep the denormalized drillName snapshot in sync everywhere it's stored,
  // so a rename shows up consistently in session history and PRs, not just here.
  if (oldName !== newName) {
    const sessions = getSessions();
    sessions.forEach((s) => {
      s.drillEntries.forEach((e) => {
        if (String(e.drillId) === String(drillId)) e.drillName = newName;
      });
    });
    saveSessions(sessions);
  }

  editingDrillId = null;
  renderApp();
}

function renderDrillLibrary() {
  const drills = [...getDrills()].sort((a, b) => a.name.localeCompare(b.name));
  const listEl = document.getElementById('drill-library-list');

  if (drills.length === 0) {
    listEl.innerHTML = `<p class="empty-state">No drills yet - drills you add during a session will appear here.</p>`;
    return;
  }

  listEl.innerHTML = drills.map((drill) => {
    if (String(editingDrillId) === String(drill.id)) {
      return `
        <div class="drill-lib-card editing" data-drill-id="${drill.id}">
          <label>Name</label>
          <input type="text" class="edit-drill-name" value="${drill.name}">

          <label>Discipline</label>
          <select class="edit-drill-discipline">
            <option value="pistol" ${drill.discipline === 'pistol' ? 'selected' : ''}>Pistol</option>
            <option value="rifle" ${drill.discipline === 'rifle' ? 'selected' : ''}>Rifle</option>
          </select>

          <label>Scoring Type</label>
          <select class="edit-drill-scoring-type">
            <option value="uspsa_zones" ${drill.scoringType === 'uspsa_zones' ? 'selected' : ''}>USPSA Zones (A/C/D/M/NS)</option>
            <option value="hit_miss" ${drill.scoringType === 'hit_miss' ? 'selected' : ''}>Hits vs Misses</option>
            <option value="time_only" ${drill.scoringType === 'time_only' ? 'selected' : ''}>Time Only</option>
          </select>

          <div class="edit-drill-power-factor-row" style="display: ${drill.scoringType === 'uspsa_zones' ? 'flex' : 'none'}">
            <label>Power Factor</label>
            <select class="edit-drill-power-factor">
              <option value="minor" ${drill.powerFactor !== 'major' ? 'selected' : ''}>Minor</option>
              <option value="major" ${drill.powerFactor === 'major' ? 'selected' : ''}>Major</option>
            </select>
          </div>

          <label>Round Count</label>
          <input type="number" inputmode="numeric" pattern="[0-9]*" class="edit-drill-round-count" value="${drill.roundCount || ''}">

          <label>Target Count</label>
          <input type="number" inputmode="numeric" pattern="[0-9]*" class="edit-drill-target-count" value="${drill.targetCount || ''}">

          <label>Par Time (optional, seconds)</label>
          <input type="number" step="0.01" inputmode="decimal" class="edit-drill-par-time" value="${drill.parTime || ''}">

          <label>Tags</label>
          <div class="tag-checkboxes edit-drill-tags">
            ${DRILL_TAGS.map((t) => `
              <label class="tag-checkbox">
                <input type="checkbox" value="${t.value}" ${drill.tags && drill.tags.includes(t.value) ? 'checked' : ''}> ${t.label}
              </label>
            `).join('')}
          </div>

          <div class="edit-drill-actions">
            <button class="save-drill-edit-btn" data-drill-id="${drill.id}">Save</button>
            <button class="cancel-drill-edit-btn secondary">Cancel</button>
          </div>
        </div>
      `;
    }

    const metaParts = [
      drill.discipline === 'rifle' ? 'Rifle' : 'Pistol',
      drill.scoringType === 'uspsa_zones' ? `USPSA Zones (${drill.powerFactor === 'major' ? 'Major' : 'Minor'})`
        : drill.scoringType === 'hit_miss' ? 'Hits/Misses'
        : 'Time Only',
    ];
    if (drill.roundCount) metaParts.push(`${drill.roundCount} rounds`);
    if (drill.targetCount) metaParts.push(`${drill.targetCount} targets`);
    if (drill.parTime) metaParts.push(`Par ${drill.parTime}s`);

    const tagsLine = (drill.tags && drill.tags.length > 0)
      ? `<p class="drill-lib-tags">${drill.tags.map(drillTagLabel).join(' &middot; ')}</p>`
      : '';

    return `
      <div class="drill-lib-card" data-drill-id="${drill.id}">
        <div class="drill-lib-header">
          <h3><button class="drill-name-link" data-drill-id="${drill.id}">${drill.name}</button></h3>
          <button class="edit-drill-lib-btn" data-drill-id="${drill.id}">Edit</button>
        </div>
        <p class="drill-lib-meta">${metaParts.join(' &middot; ')}</p>
        ${tagsLine}
      </div>
    `;
  }).join('');
}

function showTemplatesView() {
  currentView = 'templates';
  renderApp();
}
function hideTemplatesView() {
  currentView = 'main';
  cancelTemplateSetup();
}

function openNewTemplateSetup() {
  editingTemplateId = null;
  pendingTemplateDrillIds = [];
  document.getElementById('template-setup-title').textContent = 'New Template';
  document.getElementById('template-name-input').value = '';
  document.getElementById('template-setup').classList.remove('hidden');
  renderTemplateDrillOptions();
  renderTemplateDrillList();
}

function openEditTemplateSetup(templateId) {
  const template = getTemplates().find((t) => String(t.id) === String(templateId));
  if (!template) return;
  editingTemplateId = templateId;
  pendingTemplateDrillIds = [...template.drillIds];
  document.getElementById('template-setup-title').textContent = 'Edit Template';
  document.getElementById('template-name-input').value = template.name;
  document.getElementById('template-setup').classList.remove('hidden');
  renderTemplateDrillOptions();
  renderTemplateDrillList();
}

function cancelTemplateSetup() {
  editingTemplateId = null;
  pendingTemplateDrillIds = [];
  const panel = document.getElementById('template-setup');
  if (panel) panel.classList.add('hidden');
  renderApp();
}

function renderTemplateDrillOptions() {
  const select = document.getElementById('template-add-drill-select');
  select.innerHTML = '<option value="">Select a drill...</option>' +
    getDrills().map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
}

function renderTemplateDrillList() {
  const listEl = document.getElementById('template-drill-list');
  if (pendingTemplateDrillIds.length === 0) {
    listEl.innerHTML = `<p class="empty-state">No drills added yet.</p>`;
    return;
  }
  listEl.innerHTML = pendingTemplateDrillIds.map((drillId, index) => {
    const drill = getDrillById(drillId);
    if (!drill) return '';
    return `
      <div class="template-drill-row">
        <span>${index + 1}. ${drill.name}</span>
        <button class="remove-template-drill-btn" data-index="${index}">&times;</button>
      </div>
    `;
  }).join('');
}

// Drills used in a template must already exist in the library - templates
// assemble existing drills rather than defining new ones inline.
function addDrillToTemplateSetup() {
  const select = document.getElementById('template-add-drill-select');
  const drillId = select.value;
  if (!drillId) return;

  if (pendingTemplateDrillIds.includes(drillId) || pendingTemplateDrillIds.map(String).includes(String(drillId))) {
    select.value = '';
    return;
  }

  pendingTemplateDrillIds.push(drillId);
  select.value = '';
  renderTemplateDrillList();
}

function removeDrillFromTemplateSetup(index) {
  pendingTemplateDrillIds.splice(index, 1);
  renderTemplateDrillList();
}

function saveTemplate() {
  const name = document.getElementById('template-name-input').value.trim();
  if (!name) {
    alert('Give this template a name.');
    return;
  }
  if (pendingTemplateDrillIds.length === 0) {
    alert('Add at least one drill to this template.');
    return;
  }

  const templates = getTemplates();

  if (editingTemplateId) {
    const template = templates.find((t) => String(t.id) === String(editingTemplateId));
    if (template) {
      template.name = name;
      template.drillIds = [...pendingTemplateDrillIds];
    }
  } else {
    templates.push({
      id: Date.now(),
      name,
      drillIds: [...pendingTemplateDrillIds],
      createdAt: new Date().toISOString(),
    });
  }

  saveTemplates(templates);
  cancelTemplateSetup();
}

function deleteTemplate(templateId) {
  if (!confirm('Delete this template? Sessions already started from it are not affected.')) return;
  saveTemplates(getTemplates().filter((t) => String(t.id) !== String(templateId)));
  renderApp();
}

// Sums round count / target count across a template's drills, straight from
// the same drill metadata already used everywhere else - nothing template-specific to maintain.
function getTemplateStats(template) {
  let totalRounds = 0;
  let totalTargets = 0;
  template.drillIds.forEach((id) => {
    const drill = getDrillById(id);
    if (drill) {
      if (drill.roundCount) totalRounds += drill.roundCount;
      if (drill.targetCount) totalTargets += drill.targetCount;
    }
  });
  return { drillCount: template.drillIds.length, totalRounds, totalTargets };
}

function renderTemplatesList() {
  const templates = getTemplates();
  const listEl = document.getElementById('templates-list');

  if (templates.length === 0) {
    listEl.innerHTML = `<p class="empty-state">No templates yet.</p>`;
    return;
  }

  listEl.innerHTML = templates.map((template) => {
    const stats = getTemplateStats(template);
    return `
      <div class="template-lib-card">
        <div class="drill-lib-header">
          <h3>${template.name}</h3>
          <div class="template-lib-actions">
            <button class="edit-template-btn" data-template-id="${template.id}">Edit</button>
            <button class="delete-template-btn" data-template-id="${template.id}">Delete</button>
          </div>
        </div>
        <p class="drill-lib-meta">${stats.drillCount} drill${stats.drillCount === 1 ? '' : 's'} &middot; ${stats.totalRounds} rounds &middot; ${stats.totalTargets} targets</p>
      </div>
    `;
  }).join('');
}

// Template cards shown above "Start New Session" on the home screen.
function renderTemplateCards() {
  const templates = getTemplates();
  const container = document.getElementById('template-cards');

  if (templates.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = templates.map((template) => {
    const stats = getTemplateStats(template);
    return `
      <button class="template-card" data-template-id="${template.id}">
        <span class="template-card-name">${template.name}</span>
        <span class="template-card-meta">${stats.drillCount} drill${stats.drillCount === 1 ? '' : 's'} &middot; ${stats.totalRounds} rounds &middot; ${stats.totalTargets} targets</span>
      </button>
    `;
  }).join('');
}

// Starts a real session pre-populated with a template's drills, ready to log immediately.
function startSessionFromTemplate(templateId) {
  const template = getTemplates().find((t) => String(t.id) === String(templateId));
  if (!template) return;

  const drillEntries = template.drillIds
    .map((drillId) => {
      const drill = getDrillById(drillId);
      return drill ? { drillId: drill.id, drillName: drill.name, strings: [] } : null;
    })
    .filter(Boolean);

  const sessions = getSessions();
  const newSession = {
    id: Date.now(),
    date: new Date().toISOString().split('T')[0],
    startedAt: new Date().toISOString(),
    name: template.name,
    drillEntries,
  };
  sessions.push(newSession);
  saveSessions(sessions);
  setActiveSessionId(newSession.id);
  renderApp();
}

function showHistory() {
  currentView = 'history';
  renderApp();
}
function showPRs() {
  currentView = 'prs';
  renderApp();
}
function hideOverlayViews() {
  currentView = 'main';
  renderApp();
}

function renderHistoryList() {
  const sessions = [...getSessions()].reverse();
  const listEl = document.getElementById('history-list');

  if (sessions.length === 0) {
    listEl.innerHTML = `<p class="empty-state">No sessions logged yet.</p>`;
    return;
  }

  listEl.innerHTML = sessions.map((session) => {
    const totalStrings = session.drillEntries.reduce((sum, e) => sum + e.strings.length, 0);

    const drillLines = session.drillEntries.map((entry) => {
      const drill = getDrillById(entry.drillId);
      if (!drill) return '';
      const best = getBestStringInEntry(entry, drill);
      const bestText = best ? formatStringSummary(best) : 'No strings logged';
      return `
        <div class="history-drill-line">
          <span class="history-drill-name">${entry.drillName}</span>
          <span class="history-drill-best">${bestText}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="history-card">
        <div class="history-card-header">
          <strong>${session.name || 'Untitled Session'}</strong>
          <span class="history-date">${formatDate(session.date)}</span>
        </div>
        ${drillLines || '<p class="history-drills">No drills logged</p>'}
        <p class="history-count">${totalStrings} string${totalStrings === 1 ? '' : 's'} logged</p>
        <button class="view-session-btn secondary" data-session-id="${session.id}">View / Edit Session</button>
      </div>
    `;
  }).join('');
}

function toggleStringMenu(stringId) {
  openMenuStringId = openMenuStringId === stringId ? null : stringId;
  renderApp();
}

function startEditString(entryIndex, stringId) {
  editingContext = { entryIndex, stringId };
  openMenuStringId = null;
  renderApp();
}

function cancelEditString() {
  editingContext = null;
  renderApp();
}

function deleteString(entryIndex, stringId) {
  if (!confirm('Delete this logged string? This cannot be undone.')) return;

  const session = getEditableSession();
  if (!session) return;

  const entry = session.drillEntries[entryIndex];
  entry.strings = entry.strings.filter((s) => String(s.id) !== String(stringId));

  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  openMenuStringId = null;
  renderApp();
}

function updateString(entryIndex, stringId, timeSeconds, inputs) {
  const session = getEditableSession();
  if (!session) return;

  const entry = session.drillEntries[entryIndex];
  const drill = getDrillById(entry.drillId);
  if (!drill) return;

  const oldString = entry.strings.find((s) => String(s.id) === String(stringId));
  const updated = buildStringResult(drill, timeSeconds, inputs);
  updated.id = oldString ? oldString.id : Date.now(); // keep the same id, matching its original type
  updated.loggedAt = oldString ? oldString.loggedAt : updated.loggedAt;

  entry.strings = entry.strings.map((s) => (String(s.id) === String(stringId) ? updated : s));

  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  editingContext = null;
  renderApp();
}

// ============================================================
// BACKUP / RESTORE
// ============================================================
// Everything lives only in this device's localStorage, so this is the
// safety net against a cleared cache, phone reset, or PWA reinstall.

function exportData() {
  const data = {
    schemaVersion: getSchemaVersion(),
    drills: getDrills(),
    sessions: getSessions(),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `project-procedural-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    let data;
    try {
      data = JSON.parse(e.target.result);
    } catch (err) {
      alert('Could not read this file - make sure it\'s a Project Procedural backup.');
      return;
    }

    if (!confirm('This will overwrite ALL current data on this device with the backup file. This cannot be undone. Continue?')) {
      return;
    }

    if (data.drills) saveDrills(data.drills);
    if (data.sessions) saveSessions(data.sessions);
    if (data.schemaVersion) setSchemaVersion(data.schemaVersion);

    alert('Backup imported successfully.');
    renderApp();
  };
  reader.readAsText(file);
}

// ============================================================
// SESSION ACTIONS
// ============================================================

function startSession() {
  const sessions = getSessions();
  const newSession = {
    id: Date.now(),
    date: new Date().toISOString().split('T')[0],
    startedAt: new Date().toISOString(),
    name: '',
    drillEntries: [],
  };
  sessions.push(newSession);
  saveSessions(sessions);
  setActiveSessionId(newSession.id);
  renderApp();
}

function endSession() {
  if (!confirm('End this session? You can still view it later in Past Sessions.')) return;
  stopSessionTimer();
  setActiveSessionId(null);
  renderApp();
}

function endDrillEntry(entryIndex) {
  const session = getEditableSession();
  if (!session) return;
  const entry = session.drillEntries[entryIndex];

  if (!entry.strings || entry.strings.length === 0) {
    alert('Log at least one string before ending this drill.');
    return;
  }
  if (!confirm('Mark this drill as done for this session?')) return;

  entry.completed = true;
  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  renderApp();
}

function reactivateDrillEntry(entryIndex) {
  const session = getEditableSession();
  if (!session) return;
  session.drillEntries[entryIndex].completed = false;
  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  renderApp();
}

function removeDrillFromSession(entryIndex) {
  if (!confirm('Remove this drill and all strings logged under it in this session?')) return;

  const session = getEditableSession();
  if (!session) return;

  session.drillEntries.splice(entryIndex, 1);
  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  renderApp();
}

// ============================================================
// SESSION TIMER + ROUNDS FIRED
// ============================================================

let sessionTimerInterval = null;
let timerRunningForSessionId = null;

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateTimerDisplay(startedAt) {
  const el = document.getElementById('session-timer');
  if (!el) return; // view isn't showing right now - nothing to update
  const elapsedMs = Date.now() - new Date(startedAt).getTime();
  el.textContent = formatElapsed(Math.max(0, elapsedMs));
}

function startSessionTimer(session) {
  // Avoid restarting the interval on every render - only (re)start if this
  // is a different session than the one already being timed.
  if (timerRunningForSessionId === session.id) return;

  stopSessionTimer();
  const startedAt = session.startedAt || new Date().toISOString(); // fallback for pre-timer legacy data
  updateTimerDisplay(startedAt);
  sessionTimerInterval = setInterval(() => updateTimerDisplay(startedAt), 1000);
  timerRunningForSessionId = session.id;
}

function stopSessionTimer() {
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);
  sessionTimerInterval = null;
  timerRunningForSessionId = null;
}

// Total rounds fired across the whole session so far, summed from every
// logged string. What counts as a "round" depends on the drill's scoring type.
function getSessionRoundsFired(session) {
  let total = 0;
  session.drillEntries.forEach((entry) => {
    entry.strings.forEach((s) => {
      if (s.scoringType === 'uspsa_zones') {
        total += s.hits.a + s.hits.c + s.hits.d + s.hits.m + s.hits.ns;
      } else if (s.scoringType === 'hit_miss') {
        total += s.hitsCount + s.missesCount;
      }
      // time_only strings don't track individual rounds fired
    });
  });
  return total;
}

function updateSessionName(value) {
  const session = getEditableSession();
  if (!session) return;
  session.name = value;
  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
}

// Called when "Add" is clicked next to the drill dropdown. Either adds an
// existing drill straight to the session, or opens the new-drill setup panel.
function handleAddDrillClick() {
  const select = document.getElementById('add-drill-select');
  const value = select.value;
  if (!value) return;

  if (value === '__new__') {
    document.getElementById('new-drill-name-input').value = '';
    document.getElementById('new-drill-setup').classList.remove('hidden');
    select.value = '';
    return;
  }

  const session = findActiveSession();
  if (!session) return;

  const drill = getDrillById(value);
  if (!drill) return;

  const alreadyInSession = session.drillEntries.some((e) => String(e.drillId) === String(drill.id));
  if (alreadyInSession) {
    select.value = '';
    return;
  }

  addDrillEntryToSession(drill);
  select.value = '';
}

function confirmNewDrill() {
  const name = document.getElementById('new-drill-name-input').value.trim();
  if (!name) {
    alert('Give the drill a name.');
    return;
  }

  const drill = {
    id: Date.now(),
    name,
    type: 'drill',
    discipline: document.getElementById('new-drill-discipline').value,
    scoringType: document.getElementById('new-drill-scoring-type').value,
    powerFactor: document.getElementById('new-drill-power-factor').value,
    roundCount: parseInt(document.getElementById('new-drill-round-count').value) || null,
    targetCount: parseInt(document.getElementById('new-drill-target-count').value) || null,
    parTime: parseFloat(document.getElementById('new-drill-par-time').value) || null,
    tags: Array.from(document.querySelectorAll('#new-drill-tags input:checked')).map((cb) => cb.value),
    createdAt: new Date().toISOString(),
  };

  const drills = getDrills();
  drills.push(drill);
  saveDrills(drills);

  addDrillEntryToSession(drill);
  cancelNewDrill();
}

function cancelNewDrill() {
  document.getElementById('new-drill-setup').classList.add('hidden');
  document.getElementById('new-drill-name-input').value = '';
  document.getElementById('new-drill-round-count').value = '';
  document.getElementById('new-drill-target-count').value = '';
  document.getElementById('new-drill-par-time').value = '';
  document.querySelectorAll('#new-drill-tags input').forEach((cb) => (cb.checked = false));
  renderApp();
}

function addDrillEntryToSession(drill) {
  const session = findActiveSession();
  if (!session) return;
  session.drillEntries.push({ drillId: drill.id, drillName: drill.name, strings: [] });
  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  renderApp();
}

function logString(drillEntryIndex, timeSeconds, inputs) {
  const session = getEditableSession();
  if (!session) return;

  const entry = session.drillEntries[drillEntryIndex];
  const drill = getDrillById(entry.drillId);
  if (!drill) return;

  const result = buildStringResult(drill, timeSeconds, inputs);
  entry.strings.push(result);

  saveSessions(getSessions().map((s) => (s.id === session.id ? session : s)));
  renderApp();
}

// ============================================================
// RENDERING
// ============================================================

// Builds the correct mini-form HTML for a drill entry based on its scoring type.
// When editingString is provided, pre-fills values and swaps the button for Save/Cancel.
function buildMiniForm(drill, index, editingString, options = {}) {
  const isEditing = !!editingString;
  const showEndDrill = options.showEndDrill !== false; // defaults true (active session); false in history detail
  const timeValue = isEditing ? editingString.timeSeconds : '';

  const actionButtons = isEditing
    ? `<button class="log-string-btn" data-index="${index}" data-scoring="${drill.scoringType}" data-editing-id="${editingString.id}">Save Changes</button>
       <button class="cancel-edit-btn secondary">Cancel</button>`
    : showEndDrill
    ? `<div class="log-end-row">
         <button class="log-string-btn" data-index="${index}" data-scoring="${drill.scoringType}">Log String</button>
         <button class="end-drill-btn" data-index="${index}">End Drill</button>
       </div>`
    : `<button class="log-string-btn" data-index="${index}" data-scoring="${drill.scoringType}">Log String</button>`;

  if (drill.scoringType === 'uspsa_zones') {
    const h = isEditing ? editingString.hits : { a: '', c: '', d: '', m: '', ns: '' };
    return `
      <input type="number" step="0.01" inputmode="decimal" class="mini-time" placeholder="Time (seconds)" value="${timeValue}">
      <div class="hits-row-mini">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="a" placeholder="A" min="0" value="${h.a}">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="c" placeholder="C" min="0" value="${h.c}">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="d" placeholder="D" min="0" value="${h.d}">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="m" placeholder="M" min="0" value="${h.m}">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit" data-zone="ns" placeholder="NS" min="0" value="${h.ns}">
      </div>
      ${actionButtons}
    `;
  }
  if (drill.scoringType === 'hit_miss') {
    const hitsCount = isEditing ? editingString.hitsCount : '';
    const missesCount = isEditing ? editingString.missesCount : '';
    return `
      <input type="number" step="0.01" inputmode="decimal" class="mini-time" placeholder="Time (seconds)" value="${timeValue}">
      <div class="hits-row-mini">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-hit-count" placeholder="Hits" min="0" value="${hitsCount}">
        <input type="number" inputmode="numeric" pattern="[0-9]*" class="mini-miss-count" placeholder="Misses" min="0" value="${missesCount}">
      </div>
      ${actionButtons}
    `;
  }
  // time_only
  return `
    <input type="number" step="0.01" inputmode="decimal" class="mini-time" placeholder="Time (seconds)" value="${timeValue}">
    ${actionButtons}
  `;
}

// Builds the HTML for every drill-entry card in a session. Reused by both the
// active session view and the history-detail (editing a past session) view -
// allowEndDrill controls whether the completed-drill/End Drill flow applies,
// since that concept doesn't make sense once a session is already over.
function buildDrillEntriesHtml(session, { allowEndDrill = true } = {}) {
  return session.drillEntries.map((entry, index) => {
    const drill = getDrillById(entry.drillId);
    if (!drill) return ''; // defensive - shouldn't happen, but avoids a crash if data is ever inconsistent

    const stat = getDrillStat(entry.drillId);
    const disciplineTag = drill.discipline === 'rifle' ? ' 🎯 Rifle' : '';

    const stringsHtml = entry.strings.map((s) => {
      const badge = isStringAPR(stat, s) ? ' <span class="pr-badge">🏆 PR</span>' : '';
      const menuOpen = String(openMenuStringId) === String(s.id);

      return `
        <li>
          <div class="string-row">
            <span class="string-text">${formatStringSummary(s)}${badge}</span>
            <button class="string-menu-btn" data-string-id="${s.id}">&#8942;</button>
          </div>
          <div class="string-menu ${menuOpen ? '' : 'hidden'}">
            <button class="edit-string-btn" data-entry-index="${index}" data-string-id="${s.id}">Edit</button>
            <button class="delete-string-btn" data-entry-index="${index}" data-string-id="${s.id}">Delete</button>
          </div>
        </li>
      `;
    }).join('');

    const editingString = (editingContext && editingContext.entryIndex === index)
      ? entry.strings.find((s) => String(s.id) === String(editingContext.stringId))
      : null;

    const hintParts = [];
    if (drill.roundCount) hintParts.push(`Rounds: ${drill.roundCount}`);
    if (drill.parTime) hintParts.push(`Par: ${drill.parTime}s`);
    const hintLine = hintParts.length ? `<p class="par-hint">${hintParts.join(' &middot; ')}</p>` : '';

    // Completed drills show a session-best summary instead of the logging form -
    // only applies where allowEndDrill is true (the active session view).
    const isCompleted = allowEndDrill && entry.completed;
    let formArea;
    if (isCompleted) {
      const bestString = getBestStringInEntry(entry, drill);
      const isPR = bestString && isStringAPR(stat, bestString);
      formArea = `
        <div class="session-best-row">
          <div class="session-best ${isPR ? 'session-best-pr' : ''}">
            <span class="session-best-label">Best this session${isPR ? ' &mdash; 🏆 PR' : ''}</span>
            <span class="session-best-value">${bestString ? formatStringSummary(bestString) : '—'}</span>
          </div>
          <button class="edit-drill-btn" data-index="${index}">Edit</button>
        </div>
      `;
    } else {
      formArea = `${hintLine}${buildMiniForm(drill, index, editingString, { showEndDrill: allowEndDrill })}`;
    }

    return `
      <div class="drill-entry ${isCompleted ? 'drill-entry-completed' : ''}" data-index="${index}">
        <div class="drill-entry-header">
          <h3><button class="drill-name-link" data-drill-id="${entry.drillId}">${entry.drillName}</button><span class="discipline-tag">${disciplineTag}</span></h3>
          <button class="remove-drill-btn" data-index="${index}" title="Remove drill">&times;</button>
        </div>
        <ul class="string-list-mini">${stringsHtml}</ul>
        <div class="mini-form">
          ${formArea}
        </div>
      </div>
    `;
  }).join('');
}

function renderHistoryDetail() {
  const session = getEditableSession();
  if (!session) return;

  document.getElementById('history-detail-name').value = session.name || '';
  document.getElementById('history-detail-date').textContent = formatDate(session.date);
  document.getElementById('history-detail-drill-entries').innerHTML =
    buildDrillEntriesHtml(session, { allowEndDrill: false });
}

function renderApp() {
  const session = findActiveSession();
  const startView = document.getElementById('session-start-view');
  const activeView = document.getElementById('active-session-view');
  const historyView = document.getElementById('history-view');
  const prView = document.getElementById('pr-view');
  const historyDetailView = document.getElementById('history-detail-view');
  const drillLibraryView = document.getElementById('drill-library-view');
  const templatesView = document.getElementById('templates-view');

  if (currentView === 'templates') {
    stopSessionTimer();
    startView.classList.add('hidden');
    activeView.classList.add('hidden');
    historyView.classList.add('hidden');
    prView.classList.add('hidden');
    historyDetailView.classList.add('hidden');
    drillLibraryView.classList.add('hidden');
    templatesView.classList.remove('hidden');
    renderTemplatesList();
    return;
  }
  if (currentView === 'drills') {
    stopSessionTimer();
    startView.classList.add('hidden');
    activeView.classList.add('hidden');
    historyView.classList.add('hidden');
    prView.classList.add('hidden');
    historyDetailView.classList.add('hidden');
    templatesView.classList.add('hidden');
    drillLibraryView.classList.remove('hidden');
    renderDrillLibrary();
    return;
  }
  if (currentView === 'history') {
    stopSessionTimer();
    startView.classList.add('hidden');
    activeView.classList.add('hidden');
    prView.classList.add('hidden');
    historyDetailView.classList.add('hidden');
    drillLibraryView.classList.add('hidden');
    templatesView.classList.add('hidden');
    historyView.classList.remove('hidden');
    renderHistoryList();
    return;
  }
  if (currentView === 'historyDetail') {
    stopSessionTimer();
    startView.classList.add('hidden');
    activeView.classList.add('hidden');
    prView.classList.add('hidden');
    historyView.classList.add('hidden');
    drillLibraryView.classList.add('hidden');
    templatesView.classList.add('hidden');
    historyDetailView.classList.remove('hidden');
    renderHistoryDetail();
    return;
  }
  if (currentView === 'prs') {
    stopSessionTimer();
    startView.classList.add('hidden');
    activeView.classList.add('hidden');
    historyView.classList.add('hidden');
    historyDetailView.classList.add('hidden');
    drillLibraryView.classList.add('hidden');
    templatesView.classList.add('hidden');
    prView.classList.remove('hidden');
    renderPRList();
    return;
  }
  historyView.classList.add('hidden');
  prView.classList.add('hidden');
  historyDetailView.classList.add('hidden');
  drillLibraryView.classList.add('hidden');
  templatesView.classList.add('hidden');

  if (!session) {
    stopSessionTimer();
    startView.classList.remove('hidden');
    activeView.classList.add('hidden');
    renderTemplateCards();
    return;
  }

  startView.classList.add('hidden');
  activeView.classList.remove('hidden');

  startSessionTimer(session);
  document.getElementById('session-rounds').textContent =
    `${getSessionRoundsFired(session)} rounds fired`;

  document.getElementById('session-name').value = session.name || '';

  const drillSelect = document.getElementById('add-drill-select');
  const currentDrillIds = new Set(session.drillEntries.map((e) => String(e.drillId)));
  drillSelect.innerHTML = '<option value="">Select a drill...</option>' +
    getDrills()
      .filter((d) => !currentDrillIds.has(String(d.id))) // don't offer drills already in this session
      .map((d) => `<option value="${d.id}">${d.name}</option>`).join('') +
    '<option value="__new__">+ Create New Drill</option>';

  document.getElementById('drill-entries').innerHTML = buildDrillEntriesHtml(session, { allowEndDrill: true });
}

// ============================================================
// EVENT WIRING
// ============================================================

document.getElementById('close-drill-detail-btn').addEventListener('click', closeDrillDetail);
document.getElementById('drill-detail-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'drill-detail-overlay') closeDrillDetail(); // tapping the dimmed backdrop closes it
});
document.querySelectorAll('.drill-detail-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchDrillDetailTab(btn.dataset.tab));
});

// A drill's name is clickable everywhere it appears (session, history, library) -
// one shared listener on the body since the .drill-name-link buttons live in
// several different dynamically-rendered containers.
document.body.addEventListener('click', (e) => {
  if (e.target.matches('.drill-name-link')) {
    openDrillDetail(e.target.dataset.drillId);
  }
});

document.getElementById('start-session-btn').addEventListener('click', startSession);
document.getElementById('end-session-btn').addEventListener('click', endSession);
document.getElementById('view-history-btn').addEventListener('click', showHistory);
document.getElementById('back-from-history-btn').addEventListener('click', hideOverlayViews);
document.getElementById('view-prs-btn').addEventListener('click', showPRs);
document.getElementById('back-from-pr-btn').addEventListener('click', hideOverlayViews);

document.getElementById('view-drill-library-btn').addEventListener('click', showDrillLibrary);
document.getElementById('back-from-drill-library-btn').addEventListener('click', hideDrillLibrary);

document.getElementById('view-templates-btn').addEventListener('click', showTemplatesView);
document.getElementById('back-from-templates-btn').addEventListener('click', hideTemplatesView);
document.getElementById('new-template-btn').addEventListener('click', openNewTemplateSetup);
document.getElementById('save-template-btn').addEventListener('click', saveTemplate);
document.getElementById('cancel-template-btn').addEventListener('click', cancelTemplateSetup);
document.getElementById('template-add-drill-btn').addEventListener('click', addDrillToTemplateSetup);

document.getElementById('template-drill-list').addEventListener('click', (e) => {
  if (e.target.matches('.remove-template-drill-btn')) {
    removeDrillFromTemplateSetup(parseInt(e.target.dataset.index));
  }
});

document.getElementById('templates-list').addEventListener('click', (e) => {
  if (e.target.matches('.edit-template-btn')) {
    openEditTemplateSetup(e.target.dataset.templateId);
  } else if (e.target.matches('.delete-template-btn')) {
    deleteTemplate(e.target.dataset.templateId);
  }
});

// Tapping a template card on the home screen starts a session from it immediately.
document.getElementById('template-cards').addEventListener('click', (e) => {
  const card = e.target.closest('.template-card');
  if (card) startSessionFromTemplate(card.dataset.templateId);
});

document.getElementById('drill-library-list').addEventListener('click', (e) => {
  if (e.target.matches('.edit-drill-lib-btn')) {
    startEditDrill(e.target.dataset.drillId);
    return;
  }
  if (e.target.matches('.save-drill-edit-btn')) {
    saveDrillEdits(e.target.dataset.drillId);
    return;
  }
  if (e.target.matches('.cancel-drill-edit-btn')) {
    cancelEditDrill();
    return;
  }
});

// Only show the power factor picker when zone scoring is selected, same behavior as the "new drill" panel.
document.getElementById('drill-library-list').addEventListener('change', (e) => {
  if (!e.target.matches('.edit-drill-scoring-type')) return;
  const row = e.target.closest('.drill-lib-card').querySelector('.edit-drill-power-factor-row');
  row.style.display = e.target.value === 'uspsa_zones' ? 'flex' : 'none';
});

document.getElementById('export-data-btn').addEventListener('click', exportData);
document.getElementById('import-data-btn').addEventListener('click', () => {
  document.getElementById('import-file-input').click();
});
document.getElementById('import-file-input').addEventListener('change', (e) => {
  if (e.target.files.length > 0) importData(e.target.files[0]);
  e.target.value = ''; // reset so importing the same filename again still fires 'change'
});

document.getElementById('session-name').addEventListener('input', (e) => {
  updateSessionName(e.target.value);
});

document.getElementById('add-drill-btn').addEventListener('click', handleAddDrillClick);
document.getElementById('confirm-new-drill-btn').addEventListener('click', confirmNewDrill);
document.getElementById('cancel-new-drill-btn').addEventListener('click', cancelNewDrill);

// Only show the power factor picker when it's actually relevant (zone scoring).
document.getElementById('new-drill-scoring-type').addEventListener('change', (e) => {
  const row = document.getElementById('new-drill-power-factor-row');
  row.style.display = e.target.value === 'uspsa_zones' ? 'flex' : 'none';
});

// Event delegation: drill entries, strings, and their mini-forms are created dynamically.
// Shared by both the active session view and the history-detail view.
function handleDrillEntriesClick(e) {
  if (e.target.matches('.remove-drill-btn')) {
    removeDrillFromSession(parseInt(e.target.dataset.index));
    return;
  }

  if (e.target.matches('.end-drill-btn')) {
    endDrillEntry(parseInt(e.target.dataset.index));
    return;
  }

  if (e.target.matches('.edit-drill-btn')) {
    reactivateDrillEntry(parseInt(e.target.dataset.index));
    return;
  }

  if (e.target.matches('.string-menu-btn')) {
    toggleStringMenu(e.target.dataset.stringId);
    return;
  }

  if (e.target.matches('.edit-string-btn')) {
    startEditString(parseInt(e.target.dataset.entryIndex), e.target.dataset.stringId);
    return;
  }

  if (e.target.matches('.delete-string-btn')) {
    deleteString(parseInt(e.target.dataset.entryIndex), e.target.dataset.stringId);
    return;
  }

  if (e.target.matches('.cancel-edit-btn')) {
    cancelEditString();
    return;
  }

  if (e.target.matches('.log-string-btn')) {
    const drillEntryIndex = parseInt(e.target.dataset.index);
    const scoringType = e.target.dataset.scoring;
    const editingId = e.target.dataset.editingId; // present only when saving an edit
    const card = e.target.closest('.drill-entry');

    const timeSeconds = parseFloat(card.querySelector('.mini-time').value);
    if (!timeSeconds || timeSeconds <= 0) {
      alert('Enter a time before logging.');
      return;
    }

    let inputs = {};
    if (scoringType === 'uspsa_zones') {
      const hits = {};
      card.querySelectorAll('.mini-hit').forEach((input) => {
        hits[input.dataset.zone] = parseInt(input.value) || 0;
      });
      inputs = { hits };
    } else if (scoringType === 'hit_miss') {
      inputs = {
        hitsCount: parseInt(card.querySelector('.mini-hit-count').value) || 0,
        missesCount: parseInt(card.querySelector('.mini-miss-count').value) || 0,
      };
    }

    if (editingId) {
      updateString(drillEntryIndex, editingId, timeSeconds, inputs);
    } else {
      logString(drillEntryIndex, timeSeconds, inputs);
    }
  }
}

// Pressing Enter in any mini-form field submits it, same as tapping the log/save button.
function handleDrillEntriesKeydown(e) {
  const isMiniFormInput = e.target.matches('.mini-time, .mini-hit, .mini-hit-count, .mini-miss-count');
  if (e.key !== 'Enter' || !isMiniFormInput) return;

  e.preventDefault();
  const card = e.target.closest('.drill-entry');
  const button = card.querySelector('.log-string-btn');
  if (button) button.click();
}

document.getElementById('drill-entries').addEventListener('click', handleDrillEntriesClick);
document.getElementById('drill-entries').addEventListener('keydown', handleDrillEntriesKeydown);
document.getElementById('history-detail-drill-entries').addEventListener('click', handleDrillEntriesClick);
document.getElementById('history-detail-drill-entries').addEventListener('keydown', handleDrillEntriesKeydown);

document.getElementById('back-from-history-detail-btn').addEventListener('click', closeHistorySession);
document.getElementById('history-detail-name').addEventListener('input', (e) => {
  updateSessionName(e.target.value);
});

// Opening a session from the history list for viewing/editing.
document.getElementById('history-list').addEventListener('click', (e) => {
  if (e.target.matches('.view-session-btn')) {
    openHistorySession(e.target.dataset.sessionId);
  }
});

// ============================================================
// INIT
// ============================================================

renderApp();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}
