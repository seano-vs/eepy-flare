// Dynasty valuation.
//
// Rest-of-season VOR says nothing about next year, so dynasty leagues also get a
// long-term market value: Sleeper's dynasty ADP (superflex ADP in superflex leagues,
// from the undocumented season-projections endpoint) blended with FantasyPros'
// superflex dynasty consensus ranks from the nflverse mirror. Sleeper's draft market
// runs well below the experts on QBs (Purdy: ADP 47.6 vs FantasyPros rank 15), so
// either alone skews superflex trades. If both fail, tools omit the dynasty fields.

import type { LeagueContext } from "./league";
import { NflData } from "./nflverse/stats";
import type { League } from "./sleeper";
import { sleeper } from "./sleeper";
import { PROJECTED_POSITIONS } from "./scoring";

export function isDynasty(league: League): boolean {
	return league.settings.type === 2;
}

/** ADP field matching the league: superflex (2QB) or 1QB PPR. */
export function adpField(league: League): "adp_dynasty_2qb" | "adp_dynasty_ppr" {
	return league.roster_positions.includes("SUPER_FLEX") || league.roster_positions.filter((s) => s === "QB").length > 1
		? "adp_dynasty_2qb"
		: "adp_dynasty_ppr";
}

/**
 * Trade-chart style value from dynasty ADP: 10000 for the 1st pick, roughly halving
 * every ~37 picks, ~0 past pick 400. Unranked players (ADP 999+) are worth 0.
 */
export function dynastyValue(adp: number | undefined): number {
	if (adp == null || !Number.isFinite(adp) || adp >= 999) return 0;
	return Math.round(10000 * Math.exp(-0.0185 * (Math.max(1, adp) - 1)));
}

/** Parse the season-projections array into id → ADP for one field. Exported for tests. */
export function parseAdp(data: unknown, field: string): Record<string, number> {
	const out: Record<string, number> = {};
	if (!Array.isArray(data)) return out;
	for (const e of data) {
		if (!e || typeof e !== "object") continue;
		const { player_id, stats } = e as { player_id?: unknown; stats?: Record<string, unknown> };
		const adp = stats?.[field];
		if (typeof player_id === "string" && typeof adp === "number" && adp < 999) out[player_id] = adp;
	}
	return out;
}

const memo = new Map<string, { at: number; adp: Record<string, number> }>();

/** id → dynasty ADP, cached in KV for 12h (the upstream response is ~3 MB). Empty on failure. */
/** When the dynasty ADP was last fetched from Sleeper (ISO), for freshness reporting. */
export let adpFetchedAt: string | null = null;

export async function dynastyAdp(kv: KVNamespace, league: League): Promise<Record<string, number>> {
	const field = adpField(league);
	const key = `adp:v2:${league.season}:${field}`;
	const hit = memo.get(key);
	if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.adp;

	const cached = await kv.get<{ at: string; adp: Record<string, number> }>(key, "json").catch(() => null);
	let adp = cached?.adp ?? null;
	if (cached?.at) adpFetchedAt = cached.at;
	if (!adp) {
		try {
			adp = parseAdp(await sleeper.seasonProjections(league.season, "regular", PROJECTED_POSITIONS), field);
		} catch {
			adp = {};
		}
		if (Object.keys(adp).length > 0) {
			adpFetchedAt = new Date().toISOString();
			await kv.put(key, JSON.stringify({ at: adpFetchedAt, adp }), { expirationTtl: 12 * 60 * 60 }).catch(() => {});
		}
	}
	memo.set(key, { at: Date.now(), adp });
	return adp;
}

// ---------------------------------------------------------------- blended market value

export interface DynastyMarket {
	/** Blended value: the average of Sleeper's ADP value and FantasyPros' superflex rank value when both exist. */
	value: number;
	sleeper_adp?: number;
	sleeper_value?: number;
	fantasypros_sf_rank?: number;
	fantasypros_value?: number;
}

/** FantasyPros ranks older than this are ignored (the upstream scrape sometimes stalls). */
const FP_MAX_AGE_DAYS = 7;

/**
 * Combine Sleeper's superflex dynasty ADP (draft market) with FantasyPros' superflex dynasty
 * consensus rank (experts), both on the same rank-to-value curve. Either alone when only one
 * covers the player. Pure; exported for tests.
 */
export function blendDynasty(adp: Record<string, number>, fpRanks: Map<string, number>, id: string): DynastyMarket | undefined {
	const a = adp[id];
	const r = fpRanks.get(id);
	const sv = a != null ? dynastyValue(a) : undefined;
	const fv = r != null ? dynastyValue(r) : undefined;
	if (sv == null && fv == null) return undefined;
	const value = sv != null && fv != null ? Math.round((sv + fv) / 2) : (sv ?? fv)!;
	return { value, ...(a != null ? { sleeper_adp: a, sleeper_value: sv } : {}), ...(r != null ? { fantasypros_sf_rank: r, fantasypros_value: fv } : {}) };
}

const marketMemo = new Map<string, { at: number; fp: Map<string, number>; scraped: string | null }>();

/** Market lookup for a league: id -> blended value (undefined if neither source has the player). */
export async function dynastyMarket(lc: LeagueContext): Promise<{ get: (id: string) => DynastyMarket | undefined; fantasypros_used: boolean; fantasypros_scraped: string | null; any: boolean }> {
	const adp = await dynastyAdp(lc.env.PLAYERS, lc.league);
	let fp = new Map<string, number>();
	let scraped: string | null = null;
	const superflex = adpField(lc.league) === "adp_dynasty_2qb";
	if (superflex && lc.env.NFL_DB) {
		const hit = marketMemo.get(lc.season);
		if (hit && Date.now() - hit.at < 10 * 60 * 1000) ({ fp, scraped } = hit);
		else {
			const r = await NflData.from(lc.env, lc.season).dynastySf().catch(() => ({ ranks: new Map<string, number>(), scraped: null }));
			fp = r.ranks;
			scraped = r.scraped;
			marketMemo.set(lc.season, { at: Date.now(), fp, scraped });
		}
	}
	const fresh = scraped != null && Date.now() - Date.parse(`${scraped}T12:00:00Z`) <= FP_MAX_AGE_DAYS * 86_400_000;
	const ranks = fresh ? fp : new Map<string, number>();
	return { get: (id) => blendDynasty(adp, ranks, id), fantasypros_used: fresh && ranks.size > 0, fantasypros_scraped: scraped, any: Object.keys(adp).length > 0 || ranks.size > 0 };
}
