// Lineup lock timeline: when each starter's game kicks off (Sleeper locks a player at his
// kickoff), and for starters at risk of sitting, the bench or free-agent options whose games
// start later, so there's still time to pivot once inactives come out (~90 minutes before).

import { SLOT_ELIGIBILITY } from "./scoring";

export interface LockStarter {
	slot: string;
	label: string;
	pos: string;
	/** Sortable kickoff key "YYYY-MM-DD HH:MM" (ET); null = no game (bye/unknown). */
	kickoff: string | null;
	proj: number | null;
	/** Why he might not play (game-time tag, low play_pct, projected 0); undefined = no risk seen. */
	risk?: string;
}

export interface LockCandidate {
	label: string;
	pos: string;
	kickoff: string | null;
	proj: number;
	source: "bench" | "free agent";
}

export interface LockWindow {
	kickoff: string;
	starters: string[];
	pivots?: { for: string; risk: string; options: string[] }[];
}

/** Group starters by kickoff and list later-game pivots for risky ones. Pure; exported for tests. */
export function lockTimeline(starters: LockStarter[], candidates: LockCandidate[], perStarter = 3): { windows: LockWindow[]; no_game: string[] } {
	const windows = new Map<string, LockWindow>();
	const noGame: string[] = [];
	for (const s of starters) {
		if (!s.kickoff) {
			noGame.push(`${s.slot}: ${s.label}`);
			continue;
		}
		const w = windows.get(s.kickoff) ?? { kickoff: s.kickoff, starters: [] };
		w.starters.push(`${s.slot}: ${s.label}`);
		if (s.risk) {
			const eligible = SLOT_ELIGIBILITY[s.slot] ?? [s.pos];
			const options = candidates
				.filter((c) => c.kickoff && c.kickoff > s.kickoff! && (eligible as readonly string[]).includes(c.pos))
				.sort((a, b) => b.proj - a.proj)
				.slice(0, perStarter)
				.map((c) => `${c.label} (${c.source}, ${c.proj} proj, kicks off ${c.kickoff})`);
			(w.pivots ??= []).push({ for: s.label, risk: s.risk, options: options.length ? options : ["none in later games: decide before this kickoff"] });
		}
		windows.set(s.kickoff, w);
	}
	return { windows: [...windows.values()].sort((a, b) => a.kickoff.localeCompare(b.kickoff)), no_game: noGame };
}
