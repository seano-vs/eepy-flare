// League-format multipliers. Expected values for real data come from scripts/verify-format.mjs,
// an independent implementation (no shared code) that also reproduces them from Sleeper's own
// weekly stats and nflverse's raw CSV: run
//   node scripts/verify-format.mjs --through 9 --band 8 --fixture test/fixtures/qb-weeks-2026-w1-9.json
import { describe, expect, it } from "vitest";
import { MARKET_STANDARD, MIN_BAND, REPLACEMENT_BAND, formatMultipliers } from "../src/format";
import { leaguePoints } from "../src/nflverse/stats";
import fixtureJson from "./fixtures/qb-weeks-2026-w1-9.json";
import verifierSource from "../scripts/verify-format.mjs?raw";

type Row = Record<string, unknown>;
const fixture = fixtureJson as Row[];

/** This league's offensive scoring (get_league_settings, Nov 9 2026). */
const LEAGUE = {
	pass_yd: 0.04, pass_td: 6, pass_int: -2, pass_2pt: 2,
	rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
	rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
	fum_lost: -2, fum_rec_td: 6, st_td: 6,
};
const STARTERS = { QB: 24, RB: 27, WR: 33, TE: 12 };

describe("scoring map (cross-checked against Sleeper)", () => {
	it("scores Purdy's Week 9 like Sleeper's own stats", () => {
		// Sleeper week 9 stats: 232 pass yd, 2 pass TD, 1 INT, 40 rush yd, 1 rush TD; Sleeper pts_ppr 26.28 (4-pt TD, -1 INT).
		const row = fixture.find((r) => r.gsis_id === "00-0037834" && r.week === 9)!;
		expect(row).toMatchObject({ passing_yards: 232, passing_tds: 2, passing_interceptions: 1, rushing_yards: 40, rushing_tds: 1 });
		expect(leaguePoints(row, LEAGUE)).toBeCloseTo(9.28 + 12 - 2 + 4 + 6, 2); // 29.28
		expect(leaguePoints(row, { ...LEAGUE, ...MARKET_STANDARD })).toBeCloseTo(9.28 + 8 - 2 + 4 + 6, 2); // 25.28
		expect(leaguePoints(row, { ...LEAGUE, pass_td: 4, pass_int: -1 })).toBeCloseTo(26.28, 2); // Sleeper's pts_ppr
	});
	it("maps receiving, fumbles, 2-pt and TE premium", () => {
		const r = { position: "TE", receptions: 5, receiving_yards: 61, receiving_tds: 1, receiving_2pt_conversions: 1, receiving_fumbles_lost: 1 };
		expect(leaguePoints(r, LEAGUE)).toBeCloseTo(5 + 6.1 + 6 + 2 - 2, 2);
		expect(leaguePoints(r, { ...LEAGUE, bonus_rec_te: 0.5 })).toBeCloseTo(17.1 + 2.5, 2);
		expect(leaguePoints({ ...r, position: "WR" }, { ...LEAGUE, bonus_rec_te: 0.5 })).toBeCloseTo(17.1, 2);
	});
});

describe("formatMultipliers on real 2026 data (weeks 1-9)", () => {
	const at = (qb: number) => formatMultipliers(fixture, LEAGUE, { ...STARTERS, QB: qb });

	it("matches the independent implementation exactly", () => {
		const q = at(24).by_position.QB!;
		expect(q.multiplier).toBe(1.248);
		expect(q.replacement_band).toBe(REPLACEMENT_BAND);
		expect(q.replacement_ppg).toEqual({ league: 13.2, standard: 11.5 }); // verifier: 13.24 / 11.46
		expect(q.above_replacement_ppg.league).toBeCloseTo(8.282, 2);
		expect(q.above_replacement_ppg.standard).toBeCloseTo(6.636, 2);
		expect(at(22).multipliers.QB).toBe(1.238);
		expect(at(26).multipliers.QB).toBe(1.257);
	});

	it("is stable when the starter count moves by 2 (the single-player method ranged 1.12-1.40)", () => {
		const ms = [22, 23, 24, 25, 26].map((n) => at(n).multipliers.QB);
		expect(Math.max(...ms) - Math.min(...ms)).toBeLessThan(0.04);
	});

	it("sits between no adjustment and the raw-points ratio's double", () => {
		// 6-pt TDs raise QB raw points ~19%; above replacement the gain must be positive and bounded.
		const m = at(24).multipliers.QB;
		expect(m).toBeGreaterThan(1.1);
		expect(m).toBeLessThan(1.4);
	});
});

describe("formatMultipliers rules", () => {
	const qb = (id: string, td: number, games = 4) => Array.from({ length: games }, (_, w) => ({ gsis_id: id, position: "QB", week: w + 1, passing_yards: 250, passing_tds: td }));

	it("is 1 everywhere when the league uses the standard scoring", () => {
		const out = formatMultipliers(fixture, { ...LEAGUE, ...MARKET_STANDARD }, STARTERS);
		expect(out.multipliers).toEqual({ QB: 1, RB: 1, WR: 1, TE: 1 });
	});

	it("averages a replacement band: hand-computed case", () => {
		// 2 starters, then 3 replacement QBs. 250 yd = 10 pts; TDs at 4 or 6.
		const rows = [...qb("s1", 3), ...qb("s2", 2), ...qb("r1", 1), ...qb("r2", 1), ...qb("r3", 0)];
		const out = formatMultipliers(rows, { pass_yd: 0.04, pass_td: 6 }, { QB: 2, RB: 0, WR: 0, TE: 0 });
		// Standard: starters 22, 18; band (14, 14, 10) avg 12.667; PAR ((22-12.667)+(18-12.667))/2 = 7.333.
		// League:   starters 28, 22; band (16, 16, 10) avg 14;     PAR ((28-14)+(22-14))/2 = 11.
		expect(out.by_position.QB!.replacement_band).toBe(3);
		expect(out.by_position.QB!.above_replacement_ppg).toEqual({ league: 11, standard: 7.33 });
		expect(out.multipliers.QB).toBe(1.5);
	});

	it("doesn't adjust a position with fewer than MIN_BAND players after the starters", () => {
		const rows = [...qb("s1", 3), ...qb("s2", 2), ...qb("r1", 1)];
		const out = formatMultipliers(rows, { pass_yd: 0.04, pass_td: 6 }, { QB: 2, RB: 0, WR: 0, TE: 0 });
		expect(MIN_BAND).toBeGreaterThan(1);
		expect(out.multipliers.QB).toBe(1);
		expect(out.by_position.QB).toBeUndefined();
	});

	it("ignores players under 4 games", () => {
		const rows = [...qb("s1", 3), ...qb("s2", 2), ...qb("r1", 1), ...qb("r2", 1), ...qb("r3", 0), ...qb("cameo", 9, 2)];
		expect(formatMultipliers(rows, { pass_yd: 0.04, pass_td: 6 }, { QB: 2, RB: 0, WR: 0, TE: 0 }).multipliers.QB).toBe(1.5);
	});

	it("clamps extreme ratios to 0.6-1.6", () => {
		const rows = [...qb("s1", 3), ...qb("s2", 3), ...qb("r1", 0), ...qb("r2", 0), ...qb("r3", 0)];
		expect(formatMultipliers(rows, { pass_yd: 0.04, pass_td: 20 }, { QB: 2, RB: 0, WR: 0, TE: 0 }).multipliers.QB).toBe(1.6);
	});

	it("raises TEs, and only TEs, for a TE premium", () => {
		const te = (id: string, rec: number) => Array.from({ length: 4 }, (_, w) => ({ gsis_id: id, position: "TE", week: w + 1, receptions: rec, receiving_yards: rec * 10 }));
		const rows = [...te("t1", 8), ...te("t2", 6), ...te("t3", 3), ...te("t4", 3), ...te("t5", 2), ...qb("q1", 2), ...qb("q2", 1), ...qb("q3", 1), ...qb("q4", 1), ...qb("q5", 0)];
		const out = formatMultipliers(rows, { pass_yd: 0.04, pass_td: 4, rec: 1, rec_yd: 0.1, bonus_rec_te: 0.5 }, { QB: 2, RB: 0, WR: 0, TE: 2 });
		// Standard TE ppg 16, 12 | band 6, 6, 4 (avg 5.333) -> PAR 8.667. League 20, 15 | 7.5, 7.5, 5 (6.667) -> PAR 10.833.
		expect(out.multipliers.TE).toBe(1.25);
		expect(out.multipliers.QB).toBe(1);
	});
});

describe("verifier stays in sync", () => {
	it("uses the same market standard as the server", () => {
		const m = /const STANDARD = (\{[^}]+\})/.exec(verifierSource)!;
		const parsed = Function(`return (${m[1]})`)() as Record<string, number>;
		expect(parsed).toEqual(MARKET_STANDARD);
	});
});
