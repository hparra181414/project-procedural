// ============================================================
// DATA LAYER
// ============================================================
// Two separate things live in localStorage now:
// - 'drills'   : your reusable drill library (like Strong's exercise list)
// - 'sessions' : every training session, each containing drill entries with strings

function getDrills() {
  const raw = localStorage.getItem('drills');
  return raw ? JSON.parse(raw) : [];
}
function saveDrills(drills) {
  localStorage.setItem('drills', JSON.stringify(drills));
}

function getSessions() {
  const raw = localStorage.getItem('sessions');
  return raw ? JSON.parse(raw) : [];
}
function saveSessions(sessions) {
  localStorage.setItem('sessions', JSON.stringify(sessions));
}

// Tracks which session is currently "in progress" across page reloads,
// so refreshing mid-session at the range doesn't lose your place.
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
// SCORING
// ============================================================

const POINTS = { a: 5, c: 3, d: 1, m: 0, ns: -10 }; // USPSA Minor power factor

function calculateHitFactor(hits, timeSeconds) {
  const points =
    hits.a * POINTS.a + hits.c * POINTS.c + hits.d * POINTS.d +
    hits.m * POINTS.m + hits.ns * POINTS.ns;
  const hitFactor = timeSeconds > 0 ? points / timeSeconds : 0;
  return { points, hitFactor: Math.round(hitFactor * 100) / 100 };
}

// ============================================================
// SESSION ACTIONS
// ============================================================

function startSession() {
  const sessions = getSessions();
  const newSession = {
    id: Date.now(),
    date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
    location: '',
    drillEntries: [], // each: { drillId, drillName, strings: [] }
  };
  sessions.push(newSession);
  saveSessions(sessions);
  setActiveSessionId(newSession.id);
  renderApp();
}

function endSession() {
  setActiveSessionId(null);
  renderApp();
}

function updateSessionLocation(value) {
  const session = findActiveSession();
  if (!session) return;
  session.location = value;
  const sessions = getSessions().map((s) => (s.id === session.id ? session : s));
  saveSessions(sessions);
}

// Adds a drill to the active session. If the drill name is new, it's also
// added to the permanent drill library so it autocompletes next time.
function addDrillToSession(drillName) {
  const trimmed = drillName.trim();
  if (!trimmed) return;

  const session = findActiveSession();
  if (!session) return;

  // Don't add the same drill twice into one session - just ignore if it's already there.
  const alreadyInSession = session.drillEntries.some(
    (e) => e.drillName.toLowerCase() === trimmed.toLowerCase()
  );
  if (alreadyInSession) return;

  // Find-or-create in the drill library
  let drills = getDrills();
  let drill = drills.find((d) => d.name.toLowerCase() === trimmed.toLowerCase());
  if (!drill) {
    drill = { id: Date.now(), name: trimmed, createdAt: new Date().toISOString() };
    drills.push(drill);
    saveDrills(drills);
  }

  session.drillEntries.push({ drillId: drill.id, drillName: drill.name, strings: [] });
  const sessions = getSessions().map((s) => (s.id === session.id ? session : s));
  saveSessions(sessions);
  renderApp();
}

// Logs a string (one timed run) under a specific drill entry within the active session.
function logString(drillEntryIndex, timeSeconds, hits) {
  const session = findActiveSession();
  if (!session) return;

  const { points, hitFactor } = calculateHitFactor(hits, timeSeconds);
  session.drillEntries[drillEntryIndex].strings.push({
    id: Date.now(),
    timeSeconds,
    hits,
    points,
    hitFactor,
    loggedAt: new Date().toISOString(),
  });

  const sessions = getSessions().map((s) => (s.id === session.id ? session : s));
  saveSessions(sessions);
  renderApp();
}

// ============================================================
// RENDERING
// ============================================================

function renderApp() {
  const session = findActiveSession();
  const startView = document.getElementById('session-start-view');
  const activeView = document.getElementById('active-session-view');

  if (!session) {
    startView.classList.remove('hidden');
    activeView.classList.add('hidden');
    return;
  }

  startView.classList.add('hidden');
  activeView.classList.remove('hidden');

  document.getElementById('session-location').value = session.location || '';

  // Keep the "add drill" autocomplete list current
  const datalist = document.getElementById('drill-options');
  datalist.innerHTML = getDrills().map((d) => `<option value="${d.name}">`).join('');

  // Build the drill entry cards
  const container = document.getElementById('drill-entries');
  container.innerHTML = session.drillEntries.map((entry, index) => `
    <div class="drill-entry" data-index="${index}">
      <h3>${entry.drillName}</h3>
      <ul class="string-list-mini">
        ${entry.strings.map((s) => `
          <li>${s.timeSeconds}s — A:${s.hits.a} C:${s.hits.c} D:${s.hits.d} M:${s.hits.m} NS:${s.hits.ns} — HF:${s.hitFactor}</li>
        `).join('')}
      </ul>
      <div class="mini-form">
        <input type="number" step="0.01" class="mini-time" placeholder="Time (seconds)">
        <div class="hits-row-mini">
          <input type="number" class="mini-hit" data-zone="a" placeholder="A" min="0" value="0">
          <input type="number" class="mini-hit" data-zone="c" placeholder="C" min="0" value="0">
          <input type="number" class="mini-hit" data-zone="d" placeholder="D" min="0" value="0">
          <input type="number" class="mini-hit" data-zone="m" placeholder="M" min="0" value="0">
          <input type="number" class="mini-hit" data-zone="ns" placeholder="NS" min="0" value="0">
        </div>
        <button class="log-string-btn" data-index="${index}">Log String</button>
      </div>
    </div>
  `).join('');
}

// ============================================================
// EVENT WIRING
// ============================================================

document.getElementById('start-session-btn').addEventListener('click', startSession);
document.getElementById('end-session-btn').addEventListener('click', endSession);

document.getElementById('session-location').addEventListener('input', (e) => {
  updateSessionLocation(e.target.value);
});

document.getElementById('add-drill-btn').addEventListener('click', () => {
  const input = document.getElementById('add-drill-input');
  addDrillToSession(input.value);
  input.value = '';
});

// Event delegation: drill entries are created dynamically, so we listen on
// their shared parent container rather than attaching listeners one by one.
document.getElementById('drill-entries').addEventListener('click', (e) => {
  if (!e.target.matches('.log-string-btn')) return;

  const drillEntryIndex = parseInt(e.target.dataset.index);
  const card = e.target.closest('.drill-entry');

  const timeSeconds = parseFloat(card.querySelector('.mini-time').value);
  if (!timeSeconds || timeSeconds <= 0) {
    alert('Enter a time before logging.');
    return;
  }

  const hits = {};
  card.querySelectorAll('.mini-hit').forEach((input) => {
    hits[input.dataset.zone] = parseInt(input.value) || 0;
  });

  logString(drillEntryIndex, timeSeconds, hits);
});

// ============================================================
// INIT
// ============================================================

renderApp();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}
