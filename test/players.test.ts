import { describe, expect, it } from "vitest";
import { PlayerDb, compactPlayers, normalizeName } from "../src/players";
import { fmt, summarizeScoring, summarizeSlots } from "../src/tools";

const raw = {
	"4984": { full_name: "Josh Allen", position: "QB", team: "BUF", search_rank: 3, age: 30, status: "Active" },
	"2097": { full_name: "Josh Allen", position: "LB", team: "JAX", search_rank: 500 },
	"5000": { first_name: "Amon-Ra", last_name: "St. Brown", position: "WR", team: "DET", search_rank: 10, injury_status: "Questionable" },
	"7000": { full_name: "Kenneth Walker III", position: "RB", team: "SEA", search_rank: 40 },
	"7001": { full_name: "Keenan Allen", position: "WR", team: null, search_rank: 9999999 },
	BUF: { first_name: "Buffalo", last_name: "Bills", position: "DEF", team: "BUF" },
	"9": { full_name: "Some Lineman", position: "OT", team: "NE" },
};

const db = new PlayerDb(compactPlayers(raw, new Date("2026-10-01T00:00:00Z")));

describe("compactPlayers", () => {
	it("keeps only fantasy positions", () => {
		const blob = compactPlayers(raw);
		expect(Object.keys(blob.players).sort()).toEqual(["4984", "5000", "7000", "7001", "BUF"]);
		expect(blob.players["7001"]![6]).toBeNull(); // unranked sentinel dropped
	});
});

describe("PlayerDb", () => {
	it("resolves by id and by name, preferring prominent players", () => {
		expect(db.resolve("4984").name).toBe("Josh Allen");
		expect(db.resolve("josh allen").id).toBe("4984");
		expect(db.resolve("Allen").id).toBe("4984");
		expect(db.resolve("Allen FA").id).toBe("7001");
		expect(db.resolve("St Brown").id).toBe("5000");
		expect(db.resolve("kenneth walker").id).toBe("7000");
		expect(db.resolve("buf").id).toBe("BUF");
		expect(() => db.resolve("nobody here")).toThrow(/No player matches/);
	});

	it("searches by team and position", () => {
		expect(db.search({ team: "DET" }).map((p) => p.id)).toEqual(["5000"]);
		expect(db.search({ position: "WR" }).map((p) => p.id)).toEqual(["5000", "7001"]);
		expect(db.search({ team: "FA" }).map((p) => p.id)).toEqual(["7001"]);
	});

	it("formats unknown and empty slots without throwing", () => {
		expect(fmt(db.ref("5000"))).toBe("Amon-Ra St. Brown WR DET (Questionable)");
		expect(fmt(db.ref("0"))).toBe("(empty)");
		expect(db.ref("123").name).toMatch(/Unknown/);
	});
});

describe("normalizeName", () => {
	it("strips punctuation, accents and suffixes", () => {
		expect(normalizeName("Ja'Marr Chase")).toBe("jamarrchase");
		expect(normalizeName("Kenneth Walker III")).toBe("kennethwalker");
		expect(normalizeName("Martín Emerson Jr.")).toBe("martinemerson");
	});
});

describe("summaries", () => {
	it("compresses roster slots", () => {
		expect(summarizeSlots(["QB", "RB", "RB", "SUPER_FLEX", "BN", "BN"])).toBe("QB, RBx2, SUPER_FLEX, BNx2");
	});
	it("shows offensive scoring and hides K/DEF rules when those slots don't exist", () => {
		const s = summarizeScoring({ pass_td: 6, pass_yd: 0.04, rec: 1, fgm_50p: 5, pts_allow_0: 10, sack: 1, idp_tkl: 1 }, ["QB", "SUPER_FLEX"]);
		expect(s).toEqual({ pass_td: 6, pass_yd: "0.04 (1 pt / 25 yds)", rec: 1 });
	});
});
