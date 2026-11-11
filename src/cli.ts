#!/usr/bin/env node
// Direct CLI for pi/bash: JSON to stdout, errors to stderr (exit 1).
//   foreverdb-cli item "Copper" [limit]
//   foreverdb-cli recipe "Elixir" [profession-slug] [limit]
//   foreverdb-cli id items 19019
import { ForeverDBClient, ForeverDBApiError, FOREVERDB_PROFESSIONS, CREDIT } from "./client.js";

const [cmd, arg1, arg2, arg3] = process.argv.slice(2);
const client = new ForeverDBClient();

async function main() {
  if (cmd === "item") {
    if (!arg1) throw new Error('usage: foreverdb-cli item "name" [limit]');
    const res = await client.get("items", { q: arg1, limit: Number(arg2) || 5 });
    console.log(JSON.stringify(res.data, null, 1));
  } else if (cmd === "recipe") {
    if (!arg1) throw new Error('usage: foreverdb-cli recipe "name" [profession] [limit]');
    const slugs = arg2 && (FOREVERDB_PROFESSIONS as readonly string[]).includes(arg2) ? [arg2] : FOREVERDB_PROFESSIONS;
    const limit = Number(arg2 && (FOREVERDB_PROFESSIONS as readonly string[]).includes(arg2) ? arg3 : arg2) || 5;
    const found: unknown[] = [];
    for (const slug of slugs) {
      try {
        const res = await client.get(`professions/${slug}`, { q: arg1, limit });
        if (Array.isArray(res.data)) found.push(...res.data);
      } catch (e) {
        if (slugs.length === 1) throw e;
        console.error(`${slug}: ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(JSON.stringify(found.slice(0, limit), null, 1));
  } else if (cmd === "id") {
    if (!arg1 || !arg2) throw new Error("usage: foreverdb-cli id <items|spells|quests|vendors|dungeons|itemsets> <id>");
    const res = await client.get(`${arg1}/${arg2}`);
    console.log(JSON.stringify(res.data, null, 1));
  } else {
    throw new Error(`unknown command '${cmd ?? ""}' — use: item | recipe | id (see header comment)`);
  }
  console.error(CREDIT);
}

main().catch((e) => {
  console.error(`foreverdb-cli: ${e instanceof ForeverDBApiError || e instanceof Error ? e.message : e}`);
  process.exit(1);
});
