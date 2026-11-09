// League-format adjustment for dynasty market values.
//
// The market sources (FantasyPros superflex dynasty ranks, Sleeper superflex ADP) assume a
// standard format: full PPR, 4-point passing TDs, no TE premium or first-down points. This
// league may differ (6-point passing TDs here). For each position, score this season's
// games both ways and compare the average points above replacement among starters; the
// ratio scales that position's market value. Replacement is the next player after the
// league's starter count at the position, so a scoring change that lifts every QB (the
// replacement QB too) moves value less than it moves raw points.

import type { LeagueContext } from "./league";
import { NflData, leaguePoints } from "./nflverse/stats";
import { computeReplacement, round, weekPool, type SkillPos } from "./scoring";

type Row = Record<string, unknown>;

/** What the market rankings assume, applied on top of the league's own rules. */
export const MARKET_STANDARD: Record<string, number> = {
	pass_td: 4,
	rec: 1,
	bonus_rec_rb: 0,
	bonus_rec_wr: 0,
	bonus_rec_te: 0,
	pass_fd: 0,
	rush_fd: 0,
	rec_fd: 0,
};

const POSITIONS: SkillPos[] = ["QB", "RB", "WR", "TE"];
/** Games needed for a player to count (a few snaps in one game shouldn't set replacement). */
export const MIN_GAMES = 4;
/**
 * Replacement = the average of this many players after the starters, not the single next one.
 * One player's touchdown mix decides a single-player replacement: through week 9 of 2026 that
 * gave QB x1.116, but x1.399 one starter later and anywhere from x1.12 to x1.46 week to week.
 * An 8-player band held x1.23-1.25 across weeks 7-9 and within 0.02 for starters +/- 2
 * (scripts/verify-format.mjs, which recomputes it from Sleeper's and nflverse's raw stats).
 */
export const REPLACEMENT_BAND = 8;
/** With fewer than this many players after the starters, the position isn't adjusted (x1). */
export const MIN_BAND = 3;

export interface PositionFormat {
	multiplier: number;
	starters: number;
	/** Players averaged for replacement (up to REPLACEMENT_BAND). */
	replacement_band: number;
	replacement_ppg: { league: number; standard: number };
	above_replacement_ppg: { league: number; standard: number };
}

export interface FormatAdjustment {
	multipliers: Record<SkillPos, number>;
	by_position: Partial<Record<SkillPos, PositionFormat>>;
	standard: string;
	based_on: string;
}

/**
 * Per-position multipliers from season rows (one per player-week). Pure; exported for tests.
 * A position without enough players, or where the standard scoring gives no edge over
 * replacement, keeps 1. Multipliers are clamped to 0.6-1.6.
 */
export function formatMultipliers(rows: Row[], league: Record<string, number>, starters: Record<SkillPos, number>): Omit<FormatAdjustment, "standard" | "based_on"> {
	const standard = { ...league, ...MARKET_STANDARD };
	const acc = new Map<string, { pos: string; g: number; lg: number; st: number }>();
	for (const r of rows) {
		const pos = String(r.position ?? "");
		if (!(POSITIONS as string[]).includes(pos)) continue;
		const id = String(r.gsis_id ?? "");
		const a = acc.get(id) ?? { pos, g: 0, lg: 0, st: 0 };
		a.g++;
		a.lg += leaguePoints(r, league);
		a.st += leaguePoints(r, standard);
		acc.set(id, a);
	}
	const multipliers = { QB: 1, RB: 1, WR: 1, TE: 1 } as Record<SkillPos, number>;
	const by_position: Partial<Record<SkillPos, PositionFormat>> = {};
	for (const pos of POSITIONS) {
		const n = starters[pos] ?? 0;
		const players = [...acc.values()].filter((a) => a.pos === pos && a.g >= MIN_GAMES);
		const band = Math.min(REPLACEMENT_BAND, players.length - n);
		if (!n || band < MIN_BAND) continue;
		const side = (k: "lg" | "st") => {
			const ppg = players.map((a) => a[k] / a.g).sort((x, y) => y - x);
			const repl = ppg.slice(n, n + band).reduce((s, x) => s + x, 0) / band;
			return { repl, par: ppg.slice(0, n).reduce((s, x) => s + (x - repl), 0) / n };
		};
		const lg = side("lg");
		const st = side("st");
		if (st.par <= 0) continue;
		const m = Math.min(1.6, Math.max(0.6, round(lg.par / st.par, 3)));
		multipliers[pos] = m;
		by_position[pos] = {
			multiplier: m,
			starters: n,
			replacement_band: band,
			replacement_ppg: { league: round(lg.repl, 1), standard: round(st.repl, 1) },
			above_replacement_ppg: { league: round(lg.par, 2), standard: round(st.par, 2) },
		};
	}
	return { multipliers, by_position };
}

const memo = new Map<string, { at: number; adj: FormatAdjustment }>();

/** This league's format adjustment, from this season's nflverse games (cached 6h). Null if unavailable. */
export async function leagueFormat(lc: LeagueContext): Promise<FormatAdjustment | null> {
	if (!lc.env.NFL_DB) return null;
	const key = `${lc.season}:${lc.week}`;
	const hit = memo.get(key);
	if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.adj;
	const nfl = NflData.from(lc.env, lc.season);
	const latest = await nfl.latestWeek();
	if (!latest) return null;
	const [rows, pool] = await Promise.all([
		nfl.weekRange("nfl_player_week", 1, latest, "AND season_type = 'REG' AND position IN ('QB','RB','WR','TE')"),
		weekPool(lc.env.PLAYERS, lc.league, lc.season, lc.week, lc.seasonType),
	]);
	if (!pool.length) return null;
	const starters = computeReplacement(pool, lc.league.roster_positions, lc.league.total_rosters).starters;
	const core = formatMultipliers(rows, lc.league.scoring_settings, starters);
	const adj: FormatAdjustment = {
		...core,
		standard: "full PPR, 4-pt passing TDs, no TE premium or first-down points (what the market rankings assume)",
		based_on: `weeks 1-${latest} of ${lc.season}, players with ${MIN_GAMES}+ games; replacement = average of the ${REPLACEMENT_BAND} players after the league's starter count (no adjustment with fewer than ${MIN_BAND})`,
	};
	memo.set(key, { at: Date.now(), adj });
	return adj;
}
