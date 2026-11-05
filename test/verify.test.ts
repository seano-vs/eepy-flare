import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCORING, parsePlayerWeeks, summarizeWeeks, valuePlayer } from "../src/scoring";
import type { League } from "../src/sleeper";
import { INSTRUCTIONS } from "../src/tools";
import { formatWeeks, verifyNotes, type VerifyInput } from "../src/verify";

const base: VerifyInput = {
	week: 7,
	playedWeeks: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
	byeWeeks: [],
	outWeeks: [],
	rosPpg: 15,
	seasonPts: 90,
	seasonGames: 6,
};

describe("formatWeeks", () => {
	it("collapses runs of weeks", () => {
		expect(formatWeeks([13, 14, 15, 16])).toBe("weeks 13–16");
		expect(formatWeeks([10, 7, 9])).toBe("weeks 7, 9–10");
		expect(formatWeeks([12])).toBe("week 12");
	});
});

describe("summarizeWeeks", () => {
	it("separates byes (null) from weeks projected out", () => {
		const weeks = parsePlayerWeeks({
			"7": { stats: { gp: 0 }, opponent: "GB" },
			"8": { stats: {}, opponent: "NYJ" },
			"9": null,
			"10": { stats: { gp: 1, rec: 5, rec_yd: 50 }, opponent: "DAL" },
		});
		const s = summarizeWeeks(weeks, 7, 11, DEFAULT_SCORING, 0);
		expect(s.outWeeks).toEqual([7, 8]);
		expect(s.byeWeeks).toEqual([9]);
		expect(s.perWeek).toEqual([{ week: 10, opp: "DAL", pts: 10 }]);
		expect(s.ros).toBe(10);
	});
});

describe("verifyNotes", () => {
	it("stays quiet for a healthy player whose projection matches his production", () => {
		expect(verifyNotes(base)).toEqual([]);
	});

	it("flags a projected benching nobody has announced", () => {
		// Plays through week 12, bye in 11, then no games and no injury listed.
		const notes = verifyNotes({
			...base,
			playedWeeks: [7, 8, 9, 10, 12],
			byeWeeks: [11],
			outWeeks: [13, 14, 15, 16],
			rosPpg: 16,
			seasonPts: 102,
		});
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("weeks 13–16");
		expect(notes[0]).toContain("no injury or status listed");
	});

	it("treats a projected return as the earliest case", () => {
		const notes = verifyNotes({
			...base,
			injury: "IR",
			playedWeeks: [12, 13, 14, 15, 16],
			byeWeeks: [11],
			outWeeks: [7, 8, 9, 10],
			rosPpg: 14.5,
			seasonPts: 102,
		});
		expect(notes).toEqual([expect.stringContaining("return in week 12 (listed IR)")]);
	});

	it("flags a return projected with no injury or status listed", () => {
		const notes = verifyNotes({ ...base, playedWeeks: [8, 9, 10], outWeeks: [7], seasonGames: 0 });
		expect(notes).toHaveLength(2);
		expect(notes[1]).toContain("return in week 8.");
	});

	it("flags a game-time designation projected for zero", () => {
		const notes = verifyNotes({ ...base, injury: "Questionable", playedWeeks: [8, 9], outWeeks: [7] });
		expect(notes.some((n) => n.startsWith("Listed Questionable but projected for no game this week"))).toBe(true);
	});

	it("flags an Out player who is still projected to play", () => {
		expect(verifyNotes({ ...base, injury: "Out" })).toEqual([expect.stringContaining("may be stale")]);
	});

	it("flags a projection far from actual production", () => {
		const notes = verifyNotes({ ...base, rosPpg: 16.3, seasonPts: 53.5, seasonGames: 5 });
		expect(notes).toEqual([expect.stringContaining("16.3 ppg for the rest of the season vs 10.7 ppg actual so far (+52%)")]);
	});

	it("skips the production check on small samples", () => {
		expect(verifyNotes({ ...base, rosPpg: 20, seasonPts: 20, seasonGames: 2 })).toEqual([]);
	});
});

describe("valuePlayer", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("splits byes from projected absences and attaches verify notes", async () => {
		const qbWeek = (opp: string) => ({ stats: { gp: 1, pass_yd: 250, pass_td: 1 }, opponent: opp });
		const projections = {
			"7": qbWeek("TEN"),
			"8": qbWeek("PIT"),
			"9": qbWeek("NO"),
			"10": qbWeek("HOU"),
			"11": null,
			"12": qbWeek("LV"),
			"13": { stats: { gp: 0 }, opponent: "KC" },
			"14": { stats: {}, opponent: "BUF" },
			"15": { stats: {}, opponent: "CIN" },
			"16": { stats: {}, opponent: "BAL" },
		};
		const stats = Object.fromEntries([1, 2, 3, 4, 5, 6].map((w) => [String(w), qbWeek("X")]));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("/stats/") ? stats : projections))),
		);
		const league = { league_id: "1", scoring_settings: DEFAULT_SCORING, settings: {} } as unknown as League;
		const v = await valuePlayer({
			playerId: "test-qb",
			pos: "QB",
			league,
			season: "2026",
			seasonType: "regular",
			week: 7,
			throughWeek: 16,
			replacement: null,
		});
		expect(v?.bye_weeks).toEqual([11]);
		expect(v?.projected_out_weeks).toEqual([13, 14, 15, 16]);
		expect(v?.ros_games).toBe(5);
		expect(v?.verify).toEqual([expect.stringContaining("weeks 13–16, with no injury or status listed")]);
	});
});

describe("server instructions", () => {
	it("tell the model that projections are estimates to verify", () => {
		expect(INSTRUCTIONS).toContain("not facts");
		expect(INSTRUCTIONS).toContain("`verify` list");
		expect(INSTRUCTIONS).toContain("injury_tags_as_of");
	});
});
