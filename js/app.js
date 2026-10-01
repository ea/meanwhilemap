import { CATEGORIES, CATEGORY_BY_ID } from './categories.js';
import {
  fetchEvents, classifyTypes, categorize, fetchSummary, fetchImageLicense, peopleAllowed, maxOngoingMonths,
} from './data.js';
import {
  MONTHS, SPANS, PRECISION_MONTHS, dateSpan, monthIndex, fromMonthIndex, isoDate, windowLabel,
  formatDate, yearLabel, dateKey, gregorianToJulian, toAstronomical, toHistorical,
} from './time.js';

const OHM_STYLE = 'https://www.openhistoricalmap.org/map-styles/main/main.json';
const MIN_YEAR = -2999; // 3000 BCE
const MAX_YEAR = new Date().getFullYear();
const CATEGORY_ORDER = CATEGORIES.map((c) => c.id);
const LIST_MAX = 300;

// ---------------------------------------------------------------- state ----

const state = {
  year: 1812,
  month: 1,
  span: 12,
  limit: 1000,
  lang: 'en',
  anyWiki: true, // include events whose only articles are on other Wikipedias
  ongoing: true, // include events that began before the window and were still under way
  labels: 'en', // map label language, or 'local' for names as written locally
  hidden: new Set(CATEGORIES.filter((c) => c.optIn).map((c) => c.id)),
};

let events = []; // classified events for the current window
let truncated = false; // true when the window had more events than `limit`
const rawCache = new Map(); // query key -> raw events

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// The slider is piecewise-linear so recent centuries (dense with events) get
// more travel than the sparse ancient past. [slider position, year] knots:
const SLIDER_KNOTS = [[0, MIN_YEAR], [150, -499], [350, 1000], [600, 1800], [1000, MAX_YEAR]];

function sliderToYear(v) {
  for (let k = 1; k < SLIDER_KNOTS.length; k++) {
    const [p0, y0] = SLIDER_KNOTS[k - 1];
    const [p1, y1] = SLIDER_KNOTS[k];
    if (v <= p1) return Math.round(y0 + ((v - p0) / (p1 - p0)) * (y1 - y0));
  }
  return MAX_YEAR;
}

function yearToSlider(y) {
  for (let k = 1; k < SLIDER_KNOTS.length; k++) {
    const [p0, y0] = SLIDER_KNOTS[k - 1];
    const [p1, y1] = SLIDER_KNOTS[k];
    if (y <= y1) return p0 + ((y - y0) / (y1 - y0)) * (p1 - p0);
  }
  return 1000;
}

const startIdx = () => monthIndex(state.year, state.month);
const clampYear = (y) => Math.min(MAX_YEAR, Math.max(MIN_YEAR, y));

// ------------------------------------------------------------ URL hash -----
// Our params live alongside MapLibre's own `map=zoom/lat/lon` param.

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const int = (k) => (p.has(k) && Number.isFinite(+p.get(k)) ? Math.round(+p.get(k)) : null);
  if (int('y') !== null) state.year = clampYear(int('y'));
  if (int('m') !== null) state.month = Math.min(12, Math.max(1, int('m')));
  if (SPANS.some((s) => s.months === int('span'))) state.span = int('span');
  if (int('n') !== null) state.limit = Math.min(4000, Math.max(50, int('n')));
  if (/^[a-z-]{2,12}$/.test(p.get('lang') || '')) state.lang = p.get('lang');
  if (p.has('wikis')) state.anyWiki = p.get('wikis') !== 'one';
  if (p.has('ongoing')) state.ongoing = p.get('ongoing') !== '0';
  if (/^([a-z-]{2,12}|local)$/.test(p.get('labels') || '')) state.labels = p.get('labels');
  if (p.has('off')) state.hidden = new Set(p.get('off').split(',').filter((c) => CATEGORY_BY_ID[c]));
}

function writeHash() {
  // Keep values unencoded: MapLibre parses `map=` by splitting on "/".
  const parts = location.hash.slice(1).split('&').filter((kv) => kv.startsWith('map='));
  parts.unshift(`y=${state.year}`, `m=${state.month}`, `span=${state.span}`, `n=${state.limit}`, `lang=${state.lang}`,
    `wikis=${state.anyWiki ? 'any' : 'one'}`, `ongoing=${state.ongoing ? 1 : 0}`, `labels=${state.labels}`);
  parts.push(`off=${[...state.hidden].join(',')}`); // always: opt-in categories are off by default
  history.replaceState(null, '', `#${parts.join('&')}`);
}

// ----------------------------------------------------------------- map -----

const map = new maplibregl.Map({
  container: 'map',
  style: OHM_STYLE,
  center: [15, 38],
  zoom: 1.8,
  hash: 'map',
  attributionControl: {
    compact: true,
    // The OHM style's sources carry no attribution of their own, so credit the
    // basemap's data here (see https://www.openhistoricalmap.org/copyright).
    customAttribution: [
      '© <a href="https://www.openhistoricalmap.org/copyright" target="_blank">OpenHistoricalMap</a> contributors',
      'Coastlines © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
      'Land cover © ESA 2010 &amp; UCLouvain (GlobCover)',
      'Events: <a href="https://www.wikidata.org/" target="_blank">Wikidata</a> (CC0)',
      'Text: <a href="https://www.wikipedia.org/" target="_blank">Wikipedia</a> '
        + '(<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank">CC BY-SA</a>)',
    ].join(' | '), // one string: MapLibre reorders array entries
  },
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.GlobeControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-right');

let mapReady = false;
window.meanwhile = { map, state, events: () => events }; // handy for poking around in the console

function applyBasemapDate() {
  const mid = fromMonthIndex(startIdx() + Math.floor(state.span / 2));
  const day = state.span === 1 ? 15 : 1;
  $('basemap-label').textContent = `Borders & places as of ${formatDate({ ...mid, day }, state.span === 1 ? 11 : 10)}`;
  if (mapReady) map.filterByDate(isoDate(mid.year, mid.month, day));
}

// OHM tiles carry name_<lang> alongside the local `name`; the style only uses
// `name`, so swap each label's ["get","name"] for a coalesce on the chosen language.
const originalTextFields = new Map();

function localizeExpr(expr, lang) {
  if (!Array.isArray(expr)) return expr;
  if (expr.length === 2 && expr[0] === 'get' && expr[1] === 'name') {
    return ['coalesce', ['get', `name_${lang}`], ['get', 'name']];
  }
  return expr.map((e) => localizeExpr(e, lang));
}

function applyLabelLanguage() {
  if (!mapReady) return;
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol' || layer.id.startsWith('ev-')) continue;
    if (!originalTextFields.has(layer.id)) {
      let tf = map.getLayoutProperty(layer.id, 'text-field');
      if (tf === undefined) continue;
      if (tf === '{name}') tf = ['get', 'name']; // legacy token syntax
      originalTextFields.set(layer.id, tf);
    }
    const orig = originalTextFields.get(layer.id);
    map.setLayoutProperty(layer.id, 'text-field', state.labels === 'local' ? orig : localizeExpr(orig, state.labels));
  }
}

function addEventLayers() {
  map.addSource('events', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    cluster: true,
    clusterMaxZoom: 8,
    clusterRadius: 40,
  });
  map.addLayer({
    id: 'ev-clusters', type: 'circle', source: 'events', filter: ['has', 'point_count'],
    paint: {
      'circle-color': '#33414f',
      'circle-opacity': 0.82,
      'circle-radius': ['step', ['get', 'point_count'], 13, 10, 17, 50, 22, 200, 28],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  });
  map.addLayer({
    id: 'ev-cluster-count', type: 'symbol', source: 'events', filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['OpenHistorical Bold'],
      'text-size': 12,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#ffffff' },
  });
  map.addLayer({
    id: 'ev-points', type: 'circle', source: 'events', filter: ['!', ['has', 'point_count']],
    layout: { 'circle-sort-key': ['get', 'links'] },
    // Events placed at their region's or country's center are drawn hollow;
    // events already under way when the window opens are faded.
    paint: {
      'circle-opacity': ['case', ['get', 'ongoing'], 0.45, 1],
      'circle-stroke-opacity': ['case', ['get', 'ongoing'], 0.6, 1],
      'circle-color': ['case', ['get', 'approx'], '#ffffff', ['get', 'color']],
      'circle-radius': ['interpolate', ['linear'], ['get', 'links'], 1, 5, 30, 7, 100, 10, 250, 13],
      'circle-stroke-width': ['case', ['get', 'approx'], 2.5, 1.5],
      'circle-stroke-color': ['case', ['get', 'approx'], ['get', 'color'], '#ffffff'],
    },
  });
  map.addLayer({
    id: 'ev-labels', type: 'symbol', source: 'events', filter: ['!', ['has', 'point_count']], minzoom: 4,
    layout: {
      'text-field': ['get', 'title'],
      'text-font': ['OpenHistorical'],
      'text-size': 12,
      'text-anchor': 'left',
      'text-offset': [0.9, 0],
      'text-max-width': 14,
      'text-optional': true,
      'symbol-sort-key': ['-', ['get', 'links']],
    },
    paint: {
      'text-color': '#1f2328', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.4,
      'text-opacity': ['case', ['get', 'ongoing'], 0.6, 1],
    },
  });

  map.on('click', 'ev-clusters', async (e) => {
    const f = e.features[0];
    const zoom = await map.getSource('events').getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(zoom, 16) });
  });
  map.on('click', 'ev-points', (e) => {
    const { x, y } = e.point;
    const hits = map.queryRenderedFeatures([[x - 5, y - 5], [x + 5, y + 5]], { layers: ['ev-points'] });
    const list = [...new Set(hits.map((f) => f.properties.i))].map((i) => events[i]).filter(Boolean);
    if (list.length === 1) showEvent(list[0]);
    else if (list.length > 1) showEventList(list, e.lngLat);
  });
  for (const layer of ['ev-clusters', 'ev-points']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
}

// First `styledata` fires as soon as the style JSON is parsed, before tiles load,
// so the date filter is in place before any undated-era features get drawn.
map.once('styledata', () => {
  mapReady = true;
  applyBasemapDate();
  applyLabelLanguage();
  addEventLayers();
  render();
});
map.on('moveend', () => scheduleList());

// -------------------------------------------------------------- popups -----

let popup = null;

function openPopup(lngLat, html) {
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '340px', focusAfterOpen: false })
    .setLngLat(lngLat).setHTML(html).addTo(map);
  return popup.getElement();
}

/** Pans so a popup that grew after loading content stays fully on screen. */
function keepPopupInView(el) {
  if (!el.isConnected) return;
  const r = el.getBoundingClientRect();
  const m = map.getContainer().getBoundingClientRect();
  const dy = r.top < m.top + 8 ? r.top - m.top - 8 : 0;
  const dx = r.right > m.right - 56 ? r.right - m.right + 56 : r.left < m.left + 8 ? r.left - m.left - 8 : 0;
  if (dx || dy) map.panBy([dx, dy], { duration: 300 });
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
function languageName(code) {
  try {
    return languageNames.of(code) || code;
  } catch {
    return code;
  }
}

/**
 * The date as sources give it. Julian-calendar dates (Wikipedia's convention
 * before 1582, and e.g. Russia until 1918) arrive converted to Gregorian when
 * known to the day, so convert them back; after 1582 they're marked O.S.
 */
function displayDate(ev) {
  if (ev.calendar !== 'julian' || ev.precision < 11) return formatDate(ev.date, ev.precision);
  const s = formatDate(gregorianToJulian(ev.date), ev.precision);
  return ev.date.year >= 1582 ? `${s} (O.S.)` : s;
}

function dateText(ev) {
  let s = displayDate(ev);
  if (ev.dateApprox) s = `sometime in ${ev.precision <= 8 ? 'the ' : ''}${s}`;
  if (ev.kind === 'born' || ev.kind === 'died') {
    return `${ev.kind === 'born' ? 'Born' : 'Died'} ${s}${ev.place ? ` in ${ev.place}` : ''}`;
  }
  s = s[0].toUpperCase() + s.slice(1);
  if (ev.kind === 'ongoing') return `Ongoing: ${s}${ev.end ? ` – ${yearLabel(ev.end.year)}` : ''}`;
  if (ev.end && ev.end.year !== ev.date.year) s += ` – ${yearLabel(ev.end.year)}`;
  return s;
}

async function showEvent(ev) {
  const cat = CATEGORY_BY_ID[ev.cat];
  const ohmDate = isoDate(ev.date.year, ev.date.month, ev.date.day);
  const el = openPopup([ev.lon, ev.lat], `
    <div class="pop">
      <h3><a href="${esc(ev.url)}" target="_blank" rel="noopener">${esc(ev.title)}</a></h3>
      <div class="meta"><span>${esc(dateText(ev))}</span>
        <span class="cat" style="--c:${cat.color}">${esc(cat.label)}</span></div>
      ${ev.wiki !== state.lang ? `<div class="meta approx">Article in ${esc(languageName(ev.wiki))}</div>` : ''}
      ${ev.located !== 'exact' ? `<div class="meta approx">Approximate location: center of the event's ${ev.located}</div>` : ''}
      <div class="body"><p class="muted">Loading summary…</p></div>
      <div class="links">
        <a href="${esc(ev.url)}" target="_blank" rel="noopener">Wikipedia${ev.wiki !== state.lang ? ` (${esc(ev.wiki)})` : ''} ↗</a>
        <a href="https://www.wikidata.org/wiki/${ev.id}" target="_blank" rel="noopener">Wikidata ↗</a>
        <a href="https://www.openhistoricalmap.org/#map=8/${ev.lat.toFixed(4)}/${ev.lon.toFixed(4)}&date=${ohmDate}"
           target="_blank" rel="noopener">OpenHistoricalMap ↗</a>
      </div>
    </div>`);
  highlightListItem(ev);
  const s = await fetchSummary(ev.wiki, ev.article);
  const body = el.querySelector('.body');
  if (!el.isConnected) return; // popup was replaced meanwhile
  if (!s?.extract) {
    body.innerHTML = '<p class="muted">No summary available.</p>';
    return;
  }
  const extract = s.extract.length > 700 ? `${s.extract.slice(0, 700).replace(/\s+\S*$/, '')}…` : s.extract;
  body.innerHTML = `<p>${esc(extract)}</p>
    <p class="credit">Text from <a href="${esc(ev.url)}" target="_blank" rel="noopener">Wikipedia</a>,
      <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a></p>`;
  keepPopupInView(el);

  // Show the thumbnail only once its license is known to be free, with credit.
  if (!s.thumbnail) return;
  const img = await fetchImageLicense(ev.wiki, s.thumbnail.source);
  if (!img || !el.isConnected) return;
  const license = img.licenseUrl
    ? `<a href="${esc(img.licenseUrl)}" target="_blank" rel="noopener">${esc(img.license)}</a>`
    : esc(img.license);
  body.insertAdjacentHTML('afterbegin', `
    <figure>
      <a href="${esc(img.pageUrl)}" target="_blank" rel="noopener"><img src="${esc(s.thumbnail.source)}" alt=""></a>
      <figcaption>${img.artist ? `${esc(img.artist)} · ` : ''}${license}</figcaption>
    </figure>`);
  body.querySelector('figure img').addEventListener('load', () => keepPopupInView(el), { once: true });
}

function showEventList(list, lngLat) {
  list.sort((a, b) => dateKey(a.date) - dateKey(b.date));
  const el = openPopup(lngLat, `
    <div class="pop">
      <h3>${list.length} events here</h3>
      <ul>${list.map((ev) => `
        <li data-i="${events.indexOf(ev)}"><span class="dot" style="--c:${CATEGORY_BY_ID[ev.cat].color}"></span><span
          class="t">${esc(ev.title)}</span><div class="d">${esc(dateText(ev))}</div></li>`).join('')}
      </ul>
    </div>`);
  el.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => showEvent(events[+li.dataset.i])));
}

// ------------------------------------------------------------- loading -----

let controller = null;
let loadTimer = null;
let loading = false;

function setStatus(text, { loading = false, error = false } = {}) {
  const el = $('status');
  el.className = error ? 'muted error' : 'muted';
  el.innerHTML = `${loading ? '<span class="spinner"></span>' : ''}${esc(text)}`;
}

/**
 * Keeps an event if the period its date could fall in overlaps the window,
 * as long as that period isn't far vaguer than the window itself (a
 * "15th century" event says little about one particular month).
 * Flags events that may lie partly outside the window as `dateApprox`.
 */
function fitDate(ev) {
  if (ev.kind === 'ongoing') return fitOngoing(ev);
  const [from, to] = dateSpan(ev.date, ev.precision);
  const start = startIdx();
  const end = start + state.span;
  if (to <= start || from >= end) return false;
  if ((PRECISION_MONTHS[ev.precision] ?? 12000) > Math.max(12, state.span * 10)) return false;
  ev.dateApprox = from < start || to > end;
  return true;
}

/**
 * An event that began before the window is shown while it's still under way
 * when the window opens, unless it lasted far longer than the window itself.
 */
function fitOngoing(ev) {
  if (!ev.end) return false;
  const from = monthIndex(ev.date.year, ev.date.month);
  const until = monthIndex(ev.end.year, ev.end.month);
  return from < startIdx() && until >= startIdx() && until - from <= maxOngoingMonths(state.span);
}

const PLACE_MIN_LINKS = 50;

function assignCategory(ev, cache) {
  if (ev.kind === 'born' || ev.kind === 'died') return 'people';
  const cat = categorize(ev, cache, CATEGORY_ORDER); // events and ongoing events alike
  if (ev.kind === 'founded') {
    // Bots have created articles for thousands of villages, counties and
    // cantons in dozens of languages; only well-known places are worth a pin.
    return cat === 'place' && ev.links < PLACE_MIN_LINKS ? null : 'founded';
  }
  return cat && cat !== 'founded' && CATEGORY_BY_ID[cat] ? cat : null;
}

async function load() {
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  const params = {
    startIdx: startIdx(), span: state.span, lang: state.lang, limit: state.limit, anyWiki: state.anyWiki,
    founded: !state.hidden.has('founded'),
    people: !state.hidden.has('people'),
    ongoing: state.ongoing,
  };
  const key = JSON.stringify(params);
  const label = windowLabel(params.startIdx, params.span);
  loading = true;
  try {
    let raw = rawCache.get(key);
    if (!raw) {
      setStatus(`Querying Wikidata for ${label}…`, { loading: true });
      raw = await fetchEvents(params, signal, (done, total) => {
        if (total > 1) setStatus(`Querying Wikidata for ${label}… (${done}/${total})`, { loading: true });
      });
      rawCache.set(key, raw);
    }
    const cache = await classifyTypes(raw.flatMap((e) => e.types), signal, (done, total) => {
      setStatus(`Classifying event types… (${done}/${total})`, { loading: true });
    });
    if (signal.aborted) return;
    loading = false;
    truncated = raw.filter((e) => e.kind === 'event').length >= state.limit * 0.95;
    events = raw
      .map((e) => ({ ...e, cat: assignCategory(e, cache) }))
      .filter((e) => e.cat && fitDate(e));
    popup?.remove();
    render();
    $('event-list').scrollTop = 0;
  } catch (err) {
    if (signal.aborted) return;
    loading = false;
    console.error(err);
    setStatus(`${err.message}. Try a shorter window or fewer max events.`, { error: true });
  }
}

/** Updates the UI immediately; debounces the network fetch. */
function commit({ immediate = false, fromSlider = false } = {}) {
  syncInputs(fromSlider);
  writeHash();
  applyBasemapDate();
  loading = true;
  setStatus(`Loading ${windowLabel(startIdx(), state.span)}…`, { loading: true });
  clearTimeout(loadTimer);
  if (immediate) load();
  else loadTimer = setTimeout(load, 450);
}

// ------------------------------------------------------------ rendering ----

function visibleEvents() {
  return events.filter((e) => !state.hidden.has(e.cat));
}

function render() {
  renderChips();
  if (mapReady) {
    const features = [];
    events.forEach((ev, i) => {
      if (state.hidden.has(ev.cat)) return;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ev.lon, ev.lat] },
        properties: {
          i, title: ev.title, color: CATEGORY_BY_ID[ev.cat].color, links: ev.links, approx: ev.located !== 'exact',
          ongoing: ev.kind === 'ongoing',
        },
      });
    });
    map.getSource('events').setData({ type: 'FeatureCollection', features });
  }
  renderList();
  if (loading) return;
  const shown = visibleEvents().length;
  let note = truncated ? ` · top ${state.limit} by Wikipedia coverage` : '';
  if (!state.hidden.has('people') && !peopleAllowed({ startIdx: startIdx(), span: state.span })) {
    note += ' · births & deaths need a window of 10 years or less after 1850';
  }
  setStatus(`${shown} of ${events.length} events shown for ${windowLabel(startIdx(), state.span)}${note}`);
}

function renderChips() {
  const counts = {};
  for (const e of events) counts[e.cat] = (counts[e.cat] || 0) + 1;
  $('categories').innerHTML = CATEGORIES.map((c) => `
    <button class="chip" data-cat="${c.id}" style="--c:${c.color}" aria-pressed="${!state.hidden.has(c.id)}"
      title="Click to toggle, double-click to show only this">
      <span class="dot"></span>${esc(c.label)} <span class="n">${counts[c.id] || 0}</span>
    </button>`).join('');
}

$('categories').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const id = chip.dataset.cat;
  if (state.hidden.has(id)) state.hidden.delete(id);
  else state.hidden.add(id);
  // Opt-in categories come from their own queries, so showing one means fetching.
  if (CATEGORY_BY_ID[id].optIn) {
    commit({ immediate: true });
    return;
  }
  writeHash();
  render();
});
$('categories').addEventListener('dblclick', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const id = chip.dataset.cat;
  const soloed = state.hidden.size === CATEGORIES.length - 1 && !state.hidden.has(id);
  const optIn = CATEGORIES.filter((c) => c.optIn).map((c) => c.id);
  const before = optIn.map((c) => state.hidden.has(c)).join();
  // Un-soloing restores the default: every regular category, opt-in ones off.
  state.hidden = soloed ? new Set(optIn) : new Set(CATEGORY_ORDER.filter((c) => c !== id));
  if (optIn.map((c) => state.hidden.has(c)).join() !== before) {
    commit({ immediate: true });
    return;
  }
  writeHash();
  render();
});

let listFrame = 0;
function scheduleList() {
  cancelAnimationFrame(listFrame);
  listFrame = requestAnimationFrame(renderList);
}

function renderList() {
  const bounds = mapReady ? map.getBounds() : null;
  const inView = visibleEvents()
    .filter((e) => !bounds || bounds.contains([e.lon, e.lat]))
    .sort((a, b) => dateKey(a.date) - dateKey(b.date) || b.links - a.links);
  $('list-title').textContent = `${inView.length} event${inView.length === 1 ? '' : 's'} in view`;
  const items = inView.slice(0, LIST_MAX).map((ev) => `
    <li data-i="${events.indexOf(ev)}" style="--c:${CATEGORY_BY_ID[ev.cat].color}">
      <span class="dot"></span><span class="t">${esc(ev.title)}</span><span class="d">${esc(dateText(ev))}</span>
    </li>`);
  if (inView.length > LIST_MAX) items.push(`<li class="more">+${inView.length - LIST_MAX} more — zoom in to narrow</li>`);
  $('event-list').innerHTML = items.join('');
}

$('event-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const ev = events[+li.dataset.i];
  map.flyTo({ center: [ev.lon, ev.lat], zoom: Math.max(map.getZoom(), 9), speed: 1.6 });
  map.once('moveend', () => showEvent(ev));
});

function highlightListItem(ev) {
  const i = events.indexOf(ev);
  document.querySelectorAll('#event-list li.active').forEach((li) => li.classList.remove('active'));
  const li = document.querySelector(`#event-list li[data-i="${i}"]`);
  if (li) {
    li.classList.add('active');
    li.scrollIntoView({ block: 'nearest' });
  }
}

$('list-toggle').addEventListener('click', () => {
  $('list-panel').hidden = true;
  $('list-open').hidden = false;
});
$('list-open').addEventListener('click', () => {
  $('list-panel').hidden = false;
  $('list-open').hidden = true;
});
if (matchMedia('(max-width: 760px)').matches) $('list-toggle').click();

// "i" info card: a modal <dialog>; Escape closes it natively, a click on the
// backdrop (outside the card's box) closes it too.
$('info-open').addEventListener('click', () => $('info').showModal());
$('info-close').addEventListener('click', () => $('info').close());
$('info').addEventListener('click', (e) => {
  const r = $('info').getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) $('info').close();
});

// Collapsible settings card: collapsed by default on phones, remembered per browser.
function setControlsCollapsed(collapsed) {
  $('controls').classList.toggle('collapsed', collapsed);
  const btn = $('controls-toggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = btn.ariaLabel = collapsed ? 'Show settings' : 'Hide settings';
  try {
    localStorage.setItem('meanwhile-controls-collapsed', collapsed ? '1' : '0');
  } catch { /* storage unavailable */ }
}
{
  let saved = null;
  try {
    saved = localStorage.getItem('meanwhile-controls-collapsed');
  } catch { /* storage unavailable */ }
  setControlsCollapsed(saved === null ? matchMedia('(max-width: 760px)').matches : saved === '1');
}
$('controls-toggle').addEventListener('click', () => {
  setControlsCollapsed(!$('controls').classList.contains('collapsed'));
});

// ------------------------------------------------------------- controls ----

function syncInputs(fromSlider = false) {
  const h = toHistorical(state.year);
  if (!fromSlider) $('year-slider').value = yearToSlider(state.year); // don't fight the drag
  $('year-input').value = h.year;
  $('era-input').value = h.bce ? 'BCE' : 'CE';
  $('month-input').value = state.month;
  $('span-input').value = state.span;
  $('limit-input').value = state.limit;
  $('lang-input').value = state.lang;
  $('anywiki-input').checked = state.anyWiki;
  $('ongoing-input').checked = state.ongoing;
  $('labels-input').value = state.labels;
  $('when-label').textContent = windowLabel(startIdx(), state.span);
}

$('month-input').innerHTML = MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
$('span-input').innerHTML = SPANS.map((s) => `<option value="${s.months}">${s.label}</option>`).join('');
$('ticks').innerHTML = SLIDER_KNOTS.map(([p, y]) => `<span style="left:${p / 10}%">${yearLabel(y)}</span>`).join('');

$('year-slider').addEventListener('input', (e) => {
  state.year = sliderToYear(+e.target.value);
  commit({ fromSlider: true });
});
function onYearField() {
  const y = parseInt($('year-input').value, 10);
  if (!Number.isFinite(y) || y < 1) return;
  state.year = clampYear(toAstronomical(y, $('era-input').value === 'BCE'));
  commit({ immediate: true });
}
$('year-input').addEventListener('change', onYearField);
$('era-input').addEventListener('change', onYearField);
$('month-input').addEventListener('change', (e) => { state.month = +e.target.value; commit({ immediate: true }); });
$('span-input').addEventListener('change', (e) => { state.span = +e.target.value; commit({ immediate: true }); });
$('limit-input').addEventListener('change', (e) => { state.limit = +e.target.value; commit({ immediate: true }); });
$('labels-input').innerHTML = `<option value="local">Local names</option>${$('lang-input').innerHTML}`;
$('labels-input').addEventListener('change', (e) => {
  state.labels = e.target.value;
  syncInputs();
  writeHash();
  applyLabelLanguage(); // purely visual: no need to refetch events
});
$('anywiki-input').addEventListener('change', (e) => { state.anyWiki = e.target.checked; commit({ immediate: true }); });
$('ongoing-input').addEventListener('change', (e) => { state.ongoing = e.target.checked; commit({ immediate: true }); });
$('lang-input').addEventListener('change', (e) => { state.lang = e.target.value; commit({ immediate: true }); });

function step(dir) {
  const next = fromMonthIndex(startIdx() + dir * state.span);
  if (next.year < MIN_YEAR || next.year > MAX_YEAR) return;
  state.year = next.year;
  state.month = next.month;
  commit();
}
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowLeft' && e.shiftKey) step(-1);
  if (e.key === 'ArrowRight' && e.shiftKey) step(1);
});

// ---------------------------------------------------------------- start ----

readHash();
commit({ immediate: true });
