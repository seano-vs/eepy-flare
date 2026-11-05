// nflverse datasets mirrored into D1. Each one is a CSV published on GitHub
// (the same files nflreadpy/nflreadr download), reduced to the columns that
// matter for fantasy and to fantasy positions.
//
// Update cadence upstream (https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html):
// player stats nightly after game days, snap counts 4x/day, injuries daily
// 07:00 UTC, schedules every 5 min. The hourly sync only downloads files whose
// ETag changed, so checking often is cheap.

export type ColumnType = "INTEGER" | "REAL" | "TEXT";
export type Cell = string | number | null;

export interface ColumnSpec {
	name: string;
	type: ColumnType;
	/** Source CSV column, when it differs from `name`. */
	from?: string;
}

type Getter = (column: string) => string;

export interface Dataset {
	id: string;
	table: string;
	/** Per-season files are fetched for the current season only. */
	perSeason: boolean;
	url(season: string): string;
	gzip: boolean;
	columns: ColumnSpec[];
	primaryKey: string[];
	/** Rows are hashed and rewritten per chunk (usually a week), so unchanged weeks cost no writes. */
	chunkBy: string[];
	indexes?: string[][];
	keep?(get: Getter, season: string): boolean;
	/** Extra source columns read by keep()/computed() that aren't stored. */
	reads?: string[];
	/** Cheap early rejection on one source column (keep() still runs on what passes). */
	prefilter?: (season: string) => { column: string; accept: (value: string) => boolean };
	computed?: Record<string, (get: Getter) => string | number | null>;
	/** Source file format (default csv). Parquet is read column-by-column with hyparquet. */
	format?: "csv" | "parquet";
	/**
	 * Derived datasets: read these source columns as records and build the stored rows
	 * (in `columns` order) from all of them at once, e.g. aggregate plays into player-weeks.
	 */
	derive?: { columns: string[]; build(records: Record<string, unknown>[], season: string): Cell[][] };
}

const NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download";
const SKILL = new Set(["QB", "RB", "WR", "TE"]);
const skill = (get: Getter) => SKILL.has(get("position"));
const skillPrefilter = () => ({ column: "position", accept: (v: string) => SKILL.has(v) });

const int = (name: string, from?: string): ColumnSpec => ({ name, type: "INTEGER", ...(from ? { from } : {}) });
const real = (name: string, from?: string): ColumnSpec => ({ name, type: "REAL", ...(from ? { from } : {}) });
const text = (name: string, from?: string): ColumnSpec => ({ name, type: "TEXT", ...(from ? { from } : {}) });

/** Stable small hash used to spread the ID map over chunks. */
export function bucketOf(s: string, buckets = 32): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
	return h % buckets;
}

export const DATASETS: Dataset[] = [
	{
		// DynastyProcess ID map: links Sleeper ids to nflverse gsis ids and PFR ids (snap counts).
		id: "player_ids",
		table: "nfl_player_ids",
		perSeason: false,
		url: () => "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv",
		gzip: false,
		columns: [
			text("sleeper_id"),
			text("gsis_id"),
			text("pfr_id"),
			text("fantasypros_id"),
			text("name"),
			text("position"),
			text("team"),
			int("bucket"),
		],
		primaryKey: ["sleeper_id"],
		chunkBy: ["bucket"],
		indexes: [["gsis_id"], ["pfr_id"], ["fantasypros_id"]],
		keep: (get) => /^\d+$/.test(get("sleeper_id")) && (SKILL.has(get("position")) || get("position") === "PK"),
		prefilter: () => ({ column: "position", accept: (v) => SKILL.has(v) || v === "PK" }),
		computed: { bucket: (get) => bucketOf(get("sleeper_id")) },
	},
	{
		id: "player_week",
		table: "nfl_player_week",
		perSeason: true,
		url: (s) => `${NFLVERSE}/stats_player/stats_player_week_${s}.csv.gz`,
		gzip: true,
		columns: [
			int("season"),
			int("week"),
			text("season_type"),
			text("gsis_id", "player_id"),
			text("name", "player_display_name"),
			text("position"),
			text("team"),
			text("opp", "opponent_team"),
			real("completions"),
			real("attempts"),
			real("passing_yards"),
			real("passing_tds"),
			real("passing_interceptions"),
			real("sacks_suffered"),
			real("sack_fumbles_lost"),
			real("passing_air_yards"),
			real("passing_first_downs"),
			real("passing_epa"),
			real("passing_cpoe"),
			real("passing_2pt_conversions"),
			real("carries"),
			real("rushing_yards"),
			real("rushing_tds"),
			real("rushing_fumbles_lost"),
			real("rushing_first_downs"),
			real("rushing_epa"),
			real("rushing_2pt_conversions"),
			real("receptions"),
			real("targets"),
			real("receiving_yards"),
			real("receiving_tds"),
			real("receiving_fumbles_lost"),
			real("receiving_air_yards"),
			real("receiving_yards_after_catch"),
			real("receiving_first_downs"),
			real("receiving_epa"),
			real("receiving_2pt_conversions"),
			real("target_share"),
			real("air_yards_share"),
			real("wopr"),
			real("racr"),
			real("special_teams_tds"),
			real("fumble_recovery_tds"),
		],
		primaryKey: ["season", "week", "gsis_id"],
		chunkBy: ["season", "week"],
		indexes: [["gsis_id", "season", "week"]],
		keep: skill,
		prefilter: skillPrefilter,
	},
	{
		id: "snaps",
		table: "nfl_snaps",
		perSeason: true,
		url: (s) => `${NFLVERSE}/snap_counts/snap_counts_${s}.csv.gz`,
		gzip: true,
		columns: [
			int("season"),
			int("week"),
			text("game_type"),
			text("pfr_id", "pfr_player_id"),
			text("name", "player"),
			text("position"),
			text("team"),
			text("opp", "opponent"),
			real("offense_snaps"),
			real("offense_pct"),
			real("st_snaps"),
			real("st_pct"),
		],
		primaryKey: ["season", "week", "pfr_id"],
		chunkBy: ["season", "week"],
		indexes: [["pfr_id", "season", "week"]],
		keep: skill,
		prefilter: skillPrefilter,
	},
	{
		id: "injuries",
		table: "nfl_injuries",
		perSeason: true,
		url: (s) => `${NFLVERSE}/injuries/injuries_${s}.csv.gz`,
		gzip: true,
		columns: [
			int("season"),
			int("week"),
			text("game_type"),
			text("gsis_id"),
			text("name", "full_name"),
			text("position"),
			text("team"),
			text("report_injury", "report_primary_injury"),
			text("report_status"),
			text("practice_injury", "practice_primary_injury"),
			text("practice_status"),
		],
		primaryKey: ["season", "week", "gsis_id"],
		chunkBy: ["season", "week"],
		indexes: [["gsis_id", "season", "week"]],
		keep: skill,
		prefilter: skillPrefilter,
	},
	{
		// ffopportunity: expected (and actual) fantasy production per player-week.
		id: "opportunity",
		table: "nfl_opportunity",
		perSeason: true,
		url: (s) => `https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_${s}.csv`,
		gzip: false,
		columns: [
			int("season"),
			int("week"),
			text("gsis_id", "player_id"),
			text("name", "full_name"),
			text("position"),
			text("team", "posteam"),
			real("pass_attempt"),
			real("rec_attempt"),
			real("rush_attempt"),
			real("pass_air_yards"),
			real("rec_air_yards"),
			real("receptions_exp"),
			real("pass_yards_gained_exp"),
			real("rec_yards_gained_exp"),
			real("rush_yards_gained_exp"),
			real("pass_touchdown_exp"),
			real("rec_touchdown_exp"),
			real("rush_touchdown_exp"),
			real("pass_two_point_conv_exp"),
			real("rec_two_point_conv_exp"),
			real("rush_two_point_conv_exp"),
			real("pass_first_down_exp"),
			real("rec_first_down_exp"),
			real("rush_first_down_exp"),
			real("pass_interception_exp"),
			real("total_fantasy_points"),
			real("total_fantasy_points_exp"),
		],
		primaryKey: ["season", "week", "gsis_id"],
		chunkBy: ["season", "week"],
		indexes: [["gsis_id", "season", "week"]],
		keep: skill,
		prefilter: skillPrefilter,
	},
	{
		// One file with every season; we keep the current one. Lines are the closing (or latest) Vegas lines.
		id: "games",
		table: "nfl_games",
		perSeason: true,
		url: () => `${NFLVERSE}/schedules/games.csv.gz`,
		gzip: true,
		columns: [
			text("game_id"),
			int("season"),
			int("week"),
			text("game_type"),
			text("gameday"),
			text("weekday"),
			text("gametime"),
			text("away_team"),
			text("home_team"),
			real("away_score"),
			real("home_score"),
			real("spread_line"),
			real("total_line"),
			real("away_moneyline"),
			real("home_moneyline"),
			text("roof"),
			real("temp"),
			real("wind"),
		],
		primaryKey: ["game_id"],
		chunkBy: ["season", "week"],
		indexes: [["season", "week"]],
		keep: (get, season) => get("season") === season,
		prefilter: (season) => ({ column: "season", accept: (v) => v === season }),
	},
	{
		// Derived from play-by-play (Parquet, ~9 MB a season): red-zone / goal-line / deep usage per player-week.
		id: "pbp_usage",
		table: "nfl_pbp_week",
		perSeason: true,
		url: (s) => `${NFLVERSE}/pbp/play_by_play_${s}.parquet`,
		gzip: false,
		format: "parquet",
		columns: [
			int("season"),
			int("week"),
			text("gsis_id"),
			text("team"),
			real("rz_targets"),
			real("rz_target_share"),
			real("ez_targets"),
			real("deep_targets"),
			real("rz_carries"),
			real("rz_carry_share"),
			real("i10_carries"),
			real("i5_carries"),
			real("rz_pass_att"),
		],
		primaryKey: ["season", "week", "gsis_id"],
		chunkBy: ["season", "week"],
		indexes: [["gsis_id", "season", "week"]],
		derive: {
			columns: ["season", "week", "posteam", "play_type", "yardline_100", "air_yards", "receiver_player_id", "rusher_player_id", "passer_player_id", "two_point_attempt"],
			build: (plays) => aggregatePbp(plays),
		},
	},
	{
		// Next Gen Stats, all seasons in one file; weekly rows only (week 0 is the season total).
		id: "ngs_receiving",
		table: "nfl_ngs_receiving",
		perSeason: true,
		url: () => `${NFLVERSE}/nextgen_stats/ngs_receiving.csv.gz`,
		gzip: true,
		columns: [
			int("season"),
			int("week"),
			text("gsis_id", "player_gsis_id"),
			text("position", "player_position"),
			text("team", "team_abbr"),
			real("avg_cushion"),
			real("avg_separation"),
			real("avg_intended_air_yards"),
			real("share_of_intended_air_yards", "percent_share_of_intended_air_yards"),
			real("catch_percentage"),
			real("avg_yac_above_expectation"),
		],
		primaryKey: ["season", "week", "gsis_id"],
		chunkBy: ["season", "week"],
		indexes: [["gsis_id", "season", "week"]],
		keep: (get, season) => get("season") === season && get("week") !== "0",
		prefilter: (season) => ({ column: "season", accept: (v) => v === season }),
	},
	{
		id: "ngs_rushing",
		table: "nfl_ngs_rushing",
		perSeason: true,
		url: () => `${NFLVERSE}/nextgen_stats/ngs_rushing.csv.gz`,
		gzip: true,
		columns: [
			int("season"),
			int("week"),
			text("gsis_id", "player_gsis_id"),
			text("position", "player_position"),
			text("team", "team_abbr"),
			real("efficiency"),
			real("eight_box_pct", "percent_attempts_gte_eight_defenders"),
			real("avg_time_to_los"),
			real("ryoe_per_att", "rush_yards_over_expected_per_att"),
			real("rush_pct_over_expected"),
		],
		primaryKey: ["season", "week", "gsis_id"],
		chunkBy: ["season", "week"],
		indexes: [["gsis_id", "season", "week"]],
		keep: (get, season) => get("season") === season && get("week") !== "0",
		prefilter: (season) => ({ column: "season", accept: (v) => v === season }),
	},
	{
		id: "ngs_passing",
		table: "nfl_ngs_passing",
		perSeason: true,
		url: () => `${NFLVERSE}/nextgen_stats/ngs_passing.csv.gz`,
		gzip: true,
		columns: [
			int("season"),
			int("week"),
			text("gsis_id", "player_gsis_id"),
			text("position", "player_position"),
			text("team", "team_abbr"),
			real("avg_time_to_throw"),
			real("aggressiveness"),
			real("avg_intended_air_yards"),
			real("avg_air_yards_to_sticks"),
			real("cpoe", "completion_percentage_above_expectation"),
			real("passer_rating"),
		],
		primaryKey: ["season", "week", "gsis_id"],
		chunkBy: ["season", "week"],
		indexes: [["gsis_id", "season", "week"]],
		keep: (get, season) => get("season") === season && get("week") !== "0",
		prefilter: (season) => ({ column: "season", accept: (v) => v === season }),
	},
	{
		// FantasyPros expert consensus rankings via DynastyProcess (refreshed weekly upstream).
		id: "ecr",
		table: "nfl_ecr",
		perSeason: false,
		url: () => "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_fpecr_latest.csv",
		gzip: false,
		columns: [
			text("fantasypros_id"),
			text("page"),
			text("name"),
			text("position"),
			text("team"),
			int("rank"),
			real("ecr"),
			real("sd"),
			real("best"),
			real("worst"),
			text("scrape_date"),
		],
		primaryKey: ["page", "fantasypros_id"],
		chunkBy: ["page"],
		indexes: [["fantasypros_id"]],
		derive: {
			columns: ["page_type", "id", "player", "pos", "team", "ecr", "sd", "best", "worst", "scrape_date"],
			build: (records) => rankEcr(records),
		},
	},
];

// ---------------------------------------------------------------- derived: play-by-play

const RZ = 20;

/** Per player-week red-zone, goal-line, end-zone and deep usage from play-by-play (exported for tests). */
export function aggregatePbp(plays: Record<string, unknown>[]): Cell[][] {
	type Acc = { season: number; week: number; team: string; rz_tgt: number; ez_tgt: number; deep_tgt: number; rz_car: number; i10_car: number; i5_car: number; rz_att: number };
	const players = new Map<string, Acc>();
	const team = new Map<string, { rz_tgt: number; rz_car: number }>();
	const acc = (id: string, p: Record<string, unknown>): Acc => {
		const key = `${p.season}|${p.week}|${id}`;
		let a = players.get(key);
		if (!a) {
			a = { season: Number(p.season), week: Number(p.week), team: String(p.posteam ?? ""), rz_tgt: 0, ez_tgt: 0, deep_tgt: 0, rz_car: 0, i10_car: 0, i5_car: 0, rz_att: 0 };
			players.set(key, a);
		}
		return a;
	};
	for (const p of plays) {
		if (p.two_point_attempt === 1 || p.two_point_attempt === true) continue;
		const yl = typeof p.yardline_100 === "number" ? p.yardline_100 : null;
		if (yl == null || !p.posteam) continue;
		const tk = `${p.season}|${p.week}|${p.posteam}`;
		let t = team.get(tk);
		if (!t) team.set(tk, (t = { rz_tgt: 0, rz_car: 0 }));
		if (p.play_type === "pass" && typeof p.air_yards === "number") {
			if (typeof p.passer_player_id === "string" && yl <= RZ) acc(p.passer_player_id, p).rz_att++;
			if (typeof p.receiver_player_id === "string") {
				const a = acc(p.receiver_player_id, p);
				if (yl <= RZ) {
					a.rz_tgt++;
					t.rz_tgt++;
				}
				if (p.air_yards >= yl) a.ez_tgt++;
				if (p.air_yards >= 20) a.deep_tgt++;
			}
		} else if (p.play_type === "run" && typeof p.rusher_player_id === "string") {
			const a = acc(p.rusher_player_id, p);
			if (yl <= RZ) {
				a.rz_car++;
				t.rz_car++;
			}
			if (yl <= 10) a.i10_car++;
			if (yl <= 5) a.i5_car++;
		}
	}
	const share = (x: number, of: number) => (of ? Math.round((x / of) * 10000) / 10000 : null);
	const out: Cell[][] = [];
	for (const [key, a] of players) {
		const t = team.get(`${a.season}|${a.week}|${a.team}`) ?? { rz_tgt: 0, rz_car: 0 };
		const id = key.split("|")[2]!;
		out.push([a.season, a.week, id, a.team, a.rz_tgt, share(a.rz_tgt, t.rz_tgt), a.ez_tgt, a.deep_tgt, a.rz_car, share(a.rz_car, t.rz_car), a.i10_car, a.i5_car, a.rz_att]);
	}
	return out;
}

// ---------------------------------------------------------------- derived: FantasyPros ECR

/** FantasyPros pages kept: superflex weekly/dynasty overall, weekly and rest-of-season by position. */
export const ECR_PAGES = new Set([
	"weekly-op",
	"dynasty-op",
	...["qb", "rb", "wr", "te"].flatMap((p) => [`weekly-${p}`, `redraft-${p}`]),
]);

/** Rank each page by consensus (ECR is an average rank, so ties are broken by order). */
export function rankEcr(records: Record<string, unknown>[]): Cell[][] {
	const byPage = new Map<string, Record<string, unknown>[]>();
	for (const r of records) {
		const page = String(r.page_type);
		if (!ECR_PAGES.has(page) || !/^\d+$/.test(String(r.id))) continue;
		const ecr = Number(r.ecr);
		if (!Number.isFinite(ecr)) continue;
		const list = byPage.get(page) ?? [];
		list.push(r);
		byPage.set(page, list);
	}
	const num = (v: unknown) => {
		const x = Number(v);
		return Number.isFinite(x) ? x : null;
	};
	const out: Cell[][] = [];
	for (const [page, list] of byPage) {
		list.sort((a, b) => Number(a.ecr) - Number(b.ecr));
		list.forEach((r, i) => {
			out.push([String(r.id), page, String(r.player), String(r.pos), r.team ? String(r.team) : null, i + 1, num(r.ecr), num(r.sd), num(r.best), num(r.worst), String(r.scrape_date ?? "")]);
		});
	}
	return out;
}

export function dataset(id: string): Dataset {
	const d = DATASETS.find((x) => x.id === id);
	if (!d) throw new Error(`unknown dataset ${id}`);
	return d;
}
