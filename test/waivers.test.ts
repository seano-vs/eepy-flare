// Game-start waiver hold. test/fixtures/league-adds-2026-w1-10.json holds this league's real
// completed adds through week 10 (Sleeper transactions: type, time, player's team) and each team's
// 2026 kickoffs (nflverse schedule, Eastern wall time).
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/league-adds-2026-w1-10.json";
import { gameHold, nextMainRun, zonedEpoch, type MainRun } from "../src/waivers";

const MAIN: MainRun = { weekday: "Wednesday", hour: 7, minute: 5 }; // 10:05 AM ET, this league's run
const et = (iso: string) => {
	const [d, t] = iso.split("T");
	const [y, mo, dd] = d!.split("-").map(Number);
	const [h, mi] = t!.split(":").map(Number);
	return zonedEpoch(y!, mo!, dd!, h!, mi!, "America/New_York");
};
const kicks = (team: string) => ((fixture.kickoffs_et as Record<string, string[]>)[team] ?? []).map(et);

describe("time helpers", () => {
	it("converts Eastern wall time to instants across daylight saving", () => {
		expect(new Date(et("2026-11-08T13:00")).toISOString()).toBe("2026-11-08T18:00:00.000Z"); // EST
		expect(new Date(et("2026-10-25T13:00")).toISOString()).toBe("2026-10-25T17:00:00.000Z"); // EDT
	});
	it("finds the next Wednesday run after a kickoff", () => {
		expect(new Date(nextMainRun(et("2026-11-08T13:00"), MAIN)).toISOString()).toBe("2026-11-11T15:05:00.000Z"); // Sunday -> Wed 10:05 ET
		expect(new Date(nextMainRun(et("2026-11-05T20:15"), MAIN)).toISOString()).toBe("2026-11-11T15:05:00.000Z"); // Thursday -> next Wed
		expect(new Date(nextMainRun(et("2026-11-09T20:15"), MAIN)).toISOString()).toBe("2026-11-11T15:05:00.000Z"); // Monday night -> that Wed
		expect(new Date(nextMainRun(et("2026-10-25T13:00"), MAIN)).toISOString()).toBe("2026-10-28T14:05:00.000Z"); // EDT: 10:05 ET = 14:05Z
	});
});

describe("gameHold rules", () => {
	const sunday = [et("2026-11-08T13:00")];
	it("holds from kickoff until the run, not before or after", () => {
		expect(gameHold(sunday, et("2026-11-08T12:59"), MAIN)).toBeNull();
		expect(gameHold(sunday, et("2026-11-08T13:00"), MAIN)).toEqual({ kickoff: sunday[0], until: et("2026-11-11T10:05") });
		expect(gameHold(sunday, et("2026-11-10T22:00"), MAIN)).not.toBeNull(); // Tuesday night: still held
		expect(gameHold(sunday, et("2026-11-11T10:05"), MAIN)).toBeNull(); // released at the run
	});
	it("leaves a team on bye or not yet playing free", () => {
		expect(gameHold([], et("2026-11-08T16:00"), MAIN)).toBeNull();
		expect(gameHold([et("2026-11-09T20:15")], et("2026-11-08T16:00"), MAIN)).toBeNull(); // MNF team on Sunday
	});
});

describe("matches this league's real transactions (weeks 1-10)", () => {
	const adds = fixture.adds as { type: string; at: number; created: number; team: string; player: string }[];
	it("never holds a player someone actually added as a free agent", () => {
		const fa = adds.filter((a) => a.type === "free_agent");
		expect(fa.length).toBe(70);
		const held = fa.filter((a) => gameHold(kicks(a.team), a.at, MAIN));
		expect(held.map((a) => a.player)).toEqual([]);
	});
	it("counts the claims submitted inside a hold as an independent Python check did (44 of 73)", () => {
		const claims = adds.filter((a) => a.type === "waiver") as { created: number; team: string }[];
		expect(claims.length).toBe(73);
		expect(claims.filter((a) => gameHold(kicks(a.team), a.created, MAIN)).length).toBe(44);
	});
});
