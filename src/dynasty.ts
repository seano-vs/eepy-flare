// Dynasty valuation.
//
// Rest-of-season VOR says nothing about next year, so dynasty leagues also get a
// long-term market value: FantasyPros' superflex dynasty consensus ranks (nflverse
// mirror) blended with Sleeper's dynasty ADP (superflex ADP in superflex leagues, from
// the undocumented season-projections endpoint), weighted toward FantasyPros in-season
// (see FP_WEIGHT). If both fail, tools omit the dynasty fields.

import type { LeagueContext } from "./league";
import { NflData } from "./nflverse/stats";
import { leagueFormat, type FormatAdjustment } from "./format";
import type { SkillPos } from "./scoring";
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
	/** Value for this league: the market value scaled by the league-format multiplier for the position. */
	value: number;
	/** Market value before the format adjustment: FantasyPros and Sleeper, weighted (see FP_WEIGHT). */
	market_value?: number;
	/** Multiplier applied for this league's scoring vs the market's standard (omitted when 1). */
	format_multiplier?: number;
	sleeper_adp?: number;
	sleeper_value?: number;
	fantasypros_sf_rank?: number;
	fantasypros_value?: number;
}

/**
 * FantasyPros' share of the blend. Sleeper's dynasty ADP comes from drafts, which mostly happen
 * before the season: in-season it tracks redraft ADP (r = 0.92 on Nov 9) and lags breakouts and
 * injuries (Purdy ADP 47.6 vs FantasyPros 15; Omarion Hampton 20.9 vs 72 at 9 ppg). It also sits
 * below the experts on QBs across the board (Mahomes 37 vs 14, Lawrence 35 vs 13): QBs average
 * 838 value points below FantasyPros, RBs 626 above. The expert ranks update weekly, so they get
 * most of the weight during the season and half in the offseason, when draft data is fresh.
 */
export const FP_WEIGHT = { in_season: 0.8, offseason: 0.5 };

/** FantasyPros ranks older than this are ignored (the upstream scrape sometimes stalls). */
const FP_MAX_AGE_DAYS = 7;

/**
 * Combine Sleeper's superflex dynasty ADP (draft market) with FantasyPros' superflex dynasty
 * consensus rank (experts), both on the same rank-to-value curve. Either alone when only one
 * covers the player. Pure; exported for tests.
 */
export function blendDynasty(adp: Record<string, number>, fpRanks: Map<string, number>, id: string, fpWeight = 0.5): DynastyMarket | undefined {
	const a = adp[id];
	const r = fpRanks.get(id);
	const sv = a != null ? dynastyValue(a) : undefined;
	const fv = r != null ? dynastyValue(r) : undefined;
	if (sv == null && fv == null) return undefined;
	const value = sv != null && fv != null ? Math.round(fpWeight * fv + (1 - fpWeight) * sv) : (sv ?? fv)!;
	return { value, ...(a != null ? { sleeper_adp: a, sleeper_value: sv } : {}), ...(r != null ? { fantasypros_sf_rank: r, fantasypros_value: fv } : {}) };
}

const marketMemo = new Map<string, { at: number; fp: Map<string, number>; scraped: string | null }>();

/** Market lookup for a league: id -> blended value (undefined if neither source has the player). */
export async function dynastyMarket(lc: LeagueContext): Promise<{ get: (id: string) => DynastyMarket | undefined; fantasypros_used: boolean; fantasypros_weight: number; fantasypros_scraped: string | null; any: boolean; format: FormatAdjustment | null }> {
	const [adp, format] = await Promise.all([dynastyAdp(lc.env.PLAYERS, lc.league), leagueFormat(lc).catch(() => null)]);
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
	const w = lc.league.status === "in_season" ? FP_WEIGHT.in_season : FP_WEIGHT.offseason;
	const get = (id: string): DynastyMarket | undefined => {
		const b = blendDynasty(adp, ranks, id, w);
		if (!b) return undefined;
		const m = format?.multipliers[lc.players.get(id)?.pos as SkillPos] ?? 1;
		return m === 1 ? { ...b, market_value: b.value } : { ...b, market_value: b.value, value: Math.round(b.value * m), format_multiplier: m };
	};
	return { get, format, fantasypros_used: fresh && ranks.size > 0, fantasypros_weight: fresh && ranks.size > 0 ? w : 0, fantasypros_scraped: scraped, any: Object.keys(adp).length > 0 || ranks.size > 0 };
}
