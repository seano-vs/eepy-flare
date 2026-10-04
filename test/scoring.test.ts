import { describe, expect, it } from "vitest";
import {
	DEFAULT_SCORING,
	computeReplacement,
	lastFantasyWeek,
	optimalLineup,
	parsePlayerWeeks,
	parseWeekBulk,
	scoreStats,
	type ProjectedEntry,
} from "../src/scoring";
import type { League } from "../src/sleeper";

// Sean's league shape: 12 teams, superflex, no K/DEF.
const SLOTS = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "FLEX", "SUPER_FLEX", "BN", "BN", "BN", "BN", "BN", "BN"];

describe("scoreStats", () => {
	it("applies 6-point passing TDs and full PPR", () => {
		const stats = { pass_yd: 250, pass_td: 2, pass_int: 1, rush_yd: 20, rec: 0 };
		// 10 + 12 - 1 + 2
		expect(scoreStats(stats, DEFAULT_SCORING)).toBe(23);
		expect(scoreStats({ rec: 5, rec_yd: 60, rec_td: 1 }, DEFAULT_SCORING)).toBe(17);
	});

	it("ignores non-numeric and unscored stats", () => {
		expect(scoreStats({ pts_ppr: 99, rec: "7" as unknown as number, adp_dd_ppr: 4 }, DEFAULT_SCORING)).toBe(0);
	});
});

function pool(): ProjectedEntry[] {
	const out: ProjectedEntry[] = [];
	// 40 QBs from 30 down to 10.5, 60 RBs/WRs from 25 down, 20 TEs from 15 down.
	for (let i = 0; i < 40; i++) out.push({ id: `qb${i}`, pos: "QB", pts: 30 - i * 0.5 });
	for (let i = 0; i < 60; i++) out.push({ id: `rb${i}`, pos: "RB", pts: 25 - i * 0.3 });
	for (let i = 0; i < 60; i++) out.push({ id: `wr${i}`, pos: "WR", pts: 25 - i * 0.3 });
	for (let i = 0; i < 20; i++) out.push({ id: `te${i}`, pos: "TE", pts: 15 - i * 0.5 });
	return out;
}

describe("computeReplacement", () => {
	it("fills superflex with QBs and sets a deep QB replacement level", () => {
		const r = computeReplacement(pool(), SLOTS, 12);
		// 12 QB slots + 12 superflex slots, all filled by QBs (they outscore the leftovers).
		expect(r.starters.QB).toBe(24);
		expect(r.level.QB).toBe(30 - 24 * 0.5);
		expect(r.starters.TE).toBeGreaterThanOrEqual(12);
		expect(r.starters.RB + r.starters.WR + r.starters.TE).toBe(12 * (2 + 3 + 1 + 2));
	});

	it("values QBs far less in a 1-QB league", () => {
		const oneQb = SLOTS.filter((s) => s !== "SUPER_FLEX");
		const sf = computeReplacement(pool(), SLOTS, 12);
		const one = computeReplacement(pool(), oneQb, 12);
		expect(one.starters.QB).toBe(12);
		expect(one.level.QB).toBeGreaterThan(sf.level.QB);
	});

	it("falls back to the worst starter when every player starts", () => {
		const tiny: ProjectedEntry[] = [
			{ id: "a", pos: "QB", pts: 20 },
			{ id: "b", pos: "QB", pts: 15 },
		];
		expect(computeReplacement(tiny, ["QB", "QB"], 2).level.QB).toBe(15);
	});
});

describe("lastFantasyWeek", () => {
	const league = (settings: Record<string, number>) => ({ settings }) as unknown as League;
	it("handles 6-team, one-week rounds starting week 15", () => {
		expect(lastFantasyWeek(league({ playoff_week_start: 15, playoff_teams: 6 }))).toBe(17);
	});
	it("handles two-week championship", () => {
		expect(lastFantasyWeek(league({ playoff_week_start: 15, playoff_teams: 4, playoff_round_type: 1 }))).toBe(17);
	});
	it("defaults to 17 and caps at 18", () => {
		expect(lastFantasyWeek(league({}))).toBe(17);
		expect(lastFantasyWeek(league({ playoff_week_start: 16, playoff_teams: 8, playoff_round_type: 2 }))).toBe(18);
	});
});

describe("optimalLineup", () => {
	it("puts the best remaining player in flex and superflex", () => {
		const pts = new Map([
			["q1", { pos: "QB", pts: 20 }],
			["q2", { pos: "QB", pts: 18 }],
			["r1", { pos: "RB", pts: 15 }],
			["r2", { pos: "RB", pts: 10 }],
			["w1", { pos: "WR", pts: 12 }],
		]);
		const res = optimalLineup(["q1", "q2", "r1", "r2", "w1"], ["QB", "RB", "WR", "SUPER_FLEX", "BN"], pts);
		expect(res.starters.map((s) => s.id)).toEqual(["q1", "r1", "w1", "q2"]);
		expect(res.total).toBe(65);
	});
});

describe("projection parsing", () => {
	it("treats null weeks as byes and skips junk", () => {
		const weeks = parsePlayerWeeks({ "1": { stats: { gp: 1, pass_td: 2 }, opponent: "NE" }, "7": null, x: 1, "8": "bad" });
		expect(weeks.get(1)?.opp).toBe("NE");
		expect(weeks.get(7)).toBeNull();
		expect(weeks.has(8)).toBe(false);
	});

	it("scores the bulk list with league scoring and drops stub entries", () => {
		const bulk = [
			{ player_id: "1", stats: { gp: 1, pass_td: 1 }, player: { position: "QB" }, opponent: "KC" },
			{ player_id: "2", stats: { adp_dd_ppr: 1000 }, player: { position: "WR" }, opponent: null },
			{ nope: true },
		];
		expect(parseWeekBulk(bulk, DEFAULT_SCORING)).toEqual([{ id: "1", pos: "QB", pts: 6, opp: "KC" }]);
		expect(parseWeekBulk({ not: "an array" }, DEFAULT_SCORING)).toEqual([]);
	});
});

import { adpField, dynastyValue, parseAdp } from "../src/dynasty";

describe("dynasty value", () => {
	it("maps ADP onto a decaying trade-value curve", () => {
		expect(dynastyValue(1)).toBe(10000);
		expect(dynastyValue(12)).toBeGreaterThan(dynastyValue(50));
		expect(dynastyValue(38)).toBeGreaterThan(4900);
		expect(dynastyValue(38)).toBeLessThan(5100);
		expect(dynastyValue(999)).toBe(0);
		expect(dynastyValue(undefined)).toBe(0);
	});
	it("uses superflex ADP for superflex leagues", () => {
		const league = (roster_positions: string[]) => ({ roster_positions }) as unknown as League;
		expect(adpField(league(["QB", "SUPER_FLEX"]))).toBe("adp_dynasty_2qb");
		expect(adpField(league(["QB", "FLEX"]))).toBe("adp_dynasty_ppr");
	});
	it("parses ADP defensively and skips unranked players", () => {
		const data = [
			{ player_id: "1", stats: { adp_dynasty_2qb: 1.3 } },
			{ player_id: "2", stats: { adp_dynasty_2qb: 999 } },
			{ player_id: "3", stats: {} },
			null,
		];
		expect(parseAdp(data, "adp_dynasty_2qb")).toEqual({ "1": 1.3 });
		expect(parseAdp("nope", "adp_dynasty_2qb")).toEqual({});
	});
});
