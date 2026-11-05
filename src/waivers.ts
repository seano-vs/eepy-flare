// Waiver timing: when this league's waivers actually process (read from completed claims, not
// guessed from settings), and which available players are still on waivers after a drop.

import type { LeagueContext } from "./league";
import { sleeper, type Transaction } from "./sleeper";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface WaiverSchedule {
	daily: boolean;
	clear_days: number | null;
	/** Most common processing time of completed claims, e.g. "15:00 UTC" (null if no claims). */
	processes_at_utc: string | null;
	/** Weekday(s) claims processed on, most common first. */
	process_days: string[];
	/** Raw Sleeper settings, read defensively (their meaning isn't documented). */
	settings: { waiver_day_of_week: unknown; daily_waivers_hour: unknown };
	based_on_claims: number;
}

async function allTransactions(lc: LeagueContext, weeks?: number[]): Promise<Transaction[]> {
	const ws = weeks ?? Array.from({ length: Math.max(1, lc.week) }, (_, i) => i + 1);
	return (await Promise.all(ws.map((w) => sleeper.transactions(lc.config.leagueId, w).catch(() => [])))).flat();
}

/** Pure part of the schedule inference (exported for tests). */
export function inferSchedule(processedAt: number[]): { hour: string | null; days: string[] } {
	if (!processedAt.length) return { hour: null, days: [] };
	const hours = new Map<string, number>();
	const days = new Map<string, number>();
	for (const t of processedAt) {
		const d = new Date(t);
		const h = `${String(d.getUTCHours()).padStart(2, "0")}:00 UTC`;
		hours.set(h, (hours.get(h) ?? 0) + 1);
		const day = DAYS[d.getUTCDay()]!;
		days.set(day, (days.get(day) ?? 0) + 1);
	}
	const top = [...hours.entries()].sort((a, b) => b[1] - a[1])[0]![0];
	return { hour: top, days: [...days.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d) };
}

export async function waiverSchedule(lc: LeagueContext): Promise<WaiverSchedule> {
	const s = lc.league.settings;
	const txs = await allTransactions(lc);
	// One processing run moves many claims at once; dedupe by minute.
	const runs = [...new Set(txs.filter((t) => t.type === "waiver" && t.status === "complete" && t.status_updated).map((t) => Math.floor(t.status_updated! / 60000) * 60000))];
	const inf = inferSchedule(runs);
	return {
		daily: Number(s.daily_waivers) === 1,
		clear_days: s.waiver_clear_days != null ? Number(s.waiver_clear_days) : null,
		processes_at_utc: inf.hour,
		process_days: inf.days,
		settings: { waiver_day_of_week: s.waiver_day_of_week ?? null, daily_waivers_hour: s.daily_waivers_hour ?? null },
		based_on_claims: runs.length,
	};
}

export interface WaiverStatus {
	status: "on waivers" | "free agent";
	dropped_by?: string;
	dropped_at?: string;
	/** Earliest time he can clear: drop + clear days (he clears at the next processing run after that). */
	clears_after?: string;
}

/**
 * For unrostered players: on waivers if dropped within the league's clear window, else a free
 * agent. Sleeper also puts players whose game has kicked off on waivers until the next run,
 * which this can't see; the tools say so.
 */
export async function waiverStatuses(lc: LeagueContext, playerIds: string[]): Promise<Map<string, WaiverStatus>> {
	const out = new Map<string, WaiverStatus>();
	const clearDays = Number(lc.league.settings.waiver_clear_days ?? 2);
	const weeks = [lc.week - 1, lc.week].filter((w) => w >= 1);
	const txs = (await allTransactions(lc, weeks)).filter((t) => t.status === "complete" && t.drops);
	const owned = lc.ownership();
	const now = Date.now();
	for (const id of playerIds) {
		if (owned.has(id)) continue;
		const drops = txs.filter((t) => t.drops && id in t.drops).sort((a, b) => (b.status_updated ?? b.created) - (a.status_updated ?? a.created));
		const last = drops[0];
		const at = last ? (last.status_updated ?? last.created) : null;
		if (last && at && now < at + clearDays * 86_400_000) {
			out.set(id, {
				status: "on waivers",
				dropped_by: lc.team(last.drops![id]!).owner,
				dropped_at: new Date(at).toISOString(),
				clears_after: new Date(at + clearDays * 86_400_000).toISOString(),
			});
		} else {
			out.set(id, { status: "free agent" });
		}
	}
	return out;
}
