import { describe, expect, it } from "vitest";
import { roleFlags, shortenedWeeks } from "../src/nflverse/context";
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

describe("dedupeNews", () => {
	const item = (title: string, source: string, age: number) => ({ title, source, published: "", age_hours: age });
	it("merges outlets reporting the same event and keeps distinct news", async () => {
		const { dedupeNews } = await import("../src/news");
		const out = dedupeNews([
			item("Rashee Rice (hamstring/knee) limited at practice Wednesday", "fantasy_pros", 16),
			item("Rashee Rice Gets in Limited Session on Wednesday", "rotoballer", 17),
			item("Rashee Rice - Limited Wednesday", "rotowire", 17),
			item("Rashee Rice catches two touchdowns in win", "rotowire", 70),
		]);
		expect(out).toHaveLength(2);
		expect(out[0]!.also).toEqual(["rotoballer", "rotowire"]);
		const taylor = dedupeNews([
			item("Jonathan Taylor Still Remains on Colts' Roster", "rotoballer", 26),
			item("Colts Asking for a Lot for Jonathan Taylor", "rotoballer", 29),
			item("Jonathan Taylor does little with a dozen touches in Week 8 loss", "fantasy_pros", 72),
		]);
		expect(taylor).toHaveLength(3);
		const out2 = dedupeNews([item("Sam Darnold - Won't play in Week 9", "rotowire", 20), item("Sam Darnold (quad) ruled out for Week 9", "fantasy_pros", 20)]);
		expect(out2).toHaveLength(1);
	});
});

describe("batch C helpers", () => {
	it("play probability, implied delta, forecast flags, lock pivots, snapshot diffs", async () => {
		const { playProbability, impliedDelta } = await import("../src/nflverse/context");
		expect(playProbability("Questionable", "Did Not Participate In Practice", "WR")).toBe(50);
		expect(playProbability("Questionable", "Full Participation in Practice", "RB")).toBe(92);
		expect(playProbability("Questionable", "Limited", "QB")).toBe(55);
		expect(playProbability("Questionable", undefined, "TE")).toBe(74);
		expect(playProbability(undefined, "Limited", "WR")).toBeUndefined();
		expect(impliedDelta(28.8, 23.9)).toMatchObject({ implied_vs_norm: 4.9, implied_note: expect.stringContaining("+0.7") });
		expect(impliedDelta(15.5, 21.3)?.implied_note).toContain("-1.0");

		const { summarizeForecast } = await import("../src/weather");
		const h = { time: ["2026-11-08T13:00", "2026-11-08T14:00", "2026-11-08T15:00", "2026-11-08T16:00"], temperature_2m: [31, 30, 30, 29], wind_speed_10m: [14, 17, 21, 18], wind_gusts_10m: [20, 28, 33, 25], precipitation_probability: [60, 70, 80, 60], precipitation: [0.05, 0.1, 0.1, 0] };
		const f = summarizeForecast(h, "2026-11-08", "13:00")!;
		expect(f.flags).toEqual(["high wind: downgrade passing and kickers", "snow likely"]);

		const { lockTimeline } = await import("../src/locks");
		const tl = lockTimeline(
			[
				{ slot: "WR", label: "Early WR", pos: "WR", kickoff: "2026-11-08 13:00", proj: 12, risk: "listed Questionable" },
				{ slot: "QB", label: "Late QB", pos: "QB", kickoff: "2026-11-08 16:25", proj: 20 },
			],
			[
				{ label: "Bench WR", pos: "WR", kickoff: "2026-11-08 16:05", proj: 9, source: "bench" },
				{ label: "Early FA", pos: "WR", kickoff: "2026-11-08 13:00", proj: 11, source: "free agent" },
				{ label: "Bench RB", pos: "RB", kickoff: "2026-11-08 20:20", proj: 15, source: "bench" },
			],
		);
		expect(tl.windows.map((w) => w.kickoff)).toEqual(["2026-11-08 13:00", "2026-11-08 16:25"]);
		expect(tl.windows[0]!.pivots![0]!.options).toEqual([expect.stringContaining("Bench WR")]);

		const { diffSnapshots, parseSince } = await import("../src/changes");
		const a = { at: "", week: 9, players: { "1": { tag: "Questionable", practice: "Limited", proj: 12 }, "2": { proj: 10 } } };
		const b = { at: "", week: 9, players: { "1": { tag: "Out", practice: "DNP", proj: 0 }, "2": { proj: 11 }, "3": {} } };
		const d = diffSnapshots(a, b, ["1", "2", "3"]);
		expect(d.find((x) => x.id === "1")!.changes).toEqual(["tag: Questionable -> Out", "practice: Limited -> DNP", "projection: 12 -> 0"]);
		expect(d.find((x) => x.id === "2")).toBeUndefined();
		expect(d.find((x) => x.id === "3")!.changes[0]).toContain("added");
		expect(parseSince("3d", 10 * 86_400_000)).toBe(7 * 86_400_000);
	});
});

describe("shortenedWeeks", () => {
	it("drops injury exits from a baseline", () => {
		const rows = [1, 2, 3, 4].map((week, i) => ({ week, offense_pct: [0.25, 0.98, 1, 0.97][i] }));
		expect([...shortenedWeeks(rows)]).toEqual([1]);
		expect(shortenedWeeks(rows.slice(0, 2)).size).toBe(0);
	});
});

describe("freshness stamps", () => {
	it("formats ET times with age and a stale marker", async () => {
		const { stamp, ago } = await import("../src/asof");
		const now = Date.parse("2026-11-05T15:00:00Z");
		expect(stamp("2026-11-05T14:23:00Z", now)).toBe("Thu, Nov 5, 9:23 AM ET (37m ago)");
		expect(stamp("2026-11-04T09:17:00Z", now, 24)).toBe("Wed, Nov 4, 4:17 AM ET (30h ago) - stale");
		expect(stamp(null, now)).toBeNull();
		expect(ago(now - 3 * 86_400_000, now)).toBe("3d ago");
	});
	it("puts absolute times and merged sources in news lines", async () => {
		const { newsLine, parseNews } = await import("../src/news");
		const [n] = parseNews([{ published: Date.parse("2026-11-05T02:14:00Z"), source: "rotowire", metadata: { title: "Rice limited Wednesday" } }], Date.parse("2026-11-05T14:14:00Z"));
		expect(newsLine({ ...n!, also: ["fantasy_pros"] })).toBe("Rice limited Wednesday (rotowire +fantasy_pros, Wed, Nov 4, 9:14 PM ET, 12h ago)");
	});
});

describe("fixPublished", () => {
	it("reads RotoBaller's feed time as Eastern wall time", async () => {
		const { fixPublished } = await import("../src/news");
		const now = Date.parse("2026-11-09T12:00:00Z");
		// Mayfield's Week 8 recap: feed says 16:31Z (11:31 AM ET, before kickoff); really 4:31 PM ET.
		expect(new Date(fixPublished(Date.parse("2026-11-01T16:31:00Z"), "rotoballer", now)).toISOString()).toBe("2026-11-01T21:31:00.000Z");
		// Summer time is 4 hours.
		expect(new Date(fixPublished(Date.parse("2026-10-25T19:20:00Z"), "rotoballer", now)).toISOString()).toBe("2026-10-25T23:20:00.000Z");
		// Other sources and would-be-future times are untouched.
		expect(fixPublished(Date.parse("2026-11-01T16:31:00Z"), "rotowire", now)).toBe(Date.parse("2026-11-01T16:31:00Z"));
		expect(fixPublished(now - 60_000, "rotoballer", now)).toBe(now - 60_000);
	});
});
