// Role swaps for a confirmed new starter, on Sleeper's real Nov 10 2026 projections for the
// Cardinals and Seahawks QBs (weeks 10-13): Beck "set to start Week 10", Minshew possibly out.
import { describe, expect, it } from "vitest";
import { applyConfirmedStarter, type WeekMap } from "../src/starters";

const team: Record<string, string> = { beck: "ARI", minshew: "ARI", lock: "SEA", darnold: "SEA", rodgers: "PIT", arimate: "ARI" };
const teamOf = (id: string) => team[id];
const wk = (e: Record<string, number>): WeekMap => new Map(Object.entries(e).map(([id, pts]) => [id, { pos: id === "arimate" ? "WR" : "QB", pts }]));
const byWeek = [
	wk({ beck: 12.06, lock: 18.23, rodgers: 20.93, arimate: 10 }), // week 10: Sleeper already has Beck starting
	wk({ beck: 1.89, minshew: 13.31, rodgers: 17.64, arimate: 10 }), // week 11: SEA bye
	wk({ beck: 1.96, minshew: 19.27, rodgers: 16.22, darnold: 16.41, arimate: 10 }),
	wk({ beck: 1.99, minshew: 15.11, rodgers: 18.35, darnold: 19.31, arimate: 10 }),
];

describe("applyConfirmedStarter", () => {
	it("swaps Beck and Minshew in the weeks Sleeper still has Minshew starting, not in week 10", () => {
		const { weeks, swaps } = applyConfirmedStarter(byWeek, [10, 11, 12, 13], "beck", "QB", teamOf);
		expect(swaps.map((s) => [s.week, s.incumbent, s.pts, s.was])).toEqual([
			[11, "minshew", 13.31, 1.89],
			[12, "minshew", 19.27, 1.96],
			[13, "minshew", 15.11, 1.99],
		]);
		expect(weeks[0]).toBe(byWeek[0]); // unchanged
		expect(weeks[1]!.get("beck")!.pts).toBe(13.31);
		expect(weeks[1]!.get("minshew")!.pts).toBe(1.89);
		expect(byWeek[1]!.get("beck")!.pts).toBe(1.89); // input not mutated
	});
	it("leaves a bye week alone and uses the fallback when no one at the position is projected", () => {
		const bye = [wk({ rodgers: 18 }), wk({ beck: 0, arimate: 9 })];
		const { swaps } = applyConfirmedStarter(bye, [11, 12], "beck", "QB", teamOf, 12.4);
		expect(swaps).toEqual([{ week: 12, incumbent: "", pts: 12.4, was: 0 }]);
	});
});
