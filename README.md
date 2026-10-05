# [Meanwhile Map](https://www.meanwhilemap.com)

Historical exploration map  showing contemporaneous events for the chosen year and time-frame. Open data, static web page, fully client-side. 

## Motivation 

When reading a history book, I sometimes have a hard time internalizing when the events are taking place. Sure, I know the dates, but it takes a bit of effort to put them in a broader context, to understand where in history they belong. What usually helps is to put them in relation to other contemporaneous events.

For example, yes, the Mughal Empire was founded by Babur in the 1520s, but it paints a different picture in my head when I see that this roughly coincides with Cortés' capture of Tenochtitlan, or that it's close to the Siege of Vienna. Example link: https://meanwhilemap.com/#y=1520&m=1&span=120&off=founded,people&map=1.4/25/0

To play around with this, I've made Meanwhile Map. You select a date and a time window, then scroll around the world map to see a list of contemporaneous events.

## How it works

| Piece | Source |
|---|---|
| Basemap and period borders | [OpenHistoricalMap](https://www.openhistoricalmap.org/) vector tiles, filtered to the window's midpoint with [`maplibre-gl-dates`](https://github.com/OpenHistoricalMap/maplibre-gl-dates), rendered by [MapLibre GL JS](https://maplibre.org/) |
| Events | [Wikidata Query Service](https://query.wikidata.org/): items with a *point in time* (P585), *start time* (P580) or *launch date* (P619) in the window, a coordinate (P625 directly, or via *location* P276), and an article on the chosen Wikipedia |
| Location | The event's own coordinates or its *location*'s. If neither exists, it falls back to its region (P131) or country (P17), and the pin is drawn hollow to mark it approximate |
| Other Wikipedias | With "Include events from other Wikipedias" (on by default), an event only needs an article on *some* Wikipedia. It links to the selected language, then English, then the best other language (via `wbgetentities`). Events are Wikidata items, so each appears once however many language articles it has. Names use the item's label in the selected language. |
| Importance | Wikidata sitelink count (how many Wikipedias cover the event). Used to rank results, cap them at "Max events", and size the pins |
| Categories | Each event's types (P31) are walked up the subclass tree (P279*) to a set of root classes (`js/categories.js`). Types that aren't a subclass of *occurrence* (Q1190554) are dropped, which removes countries, ships, universities and other non-events. Results are cached in `localStorage` |
| Founded & built | Optional category, off by default. It's a separate query on *inception* (P571) or *date of official opening* (P1619) for cities, buildings, organisations and states, capped at half the event limit. Villages, counties and similar places need 50+ Wikipedias, which filters out bot-created articles |
| Births & deaths | Optional category, off by default. It queries birth (P569) and death (P570) dates, pinned at the place of birth (P19) or death (P20), for well-known people only (from 3+ Wikipedias before 1500 up to 40+ after 1900, rising for longer windows). It works for any window before 1850, and for windows of 10 years or less after that |
| Popup details | Wikipedia REST `page/summary` (extract and thumbnail) |

Dates only known to the year or decade are stored by Wikidata as 1 January,
so they'd miss any window not containing that day. A small extra query looks
those dates up exactly, and events whose possible period overlaps the window
are shown as "Sometime in 1452", as long as that period isn't far vaguer than
the window (a year-dated event can appear in a 1-month window, a decade-dated
one needs at least a 1-year window).

With "Include ongoing events" (on by default), events that started before the
window and were still under way when it opens are shown too, faded and
labelled "Ongoing: 1449 – 1453", as long as they lasted no more than ten
times the window (at least a year). A 1-year window shows a 4-year war; a
1-month window doesn't show the Hundred Years' War.

Long windows are split into 10-year chunks, queried three at a time. Chunks
skip weakly-linked items up front, which keeps each query well under the query
service's 60-second limit.

## Files

- `index.html`, `css/style.css`: the page shell and styles
- `js/app.js`: map, layers, popups, controls, URL state
- `js/data.js`: the SPARQL queries, classification cache, Wikipedia summaries
- `js/categories.js`: category definitions (edit root QIDs here to tune them)
- `js/time.js`: date math (astronomical years, so 0 = 1 BCE), formatting

## Controls

- Slider and year field: start year. Use *From* for the start month and *Window* for the span.
- ◀ ▶ or Shift+←/→: move the window by its own length.
- *Map labels*: the language for country and place names on the basemap (English by default). A name falls back to its local form when OpenHistoricalMap has no translation. *Local names* shows names as written locally.
- Category chips: click to toggle a category, double-click to show only that one.
- The URL hash holds the full state (`#y=1812&m=1&span=12&…&map=zoom/lat/lon`), so links can be shared.

## Data licenses and attribution

| Source | License | How it's credited |
|---|---|---|
| Wikidata | CC0 | map credit line |
| Wikipedia text | CC BY-SA 4.0 | map credit line, plus a credit under each popup extract with a link to the article |
| Popup images | per file (Commons or local wiki) | license looked up via the `imageinfo` API; **non-free and fair-use files are never shown**; free ones are captioned with artist and license and link to their file page |
| OpenHistoricalMap data and style | CC0 (a few features CC BY/BY-SA) | map credit line |
| Coastlines (`osm_land`) | © OpenStreetMap contributors | map credit line |
| Land cover raster (GlobCover) | © ESA 2010 & UCLouvain, **educational/scientific use only** | map credit line. Hide the `ohm_landcover_hillshade` layer for commercial use |
| MapLibre GL JS | BSD-3-Clause | loaded from a CDN |


## License

The code is released under the [MIT License](LICENSE). Data shown by the app
keeps its own licenses (see *Data licenses and attribution* above).
