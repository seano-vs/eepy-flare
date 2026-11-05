// Waiver timing: when this league's waivers actually process (read from completed claims, not
// guessed from settings), and which available players are still on waivers after a drop.

import type { LeagueContext } from "./league";
import { sleeper, type Transaction } from "./sleeper";

export interface WaiverSchedule {
	daily: boolean;
	clear_days: number | null;
	/** The run that processes the most claims, in Eastern time, e.g. "Wednesday ~10:06 AM ET". */
	main_run: string | null;
	/** Usual processing time in Eastern and Pacific, from Sleeper's hour (Pacific) and recent runs. */
	processes_at: { eastern: string; pacific: string } | null;
	/** How dropped players clear, from the data. */
	clears: string;
	/** Raw Sleeper settings, read defensively (their meaning isn't documented). */
	settings: { waiver_day_of_week: unknown; daily_waivers_hour: unknown };
	based_on_runs: number;
}

async function allTransactions(lc: LeagueContext, weeks?: number[]): Promise<Transaction[]> {
	const ws = weeks ?? Array.from({ length: Math.max(1, lc.week) }, (_, i) => i + 1);
	return (await Promise.all(ws.map((w) => sleeper.transactions(lc.config.leagueId, w).catch(() => [])))).flat();
}

/** Wall-clock parts of an instant in a time zone. */
export function zoned(ms: number, timeZone: string): { weekday: string; hour: number; minute: number } {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
	return { weekday: get("weekday"), hour: Number(get("hour")), minute: Number(get("minute")) };
}

export function clock(hour: number, minute: number): string {
	const h = hour % 12 === 0 ? 12 : hour % 12;
	return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/** A time in Eastern ("Wed Nov 4, 10:06 AM ET"). */
export function eastern(ms: number): string {
	return `${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(new Date(ms))}, ${(() => {
		const z = zoned(ms, "America/New_York");
		return clock(z.hour, z.minute);
	})()} ET`;
}

/**
 * Pure part of the schedule inference (exported for tests). `runs` are processing runs (one per
 * minute) with their claim counts. Hours are read in Pacific time, because Sleeper's
 * daily_waivers_hour is Pacific: a fixed UTC hour drifts by one when daylight saving changes.
 */
export function inferSchedule(runs: { at: number; claims: number }[]): { main: { weekday: string; minute: number; hour: number } | null; hourPt: number | null; minutePt: number | null } {
	if (!runs.length) return { main: null, hourPt: null, minutePt: null };
	const byDay = new Map<string, number>();
	const hours = new Map<number, number>();
	for (const r of runs) {
		const pt = zoned(r.at, "America/Los_Angeles");
		byDay.set(pt.weekday, (byDay.get(pt.weekday) ?? 0) + r.claims);
		hours.set(pt.hour, (hours.get(pt.hour) ?? 0) + r.claims);
	}
	const hourPt = [...hours.entries()].sort((a, b) => b[1] - a[1])[0]![0];
	const mainDay = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0]![0];
	// The latest run on the main day at the usual hour gives the minute.
	const latest = runs.filter((r) => zoned(r.at, "America/Los_Angeles").weekday === mainDay).sort((a, b) => b.at - a.at)[0]!;
	const z = zoned(latest.at, "America/Los_Angeles");
	return { main: { weekday: mainDay, hour: z.hour, minute: z.minute }, hourPt, minutePt: z.minute };
}

/** Convert a Pacific wall time to Eastern (always +3 hours: both zones shift together). */
function ptToEt(hour: number, minute: number) {
	return { hour: (hour + 3) % 24, minute };
}

export async function waiverSchedule(lc: LeagueContext): Promise<WaiverSchedule> {
	const s = lc.league.settings;
	const txs = await allTransactions(lc);
	// One processing run moves many claims at once: group completed claims by minute.
	const runCounts = new Map<number, number>();
	for (const t of txs) {
		if (t.type !== "waiver" || t.status !== "complete" || !t.status_updated) continue;
		const m = Math.floor(t.status_updated / 60000) * 60000;
		runCounts.set(m, (runCounts.get(m) ?? 0) + 1);
	}
	const runs = [...runCounts.entries()].map(([at, claims]) => ({ at, claims }));
	const inf = inferSchedule(runs);
	const settingHour = s.daily_waivers_hour != null && Number.isFinite(Number(s.daily_waivers_hour)) ? Number(s.daily_waivers_hour) : null;
	const hourPt = settingHour ?? inf.hourPt;
	const minute = inf.main && inf.main.hour === hourPt ? inf.main.minute : (inf.minutePt ?? 0);
	const et = hourPt != null ? ptToEt(hourPt, minute) : null;
	const clearDays = s.waiver_clear_days != null ? Number(s.waiver_clear_days) : null;
	return {
		daily: Number(s.daily_waivers) === 1,
		clear_days: clearDays,
		main_run: inf.main ? `${inf.main.weekday} ~${clock(ptToEt(inf.main.hour, inf.main.minute).hour, inf.main.minute)} ET` : null,
		processes_at: hourPt != null && et ? { eastern: `${clock(et.hour, et.minute)} ET`, pacific: `${clock(hourPt, minute)} PT` } : null,
		clears:
			clearDays != null
				? `A dropped player stays on waivers about ${clearDays} days after the drop and clears at varying hours; most claims process in the main run.`
				: "Unknown clear window.",
		settings: { waiver_day_of_week: s.waiver_day_of_week ?? null, daily_waivers_hour: s.daily_waivers_hour ?? null },
		based_on_runs: runs.length,
	};
}

export interface WaiverStatus {
	status: "on waivers" | "free agent";
	dropped_by?: string;
	dropped_at?: string;
	/** Earliest time he can clear, in Eastern: drop + clear days. */
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
				dropped_at: eastern(at),
				clears_after: eastern(at + clearDays * 86_400_000),
			});
		} else {
			out.set(id, { status: "free agent" });
		}
	}
	return out;
}
