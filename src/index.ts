#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ForeverDBClient,
  ForeverDBApiError,
  FOREVERDB_PROFESSIONS,
  FOREVERDB_GATHERING,
  CREDIT,
  slimRow,
  slimRecipe,
  type ProfessionSlug,
} from "./client.js";

// stdout is reserved for JSON-RPC — log to stderr only.
const client = new ForeverDBClient();

const server = new McpServer({
  name: "wow-forever-db",
  version: "1.1.0",
  description:
    "WoW Forever data (items, spells, quests, vendors, professions, gathering, dungeons, sets, classes, builds, buffs/nerfs, articles) via the ForeverDB API. " +
    "Data from ForeverDB.net — https://foreverdb.net (credit required when shown).",
});

// Some endpoints (class details, gathering, merchants-favor) return 100KB+; cap what reaches the model context.
const MAX_CHARS = 30000;
function ok(data: unknown) {
  let text = JSON.stringify(data, null, 1);
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) +
      `\n… truncated at ${MAX_CHARS} of ${text.length} chars. Narrow the query (limit/offset/filters) for the rest.`;
  }
  return { content: [{ type: "text" as const, text: text + `\n\n${CREDIT}` }] };
}
function fail(e: unknown) {
  const msg = e instanceof ForeverDBApiError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `ForeverDB error: ${msg}` }], isError: true };
}

// --- Shared query params; names match the API docs (https://foreverdb.net/developers).
// MCP requires every optional argument to be marked .optional() explicitly.
const q = z.string().min(2).optional().describe("Name contains");
const limit = z.number().int().min(1).max(100).default(25).describe("Max rows (1-100)");
const offset = z.number().int().min(0).optional().describe("Skip this many rows (for the next page)");
const zoneContains = z.string().optional().describe("Zone name contains");
const minLevel = z.number().int().min(1).optional().describe("Level at least");
const maxLevel = z.number().int().min(1).optional().describe("Level at most");
const classFilter = z.string().optional().describe("Class ID or name (e.g. warrior)");

// --- Tools that need custom logic (fan-out, wrapping, field filtering) ---

server.registerTool(
  "get_recipe_details",
  {
    description:
      "Search World of Warcraft: Forever crafting recipes (all professions, incl. Forever-new ones) for reagents, skill thresholds, crafted items, and trainer/vendor/quest/drop sources. " +
      "ForeverDB has no global recipe endpoint, so this fans out per profession slug; pass `profession` to keep it to one request.",
    inputSchema: {
      recipeName: z.string().min(2).describe("Full or partial name of the craft or recipe"),
      profession: z
        .enum(FOREVERDB_PROFESSIONS)
        .optional()
        .describe("Profession slug filter (e.g. 'enchanting', 'alchemy'); omit to search all 12"),
      newInForever: z.boolean().optional().describe("true: only recipes new in Forever"),
      changedFromClassic: z.boolean().optional().describe("true: only recipes changed from Classic"),
      limit: z.number().int().min(1).max(25).default(5).describe("Max recipes to return"),
    },
  },
  async ({ recipeName, profession, newInForever, changedFromClassic, limit }) => {
    try {
      const slugs: ProfessionSlug[] = profession ? [profession] : [...FOREVERDB_PROFESSIONS];
      const results = await Promise.allSettled(
        slugs.map((slug) =>
          client.get<Record<string, unknown>>(`professions/${slug}`, {
            q: recipeName,
            limit,
            new: newInForever,
            changed: changedFromClassic,
          }),
        ),
      );
      const recipes: Record<string, unknown>[] = [];
      const errors: string[] = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          // /professions/{slug} returns an object ({slug, ranks, trainers, recipes}); recipes is the row list.
          const payload = r.value.data as unknown as Record<string, unknown> | undefined;
          const rows = Array.isArray(payload?.recipes) ? (payload.recipes as Record<string, unknown>[]) : [];
          for (const row of rows) if (typeof row === "object" && row) recipes.push(slimRecipe(row as Record<string, unknown>, slugs[i]));
        } else {
          errors.push(`${slugs[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
        }
      });
      // All requests failed (bad key, network, 429) → surface as a tool error.
      if (recipes.length === 0 && errors.length === slugs.length) {
        return fail(new Error(errors[0] ?? "no results"));
      }
      return ok({ query: recipeName, count: Math.min(recipes.length, limit), recipes: recipes.slice(0, limit), partialErrors: errors.length ? errors : undefined });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_item_details",
  {
    description:
      "Search World of Warcraft: Forever items by name (optionally filtered by quality/class/slot/level): stats, binding (BoP/BoE), sell price, effects, and disenchant results when known. Volatile beta/live-diff fields are stripped.",
    inputSchema: {
      itemName: q,
      quality: z.number().int().min(0).max(5).optional().describe("0 Poor, 1 Common, 2 Uncommon, 3 Rare, 4 Epic, 5 Legendary"),
      class: z.number().int().min(0).optional().describe("Item class ID (2 weapons, 4 armour…)"),
      slot: z.number().int().min(0).optional().describe("Inventory type ID (1 head, 5 chest…)"),
      minLevel,
      maxLevel,
      limit: z.number().int().min(1).max(25).default(5).describe("Max items to return"),
      offset,
    },
  },
  async ({ itemName, quality, class: itemClass, slot, minLevel: lo, maxLevel: hi, limit: max, offset: skip }) => {
    try {
      const res = await client.get<Record<string, unknown>[]>(`items`, {
        q: itemName,
        quality,
        class: itemClass,
        slot,
        minLevel: lo,
        maxLevel: hi,
        limit: max,
        offset: skip,
      });
      const rows = Array.isArray(res.data) ? res.data.map(slimRow) : [];
      return ok({ query: itemName, count: rows.length, items: rows, meta: res.meta });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_entity_by_id",
  {
    description:
      "Fetch exact ForeverDB data by numeric ID (no fuzzy matching): item, spell, quest, vendor, dungeon, or item set. Use when the ID is known from a macro, tooltip, or C_TradeSkillUI. Recipes have no ID endpoint — look up the spell they cast via entityType 'spells' or search by name with get_recipe_details.",
    inputSchema: {
      entityType: z.enum(["items", "spells", "quests", "vendors", "dungeons", "itemsets"]).describe("ForeverDB resource to fetch"),
      id: z.number().int().positive().describe("Numeric ForeverDB ID"),
    },
  },
  async ({ entityType, id }) => {
    try {
      const res = await client.get<Record<string, unknown>>(`${entityType}/${id}`);
      const data = entityType === "items" && res.data && typeof res.data === "object" ? slimRow(res.data) : res.data;
      return ok({ data, meta: res.meta });
    } catch (e) {
      return fail(e);
    }
  },
);

// --- The rest of the API: one tool per endpoint, driven by this table ---

interface Endpoint {
  name: string;
  doc: string;
  /** Path template; {param} placeholders are filled from the matching tool argument. */
  path: string;
  params?: Record<string, z.ZodTypeAny>;
  /** Output key for array results (object results come back as `data`). */
  key?: string;
  /** Shape the result before it is returned; default is slimRow on rows/objects. */
  slim?: (data: unknown, args: Record<string, unknown>) => unknown;
}

const ENDPOINTS: Endpoint[] = [
  {
    name: "get_data_meta",
    doc: "About the ForeverDB data: client build, level cap, and how many items/spells/quests/vendors/dungeons/sets/articles it holds. Check this to see how current the data is.",
    path: "meta",
  },
  {
    name: "search_spells",
    doc: "Search WoW Forever spells and abilities by name: rank, description, school, cast time, range, cooldown, required level, costs. Use get_entity_by_id (spells) for one spell's full record.",
    path: "spells",
    key: "spells",
    params: { q, limit, offset },
  },
  {
    name: "search_quests",
    doc: "Search WoW Forever quests with ForeverDB's guide: level, side, zone, and who starts/ends each one. Use get_entity_by_id (quests) for chain, quest line, NPC locations and sources.",
    path: "quests",
    key: "quests",
    params: { q, zone: zoneContains, minLevel, maxLevel, side: z.enum(["alliance", "horde"]).optional().describe("Faction side"), limit, offset },
  },
  {
    name: "search_vendors",
    doc: "Search WoW Forever vendors by name/title and zone, with where they stand and the reputation faction that discounts their prices. Use get_entity_by_id (vendors) for their full stock and prices.",
    path: "vendors",
    key: "vendors",
    params: { q, zone: zoneContains, seen: z.boolean().optional().describe("true: only vendors seen in Forever"), limit, offset },
  },
  {
    name: "get_poison_economy",
    doc: "Rogue poisons: how they're learned (level 20 quests), every poison with reagents, skill colours, learn level, trainers and full trainer cost, plus every poison supplier and what they sell.",
    path: "poisons",
  },
  {
    name: "get_disenchant_table",
    doc: "What uncommon/rare/epic weapons and armour disenchant into, by item level: WoW Forever results where players' addons saw them (with disenchants/players counts), and Classic's table, labelled.",
    path: "disenchant",
    key: "rows",
  },
  {
    name: "list_dungeons",
    doc: "Every WoW Forever dungeon and raid with its level range, size, kind and status (lowest level first). Use get_entity_by_id (dungeons) for bosses and notable loot.",
    path: "dungeons",
    key: "dungeons",
    params: { limit, offset },
  },
  {
    name: "list_zones",
    doc: "The world map's zones and continents. The id is the UiMap ID the other ForeverDB answers reference.",
    path: "zones",
    key: "zones",
    params: { limit, offset },
  },
  {
    name: "list_classes",
    doc: "The nine WoW Forever classes with their IDs. Use get_class_details for one class's abilities and talent trees.",
    path: "classes",
    key: "classes",
  },
  {
    name: "get_class_details",
    doc: "One class: every ability with ranks and learned levels, plus all talent trees (tier, column, required level, rank spell IDs, descriptions, prerequisites; tiers/columns are 1-based). Large response.",
    path: "classes/{class}",
    params: { class: z.string().describe("Class name (warrior) or class ID (1)") },
  },
  {
    name: "search_itemsets",
    doc: "Search WoW Forever item sets by name, with their piece item IDs and availability warnings (betaEvent, speculation). Use get_entity_by_id (itemsets) for set bonuses.",
    path: "itemsets",
    key: "itemsets",
    params: { q, limit, offset },
  },
  {
    name: "list_professions",
    doc: "All twelve professions (primary, gathering, secondary) with recipe counts, how many recipes are new in Forever or changed from Classic, and trainer counts. Use get_recipe_details to search recipes.",
    path: "professions",
    key: "professions",
  },
  {
    name: "get_gathering_spots",
    doc: "Where to gather for herbalism/mining/skinning/fishing: each node or beast with its required skill and the zones with counts, plus the best zones per skill range. Skinning: pass `zone` to get that zone's beasts. Fishing: zones, catches and pools.",
    path: "gathering/{slug}",
    params: {
      slug: z.enum(FOREVERDB_GATHERING).describe("Gathering profession"),
      zone: z.string().optional().describe("Only this zone: its map ID, or part of its name (skinning also lists the zone's beasts)"),
    },
  },
  {
    name: "list_battlegrounds",
    doc: "Every WoW Forever battleground and arena: levels, team size, win condition, objectives with map positions, and where the rules come from (blizzard, classic=speculation, or client).",
    path: "battlegrounds",
    key: "battlegrounds",
  },
  {
    name: "get_changes_seen",
    doc: "What players' ForeverDB addons saw in game that differs from the game files: prices, quest rewards and XP, item stats, creature levels. Each is Verified (2+ players or checked against the client) or Not confirmed. Newest first.",
    path: "changes-seen",
    key: "changes",
    params: {
      kind: z.enum(["item", "npc", "vendor", "trainer", "quest"]).optional().describe("Only this kind of change"),
      verified: z.number().int().min(0).max(1).optional().describe("1: only Verified; 0: only Not confirmed"),
      limit,
      offset,
    },
  },
  {
    name: "list_builds",
    doc: "Every WoW Forever client build ForeverDB has compared, newest first: date, previous build, how many abilities/talents/spells/items/sets it added, removed or changed, client totals, and the article/changelog links. Game-file diffs, not Blizzard's patch notes.",
    path: "builds",
    key: "builds",
    params: { limit, offset },
  },
  {
    name: "get_build_changes",
    doc: "Everything one client build changed in the game files vs the build before it: each ability, talent, spell, item or set added/removed/changed, with every changed field (before and after, per rank). dataOnly marks rows a player never reads. Use build 'latest' for the newest.",
    path: "builds/{build}",
    key: "changes",
    params: {
      build: z.string().default("latest").describe("Build number (1.60.1.70888) or 'latest'"),
      type: z.enum(["ability", "talent", "spell", "item", "set"]).optional().describe("Only this kind of row"),
      class: classFilter,
      change: z.enum(["added", "removed", "changed"]).optional().describe("Only this kind of change"),
      q,
      limit,
      offset,
    },
  },
  {
    name: "get_buffs_nerfs",
    doc: "Every class change in each build, newest first, with direction (buff, nerf, changed, new, removed) and the changed fields a player reads. meta.counts adds them up per class. Class changes only — use get_build_changes for items/spells.",
    path: "buffs-nerfs",
    key: "changes",
    params: { class: classFilter, build: z.string().optional().describe("One build (1.60.1.70790)"), direction: z.enum(["buff", "nerf", "changed", "new", "removed"]).optional().describe("Only this direction"), limit, offset },
  },
  {
    name: "get_merchants_favor",
    doc: "Merchant's Favor, WoW Forever's crafter/gatherer currency: the Waylaid Crates that earn it (level, bundles, drop counts), the sealed crates, the Legacy perk, and what the Azeroth Commerce Authority and Durotar Supply and Logistics vendors sell for it (Favor + reputation rank). The full vendor stock is ~640 items — pass `vendor` to get one vendor's list.",
    path: "merchants-favor",
    params: { vendor: z.string().optional().describe("Only vendors whose name, title, faction or zone contains this (e.g. 'Durotar Supply')") },
    // Client-side filter: the endpoint takes no query params (the API ignores unknown ones).
    slim: (data, args) => {
      const d = data as Record<string, unknown>;
      const needle = String(args.vendor ?? "").toLowerCase();
      if (needle && Array.isArray(d.vendors)) {
        d.vendors = d.vendors.filter((v) => JSON.stringify(v).toLowerCase().includes(needle));
      }
      return d;
    },
  },
  {
    name: "search_articles",
    doc: "ForeverDB's own news and articles, newest first, with slug, title, type, date and summary. Use get_article for the full text blocks and sources.",
    path: "articles",
    key: "articles",
    params: { type: z.string().optional().describe("Article type (news, guide…)") },
  },
  {
    name: "get_article",
    doc: "One ForeverDB article in full: its blocks and sources, by the slug from search_articles or list_builds.",
    path: "articles/{slug}",
    params: { slug: z.string().min(2).describe("Article slug, e.g. build-1-60-1-70888-items-added-mounts-bind-on-pickup") },
  },
  {
    name: "list_blizzard_posts",
    doc: "Blizzard blue posts and official news about WoW Forever, newest first, with source, author, date, title and links.",
    path: "posts",
    key: "posts",
    params: { limit, offset },
  },
];

for (const ep of ENDPOINTS) {
  server.registerTool(
    ep.name,
    { description: ep.doc, inputSchema: ep.params ?? {} },
    async (args: Record<string, unknown>) => {
      try {
        const a = args ?? {};
        const path = ep.path.replace(/\{(\w+)\}/g, (_m, key: string) => encodeURIComponent(String(a[key])));
        const params: Record<string, string | number | boolean | undefined> = {};
        for (const [k, v] of Object.entries(a)) {
          if (!ep.path.includes(`{${k}}`)) params[k] = v as string | number | boolean | undefined;
        }
        const res = await client.get<unknown>(path, params);
        const shaped = ep.slim ? ep.slim(res.data, a) : res.data;
        if (Array.isArray(shaped)) {
          const rows = shaped.map((r) => (r && typeof r === "object" ? slimRow(r as Record<string, unknown>) : r));
          return ok({ count: rows.length, [ep.key ?? "results"]: rows, meta: res.meta });
        }
        return ok({ data: shaped && typeof shaped === "object" ? slimRow(shaped as Record<string, unknown>) : shaped, meta: res.meta });
      } catch (e) {
        return fail(e);
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("wow-forever-db MCP server running on stdio");
