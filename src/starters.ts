// A confirmed new starter, week by week. When a headline reports that a player starts but Sleeper's
// projections still have someone else in the role (Carson Beck, Nov 10 2026: "set to start Week 10";
// Sleeper projected him ~1.9 for weeks 11-13 and the injured Gardner Minshew 13-19), the two swap
// projections for those weeks. That gives the new starter the role's value and takes the phantom
// starts off the incumbent, who may be on the roster being valued.

export type WeekMap = Map<string, { pos: string; pts: number }>;

export interface RoleSwap {
	week: number;
	incumbent: string;
	/** Points moved to the new starter (the incumbent's projection that week). */
	pts: number;
	/** What the new starter had been projected. */
	was: number;
}

/** A starter's projection counts as current when it's at least this share of the incumbent's. */
export const CAUGHT_UP = 0.8;

/**
 * Swap roles in each week where a teammate at his position is projected as the starter and he
 * isn't (under CAUGHT_UP of that). Weeks where his team doesn't play, or Sleeper already projects
 * him as the starter, are left alone. `fallback` covers weeks where his team plays but no one
 * at the position is projected (both zeroed): he gets that many points. Pure; exported for tests.
 */
export function applyConfirmedStarter(
	byWeek: WeekMap[],
	weekNums: number[],
	sid: string,
	pos: string,
	teamOf: (id: string) => string | undefined,
	fallback?: number,
): { weeks: WeekMap[]; swaps: RoleSwap[] } {
	const team = teamOf(sid);
	const swaps: RoleSwap[] = [];
	const weeks = byWeek.map((m, i) => {
		if (!team) return m;
		const mine = m.get(sid)?.pts ?? 0;
		const mates = [...m.entries()].filter(([id]) => id !== sid && teamOf(id) === team);
		if (!mates.length && !m.has(sid)) return m; // bye: nobody on his team projected
		const incumbent = mates.filter(([, e]) => e.pos === pos && e.pts > 0).sort((a, b) => b[1].pts - a[1].pts)[0];
		const out = new Map(m);
		if (incumbent) {
			if (mine >= CAUGHT_UP * incumbent[1].pts) return m;
			out.set(sid, { pos, pts: incumbent[1].pts });
			out.set(incumbent[0], { ...incumbent[1], pts: mine });
			swaps.push({ week: weekNums[i] ?? i, incumbent: incumbent[0], pts: incumbent[1].pts, was: mine });
			return out;
		}
		if (fallback != null && mine < CAUGHT_UP * fallback) {
			out.set(sid, { pos, pts: fallback });
			swaps.push({ week: weekNums[i] ?? i, incumbent: "", pts: fallback, was: mine });
			return out;
		}
		return m;
	});
	return { weeks, swaps };
}
