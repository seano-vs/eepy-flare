// Standings from actual matchup results and a Monte Carlo of the rest of the regular season.
//
// Team strength each remaining week = the best lineup Sleeper's projections allow for that
// week (byes and projected absences count), blended with the team's actual scoring so far.
// Each simulated game draws both scores from a normal distribution around those means.

import type { LeagueContext } from "./league";
import { optimalLineup, round, weekPool } from "./scoring";
import { sleeper, type Matchup, type Roster } from "./sleeper";

export interface StandingRow {
	roster_id: number;
	wins: number;
	losses: number;
	ties: number;
	pf: number;
	pa: number;
}

/** W/L/T and points from completed weeks' matchups (pure; exported for tests). */
export function standingsFromMatchups(weeks: Matchup[][], rosterIds: number[]): Map<number, StandingRow> {
	const t = new Map<number, StandingRow>(rosterIds.map((id) => [id, { roster_id: id, wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 }]));
	for (const week of weeks) {
		const byMatch = new Map<number, Matchup[]>();
		for (const m of week) if (m.matchup_id != null) byMatch.set(m.matchup_id, [...(byMatch.get(m.matchup_id) ?? []), m]);
		for (const pair of byMatch.values()) {
			if (pair.length !== 2) continue;
			const [a, b] = pair as [Matchup, Matchup];
			const pa = a.custom_points ?? a.points ?? 0;
			const pb = b.custom_points ?? b.points ?? 0;
			const ra = t.get(a.roster_id);
			const rb = t.get(b.roster_id);
			if (!ra || !rb) continue;
			ra.pf += pa;
			ra.pa += pb;
			rb.pf += pb;
			rb.pa += pa;
			if (pa > pb) (ra.wins++, rb.losses++);
			else if (pb > pa) (rb.wins++, ra.losses++);
			else (ra.ties++, rb.ties++);
		}
	}
	for (const r of t.values()) {
		r.pf = round(r.pf, 2);
		r.pa = round(r.pa, 2);
	}
	return t;
}

/** Records from completed weeks' matchups (Sleeper's displayed record can lag a week). */
export async function computedRecords(lc: LeagueContext): Promise<Map<number, StandingRow>> {
	const completed = Number(lc.league.settings.last_scored_leg) || Math.max(0, lc.week - 1);
	const weeks = await Promise.all(Array.from({ length: completed }, (_, i) => sleeper.matchups(lc.config.leagueId, i + 1).catch(() => [] as Matchup[])));
	return standingsFromMatchups(weeks, lc.rosters.map((r) => r.roster_id));
}

export function recordString(r: StandingRow): string {
	return `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`;
}

/** Deterministic PRNG so the same inputs give the same odds. */
function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function normal(rand: () => number): number {
	let u = 0;
	while (u === 0) u = rand();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export interface SimInput {
	standings: Map<number, StandingRow>;
	/** Remaining weeks' pairings: [rosterA, rosterB] per game. */
	schedule: [number, number][][];
	/** Mean projected points per roster per remaining week (same order as schedule). */
	means: Map<number, number[]>;
	playoffTeams: number;
	/** Seeds with a first-round bye (0 if none). */
	byes: number;
	iterations?: number;
	/** Track a team's odds conditional on winning/losing the first remaining week. */
	focus?: number;
}

export interface SimResult {
	odds: Map<number, { playoffs: number; bye: number; avg_seed: number; avg_wins: number }>;
	focus?: { if_win: number; if_lose: number };
}

/** Pure simulation (exported for tests). */
export function simulate(input: SimInput): SimResult {
	const n = input.iterations ?? 5000;
	const rand = mulberry32(20261105);
	const ids = [...input.standings.keys()];
	const made = new Map(ids.map((id) => [id, 0]));
	const byeCount = new Map(ids.map((id) => [id, 0]));
	const seedSum = new Map(ids.map((id) => [id, 0]));
	const winSum = new Map(ids.map((id) => [id, 0]));
	let fw = 0;
	let fwIn = 0;
	let fl = 0;
	let flIn = 0;
	for (let it = 0; it < n; it++) {
		const wins = new Map(ids.map((id) => [id, input.standings.get(id)!.wins + input.standings.get(id)!.ties * 0.5]));
		const pf = new Map(ids.map((id) => [id, input.standings.get(id)!.pf]));
		let focusWon: boolean | null = null;
		input.schedule.forEach((games, wi) => {
			for (const [a, b] of games) {
				const ma = input.means.get(a)?.[wi] ?? 0;
				const mb = input.means.get(b)?.[wi] ?? 0;
				const sa = Math.max(0, ma + normal(rand) * Math.max(18, ma * 0.17));
				const sb = Math.max(0, mb + normal(rand) * Math.max(18, mb * 0.17));
				pf.set(a, pf.get(a)! + sa);
				pf.set(b, pf.get(b)! + sb);
				const winner = sa >= sb ? a : b;
				wins.set(winner, wins.get(winner)! + 1);
				if (wi === 0 && input.focus != null && (a === input.focus || b === input.focus)) focusWon = winner === input.focus;
			}
		});
		const order = [...ids].sort((x, y) => wins.get(y)! - wins.get(x)! || pf.get(y)! - pf.get(x)!);
		order.forEach((id, i) => {
			seedSum.set(id, seedSum.get(id)! + i + 1);
			winSum.set(id, winSum.get(id)! + wins.get(id)!);
			if (i < input.playoffTeams) made.set(id, made.get(id)! + 1);
			if (i < input.byes) byeCount.set(id, byeCount.get(id)! + 1);
		});
		if (focusWon != null) {
			const inP = order.indexOf(input.focus!) < input.playoffTeams;
			if (focusWon) (fw++, inP && fwIn++);
			else (fl++, inP && flIn++);
		}
	}
	const odds = new Map(
		ids.map((id) => [
			id,
			{
				playoffs: round((made.get(id)! / n) * 100, 1),
				bye: round((byeCount.get(id)! / n) * 100, 1),
				avg_seed: round(seedSum.get(id)! / n, 1),
				avg_wins: round(winSum.get(id)! / n, 1),
			},
		]),
	);
	return { odds, ...(input.focus != null && (fw || fl) ? { focus: { if_win: fw ? round((fwIn / fw) * 100, 1) : 0, if_lose: fl ? round((flIn / fl) * 100, 1) : 0 } } : {}) };
}

/** Byes for a playoff field: 6 teams -> 2, 12/10 -> 4/2, otherwise 0 (bracket fills a power of 2). */
export function playoffByes(teams: number): number {
	const p = 2 ** Math.ceil(Math.log2(Math.max(2, teams)));
	return p === teams ? 0 : p - teams;
}

export interface LeagueSeason {
	standings: Map<number, StandingRow>;
	completed: number;
	regEnd: number;
	weeks: number[];
	schedule: [number, number][][];
	pools: Map<string, { pos: string; pts: number }>[];
}

/** Completed results, remaining schedule and per-week projection pools. */
export async function loadSeason(lc: LeagueContext): Promise<LeagueSeason> {
	const start = Number(lc.league.settings.playoff_week_start) || 15;
	const regEnd = start - 1;
	const completed = Math.min(regEnd, Number(lc.league.settings.last_scored_leg) || Math.max(0, lc.week - 1));
	const pastWeeks = Array.from({ length: completed }, (_, i) => i + 1);
	const weeks = Array.from({ length: Math.max(0, regEnd - completed) }, (_, i) => completed + 1 + i);
	const [past, future, pools] = await Promise.all([
		Promise.all(pastWeeks.map((w) => sleeper.matchups(lc.config.leagueId, w).catch(() => [] as Matchup[]))),
		Promise.all(weeks.map((w) => sleeper.matchups(lc.config.leagueId, w).catch(() => [] as Matchup[]))),
		Promise.all(weeks.map((w) => weekPool(lc.env.PLAYERS, lc.league, lc.season, w, lc.seasonType))),
	]);
	const standings = standingsFromMatchups(past, lc.rosters.map((r) => r.roster_id));
	const schedule = future.map((ms) => {
		const byMatch = new Map<number, number[]>();
		for (const m of ms) if (m.matchup_id != null) byMatch.set(m.matchup_id, [...(byMatch.get(m.matchup_id) ?? []), m.roster_id]);
		return [...byMatch.values()].filter((p) => p.length === 2).map((p) => [p[0]!, p[1]!] as [number, number]);
	});
	return { standings, completed, regEnd, weeks, schedule, pools: pools.map((pool) => new Map(pool.map((e) => [e.id, { pos: e.pos, pts: e.pts }]))) };
}

const activeIds = (r: Roster) => {
	const res = new Set([...(r.reserve ?? []), ...(r.taxi ?? [])]);
	return (r.players ?? []).filter((id) => !res.has(id));
};

/** Mean weekly points per roster: best projected lineup each week, blended 75/25 with actual PF/game. */
export function teamMeans(lc: LeagueContext, season: LeagueSeason, overrides: Map<number, string[]> = new Map()): Map<number, number[]> {
	const slots = lc.league.roster_positions.filter((s) => s !== "BN");
	const means = new Map<number, number[]>();
	for (const r of lc.rosters) {
		const ids = overrides.get(r.roster_id) ?? activeIds(r);
		const st = season.standings.get(r.roster_id)!;
		const games = st.wins + st.losses + st.ties;
		const form = games ? st.pf / games : null;
		means.set(
			r.roster_id,
			season.pools.map((pool) => {
				const proj = optimalLineup(ids, slots, pool).total;
				return form != null && proj > 0 ? 0.75 * proj + 0.25 * form : proj || form || 0;
			}),
		);
	}
	return means;
}

export function runOdds(lc: LeagueContext, season: LeagueSeason, overrides?: Map<number, string[]>, focus?: number): SimResult {
	const teams = Number(lc.league.settings.playoff_teams) || 6;
	return simulate({
		standings: season.standings,
		schedule: season.schedule,
		means: teamMeans(lc, season, overrides),
		playoffTeams: teams,
		byes: playoffByes(teams),
		focus,
	});
}

export { activeIds };
