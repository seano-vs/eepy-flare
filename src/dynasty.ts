// Dynasty valuation.
//
// Rest-of-season VOR says nothing about next year, so dynasty leagues also get a
// long-term market value from Sleeper's dynasty ADP (superflex ADP in superflex
// leagues). It comes from the same undocumented season-projections endpoint;
// if that fails, tools simply omit the dynasty fields.

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
export async function dynastyAdp(kv: KVNamespace, league: League): Promise<Record<string, number>> {
	const field = adpField(league);
	const key = `adp:v1:${league.season}:${field}`;
	const hit = memo.get(key);
	if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.adp;

	let adp = await kv.get<Record<string, number>>(key, "json").catch(() => null);
	if (!adp) {
		try {
			adp = parseAdp(await sleeper.seasonProjections(league.season, "regular", PROJECTED_POSITIONS), field);
		} catch {
			adp = {};
		}
		if (Object.keys(adp).length > 0) {
			await kv.put(key, JSON.stringify(adp), { expirationTtl: 12 * 60 * 60 }).catch(() => {});
		}
	}
	memo.set(key, { at: Date.now(), adp });
	return adp;
}
