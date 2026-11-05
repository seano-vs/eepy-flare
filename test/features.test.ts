import { describe, expect, it } from "vitest";
import { roleFlags } from "../src/nflverse/context";
import { fillPlayedWeeks } from "../src/nflverse/stats";
import { parseNews, practiceFromText } from "../src/news";
import { playoffByes, simulate, standingsFromMatchups } from "../src/playoffs";
import { projectionTrackRecord, summarizeWeeks } from "../src/scoring";
import { zeroProjectionNote } from "../src/tools";
import { inferSchedule } from "../src/waivers";

describe("zero-touch weeks", () => {
	it("adds a zero row for a week with offensive snaps but no stats row", () => {
		const rows = fillPlayedWeeks(
			[{ week: 6, targets: 2 }, { week: 7, targets: 1 }],
			[{ week: 6, offense_snaps: 70 }, { week: 7, offense_snaps: 50 }, { week: 8, offense_snaps: 57, opp: "ATL", name: "Otton", position: "TE", team: "TB" }, { week: 9, offense_snaps: 0 }],
			"00-1",
			2026,
		);
		expect(rows.map((r) => r.week)).toEqual([6, 7, 8]);
		expect(rows[2]).toMatchObject({ week: 8, filled_from_snaps: true, opp: "ATL" });
	});
});

describe("schedule-based byes", () => {
	const proj = (pts: number) => ({ week: 0, opp: "X", stats: { gp: 1, rec: pts } });
	const weeks = new Map<number, { week: number; opp: string | null; stats: Record<string, number> } | null>([
		[9, null], // Sleeper null while his team plays: projected out, not a bye
		[10, proj(10)],
		[11, null], // team idle: a real bye
	]);
	it("treats a null week as projected out when the team has a game", () => {
		const s = summarizeWeeks(weeks, 9, 11, { rec: 1 }, 0, new Set([11]));
		expect(s.byeWeeks).toEqual([11]);
		expect(s.outWeeks).toEqual([9]);
	});
	it("falls back to null-as-bye without a schedule", () => {
		expect(summarizeWeeks(weeks, 9, 11, { rec: 1 }, 0).byeWeeks).toEqual([9, 11]);
	});
});

describe("role-change flags", () => {
	it("flags collapsing usage and a projection above recent usage", () => {
		const flags = roleFlags({ games: 2, snap_pct: 57, tgt_share: 7.3, xfp: 3.5 }, { games: 5, snap_pct: 80, tgt_share: 16.8, xfp: 11.1 }, 10.2);
		expect(flags.some((f) => f.startsWith("Snaps down"))).toBe(true);
		expect(flags.some((f) => f.startsWith("Target share down"))).toBe(true);
		expect(flags.some((f) => f.includes("assumes a bigger role"))).toBe(true);
	});
	it("stays quiet for steady usage", () => {
		expect(roleFlags({ games: 3, snap_pct: 82, tgt_share: 20, xfp: 12 }, { games: 5, snap_pct: 80, tgt_share: 21, xfp: 13 }, 13)).toEqual([]);
	});
});

describe("projection track record", () => {
	it("measures bias and average miss, needing 3+ games", () => {
		expect(projectionTrackRecord([{ proj: 15, actual: 10 }, { proj: 15, actual: 10 }, { proj: 15, actual: 10 }])).toEqual({ games: 3, avg_projected: 15, avg_actual: 10, bias_pct: 50, avg_miss: 5 });
		expect(projectionTrackRecord([{ proj: 1, actual: 1 }])).toBeUndefined();
	});
});

describe("zero-projection notes", () => {
	it("explains a 0 with news, a report, a tag, or nothing", () => {
		expect(zeroProjectionNote(0, true, undefined, undefined, { title: "Ruled out", age_hours: 5 })).toMatch(/Ruled out/);
		expect(zeroProjectionNote(0, true, undefined, "Out (Quad), DNP")).toMatch(/Official report/);
		expect(zeroProjectionNote(0, true, "Out", undefined)).toMatch(/listed Out/);
		expect(zeroProjectionNote(0, true, undefined, undefined)).toMatch(/doesn't say why/);
		expect(zeroProjectionNote(0, false, undefined, undefined)).toBeUndefined();
		expect(zeroProjectionNote(12, true, undefined, undefined)).toBeUndefined();
	});
});

describe("news parsing", () => {
	it("keeps titled, timestamped items newest first", () => {
		const now = Date.UTC(2026, 10, 5, 12);
		const items = parseNews(
			[
				{ published: now - 3_600_000 * 30, source: "rotowire", metadata: { title: "Older", url: "https://x" } },
				{ published: now - 3_600_000 * 2, source: "rotoballer", metadata: { title: "Newer", description: "Body" } },
				{ published: now, metadata: {} },
				"junk",
			],
			now,
		);
		expect(items.map((n) => [n.title, n.age_hours])).toEqual([
			["Newer", 2],
			["Older", 30],
		]);
		expect(parseNews(null)).toEqual([]);
	});
});

describe("standings and playoff simulation", () => {
	const m = (roster_id: number, matchup_id: number, points: number) => ({ roster_id, matchup_id, points, starters: [], players: [] });
	it("computes records from matchup results", () => {
		const st = standingsFromMatchups([[m(1, 1, 120), m(2, 1, 100), m(3, 2, 90), m(4, 2, 90)]], [1, 2, 3, 4]);
		expect(st.get(1)).toMatchObject({ wins: 1, losses: 0, pf: 120, pa: 100 });
		expect(st.get(3)).toMatchObject({ ties: 1 });
	});
	it("gives the stronger team better odds and is deterministic", () => {
		const standings = standingsFromMatchups([], [1, 2, 3, 4]);
		const input = {
			standings,
			schedule: [
				[[1, 2], [3, 4]] as [number, number][],
				[[1, 3], [2, 4]] as [number, number][],
			],
			means: new Map([[1, [150, 150]], [2, [100, 100]], [3, [100, 100]], [4, [100, 100]]]),
			playoffTeams: 2,
			byes: 0,
			iterations: 2000,
			focus: 1,
		};
		const a = simulate(input);
		expect(a.odds.get(1)!.playoffs).toBeGreaterThan(80);
		expect(simulate(input).odds.get(1)!.playoffs).toBe(a.odds.get(1)!.playoffs);
		expect(a.focus!.if_win).toBeGreaterThanOrEqual(a.focus!.if_lose);
	});
	it("knows how many byes a bracket has", () => {
		expect(playoffByes(6)).toBe(2);
		expect(playoffByes(4)).toBe(0);
		expect(playoffByes(12)).toBe(4);
	});
});

describe("waiver schedule inference", () => {
	it("reads the main run in Pacific time, so DST doesn't shift it", () => {
		const t = (iso: string) => Date.parse(iso);
		// 7:06 AM PT is 14:06 UTC before DST ends and 15:06 UTC after.
		const r = inferSchedule([
			{ at: t("2026-10-28T14:06:00Z"), claims: 6 }, // Wed, PDT
			{ at: t("2026-11-04T15:06:00Z"), claims: 7 }, // Wed, PST
			{ at: t("2026-10-30T14:25:00Z"), claims: 1 }, // Fri per-player clear
		]);
		expect(r.main).toEqual({ weekday: "Wednesday", hour: 7, minute: 6 });
		expect(r.hourPt).toBe(7);
		expect(inferSchedule([]).main).toBeNull();
	});
});

describe("practiceFromText", () => {
	it("reads practice participation from headlines", () => {
		expect(practiceFromText("Jaxon Smith-Njigba (hamstring) did not practice Wednesday")).toEqual({ practice: "DNP", day: "Wednesday" });
		expect(practiceFromText("Puka Nacua limited at practice on Thursday")).toEqual({ practice: "Limited", day: "Thursday" });
		expect(practiceFromText("Breece Hall logs full practice Friday after limited Thursday session")).toEqual({ practice: "Full", day: "Friday" });
		expect(practiceFromText("Josh Allen throws three touchdowns in win")).toBeNull();
	});
});
