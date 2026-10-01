// Event categories. Each item's P31 types are walked up the P279 (subclass-of)
// tree on Wikidata; the first category (in this order) whose root class is an
// ancestor wins. Anything that is an occurrence but matches nothing is "other".

export const OCCURRENCE = 'Q1190554';
// Places: human settlements (villages to cities) and administrative areas
// (counties, cantons, countries).
export const PLACE_ROOTS = ['Q486972', 'Q56061'];

// Occurrences that aren't events worth a pin: league seasons ("1944 NFL
// season") are year-long, usually only located by country, and would
// otherwise swamp every year of the 20th century.
export const EXCLUDED_ROOTS = ['Q27020041']; // sports season

export const CATEGORIES = [
  {
    id: 'violence', label: 'Massacres & attacks', color: '#8e2b5c',
    roots: ['Q3199915', 'Q2223653', 'Q3882219', 'Q41397', 'Q1520311'],
    // massacre, terrorist attack, assassination, genocide, violent crime
  },
  {
    id: 'conflict', label: 'War & conflict', color: '#d0342c',
    roots: ['Q180684', 'Q188055', 'Q645883', 'Q831663', 'Q1384277', 'Q124734'],
    // conflict, siege, military operation, campaign, military expedition, rebellion
  },
  {
    id: 'disaster', label: 'Disasters & accidents', color: '#e8871e',
    roots: ['Q3839081', 'Q8065', 'Q171558', 'Q44512', 'Q906512', 'Q168983'],
    // disaster, natural disaster, accident, epidemic, shipwrecking, conflagration
  },
  {
    id: 'politics', label: 'Politics & society', color: '#2f6fbf',
    roots: ['Q131569', 'Q40231', 'Q45382', 'Q10931', 'Q175331', 'Q273120', 'Q49776', 'Q124757', 'Q209715', 'Q186431'],
    // treaty, election, coup, revolution, demonstration, protest, strike, riot, coronation, conclave
  },
  {
    id: 'science', label: 'Science & exploration', color: '#2e9a5b',
    roots: ['Q2401485', 'Q5916', 'Q797476', 'Q3887', 'Q2020153'],
    // expedition, spaceflight, rocket launch, solar eclipse, academic conference
  },
  {
    id: 'sports', label: 'Sports', color: '#7b52c7',
    roots: ['Q16510064', 'Q13406554'],
  },
  {
    id: 'culture', label: 'Culture & arts', color: '#d0569d',
    roots: ['Q132241', 'Q464980', 'Q667276', 'Q182832'],
    // festival, exhibition, art exhibition, concert
  },
  { id: 'other', label: 'Other events', color: '#6f7780', roots: [] },
  // Not an event class: items with an inception date (P571), fetched by a
  // separate query and only when this category is switched on.
  { id: 'founded', label: 'Founded & built', color: '#9a6b2f', roots: [], optIn: true },
  // Notable people, pinned at their place of birth or death (P569/P19, P570/P20).
  { id: 'people', label: 'Births & deaths', color: '#0f8b8d', roots: [], optIn: true },
];

export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

export const ALL_ROOTS = [OCCURRENCE, ...PLACE_ROOTS, ...EXCLUDED_ROOTS, ...CATEGORIES.flatMap((c) => c.roots)];

/** Picks a category id from the set of root classes a type descends from. */
export function categoryFromRoots(roots) {
  if (EXCLUDED_ROOTS.some((r) => roots.has(r))) return null;
  for (const cat of CATEGORIES) {
    if (cat.roots.some((r) => roots.has(r))) return cat.id;
  }
  if (roots.has(OCCURRENCE)) return 'other';
  return PLACE_ROOTS.some((r) => roots.has(r)) ? 'place' : null; // neither is an event
}
