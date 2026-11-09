// Injury outlook for current players: base rates for the injury (D1 history, 2013 on), the
// player's own past episodes, and severity words from today's headlines.

import type { LeagueContext } from "../league";
import { NflData } from "../nflverse/stats";
import { normalizeBody, UNDISCLOSED, type Episode, type ListingOutcome } from "./episodes";
import { ratesFor, type Rates } from "./rates";

// ---------------------------------------------------------------- severity from headlines

// Patterns checked against real Sleeper headlines (test/injuries.test.ts). A body part in
// parentheses is only a label: "Mike Evans (achilles) ruled out for Week 9" is not a torn Achilles.
const SEVERITY: [RegExp, string][] = [
	[/\bhigh[- ]ankle\b/i, "high-ankle sprain (usually longer than a regular ankle sprain)"],
	[/\b(ACL|anterior cruciate)\b/, "ACL injury (usually season-ending)"],
	[/\bMCL\b/, "MCL injury"],
	[/\bmeniscus\b/i, "meniscus"],
	[/\b(torn|tore|ruptured?)\s+(his\s+)?achilles|achilles\s+(tear|rupture)/i, "torn Achilles (season-ending)"],
	[/\bLisfranc\b/i, "Lisfranc (often months)"],
	[/\bturf toe\b/i, "turf toe"],
	[/\bgrade[- ](1|one|I)\b/i, "Grade 1 (mild)"],
	[/\bgrade[- ](2|two|II)\b/i, "Grade 2 (moderate)"],
	[/\bgrade[- ](3|three|III)\b/i, "Grade 3 (severe)"],
	[/\b(fracture[sd]?|broken)\b/i, "fracture reported"],
	[/\b(season-ending|out for the (rest of the )?season|done for (the )?season|miss(es)? the rest of the season)\b/i, "season-ending"],
	[/\bweek[- ]to[- ]week\b/i, "week-to-week"],
	[/\bday[- ]to[- ]day\b/i, "day-to-day"],
	[/\b(multiple|several) weeks\b/i, "multiple weeks"],
];
// "IR" must stay case-sensitive (not "ir" inside words); "injured reserve" is title-cased in some headlines.
const IR = /\b([Ii]njured [Rr]eserve|IR)\b/;
const ACTIVATED = /\b(activated|designated to return|returns? from|back from|come off|comes off|coming off)\b[^.]{0,15}\b(injured reserve|IR)\b/i;
const NEGATED = /\b(won't|will not|not expected to|isn't|is not|unlikely to)\b/i;

/** Severity labels named in headline text. Pure; exported for tests. */
export function severityFromText(text: string): string[] {
	const out: string[] = [];
	for (const [re, label] of SEVERITY) if (re.test(text) && !out.includes(label)) out.push(label);
	if (ACTIVATED.test(text) && !NEGATED.test(text)) out.push("activated / designated to return from IR");
	else if (IR.test(text) && !/short-term IR/i.test(text)) out.push("on injured reserve (out 4+ games)");
	else if (/short-term IR/i.test(text)) out.push("short-term IR (out 4+ games, can return this season)");
	return out;
}

// ---------------------------------------------------------------- rates and history from D1

const rateMemo = new Map<string, { at: number; eps: Episode[]; listings: ListingOutcome[] }>();

/** All seasons' episodes and listings for one body part (cached 6h per isolate). */
async function historyFor(db: D1Database, body: string) {
	const hit = rateMemo.get(body);
	if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit;
	const [e, l] = await Promise.all([
		db.prepare("SELECT kind, body, position, games_missed, censored, pre_snap_pct, return_snap_pct, return_week, recurred FROM nfl_injury_episodes WHERE body = ?").bind(body).all<Episode>(),
		db.prepare("SELECT position, body, status, practice, played FROM nfl_injury_listings WHERE body = ?").bind(body).all<ListingOutcome>(),
	]);
	const fix = <T extends Record<string, unknown>>(r: T, keys: string[]) => {
		for (const k of keys) (r as Record<string, unknown>)[k] = !!r[k];
		return r;
	};
	const v = {
		at: Date.now(),
		eps: e.results.map((r) => fix(r as unknown as Record<string, unknown>, ["censored", "recurred"]) as unknown as Episode),
		listings: l.results.map((r) => fix(r as unknown as Record<string, unknown>, ["played"]) as unknown as ListingOutcome),
	};
	rateMemo.set(body, v);
	return v;
}

export async function injuryRates(db: D1Database, position: string, body: string): Promise<Rates | null> {
	const h = await historyFor(db, body);
	return ratesFor(position, body, h.eps, h.listings);
}

export interface HistoryRow {
	season: number;
	kind: string;
	body: string;
	start_week: number;
	start_date: string | null;
	in_game: number;
	games_missed: number;
	return_week: number | null;
	censored: number;
	ongoing: number;
	pre_snap_pct: number | null;
	return_snap_pct: number | null;
	return2_snap_pct: number | null;
	first_status: string | null;
	first_practice: string | null;
	recurred: number;
	team: string;
}

export async function playerHistory(db: D1Database, gsisIds: string[]): Promise<Map<string, HistoryRow[]>> {
	const out = new Map<string, HistoryRow[]>();
	if (!gsisIds.length) return out;
	const rows = await db
		.prepare(`SELECT gsis_id, season, kind, body, start_week, start_date, in_game, games_missed, return_week, censored, ongoing, pre_snap_pct, return_snap_pct, return2_snap_pct, first_status, first_practice, recurred, team
		          FROM nfl_injury_episodes WHERE gsis_id IN (${gsisIds.map(() => "?").join(",")}) ORDER BY season, start_week`)
		.bind(...gsisIds)
		.all<HistoryRow & { gsis_id: string }>();
	for (const r of rows.results) out.set(r.gsis_id, [...(out.get(r.gsis_id) ?? []), r]);
	return out;
}

/** "hamstring 2023 wk 5: missed 7, back wk 14 at 18% snaps" */
export function historyLine(h: HistoryRow): string {
	const where = `${h.body} ${h.season} wk ${h.start_week}${h.in_game ? " (in game)" : ""}`;
	if (h.kind === "played_through") return `${where}: listed ${h.first_status ?? ""}, played`.replace(/ ,/, ",");
	if (h.ongoing) return `${where}: missed ${h.games_missed} so far, still out`;
	if (h.censored) return `${where}: missed ${h.games_missed}, out for the season`;
	return `${where}: missed ${h.games_missed}, back wk ${h.return_week}${h.return_snap_pct != null ? ` at ${Math.round(h.return_snap_pct * 100)}% snaps` : ""}`;
}

// ---------------------------------------------------------------- outlook

export interface Outlook {
	body: string;
	basis: string;
	if_listed?: string;
	if_out?: string;
	return_game?: string;
	reaggravation?: string;
	severity_in_news?: string[];
	history?: string[];
}

/** Compact outlook text from rates and a player's history. Pure; exported for tests. */
export function outlookFrom(body: string, rates: Rates | null, history: HistoryRow[], severity: string[] = []): Outlook {
	const o: Outlook = { body, basis: rates ? `${rates.bucket}, ${rates.episodes} episodes since 2013 (nflverse; regulars only)` : `no base rates for "${body}"` };
	if (rates) {
		const q = rates.listed.questionable;
		const bp = rates.listed.questionable_by_practice;
		const parts = (["DNP", "Limited", "Full"] as const).filter((k) => bp[k] && bp[k]!.n >= 10).map((k) => `${k} ${bp[k]!.played_pct}%`);
		if (q) o.if_listed = `Questionable: played ${q.played_pct}% of the time (n=${q.n})${parts.length ? `; by last practice ${parts.join(", ")}` : ""}${rates.listed.doubtful ? `. Doubtful: ${rates.listed.doubtful.played_pct}% (n=${rates.listed.doubtful.n})` : ""}`;
		if (rates.missed) {
			const b = rates.missed.back_within;
			o.if_out = `when he misses time: median ${rates.missed.median_games ?? "?"} games; back within 1/2/4 games ${b["1"]}/${b["2"]}/${b["4"]}% (n=${rates.missed.n})`;
		}
		if (rates.return_game) o.return_game = `first game back: median ${Math.round((rates.return_game.snap_ratio ?? 0) * 100)}% of his usual snaps; ${rates.return_game.limited_pct}% of returns under 75% (n=${rates.return_game.n})`;
		if (rates.recurrence_pct != null) o.reaggravation = `${rates.recurrence_pct}% list the same injury again within 8 weeks`;
	}
	if (severity.length) o.severity_in_news = severity;
	if (history.length) o.history = history.slice(-5).map(historyLine);
	return o;
}

/**
 * Outlooks for currently injured players (Sleeper tag, or this week's report). Body part from
 * the current report row, else Sleeper's injury_body_part. Empty when the history isn't loaded.
 */
export async function injuryOutlooks(lc: LeagueContext, sleeperIds: string[], headlines: Map<string, { title: string; summary?: string }> = new Map()): Promise<Map<string, Outlook>> {
	const out = new Map<string, Outlook>();
	const db = lc.env.NFL_DB;
	if (!db) return out;
	try {
		const nfl = NflData.from(lc.env, lc.season);
		const ids = await nfl.ids(sleeperIds);
		const cur = await nfl.currentInjuries();
		// This week's report row wins; Sleeper's body part beats an older report row (Drew Lock, week 9:
		// Seattle's report wasn't mirrored yet and the week-8 row still said elbow; he'd hurt his oblique).
		const reportBody = new Map<string, string>();
		const staleBody = new Map<string, string>();
		for (const r of cur.rows) {
			const b = normalizeBody(String(r.report_primary_injury || r.practice_primary_injury || ""));
			if (b) (Number(r.week) === cur.week ? reportBody : staleBody).set(String(r.gsis_id), b);
		}
		const injured = sleeperIds.filter((id) => {
			const p = lc.players.get(id);
			const g = ids.get(id)?.gsis_id;
			return !!p?.injury || (g != null && (reportBody.has(g) || staleBody.has(g)));
		});
		if (!injured.length) return out;
		const gs = injured.map((id) => ids.get(id)?.gsis_id).filter((g): g is string => !!g);
		const hist = await playerHistory(db, gs).catch(() => new Map<string, HistoryRow[]>());
		await Promise.all(
			injured.map(async (id) => {
				const p = lc.players.get(id)!;
				const g = ids.get(id)?.gsis_id;
				const body = (g ? reportBody.get(g) : undefined) ?? normalizeBody(p.injury_body_part ?? "") ?? (g ? staleBody.get(g) : undefined) ?? null;
				const h = (g ? hist.get(g) : undefined) ?? [];
				const n = headlines.get(id);
				const sev = n ? severityFromText(`${n.title} ${n.summary ?? ""}`) : [];
				if (!body || body === UNDISCLOSED) {
					if (h.length || sev.length) out.set(id, outlookFrom(body ?? "unknown", null, h, sev));
					return;
				}
				const rates = await injuryRates(db, p.pos, body).catch(() => null);
				out.set(id, outlookFrom(body, rates, h, sev));
			}),
		);
	} catch (e) {
		console.warn("injury outlook unavailable:", e instanceof Error ? e.message : e);
	}
	return out;
}
