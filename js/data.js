// Client-side access to Wikidata (events + classification) and Wikipedia (summaries).
import { ALL_ROOTS, categoryFromRoots } from './categories.js';
import {
  parseXsd, xsdDateTime, fromMonthIndex, monthIndex, dateKey,
} from './time.js';

const WDQS = 'https://query.wikidata.org/sparql';

async function sparql(query, signal, { post = false } = {}) {
  const headers = { Accept: 'application/sparql-results+json' };
  // GET responses are cached by the query service's CDN; POST avoids URL length limits.
  const res = post
    ? await fetch(WDQS, {
      method: 'POST', headers, signal,
      body: new URLSearchParams({ query }),
    })
    : await fetch(`${WDQS}?query=${encodeURIComponent(query)}`, { headers, signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const timeout = /TimeoutException|timeout/i.test(text) || res.status === 504;
    throw new Error(timeout ? 'Wikidata query timed out' : `Wikidata query failed (HTTP ${res.status})`);
  }
  return (await res.json()).results.bindings;
}

// `hint:rangeSafe` tells Blazegraph the date values are all xsd:dateTime, so the
// range FILTER can use the index instead of scanning; 2-20x faster in practice.
const statements = (props) => props.map((p) => `{ ?item p:${p} ?st . ?st psv:${p} ?tv }`).join(' UNION ');

// Date properties per kind: point in time / start time / spacecraft launch date
// for events; start time for events already ongoing when the window opens;
// inception / official opening for things founded or built.
const DATE_PROPS = {
  event: ['P585', 'P580', 'P619'], ongoing: ['P580'], founded: ['P571', 'P1619'], born: ['P569'], died: ['P570'],
};

/**
 * Longest an ongoing event may last and still be shown: ten times the window
 * (at least a year). A 1-year window shows a 4-year war that's under way; a
 * month doesn't show the Hundred Years' War.
 */
export const maxOngoingMonths = (span) => Math.max(12, span * 10);
const PLACE_PROP = { born: 'P19', died: 'P20' }; // place of birth / death
const isPerson = (kind) => kind in PLACE_PROP;

function rangeClause({ startIdx, span, kind, windowStart }, props) {
  const s = fromMonthIndex(startIdx);
  const e = fromMonthIndex(startIdx + span);
  // Ongoing: started in this (earlier) range and still running when the window opens.
  const w = kind === 'ongoing' ? fromMonthIndex(windowStart) : null;
  return `
  ${statements(props)}
  ?tv wikibase:timeValue ?date . hint:Prior hint:rangeSafe true .
  ?tv wikibase:timePrecision ?prec ; wikibase:timeCalendarModel ?cal .
  FILTER(?date >= "${xsdDateTime(s.year, s.month)}"^^xsd:dateTime && ?date < "${xsdDateTime(e.year, e.month)}"^^xsd:dateTime)${w ? `
  ?item wdt:P582 ?until . FILTER(?until >= "${xsdDateTime(w.year, w.month)}"^^xsd:dateTime)` : ''}`;
}

// Exact lookups of year/decade start dates with coarse precision: those events
// could fall in the window, but their stored date (1 January) lies outside it.
function coarseClause(values, props) {
  const rows = values.map(({ year, maxPrec }) => `("${xsdDateTime(year, 1, 1)}"^^xsd:dateTime ${maxPrec})`);
  return `
  VALUES (?date ?maxPrec) { ${rows.join(' ')} }
  ?tv wikibase:timeValue ?date ; wikibase:timePrecision ?prec ; wikibase:timeCalendarModel ?cal .
  FILTER(?prec <= ?maxPrec)
  ${props.map((p) => `{ ?st psv:${p} ?tv . ?item p:${p} ?st }`).join(' UNION ')}`;
}

// Articles: `?ap` on the preferred Wikipedia, `?ae` on English. With anyWiki,
// both are optional and items covered only by other Wikipedias come back
// without an article URL; resolveArticles() fills those in afterwards.
function eventsQuery({ lang, limit, minLinks, anyWiki, kind }, dateClause) {
  const preferred = `?ap schema:about ?item ; schema:isPartOf <https://${lang}.wikipedia.org/>`;
  // People are pinned at their place of birth/death, which is named in the popup.
  const where = isPerson(kind) ? `
  ?item wdt:${PLACE_PROP[kind]} ?where . ?where wdt:P625 ?c1 .
  BIND(CONCAT("0|", STR(?c1)) AS ?coord)
  OPTIONAL { ?where rdfs:label ?pl FILTER(LANG(?pl) = "${lang}") }
  OPTIONAL { ?where rdfs:label ?ple FILTER(LANG(?ple) = "en") }` : `
  OPTIONAL { ?item wdt:P625 ?c1 }
  OPTIONAL { ?item wdt:P276 ?loc . ?loc wdt:P625 ?c2 }
  OPTIONAL { ?item wdt:P131 ?adm . ?adm wdt:P625 ?c3 }
  OPTIONAL { ?item wdt:P17 ?cty . ?cty wdt:P625 ?c4 }
  BIND(COALESCE(CONCAT("0|", STR(?c1)), CONCAT("0|", STR(?c2)), CONCAT("1|", STR(?c3)), CONCAT("2|", STR(?c4))) AS ?coord)
  FILTER(BOUND(?coord))
  OPTIONAL { ?item wdt:P31 ?type }
  OPTIONAL { ?item wdt:P582 ?end }`;
  return `
SELECT ?item (SAMPLE(?ap) AS ?a) (SAMPLE(?ae) AS ?ae_) (SAMPLE(?lp) AS ?lab) (SAMPLE(?le) AS ?labEn)
       (GROUP_CONCAT(DISTINCT CONCAT(STR(?date), "|", STR(?prec), "|", STRAFTER(STR(?cal), "entity/"))) AS ?d) (MAX(?end) AS ?e)
       (MIN(?coord) AS ?c) (GROUP_CONCAT(DISTINCT STRAFTER(STR(?type), "entity/")) AS ?t)
       (MAX(?links) AS ?l) (SAMPLE(COALESCE(?pl, ?ple)) AS ?place) WHERE {${dateClause}
  ?item wikibase:sitelinks ?links .${minLinks > 1 ? ` FILTER(?links >= ${minLinks})` : ''}
  ?st wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank)
  ${anyWiki ? `OPTIONAL { ${preferred} }` : `${preferred} .`}
  OPTIONAL { ?ae schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  OPTIONAL { ?item rdfs:label ?lp FILTER(LANG(?lp) = "${lang}") }
  OPTIONAL { ?item rdfs:label ?le FILTER(LANG(?le) = "en") }${where}
} GROUP BY ?item ORDER BY DESC(?l) LIMIT ${limit}`;
}

/**
 * Year and decade start dates overlapping the window but outside the range
 * query: years whose January precedes the window, and (for windows of a year
 * or more) the decade the window starts in.
 */
function coarseDates({ startIdx, span }) {
  const values = [];
  const firstYear = fromMonthIndex(startIdx).year;
  const lastYear = fromMonthIndex(startIdx + span - 1).year;
  for (let y = firstYear; y <= lastYear; y++) {
    if (monthIndex(y, 1) < startIdx) values.push({ year: y, maxPrec: 9 });
  }
  if (span >= 12) {
    const decade = Math.floor(firstYear / 10) * 10;
    if (monthIndex(decade, 1) < startIdx) values.push({ year: decade, maxPrec: 8 });
  }
  return values;
}

// Location precision, as encoded in the "?c" prefix: the event's own point or
// its location's (0), its administrative region's (1), or its country's (2).
export const LOCATED = ['exact', 'region', 'country'];

function parsePoint(wkt) {
  // Coordinates on other globes (Moon, Mars…) are prefixed with the globe's IRI.
  if (!wkt || wkt.startsWith('<')) return null;
  const m = /Point\(\s*([-\d.eE]+)\s+([-\d.eE]+)\s*\)/.exec(wkt);
  if (!m) return null;
  const lon = +m[1];
  const lat = +m[2];
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : null;
}

const JULIAN = 'Q1985786'; // calendar model item; Gregorian is Q1985727

// "?d" holds every "date|precision|calendar" triple from the date statements;
// use the most precise (an item often has a year-only P585 alongside an exact
// P580), earliest on ties. Dates are always proleptic Gregorian here: the query
// service converts day-precision Julian dates, so the calendar is kept to
// convert them back for display.
function pickDate(triples) {
  let best = null;
  for (const triple of triples.split(' ')) {
    const [value, prec, cal] = triple.split('|');
    const date = parseXsd(value);
    if (!date) continue;
    const cand = { date, precision: +prec || 9, value, calendar: cal === JULIAN ? 'julian' : 'gregorian' };
    if (!best || cand.precision > best.precision
      || (cand.precision === best.precision && dateKey(cand.date) < dateKey(best.date))) best = cand;
  }
  return best;
}

function titleFromUrl(url) {
  try {
    return decodeURIComponent(url.split('/wiki/')[1]).replace(/_/g, ' ');
  } catch {
    return url;
  }
}

// Long windows are split into chunks so no single query nears the 60 s timeout.
// Sparse early periods can use long chunks (fewer queries); modern births and
// deaths are dense enough to need two-year ones.
function chunkMonths(kind, startIdx) {
  const year = fromMonthIndex(startIdx).year;
  if (isPerson(kind)) return year >= 1850 ? 24 : year >= 1500 ? 120 : 600;
  if (kind === 'ongoing') return year >= 1800 ? 120 : year >= 1500 ? 600 : 1200;
  return 120;
}

/**
 * Births and deaths are only offered where the query count stays reasonable:
 * any window before 1850, windows of up to 10 years after.
 */
export function peopleAllowed({ startIdx, span }) {
  return fromMonthIndex(startIdx + span - 1).year < 1850 || span <= 120;
}

// Only people covered by many Wikipedias: there are orders of magnitude more
// people than events, and the query has to scan every birth in the range.
// Early periods are sparse, so the bar is far lower there and only rises for
// windows longer than a decade (rather than a year).
function peopleMinLinks({ startIdx, totalSpan, limit }) {
  const year = fromMonthIndex(startIdx).year;
  const base = year >= 1900 ? 40 : year >= 1800 ? 20 : year >= 1500 ? 8 : 3;
  const unit = year >= 1800 ? 12 : 120;
  return Math.round(base * Math.max(1, Math.sqrt(totalSpan / unit) * Math.sqrt(1000 / limit)));
}

// Recent decades have vastly more dated items (sports seasons, elections…), so
// long chunks skip the least-linked items up front. Those would never make the
// top-N cut anyway, and the pruning makes the query several times faster.
// Long overall windows keep only the top `limit` across all chunks, so each
// chunk can prune harder still.
function minLinksFor({ startIdx, span, totalSpan, limit, anyWiki }) {
  const year = fromMonthIndex(startIdx).year;
  // Without an article requirement, recent years have too many items linked
  // from a single small wiki (sports fixtures and the like) to scan in time.
  const floor = anyWiki && year >= 1950 ? 2 : 1;
  if (totalSpan <= 24) return floor;
  const density = year >= 1990 ? 8 : year >= 1900 ? 5 : year >= 1800 ? 3 : 1;
  const base = span <= 60 ? Math.ceil(density / 2) : density;
  const scale = Math.max(1, Math.sqrt(totalSpan / 120) * Math.sqrt(1000 / limit));
  return Math.max(floor, Math.round(base * scale));
}

async function fetchChunk(params, signal) {
  const props = DATE_PROPS[params.kind];
  // Foundings are far more numerous than events (every church and village has
  // an inception date), so they need more coverage to be worth a pin.
  let minLinks = params.kind === 'founded' ? Math.max(3, 2 * minLinksFor(params))
    : isPerson(params.kind) ? peopleMinLinks(params) : minLinksFor(params);
  const clause = params.coarse ? coarseClause(params.coarse, props) : rangeClause(params, props);
  let rows;
  try {
    rows = await sparql(eventsQuery({ ...params, minLinks }, clause), signal);
  } catch (err) {
    if (signal?.aborted || !/timed out/.test(err.message)) throw err;
    minLinks = minLinks * 3 + 3; // retry once, pruning harder
    rows = await sparql(eventsQuery({ ...params, minLinks }, clause), signal);
  }
  for (const r of rows) r.kind = params.kind;
  return rows;
}

/** Fetches raw (unclassified) events for a window, most-linked first. */
export async function fetchEvents(params, signal, onProgress) {
  const chunks = [];
  const kinds = ['event'];
  if (params.founded) kinds.push('founded');
  if (params.people && peopleAllowed(params)) kinds.push('born', 'died');
  if (params.ongoing) {
    // Start dates in the stretch before the window that an event lasting at
    // most maxOngoingMonths could have begun in.
    const reach = maxOngoingMonths(params.span);
    const from = params.startIdx - reach;
    const size = chunkMonths('ongoing', from);
    for (let i = 0; i < reach; i += size) {
      chunks.push({
        ...params, kind: 'ongoing', totalSpan: reach, windowStart: params.startIdx,
        startIdx: from + i, span: Math.min(size, reach - i),
      });
    }
  }
  for (const kind of kinds) {
    const size = chunkMonths(kind, params.startIdx);
    for (let i = 0; i < params.span; i += size) {
      chunks.push({
        ...params, kind, totalSpan: params.span, startIdx: params.startIdx + i, span: Math.min(size, params.span - i),
      });
    }
    const coarse = coarseDates(params);
    if (coarse.length) chunks.push({ ...params, kind, totalSpan: params.span, coarse });
  }
  const results = [];
  let done = 0;
  const queue = [...chunks];
  const worker = async () => {
    while (queue.length) {
      results.push(...await fetchChunk(queue.shift(), signal));
      onProgress?.(++done, chunks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));

  // Top `limit` events plus up to half as many ongoing events, foundings and
  // people each; events come first so an item found twice is kept as an event.
  const top = (kinds, n) => results.filter((r) => kinds.includes(r.kind))
    .sort((a, b) => +(b.l?.value ?? 0) - +(a.l?.value ?? 0)).slice(0, n);
  const half = Math.round(params.limit / 2);
  const rows = [
    ...top(['event'], params.limit), ...top(['ongoing'], half), ...top(['founded'], half), ...top(['born', 'died'], half),
  ];
  // The range and year/decade queries can both return an item (with different
  // date statements); pool its dates so pickDate() sees the most precise one.
  const dates = new Map();
  const keyOf = (r) => {
    const id = r.item.value.split('/').pop();
    return isPerson(r.kind) ? `${r.kind}:${id}` : id; // born and died in the window: two pins
  };
  for (const r of rows) {
    const k = keyOf(r);
    dates.set(k, [dates.get(k), r.d?.value].filter(Boolean).join(' '));
  }
  const events = [];
  const seen = new Set();
  for (const r of rows) {
    const id = r.item.value.split('/').pop();
    const [level, wkt] = (r.c?.value || '').split('|');
    const pt = parsePoint(wkt);
    const key = keyOf(r);
    const when = pickDate(dates.get(key) || '');
    if (!pt || !when || seen.has(key)) continue;
    seen.add(key);
    const url = r.a?.value || r.ae_?.value || null;
    events.push({
      id,
      kind: r.kind,
      ...articleFields(url),
      title: r.lab?.value || r.labEn?.value || (url ? titleFromUrl(url) : id),
      lat: pt.lat,
      lon: pt.lon,
      located: LOCATED[+level] || 'exact',
      date: when.date, // proleptic Gregorian, like the map
      precision: when.precision,
      calendar: when.calendar,
      end: r.e ? parseXsd(r.e.value) : null,
      links: +(r.l?.value ?? 0),
      types: (r.t?.value || '').split(' ').filter(Boolean),
      place: r.place?.value || null,
    });
  }
  await resolveArticles(events.filter((e) => !e.url), params.lang, signal);
  return events.filter((e) => e.url);
}

// ---- Articles on other Wikipedias ----

const wikiOf = (url) => new URL(url).hostname.split('.')[0];

function articleFields(url) {
  return url ? { url, wiki: wikiOf(url), article: titleFromUrl(url) } : { url: null, wiki: null, article: null };
}

// Fallback order when an item has no article in the preferred language or English.
const WIKI_PREFERENCE = ['de', 'fr', 'es', 'it', 'ru', 'pl', 'pt', 'nl', 'uk', 'ja', 'zh', 'ar', 'fa', 'tr', 'sv', 'cs', 'hu', 'sr', 'he', 'ko', 'id', 'vi'];

/** Picks an article for events that only have one on "other" Wikipedias; others keep url = null. */
async function resolveArticles(events, lang, signal) {
  const queue = [];
  for (let i = 0; i < events.length; i += 50) queue.push(events.slice(i, i + 50));
  const worker = async () => {
    while (queue.length) {
      const batch = queue.shift();
      const params = new URLSearchParams({
        action: 'wbgetentities', ids: batch.map((e) => e.id).join('|'), props: 'sitelinks/urls|labels',
        languages: [...new Set([lang, 'en'])].join('|'), format: 'json', origin: '*',
      });
      const res = await fetch(`https://www.wikidata.org/w/api.php?${params}`, { signal });
      if (!res.ok) continue;
      const { entities = {} } = await res.json();
      for (const ev of batch) {
        const ent = entities[ev.id];
        const urls = Object.values(ent?.sitelinks || {})
          .map((l) => l.url).filter((u) => u && /^https:\/\/[a-z-]+\.wikipedia\.org\/wiki\//.test(u));
        if (!urls.length) continue; // only on Commons, Wikisource…: not shown
        const rank = (u) => {
          const i = WIKI_PREFERENCE.indexOf(wikiOf(u));
          return i === -1 ? WIKI_PREFERENCE.length : i;
        };
        const url = urls.sort((a, b) => rank(a) - rank(b))[0];
        Object.assign(ev, articleFields(url));
        const label = ent.labels?.[lang]?.value || ent.labels?.en?.value;
        if (label) ev.title = label;
        else if (ev.title === ev.id) ev.title = ev.article;
      }
    }
  };
  await Promise.all([worker(), worker()]);
}

// ---- Type classification (type QID -> category id | null), cached in localStorage ----

const CACHE_KEY = 'meanwhile-typecat-v4'; // bump when category rules change
let typeCache = new Map();
try {
  typeCache = new Map(Object.entries(JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')));
} catch { /* storage unavailable: in-memory only */ }

function saveTypeCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(typeCache)));
  } catch { /* ignore */ }
}

function classifyQuery(types) {
  return `
SELECT ?type (GROUP_CONCAT(DISTINCT STRAFTER(STR(?root), "entity/")) AS ?roots) WHERE {
  VALUES ?type { ${types.map((t) => `wd:${t}`).join(' ')} }
  VALUES ?root { ${ALL_ROOTS.map((t) => `wd:${t}`).join(' ')} }
  ?type wdt:P279* ?root .
} GROUP BY ?type`;
}

const BATCH = 250;

/** Ensures every type is classified; returns the (shared) cache map. */
export async function classifyTypes(types, signal, onProgress) {
  const missing = [...new Set(types)].filter((t) => !typeCache.has(t));
  const batches = [];
  for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
  let done = 0;
  // Two at a time keeps us well inside the query service's per-client limits.
  const worker = async () => {
    while (batches.length) {
      const batch = batches.shift();
      const rows = await sparql(classifyQuery(batch), signal, { post: true });
      const found = new Map(rows.map((r) => [r.type.value.split('/').pop(), new Set(r.roots.value.split(' '))]));
      for (const t of batch) typeCache.set(t, categoryFromRoots(found.get(t) || new Set()));
      done += batch.length;
      onProgress?.(done, missing.length);
    }
  };
  await Promise.all([worker(), worker()]);
  if (missing.length) saveTypeCache();
  return typeCache;
}

/** Category for an event: the highest-priority category among its types. */
export function categorize(event, cache, order) {
  const rank = (c) => (order.includes(c) ? order.indexOf(c) : order.length); // 'place' ranks last
  let best = null;
  for (const t of event.types) {
    const c = cache.get(t);
    if (c && (best === null || rank(c) < rank(best))) best = c;
  }
  return best; // null => not an occurrence (a place, ship, award…)
}

// ---- Wikipedia page summaries ----

const summaryCache = new Map();

export async function fetchSummary(lang, title) {
  const key = `${lang}:${title}`;
  if (!summaryCache.has(key)) {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    summaryCache.set(key, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return summaryCache.get(key);
}

// ---- Image licensing ----
// Summary thumbnails come from Commons or the local wiki and carry their own
// licenses; some are non-free "fair use" files that only Wikipedia may show.
// Look up each file's license and only display freely licensed ones, credited.

const imageCache = new Map();

/** File name from an upload/thumb URL: …/thumb/a/ab/Name.jpg/330px-Name.jpg or …/a/ab/Name.jpg */
function fileNameFromUrl(src) {
  try {
    const path = new URL(src).pathname;
    const m = /\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/([^/]+)\//.exec(path) || /\/[0-9a-f]\/[0-9a-f]{2}\/([^/]+)$/.exec(path);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

const textOf = (html) => new DOMParser().parseFromString(html || '', 'text/html').body.textContent.trim();

/**
 * Returns { artist, license, licenseUrl, pageUrl } for a freely licensed image,
 * or null if it is non-free, unlicensed, or the lookup fails.
 */
export async function fetchImageLicense(lang, src) {
  const file = fileNameFromUrl(src);
  if (!file) return null;
  const key = `${lang}:${file}`;
  if (!imageCache.has(key)) {
    const params = new URLSearchParams({
      action: 'query', prop: 'imageinfo', iiprop: 'extmetadata|url',
      iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|Credit|NonFree',
      titles: `File:${file}`, format: 'json', formatversion: '2', origin: '*',
    });
    // Asking the article's own wiki covers both local files and Commons.
    imageCache.set(key, fetch(`https://${lang}.wikipedia.org/w/api.php?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const info = d?.query?.pages?.[0]?.imageinfo?.[0];
        const meta = info?.extmetadata || {};
        const license = meta.LicenseShortName?.value;
        if (!info || !license || meta.NonFree?.value === 'true' || /fair use|non-free/i.test(license)) return null;
        const artist = textOf(meta.Artist?.value || meta.Credit?.value).replace(/\s+/g, ' ');
        return {
          artist: artist.length > 60 ? `${artist.slice(0, 57)}…` : artist,
          license,
          licenseUrl: meta.LicenseUrl?.value || null,
          pageUrl: info.descriptionurl,
        };
      })
      .catch(() => null));
  }
  return imageCache.get(key);
}
