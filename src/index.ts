#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ForeverDBClient,
  ForeverDBApiError,
  FOREVERDB_PROFESSIONS,
  CREDIT,
  slimItem,
  slimRecipe,
  type ProfessionSlug,
} from "./client.js";

// stdout is reserved for JSON-RPC — log to stderr only.
const client = new ForeverDBClient();

const server = new McpServer({
  name: "wow-forever-db",
  version: "1.0.0",
  description: "WoW Forever item/recipe data via the ForeverDB API. Data from ForeverDB.net — https://foreverdb.net (credit required when shown).",
});

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) + `\n\n${CREDIT}` }] };
}
function fail(e: unknown) {
  const msg = e instanceof ForeverDBApiError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `ForeverDB error: ${msg}` }], isError: true };
}

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
      limit: z.number().int().min(1).max(25).default(5).describe("Max recipes to return"),
    },
  },
  async ({ recipeName, profession, limit }) => {
    try {
      const slugs: ProfessionSlug[] = profession ? [profession] : [...FOREVERDB_PROFESSIONS];
      const results = await Promise.allSettled(
        slugs.map((slug) => client.get<Record<string, unknown>[]>(`professions/${slug}`, { q: recipeName, limit })),
      );
      const recipes: Record<string, unknown>[] = [];
      const errors: string[] = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          const rows = Array.isArray(r.value.data) ? r.value.data : [];
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
      "Search World of Warcraft: Forever items by name: stats, binding (BoP/BoE), sell price, effects, and disenchant results when known. Volatile beta/live-diff fields are stripped.",
    inputSchema: {
      itemName: z.string().min(2).describe("Full or partial name of the item"),
      limit: z.number().int().min(1).max(25).default(5).describe("Max items to return"),
    },
  },
  async ({ itemName, limit }) => {
    try {
      const res = await client.get<Record<string, unknown>[]>(`items`, { q: itemName, limit });
      const rows = Array.isArray(res.data) ? res.data : [];
      return ok({ query: itemName, count: rows.length, items: rows.map(slimItem), meta: res.meta });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_entity_by_id",
  {
    description:
      "Fetch exact ForeverDB data by numeric ID (no fuzzy matching): item, spell, quest, dungeon, or item set. Use when the ID is known from a macro, tooltip, or C_TradeSkillUI. Recipes have no ID endpoint — look up the spell they cast via entityType 'spells' or search by name with get_recipe_details.",
    inputSchema: {
      entityType: z.enum(["items", "spells", "quests", "dungeons", "itemsets"]).describe("ForeverDB resource to fetch"),
      id: z.number().int().positive().describe("Numeric ForeverDB ID"),
    },
  },
  async ({ entityType, id }) => {
    try {
      const res = await client.get<Record<string, unknown>>(`${entityType}/${id}`);
      const data = entityType === "items" && res.data && typeof res.data === "object" ? slimItem(res.data) : res.data;
      return ok({ data, meta: res.meta });
    } catch (e) {
      return fail(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("wow-forever-db MCP server running on stdio");
