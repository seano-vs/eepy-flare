import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvColumns } from "../src/nflverse/csv";
import { aggregatePbp, bucketOf, dataset, rankEcr } from "../src/nflverse/datasets";
import { describeInjury, weeklyStale } from "../src/nflverse/context";
import { expectedPoints, leaguePoints, sleeperTeam, unmappedRules } from "../src/nflverse/stats";
import { extractRows } from "../src/nflverse/sync";

const LEAGUE = { pass_yd: 0.04, pass_td: 6, pass_int: -2, rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2, rec_2pt: 2 };

describe("parseCsv", () => {
	it("handles quotes, embedded commas/newlines, escaped quotes and CRLF", () => {
		const { header, rows } = parseCsv('a,b,c\r\n1,"x, y",3\r\n4,"he said ""hi""\nthere",\r\n');
		expect(header).toEqual(["a", "b", "c"]);
		expect(rows).toEqual([
			["1", "x, y", "3"],
			["4", 'he said "hi"\nthere', ""],
		]);
	});
	it("skips blank lines and tolerates a missing final newline", () => {
		expect(parseCsv("a,b\n\n1,2").rows).toEqual([["1", "2"]]);
	});
});

describe("parseCsvColumns", () => {
	const csv = 'id,name,pos,url,pts\n1,"Smith, Jr.",WR,"https://x/a,b",12.5\n2,Lineman,OT,"",0\n3,"Say ""Hey""",TE,u,3\n';
	it("extracts only requested columns, in requested order, including quoted commas", () => {
		const { rows } = parseCsvColumns(csv, ["pts", "name", "missing"]);
		expect(rows).toEqual([
			["12.5", "Smith, Jr.", ""],
			["0", "Lineman", ""],
			["3", 'Say "Hey"', ""],
		]);
	});
	it("drops lines early with a prefilter", () => {
		const { rows } = parseCsvColumns(csv, ["id", "pos"], { column: "pos", accept: (v) => v !== "OT" });
		expect(rows).toEqual([
			["1", "WR"],
			["3", "TE"],
		]);
	});
	it("agrees with the full parser", () => {
		const full = parseCsv(csv);
		expect(parseCsvColumns(csv, full.header).rows).toEqual(full.rows);
	});
});

describe("extractRows", () => {
	it("maps, converts and filters to fantasy positions", () => {
		const csv = [
			"player_id,player_display_name,position,season,week,season_type,team,opponent_team,receptions,targets,target_share,receiving_yards,extra",
			"00-1,Puka Nacua,WR,2026,8,REG,LA,SF,9,12,0.333333333,121,x",
			"00-2,Some Lineman,OT,2026,8,REG,LA,SF,0,0,NA,0,x",
		].join("\n");
		// Only the columns this test provides; the real file has them all.
		const d = { ...dataset("player_week") };
		d.columns = d.columns.filter((c) => ["season", "week", "season_type", "gsis_id", "name", "position", "team", "opp", "receptions", "targets", "target_share", "receiving_yards"].includes(c.name));
		const rows = extractRows(d, csv, "2026");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual([2026, 8, "REG", "00-1", "Puka Nacua", "WR", "LA", "SF", 9, 12, 121, 0.3333]);
	});
	it("fails loudly when upstream drops a column", () => {
		expect(() => extractRows(dataset("snaps"), "season,week\n2026,1", "2026")).toThrow(/upstream columns missing/);
	});
	it("keeps only the current season from the all-seasons schedule file", () => {
		const d = dataset("games");
		const header = d.columns.map((c) => c.from ?? c.name).join(",");
		const row = (season: number) => d.columns.map((c) => (c.name === "season" ? season : c.type === "TEXT" ? "x" : 1)).join(",");
		expect(extractRows(d, `${header}\n${row(2025)}\n${row(2026)}`, "2026")).toHaveLength(1);
	});
	it("computes the ID-map bucket and drops rows without a Sleeper id", () => {
		const d = dataset("player_ids");
		const csv = "sleeper_id,gsis_id,pfr_id,fantasypros_id,name,position,team\n4984,00-0034857,AlleJo02,19781,Josh Allen,QB,BUF\nNA,00-9,X,1,Nobody,QB,BUF\n123,00-8,Y,2,Lineman,OT,NE";
		const rows = extractRows(d, csv, "2026");
		expect(rows).toEqual([["4984", "00-0034857", "AlleJo02", "19781", "Josh Allen", "QB", "BUF", bucketOf("4984")]]);
	});
});

describe("league scoring on nflverse rows", () => {
	it("scores actual box scores with 6-pt pass TDs and fumbles from all sources", () => {
		const qb = { position: "QB", passing_yards: 250, passing_tds: 2, passing_interceptions: 1, rushing_yards: 30, sack_fumbles_lost: 1 };
		expect(leaguePoints(qb, LEAGUE)).toBe(10 + 12 - 2 + 3 - 2);
		const wr = { position: "WR", receptions: 2, receiving_yards: 36, receiving_tds: 1, receiving_2pt_conversions: 1 };
		expect(leaguePoints(wr, LEAGUE)).toBe(2 + 3.6 + 6 + 2);
	});
	it("scores expected points and applies TE premium only to TEs", () => {
		const te = { position: "TE", receptions_exp: 5, rec_yards_gained_exp: 50, rec_touchdown_exp: 0.5 };
		expect(expectedPoints(te, { ...LEAGUE, bonus_rec_te: 0.5 })).toBe(5 + 5 + 3 + 2.5);
		expect(expectedPoints({ ...te, position: "WR" }, { ...LEAGUE, bonus_rec_te: 0.5 })).toBe(13);
	});
	it("reports offensive rules it can't reproduce", () => {
		expect(unmappedRules({ ...LEAGUE, rec_40p: 2, bonus_rec_yd_100: 3, pts_allow_0: 10 })).toEqual(["bonus_rec_yd_100", "rec_40p"]);
		expect(unmappedRules(LEAGUE)).toEqual([]);
	});
	it("normalises the Rams abbreviation", () => {
		expect(sleeperTeam("LA")).toBe("LAR");
		expect(sleeperTeam("KC")).toBe("KC");
	});
});

describe("play-by-play aggregation", () => {
	const play = (o: Record<string, unknown>) => ({ season: 2026, week: 8, posteam: "IND", two_point_attempt: 0, ...o });
	const rows = aggregatePbp([
		play({ play_type: "pass", yardline_100: 15, air_yards: 15, passer_player_id: "QB1", receiver_player_id: "WR1" }), // RZ + end-zone target
		play({ play_type: "pass", yardline_100: 60, air_yards: 25, passer_player_id: "QB1", receiver_player_id: "WR1" }), // deep
		play({ play_type: "pass", yardline_100: 8, air_yards: 3, passer_player_id: "QB1", receiver_player_id: "TE1" }), // RZ target
		play({ play_type: "pass", yardline_100: 10, air_yards: null, passer_player_id: "QB1" }), // sack: not an attempt
		play({ play_type: "run", yardline_100: 4, rusher_player_id: "RB1" }), // goal line
		play({ play_type: "run", yardline_100: 18, rusher_player_id: "RB1" }),
		play({ play_type: "run", yardline_100: 2, rusher_player_id: "RB1", two_point_attempt: 1 }), // ignored
	]);
	const by = (id: string) => rows.find((r) => r[2] === id)!;
	// [season, week, gsis, team, rz_tgt, rz_tgt_share, ez_tgt, deep_tgt, rz_car, rz_car_share, i10, i5, rz_att]
	it("counts red-zone, end-zone and deep targets with team share", () => {
		expect(by("WR1").slice(4, 8)).toEqual([1, 0.5, 1, 1]);
		expect(by("TE1").slice(4, 8)).toEqual([1, 0.5, 0, 0]);
	});
	it("counts red-zone and goal-line carries, skipping two-point tries", () => {
		expect(by("RB1").slice(8, 12)).toEqual([2, 1, 1, 1]);
	});
	it("counts red-zone pass attempts but not sacks", () => {
		expect(by("QB1")[12]).toBe(2);
	});
});

describe("FantasyPros ECR", () => {
	it("keeps superflex/positional pages and ranks by consensus", () => {
		const rec = (page_type: string, id: string, ecr: string) => ({ page_type, id, player: id, pos: "WR", team: "DET", ecr, sd: "1", best: "1", worst: "3", scrape_date: "2026-10-30" });
		const rows = rankEcr([rec("weekly-wr", "2", "3.5"), rec("weekly-wr", "1", "1.2"), rec("weekly-lb", "9", "1"), rec("weekly-wr", "x", "2")]);
		expect(rows.map((r) => [r[0], r[1], r[5]])).toEqual([
			["1", "weekly-wr", 1],
			["2", "weekly-wr", 2],
		]);
	});
	it("treats weekly ranks scraped before this week's Tuesday as stale", () => {
		const thursday = new Date("2026-11-05T12:00:00Z");
		expect(weeklyStale("2026-10-30", thursday)).toBe(true);
		expect(weeklyStale("2026-11-03", thursday)).toBe(false);
		expect(weeklyStale("2026-11-04", thursday)).toBe(false);
		expect(weeklyStale("garbage", thursday)).toBe(true);
	});
});

describe("injury descriptions", () => {
	it("combines status, injury and practice", () => {
		expect(describeInjury({ report_status: "Questionable", report_injury: "Ankle", practice_status: "Limited Participation in Practice" })).toBe("Questionable (Ankle), Limited");
		expect(describeInjury({ report_status: "", practice_injury: "Hamstring", practice_status: "Did Not Participate In Practice" })).toBe("On report (Hamstring), DNP");
		expect(describeInjury({})).toBeUndefined();
	});
});
