// Injury history in D1: one season of episodes, listings and snap norms per hourly cron run,
// oldest first from 2013, then the current season every 6 hours. Each season is replaced in one
// transaction, so a failed run leaves the old rows. 2013 is the first season nflverse has snap
// counts for (snap_counts_2012 is an empty stub in both .csv and .csv.gz), and through 2022 the
// injury files exist only as plain .csv, so downloads fall back from .csv.gz to .csv.

import { parquetReadObjects } from "hyparquet";
import { parseCsvColumns } from "../nflverse/csv";
import { buildSeason, seasonNorms, type SeasonRaw } from "./build";
import { listingOutcomes, stitchEpisodes, type Episode, type ListingOutcome } from "./episodes";

const NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download";
export const FIRST_SEASON = 2013;
/** Bump when the injury tables or the episode logic change: tables are dropped and the backfill restarts. */
export const INJURY_SCHEMA_VERSION = "2";
/** A season's files must have at least this many rows, or the run fails instead of storing gaps. */
const MIN_ROWS = { injuries: 1000, snaps: 5000, stats: 3000, rosters: 5000 };
const CURRENT_REFRESH_MS = 6 * 3_600_000;

export const INJURY_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS nfl_injury_episodes (id TEXT PRIMARY KEY, gsis_id TEXT, name TEXT, season INTEGER, position TEXT, team TEXT, kind TEXT, body TEXT,
	  start_week INTEGER, start_date TEXT, in_game INTEGER, games_missed INTEGER, return_week INTEGER, censored INTEGER,
	  ongoing INTEGER, pre_snap_pct REAL, return_snap_pct REAL, return2_snap_pct REAL, first_status TEXT, first_practice TEXT, recurred INTEGER)`,
	"CREATE INDEX IF NOT EXISTS nfl_injury_episodes_player ON nfl_injury_episodes (gsis_id)",
	"CREATE INDEX IF NOT EXISTS nfl_injury_episodes_body ON nfl_injury_episodes (body, position)",
	`CREATE TABLE IF NOT EXISTS nfl_injury_listings (season INTEGER, gsis_id TEXT, week INTEGER, position TEXT, body TEXT, status TEXT, practice TEXT, played INTEGER,
	  PRIMARY KEY (season, gsis_id, week))`,
	"CREATE INDEX IF NOT EXISTS nfl_injury_listings_body ON nfl_injury_listings (body, position)",
	"CREATE TABLE IF NOT EXISTS nfl_injury_norms (season INTEGER, gsis_id TEXT, norm REAL, PRIMARY KEY (season, gsis_id))",
	"CREATE TABLE IF NOT EXISTS nfl_meta (key TEXT PRIMARY KEY, value TEXT)",
];

const COLS = {
	injuries: ["season", "game_type", "team", "week", "gsis_id", "position", "full_name", "report_primary_injury", "report_status", "practice_primary_injury", "practice_status", "date_modified"],
	snaps: ["game_type", "week", "pfr_player_id", "player", "team", "offense_snaps", "offense_pct"],
	stats: ["player_id", "week", "season_type", "position", "player_display_name"],
	rosters: ["gsis_id", "pfr_id", "week", "game_type", "team", "status_description_abbr", "position", "depth_chart_position", "full_name"],
};

async function fetchOk(url: string): Promise<Response | null> {
	for (let i = 0; i < 2; i++) {
		const res = await fetch(url).catch(() => null);
		if (res?.ok) return res;
		if (res && res.status === 404) return null;
		await new Promise((r) => setTimeout(r, 1500));
	}
	throw new Error(`injury history: download failed for ${new URL(url).pathname}`);
}

/** CSV rows as objects with only `cols`; tries .csv.gz then .csv (2012's injury file is plain). */
async function csvRows(path: string, cols: string[]): Promise<Record<string, string>[]> {
	try {
		return await csvRowsInner(path, cols);
	} catch (e) {
		throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

async function csvRowsInner(path: string, cols: string[]): Promise<Record<string, string>[]> {
	const gz = await fetchOk(`${NFLVERSE}/${path}.csv.gz`);
	let text: string | null = null;
	if (gz?.body) {
		// Some .csv.gz uploads are truncated stubs: fall back to the plain file.
		text = await new Response(gz.body.pipeThrough(new DecompressionStream("gzip"))).text().catch(() => null);
	}
	if (text == null) {
		const res = await fetchOk(`${NFLVERSE}/${path}.csv`);
		if (!res) throw new Error("not published");
		text = await res.text();
	}
	const { rows } = parseCsvColumns(text, cols);
	return rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""])));
}

async function rosterRows(season: number): Promise<Record<string, unknown>[]> {
	const res = await fetchOk(`${NFLVERSE}/weekly_rosters/roster_weekly_${season}.parquet`);
	if (!res) throw new Error(`injury history: rosters ${season} not published`);
	const rows = (await parquetReadObjects({ file: await res.arrayBuffer(), columns: COLS.rosters })) as Record<string, unknown>[];
	for (const r of rows) for (const k of COLS.rosters) if (typeof r[k] === "bigint") r[k] = Number(r[k]);
	return rows;
}

export async function loadSeasonRaw(season: number): Promise<SeasonRaw> {
	const [injuries, snaps, stats, rosters] = await Promise.all([
		csvRows(`injuries/injuries_${season}`, COLS.injuries),
		csvRows(`snap_counts/snap_counts_${season}`, COLS.snaps),
		csvRows(`stats_player/stats_player_week_${season}`, COLS.stats),
		rosterRows(season),
	]);
	const raw = { injuries, snaps, stats, rosters };
	for (const [k, min] of Object.entries(MIN_ROWS)) {
		const n = raw[k as keyof SeasonRaw].length;
		if (n < min) throw new Error(`injury history ${season}: only ${n} ${k} rows (expected ${min}+)`);
	}
	return raw;
}

// ---------------------------------------------------------------- writing

function lit(v: unknown): string {
	if (v == null) return "NULL";
	if (typeof v === "boolean") return v ? "1" : "0";
	if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
	return `'${String(v).replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

/** Multi-row INSERTs under ~90 KB each. */
export function inserts(table: string, cols: string[], rows: unknown[][]): string[] {
	const head = `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES `;
	const out: string[] = [];
	let cur: string[] = [];
	let bytes = head.length;
	for (const r of rows) {
		const t = `(${r.map(lit).join(",")})`;
		if (cur.length && bytes + t.length > 90_000) (out.push(head + cur.join(",")), (cur = []), (bytes = head.length));
		cur.push(t);
		bytes += t.length + 1;
	}
	if (cur.length) out.push(head + cur.join(","));
	return out;
}

const EP_COLS = ["id", "gsis_id", "name", "season", "position", "team", "kind", "body", "start_week", "start_date", "in_game", "games_missed", "return_week", "censored", "ongoing", "pre_snap_pct", "return_snap_pct", "return2_snap_pct", "first_status", "first_practice", "recurred"];

export function seasonStatements(season: number, eps: Episode[], listings: ListingOutcome[], norms: Map<string, number>): string[] {
	return [
		`DELETE FROM nfl_injury_episodes WHERE season = ${season}`,
		`DELETE FROM nfl_injury_listings WHERE season = ${season}`,
		`DELETE FROM nfl_injury_norms WHERE season = ${season}`,
		...inserts("nfl_injury_episodes", EP_COLS, eps.map((e) => [e.id, e.id.split(":")[0], e.name, e.season, e.position, e.team, e.kind, e.body, e.start_week, e.start_date, e.in_game, e.games_missed, e.return_week, e.censored, e.ongoing, e.pre_snap_pct, e.return_snap_pct, e.return2_snap_pct, e.first_status, e.first_practice, e.recurred])),
		...inserts("nfl_injury_listings", ["season", "gsis_id", "week", "position", "body", "status", "practice", "played"], listings.map((l) => [l.season, l.id, l.week, l.position, l.body, l.status, l.practice, l.played])),
		...inserts("nfl_injury_norms", ["season", "gsis_id", "norm"], [...norms].map(([id, n]) => [season, id, n])),
		`INSERT OR REPLACE INTO nfl_meta (key, value) VALUES ('injury_hist:${season}', '${new Date().toISOString()}')`,
	];
}

/** Which season to process this run: the oldest missing historical season, else the current one if stale. Pure. */
export function nextSeason(done: Map<number, string>, current: number, now = Date.now()): number | null {
	for (let s = FIRST_SEASON; s < current; s++) if (!done.has(s)) return s;
	const at = done.get(current);
	return !at || now - Date.parse(at) > CURRENT_REFRESH_MS ? current : null;
}

/** One cron step. Returns what it did, or null when everything is current. */
export async function syncInjuryHistory(db: D1Database, currentSeason: number, opts: { season?: number } = {}): Promise<{ season: number; episodes: number; listings: number } | null> {
	await db.prepare("CREATE TABLE IF NOT EXISTS nfl_meta (key TEXT PRIMARY KEY, value TEXT)").run();
	const ver = await db.prepare("SELECT value FROM nfl_meta WHERE key = 'injury_schema'").first<string>("value");
	if (ver !== INJURY_SCHEMA_VERSION) {
		await db.batch([
			db.prepare("DROP TABLE IF EXISTS nfl_injury_episodes"),
			db.prepare("DROP TABLE IF EXISTS nfl_injury_listings"),
			db.prepare("DROP TABLE IF EXISTS nfl_injury_norms"),
			db.prepare("DELETE FROM nfl_meta WHERE key LIKE 'injury_hist:%'"),
			db.prepare(`INSERT OR REPLACE INTO nfl_meta (key, value) VALUES ('injury_schema', '${INJURY_SCHEMA_VERSION}')`),
		]);
	}
	await db.batch(INJURY_SCHEMA.map((s) => db.prepare(s)));
	const meta = await db.prepare("SELECT key, value FROM nfl_meta WHERE key LIKE 'injury_hist:%'").all<{ key: string; value: string }>();
	const done = new Map(meta.results.map((r) => [Number(r.key.split(":")[1]), r.value]));
	const season = opts.season ?? nextSeason(done, currentSeason);
	if (season == null) return null;
	const priorRows = await db.prepare("SELECT gsis_id, norm FROM nfl_injury_norms WHERE season = ?").bind(season - 1).all<{ gsis_id: string; norm: number }>();
	const prior = new Map(priorRows.results.map((r) => [r.gsis_id, r.norm]));
	const players = buildSeason(season, await loadSeasonRaw(season), prior, season < currentSeason);
	const eps = players.flatMap(stitchEpisodes);
	const listings = players.flatMap(listingOutcomes);
	const stmts = seasonStatements(season, eps, listings, seasonNorms(players));
	// One transaction when it fits; otherwise deletes first, then inserts, meta last.
	if (stmts.length <= 50) await db.batch(stmts.map((s) => db.prepare(s)));
	else for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50).map((s) => db.prepare(s)));
	return { season, episodes: eps.length, listings: listings.length };
}
