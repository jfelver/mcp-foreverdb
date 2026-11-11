# wow-forever-db MCP server

MCP (stdio) + CLI access to [ForeverDB](https://foreverdb.net/api/v1) — all 30 endpoints of the WoW Forever API (25 tools).

## Setup
1. Get an API key: log in with Battle.net at https://foreverdb.net/developers and request access (manual approval).
2. `export FOREVERDB_API_KEY=fdb_…` (the pi MCP adapter inherits your shell env; see `.env.example`).
3. Server is registered in `~/.pi/agent/mcp-adapter.json` as `wow-forever-db` (`directTools: true`).

## Tools
Every endpoint of https://foreverdb.net/developers is covered. List endpoints take `limit` (1–100, default 25) and `offset`.

Custom logic:
- `get_recipe_details(recipeName, profession?, newInForever?, changedFromClassic?, limit=5)` — reagents, skill thresholds, crafted item, trainer/vendor/quest/drop sources. Fans out over all 12 profession slugs; pass `profession` for a single request.
- `get_item_details(itemName, quality?, class?, slot?, minLevel?, maxLevel?, limit=5, offset?)` — stats, binding, sell price, disenchant; strips beta/live-diff noise.
- `get_entity_by_id(entityType, id)` — exact lookup: `items | spells | quests | vendors | dungeons | itemsets`. (ForeverDB has no recipes-by-id endpoint.)

One tool per endpoint (`/api/v1/…`):
- `get_data_meta` (meta) · `list_zones` (zones) · `list_classes` (classes) · `get_class_details(class)` (classes/{name})
- `search_spells(q)` (spells) · `search_quests(q, zone?, minLevel?, maxLevel?, side?)` (quests) · `search_vendors(q, zone?, seen?)` (vendors)
- `search_itemsets(q)` (itemsets) · `list_dungeons` (dungeons) · `list_battlegrounds` (battlegrounds)
- `list_professions` (professions) · `get_gathering_spots(slug, zone?)` (gathering/{slug}: herbalism, mining, skinning, fishing)
- `get_poison_economy` (poisons) · `get_disenchant_table` (disenchant) · `get_merchants_favor(vendor?)` (merchants-favor)
- `get_changes_seen(kind?, verified?)` (changes-seen) · `list_builds` (builds) · `get_build_changes(build="latest", type?, class?, change?, q?)` (builds/{build})
- `get_buffs_nerfs(class?, build?, direction?)` (buffs-nerfs) · `search_articles(type?)` (articles) · `get_article(slug)` (articles/{slug}) · `list_blizzard_posts` (posts)

## CLI (bash fallback)
```
node build/cli.js item "Stonescale Eel" 3
node build/cli.js recipe "Elixir" alchemy 5
node build/cli.js id items 19019
node build/cli.js get "builds/latest" type=spell limit=5     # any endpoint + query params
node build/cli.js get "gathering/herbalism" zone=Barrens
```
JSON on stdout, errors on stderr, exit 1 on failure.

## Notes
- API requires the key on every request (`X-API-Key`); missing/bad key returns a structured `isError` tool payload, never a crash.
- Rate limits: 60 req/min, 10 000/day per key. Unfiltered recipe searches use 12 requests.
- Field names are typed defensively; `slimRecipe` falls back to `raw` if the API shape drifts.
- Responses are slimmed (nested `icon`, `tooltipHtml`, `liveClient`, empty values dropped) and truncated at 30 000 characters, because class details, gathering tables and the Merchant's Favor stock run to 100KB+. Narrow with `limit`/`offset`/filters — `get_merchants_favor(vendor=…)` is the way to read one vendor's stock.

## Acknowledgements

Data source: [ForeverDB.net](https://foreverdb.net). Per the [ForeverDB developer terms](https://foreverdb.net/developers), this project credits ForeverDB.net as the source, with a visible link, wherever the data is shown — every tool response ends with `Data from ForeverDB.net — https://foreverdb.net`.

- The data is not resold and is not presented as this project's own; it is served read-only through the official ForeverDB API.
- Data from the WoW Forever client is Blizzard Entertainment's. ForeverDB isn't affiliated with Blizzard Entertainment.
- Classic data and in-game observations in API responses are labelled as such by ForeverDB (e.g. `seenInForever`); this server passes those labels through unmodified.
