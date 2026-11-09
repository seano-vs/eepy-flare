// Recovery and availability base rates from injury episodes and listings (2012 onward).
// Pure; the Worker computes them from D1 rows, tests from real fixtures.

import { UNDISCLOSED, type Episode, type ListingOutcome } from "./episodes";

/** Below this many cases a position-specific bucket falls back to the body part across positions. */
export const MIN_N = 30;

export interface Rates {
	/** What the numbers describe, e.g. "WR hamstring" or "hamstring (all positions)". */
	bucket: string;
	episodes: number;
	/** Share of episodes where he missed no games (listed, played through). */
	played_through_pct: number;
	/** Among episodes with missed games: median games missed, and chance he's back within k games (Kaplan-Meier, censored at season end). */
	missed: { n: number; median_games: number | null; back_within: Record<"1" | "2" | "4" | "8", number> } | null;
	/** First game back vs his pre-injury snap share (median ratio) and share of returns under 75% of it. */
	return_game: { n: number; snap_ratio: number | null; limited_pct: number } | null;
	/** Same body part again within 8 team weeks of returning. */
	recurrence_pct: number | null;
	/** Chance to play the week he's listed, by status and by last practice (Questionable only). */
	listed: {
		questionable: { n: number; played_pct: number } | null;
		doubtful: { n: number; played_pct: number } | null;
		questionable_by_practice: Partial<Record<"DNP" | "Limited" | "Full", { n: number; played_pct: number }>>;
	};
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const med = (xs: number[]) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Kaplan-Meier: probability of being back within k games, from games missed with censoring
 * (censored episodes ended the season still out). Pure; exported for tests.
 */
export function backWithin(eps: { games: number; censored: boolean }[], k: number): number {
	let surv = 1;
	for (let t = 1; t <= k; t++) {
		// At risk for game t: missed at least t games (returned at game > t-1... i.e. still out entering game t).
		const atRisk = eps.filter((e) => e.games >= t).length;
		// Returned after exactly t games missed.
		const returned = eps.filter((e) => e.games === t && !e.censored).length;
		if (atRisk) surv *= 1 - returned / atRisk;
	}
	return Math.round((1 - surv) * 1000) / 10;
}

export function computeRates(bucket: string, eps: Episode[], listings: ListingOutcome[]): Rates {
	const missed = eps.filter((e) => e.kind === "missed");
	const returned = missed.filter((e) => !e.censored && e.pre_snap_pct && e.return_snap_pct != null);
	const ratios = returned.map((e) => e.return_snap_pct! / e.pre_snap_pct!);
	const eligibleRecur = eps.filter((e) => e.return_week != null);
	const q = listings.filter((l) => l.status === "Questionable");
	const d = listings.filter((l) => l.status === "Doubtful");
	const byPractice: Rates["listed"]["questionable_by_practice"] = {};
	for (const pr of ["DNP", "Limited", "Full"] as const) {
		const xs = q.filter((l) => l.practice === pr);
		if (xs.length) byPractice[pr] = { n: xs.length, played_pct: pct(xs.filter((l) => l.played).length, xs.length) };
	}
	const games = missed.map((e) => ({ games: e.games_missed, censored: e.censored }));
	return {
		bucket,
		episodes: eps.length,
		played_through_pct: pct(eps.filter((e) => e.kind === "played_through").length, eps.length),
		missed: missed.length
			? {
					n: missed.length,
					median_games: med(missed.filter((e) => !e.censored).map((e) => e.games_missed)),
					back_within: { "1": backWithin(games, 1), "2": backWithin(games, 2), "4": backWithin(games, 4), "8": backWithin(games, 8) },
				}
			: null,
		return_game: returned.length ? { n: returned.length, snap_ratio: med(ratios) == null ? null : Math.round(med(ratios)! * 100) / 100, limited_pct: pct(ratios.filter((r) => r < 0.75).length, ratios.length) } : null,
		recurrence_pct: eligibleRecur.length ? pct(eligibleRecur.filter((e) => e.recurred).length, eligibleRecur.length) : null,
		listed: {
			questionable: q.length ? { n: q.length, played_pct: pct(q.filter((l) => l.played).length, q.length) } : null,
			doubtful: d.length ? { n: d.length, played_pct: pct(d.filter((l) => l.played).length, d.length) } : null,
			questionable_by_practice: byPractice,
		},
	};
}

/** Rates for a position and body part, falling back to the body part across positions when thin. */
export function ratesFor(position: string, body: string, eps: Episode[], listings: ListingOutcome[]): Rates | null {
	if (!body || body === UNDISCLOSED) return null;
	const posEps = eps.filter((e) => e.body === body && e.position === position);
	const posList = listings.filter((l) => l.body === body && l.position === position);
	if (posEps.length >= MIN_N) return computeRates(`${position} ${body}`, posEps, posList);
	const all = eps.filter((e) => e.body === body);
	if (all.length < MIN_N) return all.length ? computeRates(`${body} (all positions, small sample)`, all, listings.filter((l) => l.body === body)) : null;
	return computeRates(`${body} (all positions)`, all, listings.filter((l) => l.body === body));
}
