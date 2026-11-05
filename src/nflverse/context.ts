// Compact nflverse context for existing tools: recent usage, FantasyPros consensus
// rank and the current injury report per Sleeper player. Fail-soft: if the D1 mirror
// isn't configured or hasn't synced yet, callers get an empty map and carry on.

import type { LeagueContext } from "../league";
import { round } from "../scoring";
import { NflData, expectedPoints, fillPlayedWeeks, leaguePoints } from "./stats";

type Row = Record<string, unknown>;

export interface RecentUsage {
	weeks: string;
	games: number;
	snap_pct?: number;
	targets?: number;
	tgt_share?: number;
	carries?: number;
	rz_opps?: number;
	pts?: number;
	xfp?: number;
}

export interface Consensus {
	/** This week's FantasyPros positional rank, e.g. "RB11". */
	week?: string;
	/** This week's superflex (all offensive players) rank. */
	week_sf?: number;
	/** Rest-of-season positional rank. */
	ros?: string;
	dynasty_sf?: number;
	as_of?: string;
}

export interface PlayerContext {
	recent?: RecentUsage;
	/** Usage that has moved a lot in the last 3 weeks vs earlier in the season, or a projection far from recent usage. */
	role_change?: string[];
	ecr?: Consensus;
	/** Current official report, e.g. "Questionable (Ankle), Limited". */
	injury_report?: string;
}

const num = (r: Row | undefined, k: string): number => {
	const v = r?.[k];
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const PRACTICE: Record<string, string> = {
	"Did Not Participate In Practice": "DNP",
	"Limited Participation in Practice": "Limited",
	"Full Participation in Practice": "Full",
};

export function describeInjury(r: Row): string | undefined {
	const status = (r.report_status as string) || "";
	const injury = (r.report_injury as string) || (r.practice_injury as string) || "";
	const practice = PRACTICE[String(r.practice_status)] ?? ((r.practice_status as string) || "");
	const parts = [status || (injury ? "On report" : ""), injury ? `(${injury})` : ""].filter(Boolean).join(" ");
	const out = [parts, practice].filter(Boolean).join(", ");
	return out || undefined;
}

const UNAVAILABLE_TAG = /^(IR|Out|Doubtful|PUP|Sus|NA|DNR|COV)$/i;

/**
 * True when a player can't be counted on this week: Sleeper's tag says Out/Doubtful/IR/PUP/
 * suspended (or a non-Active roster status), or the current official report lists him Out or
 * Doubtful. Waiver lists hide these by default, because their recent usage predates the injury.
 */
export function isUnavailable(p: { injury?: string; status?: string } | undefined, reportStatus?: unknown): boolean {
	if (!p) return false;
	if (UNAVAILABLE_TAG.test(p.injury ?? "")) return true;
	if (p.status && p.status !== "Active") return true;
	return typeof reportStatus === "string" && /^(Out|Doubtful)$/i.test(reportStatus);
}

type Usage = Omit<RecentUsage, "weeks">;

/** Per-game usage over a set of player-weeks (undefined when he didn't play). */
function usageOver(st: Row[], sn: Row[], o: Row[], p: Row[], pos: string | undefined, scoring: Record<string, number>): Usage | undefined {
	if (!st.length) return undefined;
	const games = st.length;
	const per = (rows: Row[], f: (r: Row) => number) => round(rows.reduce((a, r) => a + f(r), 0) / games, 1);
	const u: Usage = { games };
	if (sn.length) u.snap_pct = round(mean(sn.map((r) => num(r, "offense_pct"))) * 100, 1);
	if (pos !== "QB") {
		u.targets = per(st, (r) => num(r, "targets"));
		u.tgt_share = round(mean(st.map((r) => num(r, "target_share"))) * 100, 1);
	}
	if (pos === "RB" || pos === "QB") u.carries = per(st, (r) => num(r, "carries"));
	if (p.length) u.rz_opps = per(p, (r) => num(r, "rz_targets") + num(r, "rz_carries"));
	u.pts = per(st, (r) => leaguePoints(r, scoring));
	// Expected points per game played: a no-touch week contributes zero.
	if (o.length) u.xfp = round(o.reduce((a, r) => a + expectedPoints(r, scoring), 0) / Math.max(o.length, games), 1);
	return u;
}

/**
 * Plain-language flags when the last few weeks differ sharply from earlier in the season, or
 * when Sleeper's projection for this week is far from what recent usage supports.
 * Pure; exported for tests.
 */
export function roleFlags(recent: Usage, earlier: Usage | undefined, projection: number | null): string[] {
	const flags: string[] = [];
	if (earlier && earlier.games >= 2 && recent.games >= 2) {
		const cmp = (label: string, r: number | undefined, e: number | undefined, absMin: number, unit = "", relMin = 0.3) => {
			if (r == null || e == null) return;
			const d = r - e;
			const rel = e ? Math.abs(d) / e : r ? 1 : 0;
			if (Math.abs(d) >= absMin && rel >= relMin) flags.push(`${label} ${d < 0 ? "down" : "up"}: ${r}${unit} last ${recent.games} vs ${e}${unit} before`);
		};
		// Snap share is already a percentage: a 15-point move matters whatever the starting level.
		cmp("Snaps", recent.snap_pct, earlier.snap_pct, 15, "%", 0);
		cmp("Target share", recent.tgt_share, earlier.tgt_share, 6, "%");
		cmp("Carries", recent.carries, earlier.carries, 5);
		cmp("Expected points", recent.xfp, earlier.xfp, 3);
	}
	if (projection != null && recent.xfp != null && recent.games >= 2) {
		if (projection >= 6 && projection >= 1.75 * recent.xfp) {
			flags.push(`Sleeper projects ${projection} this week vs ${recent.xfp} expected points per game recently: the projection assumes a bigger role than he's had.`);
		} else if (recent.xfp >= 8 && projection > 0 && projection <= 0.55 * recent.xfp) {
			flags.push(`Sleeper projects ${projection} this week vs ${recent.xfp} expected points per game recently: find out what Sleeper expects to change.`);
		}
	}
	return flags;
}

export async function playerContext(
	lc: LeagueContext,
	sleeperIds: string[],
	opts: { weeks?: number; dynasty?: boolean; /** This week's Sleeper projection per player, for the projection-vs-usage flag. */ projections?: Map<string, number | null> } = {},
): Promise<Map<string, PlayerContext>> {
	const out = new Map<string, PlayerContext>();
	if (!sleeperIds.length) return out;
	try {
		const nfl = NflData.from(lc.env, lc.season);
		const ids = await nfl.ids(sleeperIds);
		if (!ids.size) return out;
		const latest = await nfl.latestWeek();
		const from = Math.max(1, latest - (opts.weeks ?? 3) + 1);
		const gsis = [...ids.values()].map((x) => x.gsis_id).filter((x): x is string => !!x);
		const pfr = [...ids.values()].map((x) => x.pfr_id).filter((x): x is string => !!x);
		const fp = [...ids.values()].map((x) => x.fantasypros_id).filter((x): x is string => !!x);
		// The whole season, so the last few weeks can be compared with what came before.
		const [stats, opp, pbp, snaps, ecr, injuries] = await Promise.all([
			latest ? nfl.forPlayers("nfl_player_week", "gsis_id", gsis, 1, latest) : [],
			latest ? nfl.forPlayers("nfl_opportunity", "gsis_id", gsis, 1, latest) : [],
			latest ? nfl.forPlayers("nfl_pbp_week", "gsis_id", gsis, from, latest) : [],
			latest ? nfl.forPlayers("nfl_snaps", "pfr_id", pfr, 1, latest) : [],
			nfl.ecr(fp),
			gsis.length ? nfl.currentInjuries(`AND gsis_id IN (${gsis.map(() => "?").join(",")})`, ...gsis) : { week: 0, rows: [] as Row[], published: new Set<string>() },
		]);
		const group = (rows: Row[], col: string) => {
			const m = new Map<string, Row[]>();
			for (const r of rows) {
				const k = String(r[col]);
				m.set(k, [...(m.get(k) ?? []), r]);
			}
			return m;
		};
		const statsBy = group(stats, "gsis_id");
		const oppBy = group(opp, "gsis_id");
		const pbpBy = group(pbp, "gsis_id");
		const snapsBy = group(snaps, "pfr_id");
		const ecrBy = group(ecr, "fantasypros_id");
		const injBy = new Map(injuries.rows.map((r) => [String(r.gsis_id), r]));
		const scoring = lc.league.scoring_settings;

		for (const [sid, id] of ids) {
			const ctx: PlayerContext = {};
			const pos = lc.players.get(sid)?.pos;
			const snAll = id.pfr_id ? (snapsBy.get(id.pfr_id) ?? []) : [];
			// Include weeks on the field with no touches (no nflverse stats row) as zero games.
			const stAll = id.gsis_id ? fillPlayedWeeks(statsBy.get(id.gsis_id) ?? [], snAll, id.gsis_id, nfl.season) : [];
			const oAll = id.gsis_id ? (oppBy.get(id.gsis_id) ?? []) : [];
			const inWindow = (r: Row) => Number(r.week) >= from;
			const before = (r: Row) => Number(r.week) < from;
			const p = id.gsis_id ? (pbpBy.get(id.gsis_id) ?? []) : [];
			const recentUsage = usageOver(stAll.filter(inWindow), snAll.filter(inWindow), oAll.filter(inWindow), p, pos, scoring);
			if (recentUsage) {
				ctx.recent = { weeks: `${from}-${latest}`, ...recentUsage };
				const earlier = usageOver(stAll.filter(before), snAll.filter(before), oAll.filter(before), [], pos, scoring);
				const flags = roleFlags(recentUsage, earlier, opts.projections?.get(sid) ?? null);
				if (flags.length) ctx.role_change = flags;
			}
			const e = id.fantasypros_id ? ecrBy.get(id.fantasypros_id) : undefined;
			if (e?.length) {
				const page = (name: string) => e.find((r) => r.page === name);
				const posPage = (kind: "weekly" | "redraft") => e.find((r) => String(r.page).startsWith(`${kind}-`) && r.page !== "weekly-op");
				const c: Consensus = {};
				const asOf = String(e[0]!.scrape_date ?? "");
				// Weekly ranks scraped before this NFL week began (Tuesday) are last week's.
				if (!weeklyStale(asOf)) {
					const wk = posPage("weekly");
					if (wk) c.week = `${wk.position}${wk.rank}`;
					if (page("weekly-op")) c.week_sf = num(page("weekly-op"), "rank");
				}
				const ros = posPage("redraft");
				if (ros) c.ros = `${ros.position}${ros.rank}`;
				if (opts.dynasty && page("dynasty-op")) c.dynasty_sf = num(page("dynasty-op"), "rank");
				c.as_of = asOf || undefined;
				ctx.ecr = c;
			}
			const inj = id.gsis_id ? injBy.get(id.gsis_id) : undefined;
			if (inj) {
				const text = describeInjury(inj);
				// Teams post on different days: say when this is last week's report.
				if (text) ctx.injury_report = Number(inj.week) === injuries.week ? text : `${text} [week ${inj.week} report; week ${injuries.week} not posted yet]`;
			}
			if (ctx.recent || ctx.ecr || ctx.injury_report || ctx.role_change) out.set(sid, ctx);
		}
	} catch (e) {
		console.warn("nflverse context unavailable:", e instanceof Error ? e.message : e);
		return new Map();
	}
	return out;
}

export interface Matchup {
	opp: string;
	home: boolean;
	/** Opponent's rank in league points allowed to this position this season (1 = most allowed). */
	def_rank?: number;
	def_ppg?: number;
}

/**
 * This week's opponent and how generous that defense has been to each position.
 * Returns a lookup by (NFL team, position); empty when the mirror isn't available.
 */
export async function matchups(lc: LeagueContext, week: number): Promise<(team: string | null | undefined, pos: string | undefined) => Matchup | undefined> {
	try {
		const nfl = NflData.from(lc.env, lc.season);
		const latest = await nfl.latestWeek();
		const [opps, allowed] = await Promise.all([nfl.opponents(week), latest ? nfl.pointsAllowed(lc.league.scoring_settings, 1, latest) : new Map()]);
		return (team, pos) => {
			const o = team ? opps.get(team) : undefined;
			if (!o) return undefined;
			const a = pos ? allowed.get(o.opp)?.get(pos) : undefined;
			return { opp: o.opp, home: o.home, ...(a ? { def_rank: a.rank, def_ppg: a.ppg } : {}) };
		};
	} catch {
		return () => undefined;
	}
}

/** Which teams have posted the current week's injury report. Null when unavailable. */
export async function injuryReportState(lc: LeagueContext): Promise<{ week: number; published: Set<string> } | null> {
	try {
		const cur = await NflData.from(lc.env, lc.season).currentInjuries("AND 0");
		return cur.week ? { week: cur.week, published: cur.published } : null;
	} catch {
		return null;
	}
}

/** team -> bye weeks from the schedule; empty map (fall back to Sleeper) when unavailable. */
export async function teamByes(lc: LeagueContext): Promise<Map<string, Set<number>>> {
	try {
		return await NflData.from(lc.env, lc.season).teamByes();
	} catch {
		return new Map();
	}
}

/** True when a FantasyPros scrape date precedes the most recent Tuesday (UTC), i.e. a prior NFL week. */
export function weeklyStale(scrapeDate: string, now = new Date()): boolean {
	const d = Date.parse(`${scrapeDate}T00:00:00Z`);
	if (!Number.isFinite(d)) return true;
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const sinceTuesday = (new Date(today).getUTCDay() - 2 + 7) % 7;
	return d < today - sinceTuesday * 86_400_000;
}

/** Team -> implied points for a week; empty when the mirror isn't available. */
export async function impliedTotals(lc: LeagueContext, week: number): Promise<Map<string, number>> {
	try {
		return await NflData.from(lc.env, lc.season).impliedTotals(week);
	} catch {
		return new Map();
	}
}
