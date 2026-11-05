// Shared waiver-target ranking for get_faab_advice and get_opportunity_leaders.
//
// Past usage alone ranked a QB benched the day before first and missed a free agent named the
// starter. So candidates are scored on this week's Sleeper projection as well as recent expected
// points, and each one's latest headline can demote (benched, No. 3, traded, released) or
// promote (named starter) him.

import type { LeagueContext } from "./league";
import { isUnavailable } from "./nflverse/context";
import { NflData, expectedPoints } from "./nflverse/stats";
import { latestHeadlines, roleSignal, type NewsItem, type RoleSignal } from "./news";
import { round, weekPool } from "./scoring";

export interface WaiverTarget {
	id: string;
	pos: string;
	proj_week: number | null;
	xfp_recent: number | null;
	score: number;
	news?: NewsItem;
	role_news?: RoleSignal;
}

/** Pure scoring (exported for tests). */
export function waiverScore(proj: number | null, xfp: number | null, signal: RoleSignal | null | undefined): number {
	const base = proj != null && xfp != null ? 0.5 * proj + 0.5 * xfp : (proj ?? xfp ?? 0);
	if (signal?.kind === "negative") return round(base * 0.35, 2);
	if (signal?.kind === "positive") return round(Math.max(proj ?? 0, xfp ?? 0, base), 2);
	return round(base, 2);
}

export async function rankWaiverTargets(
	lc: LeagueContext,
	opts: { position?: string; includeInjured?: boolean; limit: number; weeks?: number },
): Promise<{ targets: WaiverTarget[]; xfpBy: Map<string, Map<number, number>>; latest: number }> {
	const nfl = NflData.from(lc.env, lc.season);
	const [latest, maps, pool] = await Promise.all([nfl.latestWeek(), nfl.idMaps(), weekPool(lc.env.PLAYERS, lc.league, lc.season, lc.week, lc.seasonType)]);
	const scoring = lc.league.scoring_settings;
	const opp = latest ? await nfl.weekRange("nfl_opportunity", 1, latest) : [];
	const xfpBy = new Map<string, Map<number, number>>();
	for (const o of opp) {
		const sid = maps.byGsis.get(String(o.gsis_id));
		if (!sid) continue;
		const m = xfpBy.get(sid) ?? new Map<number, number>();
		m.set(Number(o.week), expectedPoints(o, scoring));
		xfpBy.set(sid, m);
	}
	const from = Math.max(1, latest - (opts.weeks ?? 3) + 1);
	const xfpRecent = (sid: string) => {
		const m = xfpBy.get(sid);
		if (!m) return null;
		const xs = [...m.entries()].filter(([w]) => w >= from).map(([, v]) => v);
		return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
	};
	const projBy = new Map(pool.map((e) => [e.id, e.pts]));
	const owned = lc.ownership();
	const report = new Map((await nfl.currentInjuries()).rows.map((r) => [maps.byGsis.get(String(r.gsis_id)), r.report_status]));

	const candidates = new Set<string>([...xfpBy.keys(), ...pool.filter((e) => e.pts >= 5).map((e) => e.id)]);
	const scored = [...candidates]
		.filter((sid) => !owned.has(sid))
		.filter((sid) => {
			const p = lc.players.get(sid);
			if (!p || !["QB", "RB", "WR", "TE"].includes(p.pos) || (opts.position && p.pos !== opts.position)) return false;
			return opts.includeInjured || !isUnavailable(p, report.get(sid));
		})
		.map((sid): WaiverTarget => {
			const proj = projBy.has(sid) ? projBy.get(sid)! : pool.length ? 0 : null;
			const x = xfpRecent(sid);
			return { id: sid, pos: lc.players.get(sid)!.pos, proj_week: proj, xfp_recent: x != null ? round(x, 1) : null, score: waiverScore(proj, x, null) };
		})
		.sort((a, b) => b.score - a.score);
	// Read headlines for a wider shortlist, then re-rank with what they say.
	const shortlist = scored.slice(0, Math.max(opts.limit * 3, 15));
	const headlines = await latestHeadlines(shortlist.map((t) => t.id), 96);
	for (const t of shortlist) {
		const n = headlines.get(t.id);
		if (!n) continue;
		t.news = n;
		const sig = roleSignal(n.title);
		if (sig) {
			t.role_news = sig;
			t.score = waiverScore(t.proj_week, t.xfp_recent, sig);
		}
	}
	shortlist.sort((a, b) => b.score - a.score);
	return { targets: shortlist.slice(0, opts.limit), xfpBy, latest };
}
