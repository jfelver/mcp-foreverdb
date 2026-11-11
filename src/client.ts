// ForeverDB HTTP client. API docs: https://foreverdb.net/developers
// Auth: X-API-Key header (or Authorization: Bearer). Key is REQUIRED — no public reads.
// Envelope: every response is { data, meta }. Search param is `q` (not `search`).

export const FOREVERDB_PROFESSIONS = [
  "alchemy", "blacksmithing", "enchanting", "engineering",
  "leatherworking", "tailoring", "herbalism", "mining",
  "skinning", "cooking", "first-aid", "fishing",
] as const;
export type ProfessionSlug = (typeof FOREVERDB_PROFESSIONS)[number];

export const CREDIT = "Data from ForeverDB.net — https://foreverdb.net";

export class ForeverDBApiError extends Error {
  constructor(
    public readonly status: number,
    statusText: string,
    public readonly body: string,
  ) {
    super(`ForeverDB HTTP ${status} ${statusText}: ${body.slice(0, 500)}`);
    this.name = "ForeverDBApiError";
  }
}

export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export class ForeverDBClient {
  constructor(
    private readonly baseUrl = process.env.FOREVERDB_BASE_URL || "https://foreverdb.net/api/v1",
    private readonly apiKey = process.env.FOREVERDB_API_KEY,
  ) {}

  get hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<Envelope<T>> {
    if (!this.apiKey) {
      throw new ForeverDBApiError(
        401,
        "missing key",
        "FOREVERDB_API_KEY is not set. Ask for a key at https://foreverdb.net/developers and set the env var.",
      );
    }
    const base = new URL(this.baseUrl);
    const url = new URL(base.pathname.replace(/\/$/, "") + "/" + path.replace(/^\//, ""), base);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      headers: {
        "X-API-Key": this.apiKey,
        "User-Agent": "wow-forever-db-mcp/1.0.0 (MCP server for pi)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ForeverDBApiError(res.status, res.statusText, text);
    }
    if (!res.headers.get("content-type")?.includes("application/json")) {
      throw new ForeverDBApiError(res.status, res.statusText, `non-JSON response: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text) as Envelope<T>;
  }
}

// --- Response shaping (keys are defensive; verified against live API once a key is available) ---

/** Drop volatile/heavy per-item fields that blow up agent context. */
export function slimItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (["liveClient", "dataFromBuild", "tooltipHtml", "tooltip", "icon", "iconFileDataID"].includes(k)) continue;
    if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

/** Slim a recipe row from /professions/{slug} to the fields an agent needs. */
export function slimRecipe(r: Record<string, unknown>, profession: string): Record<string, unknown> {
  const out: Record<string, unknown> = { profession };
  const pick = ["name", "spellId", "id", "skill", "reagents", "makes", "makesCount", "category", "newInForever", "changedFromClassic", "new", "changed"];
  for (const k of pick) if (r[k] !== undefined) out[k] = r[k];
  const lf = r.learnedFrom as Record<string, unknown> | undefined;
  if (lf) {
    const sources = (lf.sources ?? []) as Array<Record<string, unknown>>;
    out.learnedFrom = sources.map((s) => ({
      type: s.type,
      name: s.name,
      zone: s.zone,
      price: s.price,
      seenInForever: s.seenInForever,
    }));
  }
  // Keep anything we didn't recognise only when nothing matched (shape drift safety net).
  if (Object.keys(out).length === 1) return { profession, raw: r };
  return out;
}
