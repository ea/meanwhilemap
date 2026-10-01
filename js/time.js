// Time helpers. Years are astronomical internally (0 = 1 BCE, -1 = 2 BCE),
// which is what both Wikidata's RDF export and OpenHistoricalMap use.
// A "month index" is year * 12 + (month - 1), which makes window math trivial.

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export const SPANS = [
  { months: 1, label: '1 month' },
  { months: 3, label: '3 months' },
  { months: 4, label: '4 months' },
  { months: 6, label: '6 months' },
  { months: 12, label: '1 year' },
  { months: 24, label: '2 years' },
  { months: 60, label: '5 years' },
  { months: 120, label: '10 years' },
  { months: 300, label: '25 years' },
  { months: 600, label: '50 years' },
  { months: 1200, label: '100 years' },
];

export const monthIndex = (year, month) => year * 12 + (month - 1);

export function fromMonthIndex(i) {
  const year = Math.floor(i / 12);
  return { year, month: i - year * 12 + 1 };
}

const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');

/** ISO-like date string with a signed, zero-padded astronomical year. */
export function isoDate(year, month = 1, day = 1) {
  return `${year < 0 ? '-' : ''}${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export const xsdDateTime = (year, month, day) => `${isoDate(year, month, day)}T00:00:00Z`;

/** Human year: 1812, 44 BCE. */
export function yearLabel(year) {
  return year <= 0 ? `${1 - year} BCE` : String(year);
}

/** Historical (1 BCE = 1) + era to astronomical and back. */
export const toAstronomical = (histYear, bce) => (bce ? 1 - histYear : histYear);
export const toHistorical = (astroYear) => ({ year: astroYear <= 0 ? 1 - astroYear : astroYear, bce: astroYear <= 0 });

/** Label for the selected window, e.g. "March – June 1812" or "1812 – 1816". */
export function windowLabel(startIdx, spanMonths) {
  const s = fromMonthIndex(startIdx);
  const e = fromMonthIndex(startIdx + spanMonths - 1); // inclusive last month
  if (spanMonths % 12 === 0 && s.month === 1) {
    return spanMonths === 12 ? yearLabel(s.year) : `${yearLabel(s.year)} – ${yearLabel(e.year)}`;
  }
  if (spanMonths === 1) return `${MONTHS[s.month - 1]} ${yearLabel(s.year)}`;
  const sm = MONTHS[s.month - 1].slice(0, 3);
  const em = MONTHS[e.month - 1].slice(0, 3);
  return s.year === e.year
    ? `${sm} – ${em} ${yearLabel(s.year)}`
    : `${sm} ${yearLabel(s.year)} – ${em} ${yearLabel(e.year)}`;
}

const div = (a, b) => Math.floor(a / b);

/**
 * Converts a proleptic Gregorian date to the Julian calendar via the Julian
 * Day Number (floor division keeps it right for BCE/astronomical years).
 */
export function gregorianToJulian({ year, month, day }) {
  const a = div(14 - month, 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  const jdn = day + div(153 * m + 2, 5) + 365 * y + div(y, 4) - div(y, 100) + div(y, 400) - 32045;
  const c = jdn + 32082;
  const d = div(4 * c + 3, 1461);
  const e = c - div(1461 * d, 4);
  const mm = div(5 * e + 2, 153);
  return {
    year: d - 4800 + div(mm, 10),
    month: mm + 3 - 12 * div(mm, 10),
    day: e - div(153 * mm + 2, 5) + 1,
  };
}

/** Parses a Wikidata xsd:dateTime literal ("-0489-09-12T00:00:00Z"). */
export function parseXsd(value) {
  const m = /^(-?\d+)-(\d\d)-(\d\d)/.exec(value);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: +m[2] || 1, day: +m[3] || 1 };
}

// Wikidata time precision: 11 day, 10 month, 9 year, 8 decade, 7 century, 6 millennium.
// Roughly how many months of uncertainty each precision implies.
export const PRECISION_MONTHS = { 11: 1, 10: 1, 9: 12, 8: 120, 7: 1200, 6: 12000 };

/**
 * The month-index span a date could fall in given its precision: a year-only
 * date (stored by Wikidata as 1 January) could be any month of that year.
 */
export function dateSpan(date, precision) {
  const start = monthIndex(date.year, precision >= 10 ? date.month : 1);
  return [start, start + (PRECISION_MONTHS[precision] ?? 12000)];
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Formats a parsed date according to its Wikidata precision. */
export function formatDate(d, precision) {
  if (!d) return '';
  const { year, month, day } = d;
  if (precision >= 11) return `${day} ${MONTHS[month - 1]} ${yearLabel(year)}`;
  if (precision === 10) return `${MONTHS[month - 1]} ${yearLabel(year)}`;
  if (precision === 9) return yearLabel(year);
  if (precision === 8) {
    const h = toHistorical(year);
    return `${Math.floor(h.year / 10) * 10}s${h.bce ? ' BCE' : ''}`;
  }
  const h = toHistorical(year);
  if (precision === 7) return `${ordinal(Math.ceil(h.year / 100))} century${h.bce ? ' BCE' : ''}`;
  return `${ordinal(Math.ceil(h.year / 1000))} millennium${h.bce ? ' BCE' : ''}`;
}

/** Sortable number for a parsed date. */
export const dateKey = (d) => (d ? d.year * 10000 + d.month * 100 + d.day : 0);
