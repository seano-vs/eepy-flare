// nflverse datasets mirrored into D1. Each one is a CSV published on GitHub
// (the same files nflreadpy/nflreadr download), reduced to the columns that
// matter for fantasy and to fantasy positions.
//
// Update cadence upstream (https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html):
// player stats nightly after game days, snap counts 4x/day, injuries daily
// 07:00 UTC, schedules every 5 min. The hourly sync only downloads files whose
// ETag changed, so checking often is cheap.

export type ColumnType = "INTEGER" | "REAL" | "TEXT";

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
			text("name"),
			text("position"),
			text("team"),
			int("bucket"),
		],
		primaryKey: ["sleeper_id"],
		chunkBy: ["bucket"],
		indexes: [["gsis_id"], ["pfr_id"]],
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
];

export function dataset(id: string): Dataset {
	const d = DATASETS.find((x) => x.id === id);
	if (!d) throw new Error(`unknown dataset ${id}`);
	return d;
}
