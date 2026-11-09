// Injury episodes from public weekly data (nflverse): the official injury report, snap counts
// and team schedules. Pure and dependency-free, so the Worker's backfill and the tests run the
// same code on the same rows.
//
// The report alone can't find most absences: a player placed on IR drops off it entirely
// (Justin Jefferson, 2023: 71% of snaps in week 5, no report rows weeks 6-9, Questionable weeks
// 10-12, back in week 14). So an episode is either
//   missed          a run of his team's games without his snaps, preceded by games he played,
//                   with an injury named on a report inside the run or in the week before it;
//   played_through  weeks he was listed Questionable/Doubtful/Out with an injury and played.
// A game just before a missed run with a snap share under 75% of his norm is where he got
// hurt (in_game). Weekly rosters add injured-reserve weeks (R01 IR, R04 PUP, R48 IR designated
// to return): Derrick Henry, 2021, broke his foot in week 8 and was on IR weeks 9-18 with no
// report rows at all. Those episodes have body "undisclosed". Absences with no injury on any
// nearby report and no IR (benchings, suspensions, healthy scratches) are not episodes.

export type Practice = "DNP" | "Limited" | "Full";

export interface ReportRow {
	week: number;
	/** Normalized body part (see normalizeBody), or null when the row isn't an injury. */
	body: string | null;
	status: "Out" | "Doubtful" | "Questionable" | null;
	practice: Practice | null;
	/** When the report row was published (ISO), when nflverse has it. */
	date?: string | null;
}

export interface PlayerSeason {
	id: string;
	name: string;
	position: string;
	team: string;
	season: number;
	/** Offense snap share (0-1) for each week he played (snaps > 0, or a stats row). */
	played: Map<number, number | null>;
	reports: ReportRow[];
	/** Weeks he was on injured reserve / PUP (weekly roster status R01, R04, R48). */
	reserve?: Set<number>;
	/** Weeks his team played a regular-season game (byes excluded). */
	teamWeeks: number[];
	/** Snap-share norm from the previous season, for episodes that start in week 1. */
	priorNorm?: number | null;
	/** False while the season is in progress: an unreturned episode is then ongoing, not season-ending. */
	complete?: boolean;
}

export interface Episode {
	id: string;
	name: string;
	position: string;
	team: string;
	season: number;
	kind: "missed" | "played_through";
	body: string;
	/** First week of the episode: the in-game injury week, else the first missed or listed week. */
	start_week: number;
	start_date: string | null;
	in_game: boolean;
	/** Team games he didn't play. */
	games_missed: number;
	/** Week he played again; null if he didn't return that season (censored). */
	return_week: number | null;
	censored: boolean;
	/** Censored in a season still in progress: still out as of the latest week, not season-ending. */
	ongoing: boolean;
	/** Median snap share in his games before the episode (that season, else the previous one). */
	pre_snap_pct: number | null;
	/** Snap share in the first and second games back. */
	return_snap_pct: number | null;
	return2_snap_pct: number | null;
	first_status: string | null;
	first_practice: Practice | null;
	/** Same body part again within 8 team weeks of returning (set by markRecurrence). */
	recurred: boolean;
}

const NOT_INJURY = /not injury|coach|personal|rest|illness|suspension|team decision|load management|non-football|^$/i;

/** "right Hamstring" -> "hamstring"; "back, ankle, knee" -> "back"; non-injuries -> null. Pure. */
export function normalizeBody(raw: string | null | undefined): string | null {
	const s = (raw ?? "").trim().toLowerCase();
	if (!s || NOT_INJURY.test(s)) return null;
	let b = s.split(/[,/;]| and /)[0]!.trim().replace(/^(right|left|r\.|l\.)\s+/, "").trim();
	const alias: Record<string, string> = {
		ribs: "rib", quadricep: "quadriceps", quad: "quadriceps", hamstrings: "hamstring", "achilles tendon": "achilles",
		abdominal: "abdomen", "lower back": "back", "low back": "back", tricep: "triceps", bicep: "biceps",
	};
	b = alias[b] ?? b;
	return b || null;
}

export function normalizePractice(raw: string | null | undefined): Practice | null {
	const s = (raw ?? "").toLowerCase();
	if (s.includes("did not")) return "DNP";
	if (s.includes("limited")) return "Limited";
	if (s.includes("full")) return "Full";
	return null;
}

export function normalizeStatus(raw: string | null | undefined): ReportRow["status"] {
	const s = (raw ?? "").trim().toLowerCase();
	return s === "out" ? "Out" : s === "doubtful" ? "Doubtful" : s === "questionable" ? "Questionable" : null;
}

/** True median (even count: mean of the middle two). */
export const median = (xs: number[]): number | null => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const r2 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100) / 100);

/** A player must be a regular for an absence to count: median snap share of at least this. */
export const REGULAR_SNAP_PCT = 0.4;
/** A game under this share of his norm, right before a missed run, is the injury game. */
export const IN_GAME_DROP = 0.75;
export const RECURRENCE_WEEKS = 8;
/** Body part for an injured-reserve stint no report named. */
export const UNDISCLOSED = "undisclosed";
/** Weekly roster codes that mean injured: R01 Reserve/Injured, R04 PUP, R48 IR designated to return. */
export const RESERVE_CODES = new Set(["R01", "R04", "R48"]);

/** Episodes for one player-season. Pure; exported for tests. */
export function stitchEpisodes(p: PlayerSeason): Episode[] {
	const weeks = [...p.teamWeeks].sort((a, b) => a - b);
	const played = (w: number) => p.played.has(w);
	const share = (w: number) => p.played.get(w) ?? null;
	const reportAt = new Map(p.reports.map((r) => [r.week, r]));
	const injuryAt = (w: number) => {
		const r = reportAt.get(w);
		return r?.body ? r : undefined;
	};
	const normBefore = (w: number) => {
		const xs = weeks.filter((x) => x < w && played(x)).map(share).filter((x): x is number => x != null);
		return xs.length >= 2 ? median(xs) : (p.priorNorm ?? (xs.length ? median(xs) : null));
	};
	const out: Episode[] = [];
	const covered = new Set<number>();

	// Missed runs.
	for (let i = 0; i < weeks.length; i++) {
		if (played(weeks[i]!)) continue;
		let j = i;
		while (j + 1 < weeks.length && !played(weeks[j + 1]!)) j++;
		const run = weeks.slice(i, j + 1);
		const prev = i > 0 ? weeks[i - 1] : undefined;
		const norm = normBefore(run[0]!);
		const regular = norm != null && norm >= REGULAR_SNAP_PCT;
		// He must have been playing before the run (or a regular last season, for week 1).
		const wasPlaying = prev != null ? played(prev) : p.priorNorm != null;
		const reported = [prev, ...run].filter((w): w is number => w != null).map(injuryAt).find(Boolean);
		// Later report rows can name an IR stint's injury (Jefferson's hamstring, weeks 10-12); else it's undisclosed.
		const onIr = run.some((w) => p.reserve?.has(w));
		const evidence: ReportRow | undefined = reported ?? (onIr ? { week: run[0]!, body: UNDISCLOSED, status: "Out", practice: null } : undefined);
		if (regular && wasPlaying && evidence) {
			const prevShare = prev != null ? share(prev) : null;
			const inGame = prev != null && prevShare != null && norm != null && prevShare < IN_GAME_DROP * norm;
			const startWeek = inGame ? prev! : run[0]!;
			const back = weeks.find((w) => w > run[run.length - 1]! && played(w)) ?? null;
			const back2 = back != null ? (weeks.find((w) => w > back && played(w)) ?? null) : null;
			const first = injuryAt(startWeek) ?? evidence;
			out.push({
				id: `${p.id}:${p.season}:${startWeek}`,
				name: p.name,
				position: p.position,
				team: p.team,
				season: p.season,
				kind: "missed",
				body: evidence.body!,
				start_week: startWeek,
				// Only a report row from the starting week dates it (Jefferson 2023's first hamstring row is week 10, not week 5).
				start_date: injuryAt(startWeek)?.date ?? null,
				in_game: inGame,
				games_missed: run.length,
				return_week: back,
				censored: back == null,
				ongoing: back == null && p.complete === false,
				pre_snap_pct: r2(norm),
				return_snap_pct: back != null ? r2(share(back)) : null,
				return2_snap_pct: back2 != null ? r2(share(back2)) : null,
				first_status: first.status,
				first_practice: first.practice,
				recurred: false,
			});
			for (const w of run) covered.add(w);
			if (inGame) covered.add(prev!);
			// A return game listed with the same injury is part of this episode (Ja'Marr Chase, 2022: hip, back week 13 as Questionable).
			if (back != null && injuryAt(back)?.body === evidence.body) covered.add(back);
		}
		i = j;
	}

	// Played-through listings (Questionable/Doubtful/Out but played), merged while consecutive with the same body part.
	let cur: Episode | null = null;
	let lastWeek = -1;
	for (const w of weeks) {
		const r = injuryAt(w);
		const listed = r && r.status && played(w) && !covered.has(w);
		if (listed && cur && cur.body === r!.body && weeks.indexOf(w) === weeks.indexOf(lastWeek) + 1) {
			lastWeek = w;
			continue;
		}
		if (cur) out.push(cur), (cur = null);
		if (!listed) continue;
		const norm = normBefore(w);
		if (norm == null || norm < REGULAR_SNAP_PCT) continue;
		cur = {
			id: `${p.id}:${p.season}:${w}:p`,
			name: p.name,
			position: p.position,
			team: p.team,
			season: p.season,
			kind: "played_through",
			body: r!.body!,
			start_week: w,
			start_date: r!.date ?? null,
			in_game: false,
			games_missed: 0,
			return_week: w,
			censored: false,
			ongoing: false,
			pre_snap_pct: r2(norm),
			return_snap_pct: r2(share(w)),
			return2_snap_pct: null,
			first_status: r!.status,
			first_practice: r!.practice,
			recurred: false,
		};
		lastWeek = w;
	}
	if (cur) out.push(cur);
	return markRecurrence(out.sort((a, b) => a.start_week - b.start_week), weeks);
}

/** Flag episodes followed by another with the same body part within RECURRENCE_WEEKS team weeks of returning. */
export function markRecurrence(eps: Episode[], weeks: number[]): Episode[] {
	for (const e of eps) {
		const from = e.return_week ?? null;
		if (from == null) continue;
		const later = eps.find((x) => x !== e && x.body === e.body && x.start_week > from && weeks.filter((w) => w > from && w <= x.start_week).length <= RECURRENCE_WEEKS);
		if (later && e.body !== UNDISCLOSED) e.recurred = true;
	}
	return eps;
}

export interface ListingOutcome {
	id: string;
	season: number;
	week: number;
	position: string;
	body: string;
	status: "Out" | "Doubtful" | "Questionable";
	practice: Practice | null;
	played: boolean;
}

/**
 * Every week a regular was listed with an injury and a game status, and whether he played.
 * The base for "chance to play" by body part. Pure; exported for tests.
 */
export function listingOutcomes(p: PlayerSeason): ListingOutcome[] {
	const weeks = new Set(p.teamWeeks);
	const sorted = [...p.teamWeeks].sort((a, b) => a - b);
	const out: ListingOutcome[] = [];
	for (const r of p.reports) {
		if (!r.body || !r.status || !weeks.has(r.week)) continue;
		const xs = sorted.filter((w) => w < r.week && p.played.has(w)).map((w) => p.played.get(w)).filter((x): x is number => x != null);
		const norm = xs.length >= 2 ? median(xs) : (p.priorNorm ?? null);
		if (norm == null || norm < REGULAR_SNAP_PCT) continue;
		out.push({ id: p.id, season: p.season, week: r.week, position: p.position, body: r.body, status: r.status, practice: r.practice, played: p.played.has(r.week) });
	}
	return out;
}
