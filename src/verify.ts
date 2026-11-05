// Hints that tell the model which parts of a Sleeper projection to check.
//
// Sleeper's projections are estimates. They lag news, and some of them assume
// changes nobody has announced: a benching after a bye, a best-case return
// date, a player listed Questionable but projected for zero. These notes point
// at exactly those spots so the model verifies them against current news
// instead of repeating them as fact. Pure and dependency-free.

/** Sleeper injury_status values that mean the player isn't expected to play. */
const NOT_PLAYING = new Set(["Out", "IR", "PUP", "Sus", "NA", "COV", "DNR"]);
/** Game-time designations. */
const GAME_TIME = new Set(["Questionable", "Doubtful"]);

/** Flag a projection when rest-of-season ppg differs from actual ppg by at least this share. */
export const PPG_GAP = 0.25;
/** Games played before projection and actual production are compared. */
export const MIN_GAMES_FOR_GAP = 4;

/** [13,14,15,16] → "weeks 13–16"; [7,9,10] → "weeks 7, 9–10"; [12] → "week 12". */
export function formatWeeks(weeks: number[]): string {
	const sorted = [...new Set(weeks)].sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length; i++) {
		const start = sorted[i]!;
		let end = start;
		while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i]!;
		parts.push(end === start ? `${start}` : `${start}–${end}`);
	}
	return `${sorted.length === 1 ? "week" : "weeks"} ${parts.join(", ")}`;
}

export interface VerifyInput {
	/** The week being projected (usually the current week). */
	week: number;
	/** Weeks in range with a projected game. */
	playedWeeks: number[];
	/** Weeks in range when the player's team is on bye. */
	byeWeeks: number[];
	/** Non-bye weeks in range with no projected game. */
	outWeeks: number[];
	/** Sleeper injury_status, e.g. "Questionable" or "IR". */
	injury?: string;
	/** Sleeper roster status when it isn't "Active", e.g. "Inactive". */
	status?: string;
	/** Projected rest-of-season points per game. */
	rosPpg: number;
	/** Actual points and games so far this season, when known. */
	seasonPts?: number;
	seasonGames?: number;
}

/** The projection assumptions worth checking for one player. Empty when nothing stands out. */
export function verifyNotes(i: VerifyInput): string[] {
	const notes: string[] = [];
	const tag = i.injury ?? i.status;
	const outNow = i.outWeeks.includes(i.week);
	const playsNow = i.playedWeeks.includes(i.week);

	if (i.outWeeks.length && !tag) {
		notes.push(
			`Projected for no game in ${formatWeeks(i.outWeeks)}, with no injury or status listed. ` +
				"Sleeper doesn't say why (benching, suspension, depth chart?), so find a dated source before relying on it.",
		);
	}

	const back = i.outWeeks.length ? i.playedWeeks.find((w) => w > i.outWeeks[0]!) : undefined;
	if (outNow && back != null) {
		notes.push(
			`Projected to return in week ${back}${tag ? ` (listed ${tag})` : ""}. ` +
				"Treat that as the earliest case and check the official timeline.",
		);
	}

	if (tag && GAME_TIME.has(tag) && outNow) {
		notes.push(
			`Listed ${tag} but projected for no game this week, so Sleeper may be assuming he sits. ` +
				"Check the final injury report and inactives.",
		);
	}
	if (tag && NOT_PLAYING.has(tag) && playsNow) {
		notes.push(`Listed ${tag} but still projected to play this week. The projection may be stale.`);
	}

	if (i.seasonGames != null && i.seasonGames >= MIN_GAMES_FOR_GAP && i.seasonPts != null && i.rosPpg > 0) {
		const actual = i.seasonPts / i.seasonGames;
		if (actual > 0) {
			const gap = (i.rosPpg - actual) / actual;
			if (Math.abs(gap) >= PPG_GAP) {
				notes.push(
					`Projects ${i.rosPpg} ppg for the rest of the season vs ${round1(actual)} ppg actual so far ` +
						`(${gap > 0 ? "+" : ""}${Math.round(gap * 100)}%). Find out what Sleeper expects to change.`,
				);
			}
		}
	}
	return notes;
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}
