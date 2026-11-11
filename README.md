# wow-forever-db MCP server

MCP (stdio) + CLI access to [ForeverDB](https://foreverdb.net/api/v1) — WoW Forever items, recipes, spells, quests.

## Setup
1. Get an API key: log in with Battle.net at https://foreverdb.net/developers and request access (manual approval).
2. `export FOREVERDB_API_KEY=fdb_…` (the pi MCP adapter inherits your shell env; see `.env.example`).
3. Server is registered in `~/.pi/agent/mcp-adapter.json` as `wow-forever-db` (`directTools: true`).

## Tools
- `get_recipe_details(recipeName, profession?, limit=5)` — reagents, skill thresholds, crafted item, trainer/vendor/quest/drop sources. Fans out over all 12 profession slugs; pass `profession` for a single request.
- `get_item_details(itemName, limit=5)` — stats, binding, sell price, disenchant; strips beta/live-diff noise.
- `get_entity_by_id(entityType, id)` — exact lookup: `items | spells | quests | dungeons | itemsets`. (ForeverDB has no recipes-by-id endpoint.)

## CLI (bash fallback)
```
node build/cli.js item "Stonescale Eel" 3
node build/cli.js recipe "Elixir" alchemy 5
node build/cli.js id items 19019
```
JSON on stdout, errors on stderr, exit 1 on failure.

## Notes
- API requires the key on every request (`X-API-Key`); missing/bad key returns a structured `isError` tool payload, never a crash.
- Rate limits: 60 req/min, 10 000/day per key. Unfiltered recipe searches use 12 requests.
- Credit requirement: keep the "Data from ForeverDB.net" line when showing this data.
- Recipe/item field names are typed defensively (no approved key existed at build time); `slimRecipe` falls back to `raw` if the API shape drifts.
