// Read side of the nflverse mirror: league-scored actual and expected points,
// and the queries the tools use.

import { round } from "../scoring";

type Row = Record<string, unknown>;

const n = (r: Row, k: string): number => {
	const v = r[k];
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
};

/** Sleeper scoring key -> value from an nflverse player-week row. */
const ACTUAL: Record<string, (r: Row) => number> = {
	pass_yd: (r) => n(r, "passing_yards"),
	pass_td: (r) => n(r, "passing_tds"),
	pass_int: (r) => n(r, "passing_interceptions"),
	pass_2pt: (r) => n(r, "passing_2pt_conversions"),
	pass_sack: (r) => n(r, "sacks_suffered"),
	pass_fd: (r) => n(r, "passing_first_downs"),
	pass_att: (r) => n(r, "attempts"),
	pass_cmp: (r) => n(r, "completions"),
	rush_yd: (r) => n(r, "rushing_yards"),
	rush_td: (r) => n(r, "rushing_tds"),
	rush_2pt: (r) => n(r, "rushing_2pt_conversions"),
	rush_fd: (r) => n(r, "rushing_first_downs"),
	rush_att: (r) => n(r, "carries"),
	rec: (r) => n(r, "receptions"),
	rec_yd: (r) => n(r, "receiving_yards"),
	rec_td: (r) => n(r, "receiving_tds"),
	rec_2pt: (r) => n(r, "receiving_2pt_conversions"),
	rec_fd: (r) => n(r, "receiving_first_downs"),
	rec_tgt: (r) => n(r, "targets"),
	fum_lost: (r) => n(r, "rushing_fumbles_lost") + n(r, "receiving_fumbles_lost") + n(r, "sack_fumbles_lost"),
	fum_rec_td: (r) => n(r, "fumble_recovery_tds"),
	st_td: (r) => n(r, "special_teams_tds"),
	bonus_rec_rb: (r) => (r.position === "RB" ? n(r, "receptions") : 0),
	bonus_rec_wr: (r) => (r.position === "WR" ? n(r, "receptions") : 0),
	bonus_rec_te: (r) => (r.position === "TE" ? n(r, "receptions") : 0),
};

/** Sleeper scoring key -> expected value from an ffopportunity row. */
const EXPECTED: Record<string, (r: Row) => number> = {
	pass_yd: (r) => n(r, "pass_yards_gained_exp"),
	pass_td: (r) => n(r, "pass_touchdown_exp"),
	pass_int: (r) => n(r, "pass_interception_exp"),
	pass_2pt: (r) => n(r, "pass_two_point_conv_exp"),
	pass_fd: (r) => n(r, "pass_first_down_exp"),
	rush_yd: (r) => n(r, "rush_yards_gained_exp"),
	rush_td: (r) => n(r, "rush_touchdown_exp"),
	rush_2pt: (r) => n(r, "rush_two_point_conv_exp"),
	rush_fd: (r) => n(r, "rush_first_down_exp"),
	rec: (r) => n(r, "receptions_exp"),
	rec_yd: (r) => n(r, "rec_yards_gained_exp"),
	rec_td: (r) => n(r, "rec_touchdown_exp"),
	rec_2pt: (r) => n(r, "rec_two_point_conv_exp"),
	rec_fd: (r) => n(r, "rec_first_down_exp"),
	bonus_rec_rb: (r) => (r.position === "RB" ? n(r, "receptions_exp") : 0),
	bonus_rec_wr: (r) => (r.position === "WR" ? n(r, "receptions_exp") : 0),
	bonus_rec_te: (r) => (r.position === "TE" ? n(r, "receptions_exp") : 0),
};

function score(r: Row, scoring: Record<string, number>, map: Record<string, (r: Row) => number>): number {
	let pts = 0;
	for (const [k, mult] of Object.entries(scoring)) {
		if (!mult) continue;
		const f = map[k];
		if (f) pts += f(r) * mult;
	}
	return round(pts, 2);
}

export const leaguePoints = (r: Row, scoring: Record<string, number>) => score(r, scoring, ACTUAL);
export const expectedPoints = (r: Row, scoring: Record<string, number>) => score(r, scoring, EXPECTED);

const OFFENSE_KEY = /^(pass_|rush_|rec|bonus_(pass|rush|rec|fd)|fum$|fum_lost|fum_rec_td)/;

/** Offensive scoring rules in this league that nflverse data can't reproduce (e.g. yardage-bucket bonuses). */
export function unmappedRules(scoring: Record<string, number>): string[] {
	return Object.entries(scoring)
		.filter(([k, v]) => v && OFFENSE_KEY.test(k) && !ACTUAL[k])
		.map(([k]) => k)
		.sort();
}

// ---------------------------------------------------------------- queries

export class NflData {
	constructor(
		readonly db: D1Database,
		readonly season: number,
	) {}

	static from(env: Env, season: string): NflData {
		const db = (env as { NFL_DB?: D1Database }).NFL_DB;
		if (!db) throw new Error("The NFL data store (D1 binding NFL_DB) is not configured on this Worker.");
		return new NflData(db, Number(season));
	}

	private async all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
		try {
			return (await this.db.prepare(sql).bind(...params).all<T>()).results;
		} catch (e) {
			if (/no such table/i.test(String(e))) {
				throw new Error("nflverse data hasn't been loaded yet. It syncs hourly; try again after the next sync.");
			}
			throw e;
		}
	}

	/** Latest week with player stats this season (0 if none). */
	async latestWeek(): Promise<number> {
		const r = await this.all<{ w: number | null }>("SELECT MAX(week) AS w FROM nfl_player_week WHERE season = ?", this.season);
		return r[0]?.w ?? 0;
	}

	/** sleeper_id -> { gsis_id, pfr_id, fantasypros_id } */
	async ids(sleeperIds: string[]): Promise<Map<string, PlayerIds>> {
		const out = new Map<string, PlayerIds>();
		for (const part of chunks(sleeperIds)) {
			const rows = await this.all<PlayerIds & { sleeper_id: string }>(
				`SELECT sleeper_id, gsis_id, pfr_id, fantasypros_id FROM nfl_player_ids WHERE sleeper_id IN (${part.map(() => "?").join(",")})`,
				...part,
			);
			for (const r of rows) out.set(r.sleeper_id, { gsis_id: r.gsis_id, pfr_id: r.pfr_id, fantasypros_id: r.fantasypros_id });
		}
		return out;
	}

	/** Rows for many players over a week range (ids chunked to stay under D1's 100 bound parameters). */
	async forPlayers(table: string, idCol: "gsis_id" | "pfr_id", ids: string[], fromWeek: number, toWeek: number): Promise<Row[]> {
		const out: Row[] = [];
		for (const part of chunks([...new Set(ids)], 90)) {
			out.push(
				...(await this.all(
					`SELECT * FROM ${table} WHERE season = ? AND week BETWEEN ? AND ? AND ${idCol} IN (${part.map(() => "?").join(",")})`,
					this.season,
					fromWeek,
					toWeek,
					...part,
				)),
			);
		}
		return out;
	}

	/** FantasyPros consensus rows for these FantasyPros ids (all kept pages). */
	async ecr(fpIds: string[]): Promise<Row[]> {
		const out: Row[] = [];
		for (const part of chunks([...new Set(fpIds)])) {
			out.push(...(await this.all(`SELECT * FROM nfl_ecr WHERE fantasypros_id IN (${part.map(() => "?").join(",")})`, ...part)));
		}
		return out;
	}

	/** Vegas implied points per (Sleeper-style) team for a week. */
	async impliedTotals(week: number): Promise<Map<string, number>> {
		const out = new Map<string, number>();
		for (const g of await this.games(week)) {
			const spread = g.spread_line;
			const total = g.total_line;
			if (typeof spread !== "number" || typeof total !== "number") continue;
			out.set(sleeperTeam(g.home_team)!, round((total + spread) / 2, 1));
			out.set(sleeperTeam(g.away_team)!, round((total - spread) / 2, 1));
		}
		return out;
	}

	/** gsis_id -> sleeper_id and pfr_id -> sleeper_id for everyone mapped. */
	async idMaps(): Promise<{ bySleeper: Map<string, string>; byGsis: Map<string, string>; byPfr: Map<string, string> }> {
		const rows = await this.all<{ sleeper_id: string; gsis_id: string | null; pfr_id: string | null }>(
			"SELECT sleeper_id, gsis_id, pfr_id FROM nfl_player_ids",
		);
		const byGsis = new Map<string, string>();
		const byPfr = new Map<string, string>();
		const bySleeper = new Map<string, string>();
		for (const r of rows) {
			if (r.gsis_id) {
				byGsis.set(r.gsis_id, r.sleeper_id);
				bySleeper.set(r.sleeper_id, r.gsis_id);
			}
			if (r.pfr_id) byPfr.set(r.pfr_id, r.sleeper_id);
		}
		return { bySleeper, byGsis, byPfr };
	}

	weekRange(table: string, fromWeek: number, toWeek: number, extra = "", ...params: unknown[]): Promise<Row[]> {
		return this.all(`SELECT * FROM ${table} WHERE season = ? AND week BETWEEN ? AND ? ${extra}`, this.season, fromWeek, toWeek, ...params);
	}

	byPlayer(table: string, idCol: "gsis_id" | "pfr_id", id: string, fromWeek: number, toWeek: number): Promise<Row[]> {
		return this.all(
			`SELECT * FROM ${table} WHERE ${idCol} = ? AND season = ? AND week BETWEEN ? AND ? ORDER BY week`,
			id,
			this.season,
			fromWeek,
			toWeek,
		);
	}

	/** Week of the most recent published injury report (0 if none). */
	async latestInjuryWeek(): Promise<number> {
		const r = await this.all<{ w: number | null }>("SELECT MAX(week) AS w FROM nfl_injuries WHERE season = ?", this.season);
		return r[0]?.w ?? 0;
	}

	/**
	 * Current injury report rows: the latest week for teams that have published it,
	 * otherwise that team's previous week (teams report on different days).
	 */
	async currentInjuries(filter = "", ...params: unknown[]): Promise<{ week: number; rows: Row[] }> {
		const week = await this.latestInjuryWeek();
		if (!week) return { week: 0, rows: [] };
		const rows = await this.weekRange("nfl_injuries", Math.max(1, week - 1), week, filter, ...params);
		const published = new Set((await this.all<{ team: string }>("SELECT DISTINCT team FROM nfl_injuries WHERE season = ? AND week = ?", this.season, week)).map((r) => r.team));
		return { week, rows: rows.filter((r) => (published.has(String(r.team)) ? r.week === week : r.week === week - 1)) };
	}

	latestInjury(gsisIds: string[]): Promise<Row[]> {
		if (!gsisIds.length) return Promise.resolve([]);
		return this.all(
			`SELECT i.* FROM nfl_injuries i
			 JOIN (SELECT gsis_id, MAX(week) AS w FROM nfl_injuries WHERE season = ? AND gsis_id IN (${gsisIds.map(() => "?").join(",")}) GROUP BY gsis_id) m
			   ON i.gsis_id = m.gsis_id AND i.week = m.w
			 WHERE i.season = ?`,
			this.season,
			...gsisIds,
			this.season,
		);
	}

	games(week: number): Promise<Row[]> {
		return this.all("SELECT * FROM nfl_games WHERE season = ? AND week = ? ORDER BY gameday, gametime, game_id", this.season, week);
	}

	async status(): Promise<Row[]> {
		return this.all("SELECT dataset, season, checked_at, changed_at, rows, note FROM nfl_sync ORDER BY dataset");
	}
}

export interface PlayerIds {
	gsis_id: string | null;
	pfr_id: string | null;
	fantasypros_id: string | null;
}

function chunks<T>(xs: T[], size = 90): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
	return out;
}

/** nflverse uses "LA" for the Rams; Sleeper uses "LAR". */
export function sleeperTeam(abbr: unknown): string | null {
	if (typeof abbr !== "string" || !abbr) return null;
	return abbr === "LA" ? "LAR" : abbr;
}
