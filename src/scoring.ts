// League-specific scoring and valuation on top of Sleeper's (undocumented)
// projections.
//
// Points are always computed from raw projected stats with *this league's*
// scoring_settings, never from Sleeper's pts_ppr, so 6-point passing TDs and
// any other customisation are reflected. Valuation is value over replacement
// (VOR) where the replacement level is derived from the league's actual
// starting slots, so a superflex league naturally values QBs much higher.

import { sleeper, type League } from "./sleeper";
import { verifyNotes } from "./verify";

export const PROJECTED_POSITIONS = ["QB", "RB", "WR", "TE"] as const;
export type SkillPos = (typeof PROJECTED_POSITIONS)[number];

/**
 * Fallback if the league can't be fetched: Sleeper's PPR defaults with
 * 6-point passing TDs (the league this server was built for).
 */
export const DEFAULT_SCORING: Record<string, number> = {
	pass_yd: 0.04,
	pass_td: 6,
	pass_int: -1,
	pass_2pt: 2,
	rush_yd: 0.1,
	rush_td: 6,
	rush_2pt: 2,
	rec: 1,
	rec_yd: 0.1,
	rec_td: 6,
	rec_2pt: 2,
	fum_lost: -2,
	fum_rec_td: 6,
};

export function scoreStats(stats: Record<string, unknown>, scoring: Record<string, number>): number {
	let pts = 0;
	for (const [k, mult] of Object.entries(scoring)) {
		if (!mult) continue;
		const v = stats[k];
		if (typeof v === "number" && Number.isFinite(v)) pts += v * mult;
	}
	return round(pts);
}

export function round(n: number, places = 2): number {
	const f = 10 ** places;
	return Math.round(n * f) / f;
}

// ---------- Slots & replacement level ----------

const SLOT_ELIGIBILITY: Record<string, readonly SkillPos[]> = {
	QB: ["QB"],
	RB: ["RB"],
	WR: ["WR"],
	TE: ["TE"],
	WRRB_FLEX: ["RB", "WR"],
	REC_FLEX: ["WR", "TE"],
	FLEX: ["RB", "WR", "TE"],
	SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};
// Most restrictive first so flexible slots get what's left over.
const SLOT_FILL_ORDER = ["QB", "RB", "WR", "TE", "WRRB_FLEX", "REC_FLEX", "FLEX", "SUPER_FLEX"];

export function slotEligibility(slot: string): readonly string[] {
	return SLOT_ELIGIBILITY[slot] ?? [slot];
}

export interface ProjectedEntry {
	id: string;
	pos: string;
	pts: number;
	opp?: string | null;
}

export interface Replacement {
	/** Weekly points of the best player at each position who would not start league-wide. */
	level: Record<SkillPos, number>;
	/** How many players at each position start league-wide (e.g. QB: 24 in a 12-team superflex). */
	starters: Record<SkillPos, number>;
}

/**
 * Fill every team's starting slots league-wide from a pool of weekly
 * projections (dedicated slots first, then flex slots with the best players
 * left), then call the best non-starter at each position "replacement".
 */
export function computeReplacement(
	pool: ProjectedEntry[],
	rosterPositions: string[],
	teams: number,
): Replacement {
	const sorted = pool
		.filter((p) => (PROJECTED_POSITIONS as readonly string[]).includes(p.pos))
		.sort((a, b) => b.pts - a.pts);
	const taken = new Set<string>();
	const starters: Record<SkillPos, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };

	const counts = new Map<string, number>();
	for (const slot of rosterPositions) counts.set(slot, (counts.get(slot) ?? 0) + 1);

	for (const slot of SLOT_FILL_ORDER) {
		const eligible = SLOT_ELIGIBILITY[slot]!;
		let need = (counts.get(slot) ?? 0) * teams;
		for (const p of sorted) {
			if (need <= 0) break;
			if (taken.has(p.id) || !eligible.includes(p.pos as SkillPos)) continue;
			taken.add(p.id);
			starters[p.pos as SkillPos]++;
			need--;
		}
	}

	const level = { QB: 0, RB: 0, WR: 0, TE: 0 } as Record<SkillPos, number>;
	for (const pos of PROJECTED_POSITIONS) {
		const atPos = sorted.filter((p) => p.pos === pos);
		// Best non-starter; if every projected player starts, fall back to the worst starter.
		const next = atPos.find((p) => !taken.has(p.id)) ?? atPos[atPos.length - 1];
		level[pos] = next ? round(next.pts) : 0;
	}
	return { level, starters };
}

/** Last week that counts for fantasy (end of the league's playoffs). */
export function lastFantasyWeek(league: League): number {
	const s = league.settings;
	const start = Number(s.playoff_week_start) || 0;
	if (!start) return 17;
	const teams = Math.max(2, Number(s.playoff_teams) || 6);
	const rounds = Math.ceil(Math.log2(teams));
	const type = Number(s.playoff_round_type) || 0;
	const weeks = type === 2 ? rounds * 2 : type === 1 ? rounds + 1 : rounds;
	return Math.min(18, start + weeks - 1);
}

// ---------- Projections parsing (defensive: the endpoints are undocumented) ----------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface WeekProjection {
	week: number;
	opp: string | null;
	stats: Record<string, number>;
}

/** Parse `/projections/nfl/player/{id}?grouping=week`: `{ "1": {...} | null, ... }`. */
export function parsePlayerWeeks(data: unknown): Map<number, WeekProjection | null> {
	const out = new Map<number, WeekProjection | null>();
	if (!isRecord(data)) return out;
	for (const [k, v] of Object.entries(data)) {
		const week = Number(k);
		if (!Number.isInteger(week)) continue;
		if (v === null) {
			out.set(week, null); // bye
			continue;
		}
		if (!isRecord(v) || !isRecord(v.stats)) continue;
		out.set(week, {
			week,
			opp: typeof v.opponent === "string" ? v.opponent : null,
			stats: v.stats as Record<string, number>,
		});
	}
	return out;
}

/** Parse the bulk weekly projections array into league-scored entries. */
export function parseWeekBulk(data: unknown, scoring: Record<string, number>): ProjectedEntry[] {
	if (!Array.isArray(data)) return [];
	const out: ProjectedEntry[] = [];
	for (const e of data) {
		if (!isRecord(e) || typeof e.player_id !== "string" || !isRecord(e.stats)) continue;
		const player = isRecord(e.player) ? e.player : {};
		const pos = typeof player.position === "string" ? player.position : null;
		if (!pos) continue;
		const stats = e.stats as Record<string, unknown>;
		// Byes and injured players come back as stub entries without games played.
		if (!(typeof stats.gp === "number" && stats.gp > 0)) continue;
		out.push({
			id: e.player_id,
			pos,
			pts: scoreStats(stats, scoring),
			opp: typeof e.opponent === "string" ? e.opponent : null,
		});
	}
	return out;
}

// ---------- Fetch + cache ----------

const bulkMemo = new Map<string, { at: number; entries: ProjectedEntry[] }>();
const BULK_TTL_S = 6 * 60 * 60;

/**
 * League-scored projections for every QB/RB/WR/TE in a given week.
 * Cached in KV (6h) because the upstream response is ~2 MB.
 * Returns [] if the undocumented endpoint fails or changes shape.
 */
export async function weekPool(
	kv: KVNamespace,
	league: League,
	season: string,
	week: number,
	seasonType = "regular",
): Promise<ProjectedEntry[]> {
	const key = `proj:v2:${league.league_id}:${season}:${seasonType}:${week}:${scoringHash(league.scoring_settings)}`;
	const memo = bulkMemo.get(key);
	if (memo && Date.now() - memo.at < 10 * 60 * 1000) return memo.entries;

	let entries: ProjectedEntry[] | null = await kv.get<[string, string, number, string | null][]>(key, "json").then(
		(rows) => rows?.map(([id, pos, pts, opp]): ProjectedEntry => ({ id, pos, pts, opp })) ?? null,
		() => null,
	);
	if (!entries) {
		try {
			const raw = await sleeper.weekProjections(season, week, seasonType, PROJECTED_POSITIONS);
			entries = parseWeekBulk(raw, league.scoring_settings);
		} catch {
			entries = [];
		}
		if (entries.length > 0) {
			const rows = entries.map((e) => [e.id, e.pos, e.pts, e.opp ?? null]);
			await kv.put(key, JSON.stringify(rows), { expirationTtl: BULK_TTL_S }).catch(() => {});
		}
	}
	if (bulkMemo.size > 50) bulkMemo.clear();
	bulkMemo.set(key, { at: Date.now(), entries });
	return entries;
}

function scoringHash(s: Record<string, number>): string {
	// Small stable hash so a scoring change invalidates cached points.
	const str = Object.keys(s)
		.sort()
		.filter((k) => s[k])
		.map((k) => `${k}=${s[k]}`)
		.join(",");
	let h = 5381;
	for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
	return h.toString(36);
}

export interface PlayerValuation {
	/** Projected points for the requested week under league scoring (null = bye/out/no projection). */
	week_pts: number | null;
	week_opp: string | null;
	/** Rest of season: requested week through the end of the fantasy playoffs. */
	ros_pts: number;
	ros_games: number;
	ros_ppg: number;
	/** Value over replacement across the rest of the season. */
	ros_vor: number;
	/** Weeks in that range when the player's team is on bye. */
	bye_weeks: number[];
	/**
	 * Non-bye weeks in that range with no projected game: an injury, a suspension,
	 * or an assumption Sleeper doesn't explain (e.g. an expected benching).
	 */
	projected_out_weeks: number[];
	/** Actual points so far this season under league scoring. */
	season_pts?: number;
	season_games?: number;
	weeks?: { week: number; opp: string | null; pts: number }[];
	key_stats?: Record<string, number>;
	/** Projection assumptions to check against current news before relying on them. */
	verify?: string[];
}

export interface WeekSummary {
	perWeek: { week: number; opp: string | null; pts: number }[];
	byeWeeks: number[];
	outWeeks: number[];
	ros: number;
	vor: number;
}

/**
 * Walk a player's weekly projections from `fromWeek` through `throughWeek`.
 * Sleeper returns null for bye weeks; any other week without a projected game
 * counts as projected out. Weeks missing from the response are skipped.
 * Pure; exported for tests.
 */
export function summarizeWeeks(
	weeks: Map<number, WeekProjection | null>,
	fromWeek: number,
	throughWeek: number,
	scoring: Record<string, number>,
	replacement: number,
): WeekSummary {
	const s: WeekSummary = { perWeek: [], byeWeeks: [], outWeeks: [], ros: 0, vor: 0 };
	for (let w = fromWeek; w <= throughWeek; w++) {
		if (!weeks.has(w)) continue;
		const wp = weeks.get(w);
		if (wp === null) {
			s.byeWeeks.push(w);
			continue;
		}
		if (!wp || !plays(wp.stats)) {
			s.outWeeks.push(w);
			continue;
		}
		const pts = scoreStats(wp.stats, scoring);
		s.perWeek.push({ week: w, opp: wp.opp, pts });
		s.ros += pts;
		s.vor += pts - replacement;
	}
	return s;
}

const KEY_STATS = [
	"pass_att",
	"pass_cmp",
	"pass_yd",
	"pass_td",
	"pass_int",
	"rush_att",
	"rush_yd",
	"rush_td",
	"rec_tgt",
	"rec",
	"rec_yd",
	"rec_td",
	"fum_lost",
];

export async function valuePlayer(opts: {
	playerId: string;
	pos: string;
	league: League;
	season: string;
	seasonType: string;
	week: number;
	throughWeek: number;
	replacement: Replacement | null;
	includeWeeks?: boolean;
	/** Sleeper injury_status and non-Active roster status, used for the verify notes. */
	injury?: string;
	status?: string;
}): Promise<PlayerValuation | null> {
	const [projRaw, statsRaw] = await Promise.all([
		sleeper.playerProjections(opts.playerId, opts.season, opts.seasonType).catch(() => null),
		sleeper.playerStats(opts.playerId, opts.season, opts.seasonType).catch(() => null),
	]);
	const weeks = parsePlayerWeeks(projRaw);
	if (weeks.size === 0) return null;

	const scoring = opts.league.scoring_settings;
	const repl = opts.replacement?.level[opts.pos as SkillPos] ?? 0;
	const sum = summarizeWeeks(weeks, opts.week, opts.throughWeek, scoring, repl);
	const current = weeks.get(opts.week) ?? null;
	const playsNow = current && plays(current.stats);
	const v: PlayerValuation = {
		week_pts: playsNow ? scoreStats(current.stats, scoring) : null,
		week_opp: current?.opp ?? null,
		ros_pts: round(sum.ros, 1),
		ros_games: sum.perWeek.length,
		ros_ppg: sum.perWeek.length ? round(sum.ros / sum.perWeek.length, 1) : 0,
		ros_vor: round(sum.vor, 1),
		bye_weeks: sum.byeWeeks,
		projected_out_weeks: sum.outWeeks,
	};

	// Season to date, from actual stats (also undocumented; skipped if missing).
	let seasonPts = 0;
	let seasonGames = 0;
	for (const [w, wk] of parsePlayerWeeks(statsRaw)) {
		if (w >= opts.week || !wk || !plays(wk.stats)) continue;
		seasonPts += scoreStats(wk.stats, scoring);
		seasonGames++;
	}
	if (statsRaw) {
		v.season_pts = round(seasonPts, 1);
		v.season_games = seasonGames;
	}

	if (opts.includeWeeks) v.weeks = sum.perWeek;
	if (playsNow) {
		const ks: Record<string, number> = {};
		for (const k of KEY_STATS) {
			const val = current.stats[k];
			if (typeof val === "number" && val >= 0.05) ks[k] = round(val, 1);
		}
		v.key_stats = ks;
	}

	const verify = verifyNotes({
		week: opts.week,
		playedWeeks: sum.perWeek.map((x) => x.week),
		byeWeeks: sum.byeWeeks,
		outWeeks: sum.outWeeks,
		injury: opts.injury,
		status: opts.status,
		rosPpg: v.ros_ppg,
		seasonPts: v.season_pts,
		seasonGames: v.season_games,
	});
	if (verify.length) v.verify = verify;
	return v;
}

function plays(stats: Record<string, number>): boolean {
	return typeof stats.gp === "number" && stats.gp > 0;
}

/** Best possible lineup for one roster from a weekly pool. Returns total points and the chosen ids. */
export function optimalLineup(
	rosterIds: string[],
	rosterPositions: string[],
	ptsById: Map<string, { pos: string; pts: number }>,
): { total: number; starters: { slot: string; id: string | null; pts: number }[] } {
	const avail = rosterIds
		.map((id) => ({ id, ...(ptsById.get(id) ?? { pos: "?", pts: 0 }) }))
		.sort((a, b) => b.pts - a.pts);
	const used = new Set<string>();
	const slots = rosterPositions.filter((s) => s !== "BN" && s !== "IR" && s !== "TAXI");
	const fillRank = (slot: string) => {
		const i = SLOT_FILL_ORDER.indexOf(slot);
		return i === -1 ? SLOT_FILL_ORDER.length : i;
	};
	const ordered = slots.map((slot, i) => ({ slot, i })).sort((a, b) => fillRank(a.slot) - fillRank(b.slot));
	const result: { slot: string; id: string | null; pts: number }[] = new Array(slots.length);
	let total = 0;
	for (const { slot, i } of ordered) {
		const elig = slotEligibility(slot);
		const pick = avail.find((p) => !used.has(p.id) && elig.includes(p.pos));
		if (pick) {
			used.add(pick.id);
			total += pick.pts;
		}
		result[i] = { slot, id: pick?.id ?? null, pts: pick?.pts ?? 0 };
	}
	return { total: round(total, 1), starters: result };
}
