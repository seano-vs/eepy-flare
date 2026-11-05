import { describe, expect, it } from "vitest";
import { pickValue, slotNumber, suggestBid } from "../src/advisor";
import { computePointsAllowed } from "../src/nflverse/stats";

const hist = (pos: string, xfp: number, winning: number, runnerUp?: number) => ({ label: `${pos}${xfp}`, pos, week: 5, xfp, winning, ...(runnerUp != null ? { runnerUp } : {}) });

describe("suggestBid", () => {
	const history = [hist("RB", 10, 4), hist("RB", 11, 8, 6), hist("RB", 9, 2), hist("RB", 18, 40, 35), hist("WR", 10, 20)];
	it("uses same-position claims with similar expected points", () => {
		const s = suggestBid("RB", 10, history, 100)!;
		expect(s.comps.map((c) => c.winning_bid).sort((a, b) => a - b)).toEqual([2, 4, 8]);
		expect(s.likely).toBe(4);
		// aggressive clears the best losing bid on a comparable (6 + 1).
		expect(s.aggressive).toBeGreaterThanOrEqual(7);
		expect(s.basis).toMatch(/3 past RB claims/);
	});
	it("caps bids at the remaining budget", () => {
		expect(suggestBid("RB", 18, history, 10)!.aggressive).toBeLessThanOrEqual(10);
	});
	it("falls back to the position's distribution when nothing is close", () => {
		const s = suggestBid("RB", 30, history, 100)!;
		expect(s.basis).toMatch(/percentile/);
		expect(s.likely).toBeGreaterThanOrEqual(8);
	});
	it("returns null without history at the position", () => {
		expect(suggestBid("TE", 10, history, 100)).toBeNull();
	});
});

describe("draft pick value", () => {
	const rookies = [9000, 7000, 5000, 3000, 2000, 1000];
	it("maps an overall slot to that rank of this year's rookie class", () => {
		expect(pickValue(1, rookies, 1)).toBe(9000);
		expect(pickValue(3, rookies, 1)).toBe(5000);
		expect(pickValue(40, rookies, 1)).toBe(1000); // beyond the class: last known
	});
	it("discounts picks more than a year out", () => {
		expect(pickValue(1, rookies, 2)).toBe(8100);
		expect(pickValue(1, [], 1)).toBe(0);
	});
	it("turns early/mid/late into a slot", () => {
		expect(slotNumber("early", 12)).toBe(2);
		expect(slotNumber("mid", 12)).toBe(6.5);
		expect(slotNumber("late", 12)).toBe(11);
		expect(slotNumber(4, 12)).toBe(4);
		expect(slotNumber(99, 12)).toBe(12);
	});
});

describe("points allowed by position", () => {
	const scoring = { rec: 1, rec_yd: 0.1, rec_td: 6 };
	const row = (opp: string, week: number, position: string, receptions: number, yards: number) => ({ opp, week, position, receptions, receiving_yards: yards });
	it("sums per game, averages per defense, and ranks most-allowed first", () => {
		const pa = computePointsAllowed(
			[
				row("MIA", 1, "WR", 5, 50), // 10
				row("MIA", 1, "WR", 5, 50), // +10 same game = 20
				row("MIA", 2, "WR", 2, 20), // 4
				row("LA", 1, "WR", 10, 100), // 20 (Rams normalised to LAR)
			],
			scoring,
		);
		expect(pa.get("MIA")!.get("WR")).toEqual({ ppg: 12, games: 2, rank: 2 });
		expect(pa.get("LAR")!.get("WR")).toEqual({ ppg: 20, games: 1, rank: 1 });
	});
});
