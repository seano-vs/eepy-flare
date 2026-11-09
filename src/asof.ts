// Freshness stamps. Every source the tools read has its own lag: a daily players cache, 30-minute
// projections, an nflverse mirror that picks up team injury reports hours after they post, Vegas
// lines that move all week, a FantasyPros scrape that can stall. Each response carries an `as_of`
// block naming when each source it used was last updated, in Eastern time, with a stale marker
// past a per-source limit, so the reader can weigh old data instead of treating it as current.

import { adpFetchedAt } from "./dynasty";
import type { LeagueContext } from "./league";
import { NflData, sleeperTeam } from "./nflverse/stats";
import { poolFetchedAt } from "./scoring";
import { eastern } from "./waivers";

export type Source = "injury_history" | "injury_tags" | "projections" | "injury_report" | "lines" | "rankings" | "adp" | "stats" | "usage" | "news" | "weather" | "transactions";

/** Hours after which a source counts as stale. */
const STALE_HOURS: Partial<Record<Source, number>> = {
	injury_tags: 30,
	projections: 3,
	lines: 48,
	rankings: 7 * 24,
	adp: 24,
	weather: 3,
};

/** Hours or days since `ms`, e.g. "3h ago", "2d ago". */
export function ago(ms: number, now = Date.now()): string {
	const h = Math.max(0, (now - ms) / 3_600_000);
	if (h < 1) return `${Math.max(0, Math.round(h * 60))}m ago`;
	if (h < 48) return `${Math.round(h)}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

/** "Thu, Nov 5, 9:23 AM ET (3h ago)", plus " - stale" past the limit. Pure; exported for tests. */
export function stamp(at: string | number | null | undefined, now = Date.now(), staleAfterHours?: number): string | null {
	if (at == null || at === "") return null;
	const ms = typeof at === "number" ? at : Date.parse(at);
	if (!Number.isFinite(ms)) return null;
	const stale = staleAfterHours != null && now - ms > staleAfterHours * 3_600_000;
	return `${eastern(ms)} (${ago(ms, now)})${stale ? " - stale" : ""}`;
}

/** Date-only stamp, for sources that only carry a date (FantasyPros scrape date). */
function dateStamp(day: string, now: number, staleAfterHours?: number): string {
	const ms = Date.parse(`${day}T12:00:00Z`);
	const days = Math.floor((now - ms) / 86_400_000);
	const stale = staleAfterHours != null && now - ms > staleAfterHours * 3_600_000;
	return `${day} scrape (${days}d old)${stale ? " - stale" : ""}`;
}

// ---------------------------------------------------------------- injury report log

export interface ReportSeen {
	/** When the mirror first had this team's report for the week (the injuries file change that brought it). */
	first_seen: string;
	/** True when tracking began after the report was already there: first_seen is then an upper bound. */
	by?: boolean;
	/** When this team's rows for the week last changed in the mirror. */
	changed_at: string;
	hash: string;
}

const REPORT_KEY = (season: string) => `reports:${season}`;

function fnv(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16);
}

/**
 * Hourly (after the nflverse sync): note when each team's report for the current and previous
 * week first appeared in the mirror and when it last changed. nflverse's file has no per-row
 * time, so this is the best available "as of" for an injury report.
 */
export async function recordReports(lc: LeagueContext): Promise<void> {
	const nfl = NflData.from(lc.env, lc.season);
	const cur = await nfl.currentInjuries();
	if (!cur.week) return;
	const rows = await nfl.weekRange("nfl_injuries", Math.max(1, cur.week - 1), cur.week);
	const byTeamWeek = new Map<string, string[]>();
	for (const r of rows) {
		const k = `${sleeperTeam(r.team)}:${r.week}`;
		byTeamWeek.set(k, [...(byTeamWeek.get(k) ?? []), `${r.gsis_id}|${r.report_status ?? ""}|${r.practice_status ?? ""}|${r.report_primary_injury ?? ""}`]);
	}
	const stored = await lc.env.PLAYERS.get<Record<string, ReportSeen>>(REPORT_KEY(lc.season), "json");
	const prev = stored ?? {};
	// The injuries file's last change is when any new or changed team report reached the mirror.
	const sync = (await nfl.status().catch(() => [])).find((r) => r.dataset === "injuries" && String(r.season) === lc.season);
	const now = typeof sync?.changed_at === "string" ? sync.changed_at : new Date().toISOString();
	const next: Record<string, ReportSeen> = {};
	for (const [k, lines] of byTeamWeek) {
		const hash = fnv(lines.sort().join("\n"));
		const p = prev[k];
		next[k] = p
			? { first_seen: p.first_seen, changed_at: p.hash === hash ? p.changed_at : now, hash, ...(p.by ? { by: true } : {}) }
			: { first_seen: now, changed_at: now, hash, ...(stored ? {} : { by: true }) };
	}
	await lc.env.PLAYERS.put(REPORT_KEY(lc.season), JSON.stringify(next), { expirationTtl: 14 * 86_400 });
}

// ---------------------------------------------------------------- the block

export interface AsOfOptions {
	/** NFL teams in the response, for per-team injury report times. */
	teams?: Iterable<string | null | undefined>;
	/** When the weather in the response was fetched (ms). */
	weatherAt?: number | null;
}

/** The `as_of` block for a response that used these sources. Never throws. */
export async function asOf(lc: LeagueContext, sources: Source[], opts: AsOfOptions = {}): Promise<Record<string, unknown>> {
	const now = Date.now();
	const want = new Set(sources);
	const out: Record<string, unknown> = { now: eastern(now) };
	try {
		if (want.has("injury_tags")) out.injury_tags = `Sleeper players cache, ${stamp(lc.players.updated, now, STALE_HOURS.injury_tags)}; refreshed once a day, so tags can trail news`;
		if (want.has("projections")) {
			const p = poolFetchedAt.get(`${lc.season}:${lc.week}`);
			out.projections = p ? `Sleeper, fetched ${stamp(p, now, STALE_HOURS.projections)}` : "Sleeper, fetched just now";
		}
		if (want.has("adp") && adpFetchedAt) out.dynasty_adp = `Sleeper ADP, fetched ${stamp(adpFetchedAt, now, STALE_HOURS.adp)}`;
		if (want.has("news")) out.news = `Sleeper's feed, read just now; each item shows its own publish time`;
		if (want.has("transactions")) out.transactions = "Sleeper, read just now (authoritative)";
		if (want.has("weather") && opts.weatherAt) out.weather = `Open-Meteo forecast, fetched ${stamp(opts.weatherAt, now, STALE_HOURS.weather)}`;

		if (want.has("injury_history") && lc.env.NFL_DB) {
			const rows = await lc.env.NFL_DB.prepare("SELECT key, value FROM nfl_meta WHERE key LIKE 'injury_hist:%'").all<{ key: string; value: string }>().catch(() => null);
			const seasons = (rows?.results ?? []).map((r) => Number(r.key.split(":")[1])).sort((a, b) => a - b);
			const cur = rows?.results.find((r) => r.key === `injury_hist:${lc.season}`);
			out.injury_history = seasons.length
				? `nflverse, seasons ${seasons[0]}-${seasons[seasons.length - 1]} (${seasons.length} loaded)${cur ? `; ${lc.season} rebuilt ${stamp(cur.value, now, 7)}` : ""}`
				: "not loaded yet (the hourly job backfills 4 seasons per run)";
		}
		const nflSources = (["injury_report", "lines", "rankings", "stats", "usage"] as Source[]).filter((s) => want.has(s));
		if (nflSources.length && lc.env.NFL_DB) {
			const nfl = NflData.from(lc.env, lc.season);
			const status = await nfl.status().catch(() => []);
			// Per-season datasets have one row per season; the others have a null season.
			const sync = (id: string) => status.find((r) => r.dataset === id && (r.season == null || String(r.season) === lc.season));
			const synced = (id: string, staleH?: number) => {
				const r = sync(id);
				if (!r) return "not synced yet";
				return `changed ${stamp(r.changed_at as string, now, staleH) ?? "never"}, checked ${stamp(r.checked_at as string, now) ?? "never"}`;
			};
			if (want.has("stats") || want.has("usage")) out.nflverse_stats = `box scores and snaps through the latest completed week; player_week ${synced("player_week")}`;
			if (want.has("lines")) out.vegas_lines = `nflverse schedule file, ${synced("games", STALE_HOURS.lines)}; lines move through the week`;
			if (want.has("rankings")) {
				const d = await nfl.ecrDate().catch(() => null);
				if (d) out.fantasypros = dateStamp(d, now, STALE_HOURS.rankings);
			}
			if (want.has("injury_report")) {
				const cur = await nfl.currentInjuries("AND 0").catch(() => null);
				const log = (await lc.env.PLAYERS.get<Record<string, ReportSeen>>(REPORT_KEY(lc.season), "json").catch(() => null)) ?? {};
				const teams = [...new Set([...(opts.teams ?? [])].filter((t): t is string => !!t))].sort();
				const perTeam: Record<string, string> = {};
				if (cur?.week) {
					for (const t of teams) {
						const has = cur.published.has(t);
						const wk = has ? cur.week : cur.week - 1;
						const seen = log[`${t}:${wk}`];
						perTeam[t] = `week ${wk}${has ? "" : ` (week ${cur.week} not in nflverse yet)`}${seen ? `, in mirror ${seen.by ? "by" : "since"} ${stamp(seen.first_seen, now)}${seen.changed_at !== seen.first_seen ? `, last changed ${stamp(seen.changed_at, now)}` : ""}` : ""}`;
					}
				}
				out.injury_report = {
					source: `official NFL report via nflverse, ${synced("injuries")}. Teams post Wed-Fri (final game status Fri); the mirror picks reports up hours later`,
					...(teams.length && cur?.week ? { teams: perTeam } : {}),
				};
			}
		}
	} catch (e) {
		out.error = `freshness unavailable: ${e instanceof Error ? e.message : String(e)}`;
	}
	return out;
}
