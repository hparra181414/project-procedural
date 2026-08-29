// ---- Data layer ----
// localStorage only stores strings, so we JSON.stringify/parse to store objects.

function getStrings() {
  const raw = localStorage.getItem('strings');
  return raw ? JSON.parse(raw) : [];
}

function saveStrings(strings) {
  localStorage.setItem('strings', JSON.stringify(strings));
}

// USPSA Minor power factor scoring. (Major scores C/D differently -
// we'll make this switchable once divisions/power factor come into the app.)
const POINTS = { a: 5, c: 3, d: 1, m: 0, ns: -10 };

function calculateHitFactor(hits, timeSeconds) {
  const points =
    hits.a * POINTS.a +
    hits.c * POINTS.c +
    hits.d * POINTS.d +
    hits.m * POINTS.m +
    hits.ns * POINTS.ns;

  const hitFactor = timeSeconds > 0 ? points / timeSeconds : 0;

  return { points, hitFactor: Math.round(hitFactor * 100) / 100 };
}

// ---- Rendering ----

function renderList() {
  const listEl = document.getElementById('string-list');
  const strings = getStrings();

  listEl.innerHTML = ''; // clear and redraw - simplest approach for a small list

  // newest first
  const sorted = [...strings].reverse();

  sorted.forEach((s) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <strong>${s.drillName}</strong> — ${s.timeSeconds}s
      <br>
      A:${s.hits.a} C:${s.hits.c} D:${s.hits.d} M:${s.hits.m} NS:${s.hits.ns}
      <br>
      Points: ${s.points} | Hit Factor: ${s.hitFactor}
    `;
    listEl.appendChild(li);
  });
}

// ---- Form handling ----

function handleSubmit(event) {
  event.preventDefault(); // stops the page from reloading, which is a normal HTML form's default behavior

  const drillName = document.getElementById('drill-name').value.trim();
  const timeSeconds = parseFloat(document.getElementById('time-seconds').value);

  const hits = {
    a: parseInt(document.getElementById('hits-a').value) || 0,
    c: parseInt(document.getElementById('hits-c').value) || 0,
    d: parseInt(document.getElementById('hits-d').value) || 0,
    m: parseInt(document.getElementById('hits-m').value) || 0,
    ns: parseInt(document.getElementById('hits-ns').value) || 0,
  };

  const { points, hitFactor } = calculateHitFactor(hits, timeSeconds);

  const newString = {
    id: Date.now(),          // simple unique id - good enough for a personal, single-device app
    drillName,
    timeSeconds,
    hits,
    points,
    hitFactor,
    loggedAt: new Date().toISOString(),
  };

  const strings = getStrings();
  strings.push(newString);
  saveStrings(strings);

  renderList();
  event.target.reset(); // clears the form so it's ready for the next string
}

// ---- Init ----

document.getElementById('string-form').addEventListener('submit', handleSubmit);
renderList(); // show any strings already saved from a previous session

// Register the service worker so the app can work offline once cached.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}
