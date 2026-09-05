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

function disciplineLabel(discipline) {
  if (discipline === 'rifle') return 'Rifle';
  if (discipline === 'combination') return 'Combination';
  return 'Pistol';
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

let currentView = 'homeMenu'; // 'homeMenu', 'main', 'history', 'prs', 'historyDetail', 'drills', 'templates', 'dryFire', or 'matchTracking'
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
  const instructionsBlock = drill.description
    ? `<div class="detail-instructions"><h4 class="detail-subheading">Instructions</h4><p>${drill.description}</p></div>`
    : '';

  const rows = [];
  rows.push(`<div class="detail-row"><span class="detail-label">Discipline</span><span class="detail-value">${disciplineLabel(drill.discipline)}</span></div>`);

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

  return `${instructionsBlock}<div class="detail-about">${rows.join('')}</div><p class="detail-note">Diagram support coming in a future update.</p>`;
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

// Fixed set of starter drills a shooter can load with one tap, so the library
// isn't empty on day one. Merges by name (skips duplicates) rather than
// overwriting - safe to run even if drills already exist.
const STARTER_DRILLS = [
  { name: 'Draw to First Shot (Pistol)', discipline: 'pistol', scoringType: 'time_only', powerFactor: 'minor', roundCount: 1, targetCount: 1, parTime: 2.0, tags: ['static', 'indoor'],
    description: 'Start holstered, target at 7-10 yards. On the buzzer, draw and fire one round into the A-zone.' },
  { name: 'Bill Drill (Pistol)', discipline: 'pistol', scoringType: 'uspsa_zones', powerFactor: 'minor', roundCount: 6, targetCount: 1, parTime: 5.0, tags: ['static', 'indoor'],
    description: 'Start holstered, single target. On the buzzer, draw and fire 6 rounds as fast as possible while keeping hits in the A/C zone.' },
  { name: 'Blake Drill (Pistol)', discipline: 'pistol', scoringType: 'uspsa_zones', powerFactor: 'minor', roundCount: 6, targetCount: 3, parTime: 5.5, tags: ['static', 'indoor'],
    description: 'Three targets spaced a few feet apart, start holstered. On the buzzer, draw and fire 2 rounds on each target (6 total).' },
  { name: 'Failure Drill (Pistol)', discipline: 'pistol', scoringType: 'uspsa_zones', powerFactor: 'minor', roundCount: 3, targetCount: 1, parTime: 3.2, tags: ['static', 'indoor'],
    description: 'Single target, start holstered. On the buzzer, draw and fire 2 rounds to the body and 1 to the head (3 total).' },
  { name: 'Reload Standards (Pistol)', discipline: 'pistol', scoringType: 'time_only', powerFactor: 'minor', roundCount: 4, targetCount: 1, parTime: 4.0, tags: ['static', 'indoor'],
    description: 'Single target, pistol loaded with 2 rounds. On the buzzer, fire 2, reload, fire 2 more (4 total). Time includes the reload.' },
  { name: 'El Presidente (Pistol)', discipline: 'pistol', scoringType: 'uspsa_zones', powerFactor: 'minor', roundCount: 12, targetCount: 3, parTime: 13.0, tags: [],
    description: 'Three targets, start facing away with hands at sides, pistol holstered. On the buzzer, turn, draw, engage each target with 2 rounds (6), reload, engage each target again with 2 rounds (6 more, 12 total).' },
  { name: 'Dot Torture (Pistol)', discipline: 'pistol', scoringType: 'hit_miss', powerFactor: 'minor', roundCount: 50, targetCount: 1, parTime: null, tags: ['static', 'indoor'],
    description: 'Use a Dot Torture target at 3-5 yards, follow the printed stage instructions per dot (some strong-hand-only, some with a reload). Scored on hits, not time.' },

  { name: 'Ready to First Shot (Rifle)', discipline: 'rifle', scoringType: 'time_only', powerFactor: 'minor', roundCount: 1, targetCount: 1, parTime: 1.5, tags: [],
    description: 'Start at low ready or slung, safety on. On the buzzer, shoulder and fire 1 round into the target.' },
  { name: 'Bill Drill (Rifle)', discipline: 'rifle', scoringType: 'uspsa_zones', powerFactor: 'minor', roundCount: 6, targetCount: 1, parTime: 3.5, tags: [],
    description: 'Start at low ready, single target. On the buzzer, shoulder and fire 6 rounds as fast as possible while keeping hits in the A/C zone.' },
  { name: 'Failure Drill (Rifle)', discipline: 'rifle', scoringType: 'uspsa_zones', powerFactor: 'minor', roundCount: 3, targetCount: 1, parTime: 2.8, tags: [],
    description: 'Single target, start at low ready. On the buzzer, fire 2 rounds to the body and 1 to the head (3 total).' },
  { name: 'Reload Standards (Rifle)', discipline: 'rifle', scoringType: 'time_only', powerFactor: 'minor', roundCount: 4, targetCount: 1, parTime: 3.0, tags: [],
    description: 'Single target, rifle loaded with 2 rounds. On the buzzer, fire 2, execute a magazine change, fire 2 more (4 total).' },
  { name: 'Positional Drill (Rifle)', discipline: 'rifle', scoringType: 'hit_miss', powerFactor: 'minor', roundCount: 5, targetCount: 1, parTime: null, tags: [],
    description: 'Single target. On the buzzer, get into the called position (kneeling, prone, etc.) and fire 5 rounds. Focus on accuracy and position speed - scored on hits, not time.' },

  { name: 'Rifle-to-Pistol Transition', discipline: 'combination', scoringType: 'uspsa_zones', powerFactor: 'minor', roundCount: 6, targetCount: 1, parTime: 6.0, tags: ['movement'],
    description: 'Single target, rifle at low ready with 3 rounds loaded, pistol holstered. On the buzzer, fire 3 rifle rounds, transition to pistol, fire 3 more (6 total).' },
  { name: 'Barricade Transition Drill', discipline: 'combination', scoringType: 'hit_miss', powerFactor: 'minor', roundCount: 8, targetCount: 2, parTime: null, tags: ['movement', 'outdoor-only'],
    description: 'Two targets, two positions. Start with rifle at position 1. On the buzzer, engage target 1 with rifle (4 rounds), move to position 2, transition to pistol, engage target 2 with pistol (4 rounds). Focus on clean position changes - untimed initially.' },
];

function loadStarterDrills() {
  const existingNames = new Set(getDrills().map((d) => d.name.toLowerCase()));
  const toAdd = STARTER_DRILLS.filter((d) => !existingNames.has(d.name.toLowerCase()));

  if (toAdd.length === 0) {
    alert('All starter drills are already in your library.');
    return;
  }

  const drills = getDrills();
  toAdd.forEach((d, i) => {
    drills.push({
      id: Date.now() + i, // offset avoids id collisions when adding several in the same millisecond
      type: 'drill',
      createdAt: new Date().toISOString(),
      ...d,
    });
  });
  saveDrills(drills);

  alert(`Added ${toAdd.length} starter drill${toAdd.length === 1 ? '' : 's'} to your library.`);
  renderApp();
}

// ============================================================
// DRY FIRE (standalone shot timer - no results saved anywhere)
// ============================================================

let dryFireAudioCtx = null;
let dryFireTimeoutIds = [];

function getDryFireAudioContext() {
  if (!dryFireAudioCtx) dryFireAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return dryFireAudioCtx;
}

// Generates a short beep tone directly (no audio file), so this works fully
// offline like everything else in the app.
function playDryFireBeep() {
  const ctx = getDryFireAudioContext();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.frequency.value = 1200;
  oscillator.type = 'sine';
  gain.gain.value = 0.3;
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start();
  oscillator.stop(ctx.currentTime + 0.15);
  if (navigator.vibrate) navigator.vibrate(100); // works even if the phone is on silent
}

function clearDryFireTimers() {
  dryFireTimeoutIds.forEach((id) => clearTimeout(id));
  dryFireTimeoutIds = [];
}

function setDryFireStatus(state, text) {
  const el = document.getElementById('dry-fire-status');
  if (!el) return;
  el.textContent = text;
  el.className = `dry-fire-status dry-fire-status-${state}`;
}

function startDryFireRep() {
  const parInput = document.getElementById('dry-fire-par-time');
  const par = parseFloat(parInput.value);
  if (!par || par <= 0) {
    alert('Set a par time first.');
    return;
  }
  localStorage.setItem('dryFireLastPar', String(par)); // remembers your last setting, not practice results

  clearDryFireTimers();
  setDryFireStatus('ready', 'Get ready...');

  const randomDelay = 1000 + Math.random() * 3000; // 1-4 seconds, matching a typical shot timer's random delay

  const startId = setTimeout(() => {
    playDryFireBeep();
    setDryFireStatus('go', 'GO');

    const parId = setTimeout(() => {
      playDryFireBeep();
      setDryFireStatus('par', 'PAR');
    }, par * 1000);
    dryFireTimeoutIds.push(parId);
  }, randomDelay);
  dryFireTimeoutIds.push(startId);
}

function cancelDryFireRep() {
  clearDryFireTimers();
  setDryFireStatus('idle', 'Ready');
}

function showDryFireView() {
  currentView = 'dryFire';
  renderApp();
}
function hideDryFireView() {
  cancelDryFireRep();
  currentView = 'main';
  renderApp();
}

// ============================================================
// DRY FIRE TECHNIQUE EXERCISES (static content, no timer/tracking)
// ============================================================

const DRY_FIRE_EXERCISES = [
  { id: 'wall-drill', name: 'Wall Drill', illustration: 'wall-drill',
    about: 'Unloaded pistol, muzzle about an inch from a blank wall, sights aligned. Press the trigger while watching your front sight (or dot) for any movement.',
    teaches: 'Isolates trigger control from everything else - no target, no par, just whether the sights moved when the trigger broke.' },
  { id: 'balance-drill', name: 'Balance Drill (Coin Drill)', illustration: 'balance-drill',
    about: 'Balance a coin on the slide near the front sight. Press the trigger without the coin falling.',
    teaches: 'Same trigger-control goal as the Wall Drill, but gives instant physical feedback - the coin falling means the gun moved.' },
  { id: 'trigger-reset', name: 'Trigger Reset Drill', illustration: 'trigger-reset',
    about: 'Press the trigger to the break, then release only until you feel or hear the reset click - no further - then press again. Repeat without ever fully releasing.',
    teaches: 'Minimizes wasted trigger travel, which speeds up follow-up shots without sacrificing control.' },
  { id: 'presentation-confirmation', name: 'Presentation Confirmation Drill', illustration: 'presentation-confirmation',
    about: 'From ready or holster, present the pistol and stop the instant your sights are aligned on target - no trigger press, just confirm a clean sight picture every time.',
    teaches: 'Builds a consistent, repeatable presentation before speed ever gets added.' },
  { id: 'strong-hand-only', name: 'Strong-Hand-Only Manipulation Drill', illustration: 'strong-hand-only',
    about: 'Run the Wall Drill or Balance Drill using only your dominant hand.',
    teaches: 'Grip stability and trigger control without support-hand help - relevant if your other arm is ever injured or occupied.' },
  { id: 'weak-hand-only', name: 'Weak-Hand-Only Manipulation Drill', illustration: 'weak-hand-only',
    about: 'Same as the Strong-Hand-Only Drill, but using only your support hand.',
    teaches: 'The same resilience from the other side - most shooters find this exposes weaknesses fast.' },
  { id: 'tactical-reload', name: 'Tactical (Proactive) Reload Drill', illustration: 'tactical-reload',
    about: 'Magazine in gun, spare in pouch. Draw the fresh magazine, eject the old one into your support hand, insert the new one, then stow the old magazine.',
    teaches: 'Smooth reload mechanics while retaining a partially-full magazine - practice slow, technique only.' },
  { id: 'tap-rack', name: 'Tap-Rack Malfunction Clearance Drill', illustration: 'tap-rack',
    about: 'Simulate a "click instead of bang": tap the base of the magazine firmly, rack the slide, and reassess the target.',
    teaches: 'The reflexive response to the most common type of malfunction.' },
  { id: 'type-3-malfunction', name: 'Type 3 Malfunction Clearance Drill (Double Feed)', illustration: 'type-3-malfunction',
    about: 'Simulate a stuck double-feed: rip the magazine out, rack the slide 2-3 times to clear the chamber, reload, rack, and reassess.',
    teaches: 'The more involved clearance sequence for a jam that tap-rack alone will not fix.' },
  { id: 'target-transition', name: 'Target Transition Drill (Eyes Lead, Gun Follows)', illustration: 'target-transition',
    about: 'Set up multiple aim points across your field of view. Press on the first, then move your eyes to the next point before the gun arrives, letting the muzzle follow.',
    teaches: 'Visually-led transitions instead of dragging the gun and hoping your eyes catch up.' },
  { id: 'grip-pressure', name: 'Grip Pressure Variation Drill', illustration: 'grip-pressure',
    about: 'Deliberately dry fire at several different grip pressures - light, medium, crushing - and compare sight movement at each.',
    teaches: 'Finds your actual optimal grip pressure instead of guessing.' },
  { id: 'retention-position', name: 'Retention Position Reset Drill', illustration: 'retention-position',
    about: 'Between reps, deliberately bring the gun to a retention position before resetting, rather than resetting in place.',
    teaches: 'Builds in a habitual pause so dry fire repetition does not accidentally train an unsafe "just keep pressing" habit.' },
];

// Simple schematic pistol shape (slide + grip as two rectangles) reused across
// every illustration - intentionally abstract rather than a detailed firearm rendering.
function pistolShape(cx, cy, scale) {
  scale = scale || 1;
  return `<g transform="translate(${cx},${cy}) scale(${scale})">
    <rect x="-30" y="-6" width="55" height="12" rx="2" fill="#4da6ff" />
    <rect x="-30" y="4" width="14" height="26" rx="2" fill="#4da6ff" transform="rotate(12 -23 4)" />
  </g>`;
}

function svgWrap(inner, caption) {
  return `<svg viewBox="0 0 280 170" class="drill-chart-svg">${inner}</svg><p class="illustration-caption">${caption}</p>`;
}

function buildExerciseIllustrationSvg(key) {
  const W = '#eee', DIM = '#888', ACCENT = '#4da6ff', GOLD = '#ffd54d';

  if (key === 'wall-drill') {
    return svgWrap(`
      <line x1="220" y1="20" x2="220" y2="150" stroke="${DIM}" stroke-width="4" />
      ${pistolShape(150, 85, 1)}
      <line x1="180" y1="85" x2="218" y2="85" stroke="${GOLD}" stroke-width="1.5" stroke-dasharray="4,3" />
      <text x="180" y="75" fill="${GOLD}" font-size="10">~1"</text>
      <text x="130" y="150" fill="${DIM}" font-size="10">Muzzle near wall, sights aligned</text>
    `, 'Schematic - see About tab for full setup.');
  }
  if (key === 'balance-drill') {
    return svgWrap(`
      ${pistolShape(140, 90, 1.1)}
      <circle cx="112" cy="72" r="7" fill="${GOLD}" />
      <text x="90" y="55" fill="${GOLD}" font-size="10">Coin</text>
      <text x="90" y="150" fill="${DIM}" font-size="10">Press trigger without dropping the coin</text>
    `, 'Schematic - see About tab for full setup.');
  }
  if (key === 'trigger-reset') {
    return svgWrap(`
      <line x1="40" y1="90" x2="240" y2="90" stroke="${DIM}" stroke-width="3" />
      <circle cx="220" cy="90" r="5" fill="${ACCENT}" />
      <text x="205" y="75" fill="${ACCENT}" font-size="9">Start</text>
      <circle cx="140" cy="90" r="5" fill="${GOLD}" />
      <text x="110" y="75" fill="${GOLD}" font-size="9">Reset click</text>
      <circle cx="55" cy="90" r="5" fill="${W}" />
      <text x="35" y="75" fill="${W}" font-size="9">Break</text>
      <text x="60" y="150" fill="${DIM}" font-size="10">Only travel to reset, then press again</text>
    `, 'Schematic - see About tab for full setup.');
  }
  if (key === 'presentation-confirmation') {
    return svgWrap(`
      <rect x="40" y="110" width="26" height="34" rx="3" fill="none" stroke="${DIM}" stroke-width="2" />
      <text x="30" y="155" fill="${DIM}" font-size="9">Holster</text>
      <path d="M 70 120 Q 130 60 165 90" fill="none" stroke="${GOLD}" stroke-width="1.5" stroke-dasharray="4,3" />
      ${pistolShape(190, 85, 1)}
      <rect x="215" y="60" width="40" height="30" fill="none" stroke="${ACCENT}" stroke-width="1.5" stroke-dasharray="3,2" />
      <text x="210" y="50" fill="${ACCENT}" font-size="9">Sight picture</text>
    `, 'Schematic - see About tab for full setup.');
  }
  if (key === 'strong-hand-only' || key === 'weak-hand-only') {
    const label = key === 'strong-hand-only' ? 'Strong hand only' : 'Support hand only';
    return svgWrap(`
      ${pistolShape(150, 90, 1.1)}
      <circle cx="115" cy="100" r="16" fill="none" stroke="${GOLD}" stroke-width="2" />
      <text x="90" y="140" fill="${GOLD}" font-size="10">${label}</text>
      <text x="50" y="30" fill="${DIM}" font-size="10">Other hand not used</text>
    `, 'Schematic - see About tab for full setup.');
  }
  if (key === 'tactical-reload') {
    return svgWrap(`
      <rect x="40" y="60" width="16" height="46" fill="${DIM}" />
      <text x="25" y="120" fill="${DIM}" font-size="9">Old mag</text>
      ${pistolShape(140, 85, 1)}
      <rect x="215" y="55" width="16" height="46" fill="${ACCENT}" />
      <text x="200" y="115" fill="${ACCENT}" font-size="9">Fresh mag</text>
      <path d="M 195 80 L 165 80" stroke="${GOLD}" stroke-width="1.5" marker-end="url(#arrow)" />
      <text x="150" y="35" fill="${DIM}" font-size="9">Insert fresh, stow old</text>
    `, 'Schematic - see About tab for full setup.');
  }
  if (key === 'tap-rack') {
    return svgWrap(`
      ${pistolShape(140, 90, 1.1)}
      <path d="M 120 130 L 120 110" stroke="${GOLD}" stroke-width="2" />
      <text x="90" y="145" fill="${GOLD}" font-size="9">1. Tap mag base</text>
      <path d="M 170 60 A 20 20 0 1 1 169 59" fill="none" stroke="${ACCENT}" stroke-width="2" />
      <text x="150" y="45" fill="${ACCENT}" font-size="9">2. Rack slide</text>
    `, 'Schematic - see About tab for full setup.');
  }
  if (key === 'type-3-malfunction') {
    return svgWrap(`
      ${pistolShape(140, 100, 1.1)}
      <path d="M 130 78 l 6 6 l -6 6 l 6 6" stroke="${GOLD}" stroke-width="2" fill="none" />
      <text x="150" y="70" fill="${GOLD}" font-size="9">Stuck brass</text>
      <path d="M 70 120 L 40 90" stroke="${ACCENT}" stroke-width="2" />
      <text x="20" y="140" fill="${ACCENT}" font-size="9">Rip mag out</text>
      <text x="90" y="155" fill="${DIM}" font-size="9">Rack 2-3x, reload, rack, reassess</text>
    `, 'Schematic - see About tab for full setup.');
  }
  if (key === 'target-transition') {
    return svgWrap(`
      <circle cx="70" cy="50" r="14" fill="none" stroke="${W}" stroke-width="2" />
      <circle cx="150" cy="50" r="14" fill="none" stroke="${W}" stroke-width="2" />
      <circle cx="230" cy="50" r="14" fill="none" stroke="${W}" stroke-width="2" />
      <path d="M 70 65 Q 110 100 150 65" fill="none" stroke="${GOLD}" stroke-width="1.5" stroke-dasharray="3,2" />
      <text x="80" y="95" fill="${GOLD}" font-size="9">Eyes move first</text>
      ${pistolShape(90, 130, 0.9)}
      <path d="M 110 125 L 145 100" fill="none" stroke="${ACCENT}" stroke-width="1.5" stroke-dasharray="3,2" />
      <text x="120" y="150" fill="${ACCENT}" font-size="9">Gun follows</text>
    `, 'Schematic - see About tab for full setup.');
  }
  if (key === 'grip-pressure') {
    return svgWrap(`
      ${pistolShape(150, 90, 1.1)}
      <circle cx="120" cy="105" r="16" fill="none" stroke="${DIM}" stroke-width="2" />
      <path d="M 200 130 A 30 30 0 0 1 260 130" fill="none" stroke="${ACCENT}" stroke-width="2" />
      <text x="195" y="150" fill="${DIM}" font-size="8">Light</text>
      <text x="245" y="150" fill="${GOLD}" font-size="8">Firm</text>
      <text x="40" y="30" fill="${DIM}" font-size="10">Compare sight movement per pressure</text>
    `, 'Schematic - see About tab for full setup.');
  }
  if (key === 'retention-position') {
    return svgWrap(`
      ${pistolShape(210, 60, 0.9)}
      <text x="195" y="35" fill="${DIM}" font-size="9">Extended</text>
      <path d="M 190 70 Q 130 110 90 120" fill="none" stroke="${GOLD}" stroke-width="1.5" stroke-dasharray="4,3" />
      ${pistolShape(80, 125, 0.9)}
      <text x="45" y="150" fill="${GOLD}" font-size="9">Retention</text>
    `, 'Schematic - see About tab for full setup.');
  }

  return `<p class="empty-state">No illustration available.</p>`;
}

let currentExerciseDetailId = null;
let currentExerciseDetailTab = 'about';

function openExerciseDetail(exerciseId) {
  currentExerciseDetailId = exerciseId;
  currentExerciseDetailTab = 'about';
  document.getElementById('exercise-detail-overlay').classList.remove('hidden');
  document.querySelectorAll('.exercise-detail-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === 'about');
  });
  renderExerciseDetailContent();
}
function closeExerciseDetail() {
  currentExerciseDetailId = null;
  document.getElementById('exercise-detail-overlay').classList.add('hidden');
}
function switchExerciseDetailTab(tab) {
  currentExerciseDetailTab = tab;
  document.querySelectorAll('.exercise-detail-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  renderExerciseDetailContent();
}
function renderExerciseDetailContent() {
  const exercise = DRY_FIRE_EXERCISES.find((e) => e.id === currentExerciseDetailId);
  const nameEl = document.getElementById('exercise-detail-name');
  const contentEl = document.getElementById('exercise-detail-content');

  if (!exercise) {
    contentEl.innerHTML = `<p class="empty-state">Exercise not found.</p>`;
    return;
  }
  nameEl.textContent = exercise.name;

  if (currentExerciseDetailTab === 'about') {
    contentEl.innerHTML = `
      <div class="detail-instructions">
        <h4 class="detail-subheading">About</h4>
        <p>${exercise.about}</p>
      </div>
      <div class="detail-instructions">
        <h4 class="detail-subheading">What It Teaches</h4>
        <p>${exercise.teaches}</p>
      </div>
    `;
  } else {
    contentEl.innerHTML = buildExerciseIllustrationSvg(exercise.illustration);
  }
}

function renderDryFireExerciseList() {
  document.getElementById('dry-fire-exercise-list').innerHTML = DRY_FIRE_EXERCISES.map((ex) => `
    <button class="exercise-list-item" data-exercise-id="${ex.id}">${ex.name}</button>
  `).join('');
}

function renderDryFireView() {
  const select = document.getElementById('dry-fire-drill-select');
  const drillsWithPar = getDrills().filter((d) => d.parTime);
  select.innerHTML = '<option value="">Custom par time</option>' +
    drillsWithPar.map((d) => `<option value="${d.id}">${d.name} (${d.parTime}s)</option>`).join('');

  const lastPar = localStorage.getItem('dryFireLastPar');
  if (lastPar) document.getElementById('dry-fire-par-time').value = lastPar;

  setDryFireStatus('idle', 'Ready');
  renderDryFireExerciseList();
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
  drill.description = card.querySelector('.edit-drill-instructions').value.trim();
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

          <label>Instructions</label>
          <textarea class="edit-drill-instructions" rows="3" placeholder="Setup and execution instructions...">${drill.description || ''}</textarea>

          <label>Discipline</label>
          <select class="edit-drill-discipline">
            <option value="pistol" ${drill.discipline === 'pistol' ? 'selected' : ''}>Pistol</option>
            <option value="rifle" ${drill.discipline === 'rifle' ? 'selected' : ''}>Rifle</option>
            <option value="combination" ${drill.discipline === 'combination' ? 'selected' : ''}>Combination (Rifle + Pistol)</option>
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
      disciplineLabel(drill.discipline),
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
    templates: getTemplates(),
    matches: getMatches(),
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
    if (data.templates) saveTemplates(data.templates);
    if (data.matches) saveMatches(data.matches);
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
    description: document.getElementById('new-drill-instructions').value.trim(),
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
  document.getElementById('new-drill-instructions').value = '';
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
// MATCH TRACKING
// ============================================================

function getMatches() {
  const raw = localStorage.getItem('matches');
  return raw ? JSON.parse(raw) : [];
}
function saveMatches(matches) {
  localStorage.setItem('matches', JSON.stringify(matches));
}

function goHome() {
  currentView = 'homeMenu';
  renderApp();
}
function goToTraining() {
  currentView = 'main';
  renderApp();
}
function goToMatchTracking() {
  currentView = 'matchTracking';
  renderApp();
}

// Derived stats computed live (not stored) so editing a match never leaves a stale number behind.
function getMatchStats(match) {
  if (match.status !== 'completed') return null;
  const percentPossible = (match.pointsPossible && match.pointsAcquired != null)
    ? Math.round((match.pointsAcquired / match.pointsPossible) * 1000) / 10
    : null;
  const matchHitFactor = (match.timeSeconds > 0 && match.pointsAcquired != null)
    ? Math.round((match.pointsAcquired / match.timeSeconds) * 100) / 100
    : null;
  return { percentPossible, matchHitFactor };
}

let calendarViewYear = new Date().getFullYear();
let calendarViewMonth = new Date().getMonth(); // 0-indexed
let editingMatchId = null; // null while creating a new match, else the match being edited

function renderMatchCalendar() {
  const container = document.getElementById('match-calendar');
  const matches = getMatches();
  const statusByDate = {};
  matches.forEach((m) => { statusByDate[m.date] = m.status; });

  const year = calendarViewYear;
  const month = calendarViewMonth;
  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = firstDay.toLocaleString('default', { month: 'long', year: 'numeric' });

  let cells = '';
  for (let i = 0; i < startWeekday; i++) cells += `<div class="cal-cell cal-empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const status = statusByDate[dateStr];
    const statusClass = status === 'completed' ? 'cal-completed' : status === 'upcoming' ? 'cal-upcoming' : '';
    cells += `<div class="cal-cell ${statusClass}" data-date="${dateStr}">${d}</div>`;
  }

  container.innerHTML = `
    <div class="cal-header">
      <button id="cal-prev-btn" class="secondary">&lsaquo;</button>
      <span>${monthLabel}</span>
      <button id="cal-next-btn" class="secondary">&rsaquo;</button>
    </div>
    <div class="cal-weekdays"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
    <div class="cal-grid">${cells}</div>
    <div class="cal-legend"><span class="cal-legend-dot cal-completed"></span> Completed &nbsp; <span class="cal-legend-dot cal-upcoming"></span> Upcoming</div>
  `;
}

function toggleMatchResultsFieldsVisibility() {
  const status = document.getElementById('match-status-select').value;
  document.getElementById('match-results-fields').style.display = status === 'completed' ? 'flex' : 'none';
}

function openMatchEntryForm(matchId, prefilledDate) {
  editingMatchId = matchId || null;
  const match = matchId ? getMatches().find((m) => String(m.id) === String(matchId)) : null;

  document.getElementById('match-entry-title').textContent = match ? 'Edit Match' : 'Enter Match';
  document.getElementById('match-status-select').value = match ? match.status : 'upcoming';
  document.getElementById('match-date-input').value = match ? match.date : (prefilledDate || '');
  document.getElementById('match-name-input').value = match ? match.name : '';
  document.getElementById('match-division-input').value = match ? match.division : 'Carry Optics';

  document.getElementById('match-stage-count-input').value = (match && match.numberOfStages) || '';
  document.getElementById('match-points-possible-input').value = (match && match.pointsPossible) || '';
  document.getElementById('match-points-acquired-input').value = (match && match.pointsAcquired) || '';
  document.getElementById('match-time-input').value = (match && match.timeSeconds) || '';
  document.getElementById('match-overall-percent-input').value = (match && match.overallPercent) || '';

  const hits = (match && match.hits) || {};
  document.getElementById('match-hits-a').value = hits.a || '';
  document.getElementById('match-hits-c').value = hits.c || '';
  document.getElementById('match-hits-d').value = hits.d || '';
  document.getElementById('match-hits-m').value = hits.m || '';
  document.getElementById('match-hits-npm').value = hits.npm || '';
  document.getElementById('match-hits-ns').value = hits.ns || '';
  document.getElementById('match-hits-p').value = hits.p || '';

  toggleMatchResultsFieldsVisibility();
  document.getElementById('delete-match-btn').classList.toggle('hidden', !match);
  document.getElementById('match-entry-form').classList.remove('hidden');
}

function closeMatchEntryForm() {
  editingMatchId = null;
  document.getElementById('match-entry-form').classList.add('hidden');
}

function saveMatch() {
  const date = document.getElementById('match-date-input').value;
  const name = document.getElementById('match-name-input').value.trim();
  if (!date || !name) {
    alert('Date and match name are required.');
    return;
  }

  const status = document.getElementById('match-status-select').value;
  const division = document.getElementById('match-division-input').value.trim();

  const matches = getMatches();
  let match = editingMatchId ? matches.find((m) => String(m.id) === String(editingMatchId)) : null;
  if (!match) {
    match = { id: Date.now(), createdAt: new Date().toISOString() };
    matches.push(match);
  }

  match.date = date;
  match.name = name;
  match.division = division;
  match.status = status;

  if (status === 'completed') {
    match.numberOfStages = parseInt(document.getElementById('match-stage-count-input').value) || null;
    match.pointsPossible = parseFloat(document.getElementById('match-points-possible-input').value) || null;
    match.pointsAcquired = parseFloat(document.getElementById('match-points-acquired-input').value) || null;
    match.timeSeconds = parseFloat(document.getElementById('match-time-input').value) || null;
    match.overallPercent = parseFloat(document.getElementById('match-overall-percent-input').value) || null;
    match.hits = {
      a: parseInt(document.getElementById('match-hits-a').value) || 0,
      c: parseInt(document.getElementById('match-hits-c').value) || 0,
      d: parseInt(document.getElementById('match-hits-d').value) || 0,
      m: parseInt(document.getElementById('match-hits-m').value) || 0,
      npm: parseInt(document.getElementById('match-hits-npm').value) || 0,
      ns: parseInt(document.getElementById('match-hits-ns').value) || 0,
      p: parseInt(document.getElementById('match-hits-p').value) || 0,
    };
  }

  saveMatches(matches);
  closeMatchEntryForm();
  renderMatchTrackingView();
}

function deleteMatch() {
  if (!editingMatchId) return;
  if (!confirm('Delete this match entry? This cannot be undone.')) return;
  saveMatches(getMatches().filter((m) => String(m.id) !== String(editingMatchId)));
  closeMatchEntryForm();
  renderMatchTrackingView();
}

function renderPerformanceTracking() {
  const completed = getMatches()
    .filter((m) => m.status === 'completed' && m.overallPercent != null)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const container = document.getElementById('performance-tracking-content');
  if (completed.length < 2) {
    container.innerHTML = `<p class="empty-state">Log an Overall Match % on at least 2 completed matches to see your trend.</p>`;
    return;
  }

  const values = completed.map((m) => m.overallPercent);
  container.innerHTML = `<p class="chart-metric-label">Overall Match % Over Time &middot; Higher is better</p>${buildLineChartSvg(values)}`;
}

function renderMatchHistoryList() {
  const matches = [...getMatches()].sort((a, b) => new Date(b.date) - new Date(a.date));
  const listEl = document.getElementById('match-history-list');

  if (matches.length === 0) {
    listEl.innerHTML = `<p class="empty-state">No matches logged yet.</p>`;
    return;
  }

  listEl.innerHTML = matches.map((m) => {
    const stats = getMatchStats(m);
    const statusBadge = m.status === 'upcoming'
      ? '<span class="match-badge match-badge-upcoming">Upcoming</span>'
      : '<span class="match-badge match-badge-completed">Completed</span>';
    const resultLine = m.status === 'completed'
      ? `${m.pointsAcquired ?? '-'} / ${m.pointsPossible ?? '-'} pts (${stats.percentPossible ?? '-'}% PSBL)${m.overallPercent ? ` &middot; Overall: ${m.overallPercent}%` : ''}`
      : 'Results pending';

    return `
      <div class="history-card match-history-card" data-match-id="${m.id}">
        <div class="history-card-header">
          <strong>${m.name}</strong>
          <span class="history-date">${formatDate(m.date)}</span>
        </div>
        <p class="history-drills">${m.division} ${statusBadge}</p>
        <p class="history-count">${resultLine}</p>
      </div>
    `;
  }).join('');
}

function renderMatchTrackingView() {
  renderMatchCalendar();
  renderPerformanceTracking();
  renderMatchHistoryList();
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
    const disciplineTag = drill.discipline !== 'pistol' ? ` ${drill.discipline === 'rifle' ? '🎯 Rifle' : '🔀 Combo'}` : '';

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

const ALL_VIEW_IDS = [
  'home-menu-view', 'session-start-view', 'active-session-view', 'history-view',
  'pr-view', 'history-detail-view', 'drill-library-view', 'templates-view',
  'dry-fire-view', 'match-tracking-view',
];
function hideAllViews() {
  ALL_VIEW_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
}

function renderApp() {
  const session = findActiveSession();

  // Safety net: if the person navigates away mid-sequence, don't let a beep fire on a hidden screen.
  if (currentView !== 'dryFire') clearDryFireTimers();

  hideAllViews();

  if (currentView === 'homeMenu') {
    stopSessionTimer();
    document.getElementById('home-menu-view').classList.remove('hidden');
    return;
  }
  if (currentView === 'matchTracking') {
    stopSessionTimer();
    document.getElementById('match-tracking-view').classList.remove('hidden');
    renderMatchTrackingView();
    return;
  }
  if (currentView === 'dryFire') {
    stopSessionTimer();
    document.getElementById('dry-fire-view').classList.remove('hidden');
    renderDryFireView();
    return;
  }
  if (currentView === 'templates') {
    stopSessionTimer();
    document.getElementById('templates-view').classList.remove('hidden');
    renderTemplatesList();
    return;
  }
  if (currentView === 'drills') {
    stopSessionTimer();
    document.getElementById('drill-library-view').classList.remove('hidden');
    renderDrillLibrary();
    return;
  }
  if (currentView === 'history') {
    stopSessionTimer();
    document.getElementById('history-view').classList.remove('hidden');
    renderHistoryList();
    return;
  }
  if (currentView === 'historyDetail') {
    stopSessionTimer();
    document.getElementById('history-detail-view').classList.remove('hidden');
    renderHistoryDetail();
    return;
  }
  if (currentView === 'prs') {
    stopSessionTimer();
    document.getElementById('pr-view').classList.remove('hidden');
    renderPRList();
    return;
  }

  // 'main': Training landing screen, or the active session itself
  if (!session) {
    stopSessionTimer();
    document.getElementById('session-start-view').classList.remove('hidden');
    renderTemplateCards();
    return;
  }

  document.getElementById('active-session-view').classList.remove('hidden');

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

document.getElementById('close-exercise-detail-btn').addEventListener('click', closeExerciseDetail);
document.getElementById('exercise-detail-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'exercise-detail-overlay') closeExerciseDetail();
});
document.querySelectorAll('.exercise-detail-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchExerciseDetailTab(btn.dataset.tab));
});
document.getElementById('dry-fire-exercise-list').addEventListener('click', (e) => {
  const item = e.target.closest('.exercise-list-item');
  if (item) openExerciseDetail(item.dataset.exerciseId);
});

// A drill's name is clickable everywhere it appears (session, history, library) -
// one shared listener on the body since the .drill-name-link buttons live in
// several different dynamically-rendered containers.
document.body.addEventListener('click', (e) => {
  if (e.target.matches('.drill-name-link')) {
    openDrillDetail(e.target.dataset.drillId);
  }
});

document.getElementById('goto-training-btn').addEventListener('click', goToTraining);
document.getElementById('goto-match-tracking-btn').addEventListener('click', goToMatchTracking);
document.getElementById('back-to-home-btn').addEventListener('click', goHome);

document.getElementById('start-session-btn').addEventListener('click', startSession);
document.getElementById('end-session-btn').addEventListener('click', endSession);
document.getElementById('view-history-btn').addEventListener('click', showHistory);
document.getElementById('back-from-history-btn').addEventListener('click', hideOverlayViews);
document.getElementById('view-prs-btn').addEventListener('click', showPRs);
document.getElementById('back-from-pr-btn').addEventListener('click', hideOverlayViews);

document.getElementById('view-drill-library-btn').addEventListener('click', showDrillLibrary);
document.getElementById('back-from-drill-library-btn').addEventListener('click', hideDrillLibrary);
document.getElementById('load-starter-drills-btn').addEventListener('click', loadStarterDrills);

document.getElementById('view-templates-btn').addEventListener('click', showTemplatesView);
document.getElementById('back-from-templates-btn').addEventListener('click', hideTemplatesView);
document.getElementById('new-template-btn').addEventListener('click', openNewTemplateSetup);
document.getElementById('save-template-btn').addEventListener('click', saveTemplate);
document.getElementById('cancel-template-btn').addEventListener('click', cancelTemplateSetup);

document.getElementById('view-dry-fire-btn').addEventListener('click', showDryFireView);
document.getElementById('back-from-dry-fire-btn').addEventListener('click', hideDryFireView);
document.getElementById('start-dry-fire-btn').addEventListener('click', startDryFireRep);
document.getElementById('cancel-dry-fire-btn').addEventListener('click', cancelDryFireRep);
document.getElementById('dry-fire-drill-select').addEventListener('change', (e) => {
  const drill = getDrillById(e.target.value);
  if (drill && drill.parTime) {
    document.getElementById('dry-fire-par-time').value = drill.parTime;
  }
});
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

document.getElementById('back-from-match-tracking-btn').addEventListener('click', goHome);
document.getElementById('enter-match-btn').addEventListener('click', () => openMatchEntryForm(null));
document.getElementById('save-match-btn').addEventListener('click', saveMatch);
document.getElementById('cancel-match-btn').addEventListener('click', closeMatchEntryForm);
document.getElementById('delete-match-btn').addEventListener('click', deleteMatch);
document.getElementById('match-status-select').addEventListener('change', toggleMatchResultsFieldsVisibility);

document.getElementById('match-calendar').addEventListener('click', (e) => {
  if (e.target.id === 'cal-prev-btn') {
    calendarViewMonth--;
    if (calendarViewMonth < 0) { calendarViewMonth = 11; calendarViewYear--; }
    renderMatchCalendar();
    return;
  }
  if (e.target.id === 'cal-next-btn') {
    calendarViewMonth++;
    if (calendarViewMonth > 11) { calendarViewMonth = 0; calendarViewYear++; }
    renderMatchCalendar();
    return;
  }
  const cell = e.target.closest('.cal-cell[data-date]');
  if (!cell) return;
  const match = getMatches().find((m) => m.date === cell.dataset.date);
  if (match) {
    openMatchEntryForm(match.id);
  } else {
    openMatchEntryForm(null, cell.dataset.date); // pre-fill the date for a new entry
  }
});

document.getElementById('match-history-list').addEventListener('click', (e) => {
  const card = e.target.closest('.match-history-card');
  if (card) openMatchEntryForm(card.dataset.matchId);
});

// ============================================================
// INIT
// ============================================================

// If a session is already in progress, resume straight into it rather than
// showing the home menu - you shouldn't have to navigate past a menu mid-range-session.
if (findActiveSession()) {
  currentView = 'main';
}
renderApp();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}
