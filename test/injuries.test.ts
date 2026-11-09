// Injury episodes and recovery rates.
//
// Real data: test/fixtures/injury-anchors-2020-2023.json holds the actual nflverse rows (report,
// weekly roster, snaps, stats) for players whose injuries are public record, plus one real snap
// row per team-week for the schedule. test/fixtures/injury-episodes-2020-2023.json holds the
// episodes and listings this code produced from the full 2020-2023 files for four body parts;
// the expected rates below were computed from it by a separate Python implementation
// (product-limit Kaplan-Meier, medians, ratios), and the listing outcomes were reproduced row
// for row from the raw CSVs without this code.
import { describe, expect, it } from "vitest";
import anchorsJson from "./fixtures/injury-anchors-2020-2023.json";
import ratesJson from "./fixtures/injury-episodes-2020-2023.json";
import { buildSeason, seasonNorms, type SeasonRaw } from "../src/injuries/build";
import { listingOutcomes, normalizeBody, stitchEpisodes, UNDISCLOSED, type Episode, type ListingOutcome, type PlayerSeason } from "../src/injuries/episodes";
import { backWithin, computeRates, ratesFor } from "../src/injuries/rates";

const anchors = anchorsJson as unknown as Record<string, SeasonRaw>;

function runAnchors() {
	let prior = new Map<string, number>();
	const players: PlayerSeason[] = [];
	for (const s of ["2020", "2021", "2022", "2023"]) {
		const ps = buildSeason(Number(s), anchors[s]!, prior);
		prior = seasonNorms(ps);
		players.push(...ps);
	}
	return players;
}
const players = runAnchors();
const episodes = (name: string, season: number) =>
	players
		.filter((p) => p.name === name && p.season === season)
		.flatMap(stitchEpisodes)
		.map((e) => ({ kind: e.kind, body: e.body, start: e.start_week, in_game: e.in_game, missed: e.games_missed, back: e.return_week, censored: e.censored }));

describe("episodes from real nflverse rows match the public record", () => {
	it("Justin Jefferson 2023: hamstring in week 5, IR, back week 14 (bye 13), then a chest listing he played through", () => {
		expect(episodes("Justin Jefferson", 2023)).toEqual([
			{ kind: "missed", body: "hamstring", start: 5, in_game: true, missed: 7, back: 14, censored: false },
			{ kind: "played_through", body: "chest", start: 15, in_game: false, missed: 0, back: 15, censored: false },
		]);
		const e = players.filter((p) => p.name === "Justin Jefferson").flatMap(stitchEpisodes)[0]!;
		expect(e.pre_snap_pct).toBe(0.98);
		expect(e.return_snap_pct).toBe(0.18); // hurt his chest in the return game
	});
	it("dates an episode only from a report row in its starting week", () => {
		const jj = players.filter((p) => p.name === "Justin Jefferson" && p.season === 2023).flatMap(stitchEpisodes)[0]!;
		expect(jj.start_week).toBe(5);
		expect(jj.start_date).toBeNull(); // his first hamstring row is week 10, on IR return
		const ck = players.filter((p) => p.name === "Cooper Kupp" && p.season === 2023).flatMap(stitchEpisodes)[0]!;
		expect(ck.start_date).toBe("2023-09-08T19:53:13Z"); // week 1 report
	});
	it("marks an unreturned episode as ongoing while the season is in progress, season-ending after", () => {
		const raw = anchors["2023"]!;
		const prior = seasonNorms(buildSeason(2022, anchors["2022"]!));
		const done = buildSeason(2023, raw, prior, true).filter((p) => p.name === "Joe Burrow").flatMap(stitchEpisodes).find((e) => e.body === "wrist")!;
		const live = buildSeason(2023, raw, prior, false).filter((p) => p.name === "Joe Burrow").flatMap(stitchEpisodes).find((e) => e.body === "wrist")!;
		expect([done.censored, done.ongoing]).toEqual([true, false]);
		expect([live.censored, live.ongoing]).toEqual([true, true]);
	});
	it("Cooper Kupp 2023: hamstring, missed weeks 1-4, debuted week 5", () => {
		expect(episodes("Cooper Kupp", 2023)).toEqual([{ kind: "missed", body: "hamstring", start: 1, in_game: false, missed: 4, back: 5, censored: false }]);
	});
	it("Joe Burrow 2023: calf listing played through, then the season-ending wrist injury in week 11", () => {
		expect(episodes("Joe Burrow", 2023)).toEqual([
			{ kind: "played_through", body: "calf", start: 3, in_game: false, missed: 0, back: 3, censored: false },
			{ kind: "missed", body: "wrist", start: 11, in_game: true, missed: 7, back: null, censored: true },
		]);
	});
	it("Aaron Rodgers 2023: Achilles on his 4th snap, out for the season", () => {
		expect(episodes("Aaron Rodgers", 2023)).toEqual([{ kind: "missed", body: "achilles", start: 1, in_game: true, missed: 16, back: null, censored: true }]);
	});
	it("Derrick Henry 2021: IR from week 9 with no report rows -> undisclosed, censored", () => {
		expect(episodes("Derrick Henry", 2021)).toEqual([{ kind: "missed", body: UNDISCLOSED, start: 9, in_game: false, missed: 9, back: null, censored: true }]);
	});
	it("Saquon Barkley 2020: hurt in week 2, out for the season (bye week 11 not counted)", () => {
		expect(episodes("Saquon Barkley", 2020)).toEqual([{ kind: "missed", body: UNDISCLOSED, start: 2, in_game: true, missed: 14, back: null, censored: true }]);
	});
	it("Ja'Marr Chase 2022: hip, missed 4 around the bye, and the Questionable return game belongs to that episode", () => {
		expect(episodes("Ja'Marr Chase", 2022)).toEqual([{ kind: "missed", body: "hip", start: 8, in_game: false, missed: 4, back: 13, censored: false }]);
	});
	it("Christian McCaffrey 2021: hamstring in week 3, back week 9 on a limited snap count, then season-ending in week 12", () => {
		expect(episodes("Christian McCaffrey", 2021)).toEqual([
			{ kind: "missed", body: "hamstring", start: 3, in_game: true, missed: 5, back: 9, censored: false },
			{ kind: "missed", body: UNDISCLOSED, start: 12, in_game: true, missed: 5, back: null, censored: true },
		]);
	});
	it("excludes fullbacks (Patrick Ricard is RB on the roster, FB on the report)", () => {
		expect(players.some((p) => p.name === "Patrick Ricard")).toBe(false);
	});
	it("excludes a player only the injury report calls FB", () => {
		const raw = JSON.parse(JSON.stringify(anchors["2021"])) as SeasonRaw;
		for (const r of raw.rosters) if (r.full_name === "Patrick Ricard") (r.depth_chart_position = "RB"), (r.position = "RB");
		expect(buildSeason(2021, raw).some((p) => p.name === "Patrick Ricard")).toBe(false);
		for (const r of raw.injuries) if (r.full_name === "Patrick Ricard") r.position = "RB";
		expect(buildSeason(2021, raw).some((p) => p.name === "Patrick Ricard")).toBe(true);
	});
	it("uses a true median for the prior-season norm (Ty Montgomery 2021: 0.375, not a regular in 2022 week 1)", () => {
		const norms = seasonNorms(players.filter((p) => p.season === 2021));
		const ty = players.find((p) => p.name === "Ty Montgomery" && p.season === 2021)!;
		expect(norms.get(ty.id)).toBe(0.375);
		const ty22 = players.find((p) => p.name === "Ty Montgomery" && p.season === 2022)!;
		expect(listingOutcomes(ty22).filter((l) => l.week === 1)).toEqual([]);
	});
});

describe("recovery rates on real 2020-2023 episodes (expected values from an independent implementation)", () => {
	const eps = ratesJson.episodes as unknown as Episode[];
	const listings = ratesJson.listings as unknown as ListingOutcome[];

	it("WR hamstring", () => {
		const r = ratesFor("WR", "hamstring", eps, listings)!;
		expect(r.bucket).toBe("WR hamstring");
		expect(r.episodes).toBe(90);
		expect(r.played_through_pct).toBe(25.6);
		expect(r.missed).toEqual({ n: 67, median_games: 2, back_within: { "1": 32.8, "2": 51.3, "4": 79.1, "8": 97.6 } });
		expect(r.return_game).toEqual({ n: 58, snap_ratio: 0.84, limited_pct: 37.9 });
		expect(r.recurrence_pct).toBe(21);
	});
	it("RB ankle", () => {
		const r = ratesFor("RB", "ankle", eps, listings)!;
		expect([r.episodes, r.played_through_pct, r.recurrence_pct]).toEqual([44, 34.1, 11.4]);
		expect(r.missed).toEqual({ n: 29, median_games: 1.5, back_within: { "1": 34.5, "2": 38.3, "4": 74.8, "8": 81.1 } });
		expect(r.return_game).toEqual({ n: 20, snap_ratio: 0.98, limited_pct: 30 });
	});
	it("knee and concussion fall back to all positions for thin buckets", () => {
		const k = ratesFor("QB", "knee", eps, listings)!;
		expect(k.bucket).toBe("knee (all positions)");
		expect(k.missed!.back_within).toEqual({ "1": 31.2, "2": 51, "4": 71, "8": 82.7 });
		expect(k.listed.questionable_by_practice).toEqual({ DNP: { n: 21, played_pct: 52.4 }, Limited: { n: 123, played_pct: 71.5 }, Full: { n: 24, played_pct: 91.7 } });
		const c = ratesFor("TE", "concussion", eps, listings)!;
		expect([c.episodes, c.missed!.median_games, c.recurrence_pct]).toEqual([82, 1, 5.6]);
		expect(c.missed!.back_within).toEqual({ "1": 49.2, "2": 71, "4": 84.7, "8": 91.8 });
	});
	it("hamstring listings by practice match the raw-CSV reproduction", () => {
		const h = ratesFor("QB", "hamstring", eps, listings)!; // falls back to all positions
		expect(h.listed.questionable_by_practice).toEqual({ DNP: { n: 20, played_pct: 35 }, Limited: { n: 100, played_pct: 70 }, Full: { n: 13, played_pct: 76.9 } });
	});
	it("has nothing to say about undisclosed injuries", () => {
		expect(ratesFor("RB", UNDISCLOSED, eps, listings)).toBeNull();
	});
});

describe("stitching rules (hand-built cases)", () => {
	const base = (over: Partial<PlayerSeason>): PlayerSeason => ({
		id: "x", name: "X", position: "WR", team: "AAA", season: 2025,
		played: new Map([[1, 0.9], [2, 0.9], [3, 0.9]]), reports: [], teamWeeks: [1, 2, 3, 4, 5, 6, 7, 8], ...over,
	});
	it("doesn't count a bye as a missed game", () => {
		const p = base({ played: new Map([[1, 0.9], [2, 0.9], [3, 0.5], [6, 0.9]]), teamWeeks: [1, 2, 3, 4, 6, 7], reports: [{ week: 4, body: "ankle", status: "Out", practice: "DNP" }] });
		expect(stitchEpisodes(p)[0]).toMatchObject({ body: "ankle", start_week: 3, in_game: true, games_missed: 1, return_week: 6 });
	});
	it("ignores absences with no injury evidence (benched, suspended)", () => {
		expect(stitchEpisodes(base({ played: new Map([[1, 0.9], [2, 0.9], [5, 0.9]]) }))).toEqual([]);
	});
	it("ignores non-regulars", () => {
		const p = base({ played: new Map([[1, 0.2], [2, 0.3], [5, 0.2]]), reports: [{ week: 3, body: "knee", status: "Out", practice: "DNP" }] });
		expect(stitchEpisodes(p)).toEqual([]);
	});
	it("merges consecutive played-through weeks with the same body part, and flags recurrence", () => {
		const p = base({
			played: new Map([1, 2, 3, 4, 6, 7, 8].map((w) => [w, 0.9])),
			reports: [
				{ week: 2, body: "hamstring", status: "Questionable", practice: "Limited" },
				{ week: 3, body: "hamstring", status: "Questionable", practice: "Limited" },
				{ week: 5, body: "hamstring", status: "Out", practice: "DNP" },
			],
		});
		const eps = stitchEpisodes(p);
		expect(eps.map((e) => [e.kind, e.start_week, e.games_missed])).toEqual([["played_through", 2, 0], ["missed", 5, 1]]);
		expect(eps[0]!.recurred).toBe(true);
	});
	it("normalizes body parts and drops non-injuries", () => {
		expect(["right Hamstring", "Ribs", "back, ankle, knee", "Quadricep", "Not injury related - resting player", "Illness", "", "Coach's decision"].map(normalizeBody)).toEqual(["hamstring", "rib", "back", "quadriceps", null, null, null, null]);
	});
});

describe("Kaplan-Meier back_within (hand-computed)", () => {
	it("handles censoring", () => {
		// Missed 1, 1, 2, 3 (censored), 5: S(1)=1-2/5=0.6; S(2)=0.6*(1-1/3)=0.4; t=3 censored only; S(4)=0.4; S(5)=0.
		const xs = [{ games: 1, censored: false }, { games: 1, censored: false }, { games: 2, censored: false }, { games: 3, censored: true }, { games: 5, censored: false }];
		expect(backWithin(xs, 1)).toBe(40);
		expect(backWithin(xs, 2)).toBe(60);
		expect(backWithin(xs, 4)).toBe(60);
		expect(backWithin(xs, 5)).toBe(100);
	});
	it("computeRates on an empty bucket is all nulls", () => {
		expect(computeRates("none", [], [])).toMatchObject({ episodes: 0, missed: null, return_game: null, recurrence_pct: null });
	});
});

describe("severity from real Sleeper headlines (Nov 2026 feed)", () => {
	const sev = async (t: string) => (await import("../src/injuries/outlook")).severityFromText(t);
	it("reads season-ending and IR moves", async () => {
		expect(await sev("Jake Tonges Done for Season After MCL Surgery")).toEqual(["MCL injury", "season-ending"]);
		expect(await sev("Jayden Reed (neck) to undergo season-ending surgery")).toEqual(["season-ending"]);
		expect(await sev("Jalen Hurts (blood clot) out for the season as additional clots are found")).toEqual(["season-ending"]);
		expect(await sev("Jayden Reed - Headed for injured reserve")).toEqual(["on injured reserve (out 4+ games)"]);
		expect(await sev("Jayden Reed - Officially on injured reserve")).toEqual(["on injured reserve (out 4+ games)"]);
		expect(await sev("Jalen McMillan - Lands on IR")).toEqual(["on injured reserve (out 4+ games)"]);
		expect(await sev("Tyrone Tracy - Move to IR official")).toEqual(["on injured reserve (out 4+ games)"]);
		expect(await sev("RJ Harvey (knee) placed on short-term IR")).toEqual(["short-term IR (out 4+ games, can return this season)"]);
		expect(await sev("Jaxson Dart - Has surgery on meniscus, MCL")).toEqual(["MCL injury", "meniscus"]);
	});
	it("reads timelines", async () => {
		expect(await sev("Sam Darnold Considered Week-to-Week With Quad, Rib Injuries")).toEqual(["week-to-week"]);
	});
	it("doesn't over-read body-part labels or negated activations", async () => {
		expect(await sev("Mike Evans (achilles) ruled out for Week 9")).toEqual([]);
		expect(await sev("James Conner Won't Come Off Injured Reserve This Week")).toEqual(["on injured reserve (out 4+ games)"]);
		expect(await sev("Drew Lock - Injures oblique during Week 9 win")).toEqual([]);
	});
	it("reads activations", async () => {
		expect(await sev("Brian Robinson Jr. activated from injured reserve")).toEqual(["activated / designated to return from IR"]);
	});
});

describe("outlook text", () => {
	it("summarizes rates and history (WR hamstring, real 2020-2023 rates)", async () => {
		const { outlookFrom } = await import("../src/injuries/outlook");
		const r = ratesFor("WR", "hamstring", ratesJson.episodes as unknown as Episode[], ratesJson.listings as unknown as ListingOutcome[]);
		const o = outlookFrom("hamstring", r, [
			{ season: 2023, kind: "missed", body: "hamstring", start_week: 5, start_date: null, in_game: 1, games_missed: 7, return_week: 14, censored: 0, ongoing: 0, pre_snap_pct: 0.98, return_snap_pct: 0.18, return2_snap_pct: 0.96, first_status: "Questionable", first_practice: "Limited", recurred: 0, team: "MIN" },
		]);
		expect(o.basis).toBe("WR hamstring, 90 episodes since 2013 (nflverse; regulars only)");
		expect(o.if_out).toBe("when he misses time: median 2 games; back within 1/2/4 games 32.8/51.3/79.1% (n=67)");
		expect(o.return_game).toBe("first game back: median 84% of his usual snaps; 37.9% of returns under 75% (n=58)");
		expect(o.reaggravation).toBe("21% list the same injury again within 8 weeks");
		expect(o.if_listed).toMatch(/^Questionable: played 63\.9% of the time \(n=83\); by last practice DNP 36\.8%, Limited 71\.4%/);
		expect(o.history).toEqual(["hamstring 2023 wk 5 (in game): missed 7, back wk 14 at 18% snaps"]);
	});
});
