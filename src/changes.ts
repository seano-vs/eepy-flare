// "What changed since": hourly snapshots of every rostered player's injury tag, official report
// status/practice and this week's projection (KV, kept 14 days), diffed against the current state.
// Headlines and transactions carry their own timestamps, so they're filtered by time directly.

import type { LeagueContext } from "./league";
import { NflData } from "./nflverse/stats";
import { round, weekPool } from "./scoring";

export interface PlayerState {
	tag?: string;
	report?: string;
	practice?: string;
	proj?: number;
}

export interface Snapshot {
	at: string;
	week: number;
	players: Record<string, PlayerState>;
}

const PREFIX = "snap:";
const TTL = 14 * 86_400;

const PRACTICE: Record<string, string> = {
	"Did Not Participate In Practice": "DNP",
	"Limited Participation in Practice": "Limited",
	"Full Participation in Practice": "Full",
};

/** Current state of every rostered player in the league. */
export async function takeSnapshot(lc: LeagueContext): Promise<Snapshot> {
	const ids = [...lc.ownership().keys()];
	const pool = new Map((await weekPool(lc.env.PLAYERS, lc.league, lc.season, lc.week, lc.seasonType)).map((e) => [e.id, e.pts]));
	const report = new Map<string, { status?: string; practice?: string }>();
	try {
		const nfl = NflData.from(lc.env, lc.season);
		const [cur, maps] = await Promise.all([nfl.currentInjuries(), nfl.idMaps()]);
		for (const r of cur.rows) {
			if (Number(r.week) !== cur.week) continue;
			const sid = maps.byGsis.get(String(r.gsis_id));
			if (sid) report.set(sid, { ...(r.report_status ? { status: String(r.report_status) } : {}), ...(r.practice_status ? { practice: PRACTICE[String(r.practice_status)] ?? String(r.practice_status) } : {}) });
		}
	} catch {
		// nflverse unavailable: tags and projections still compare.
	}
	const players: Record<string, PlayerState> = {};
	for (const id of ids) {
		const p = lc.players.get(id);
		const rep = report.get(id);
		const st: PlayerState = {};
		if (p?.injury) st.tag = p.injury;
		if (rep?.status) st.report = rep.status;
		if (rep?.practice) st.practice = rep.practice;
		if (pool.has(id)) st.proj = round(pool.get(id)!, 1);
		players[id] = st;
	}
	return { at: new Date().toISOString(), week: lc.week, players };
}

/** Hourly from the cron: one snapshot per hour, kept 14 days. */
export async function saveSnapshot(lc: LeagueContext): Promise<void> {
	const snap = await takeSnapshot(lc);
	await lc.env.PLAYERS.put(`${PREFIX}${snap.at.slice(0, 13)}`, JSON.stringify(snap), { expirationTtl: TTL });
}

/** Latest snapshot taken at or before `sinceMs`, else the oldest one kept. */
export async function findSnapshot(kv: KVNamespace, sinceMs: number): Promise<Snapshot | null> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: PREFIX, cursor });
		keys.push(...page.keys.map((k) => k.name));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	if (!keys.length) return null;
	keys.sort();
	const hour = new Date(sinceMs).toISOString().slice(0, 13);
	const before = keys.filter((k) => k.slice(PREFIX.length) <= hour);
	const key = before[before.length - 1] ?? keys[0]!;
	return kv.get<Snapshot>(key, "json");
}

export interface PlayerChange {
	id: string;
	changes: string[];
}

/** Status, practice and projection moves between two snapshots. Pure; exported for tests. */
export function diffSnapshots(before: Snapshot, after: Snapshot, ids: string[], projThreshold = 2): PlayerChange[] {
	const out: PlayerChange[] = [];
	const sameWeek = before.week === after.week;
	for (const id of ids) {
		const a = before.players[id];
		const b = after.players[id];
		if (!b) continue;
		if (!a) {
			out.push({ id, changes: ["added to a roster since then"] });
			continue;
		}
		const c: string[] = [];
		if ((a.tag ?? "") !== (b.tag ?? "")) c.push(`tag: ${a.tag ?? "none"} -> ${b.tag ?? "none"}`);
		if ((a.report ?? "") !== (b.report ?? "")) c.push(`game status: ${a.report ?? "none"} -> ${b.report ?? "none"}`);
		if ((a.practice ?? "") !== (b.practice ?? "") && b.practice) c.push(`practice: ${a.practice ?? "none"} -> ${b.practice}`);
		if (sameWeek && a.proj != null && b.proj != null && Math.abs(b.proj - a.proj) > projThreshold) c.push(`projection: ${a.proj} -> ${b.proj}`);
		if (c.length) out.push({ id, changes: c });
	}
	return out;
}

/** "24h", "3d", "90m" or an ISO time -> epoch ms. */
export function parseSince(since: string | undefined, now = Date.now()): number {
	const s = (since ?? "24h").trim();
	const m = /^(\d+(?:\.\d+)?)\s*([mhd])$/i.exec(s);
	if (m) return now - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as "m" | "h" | "d"];
	const t = Date.parse(s);
	if (!Number.isFinite(t)) throw new Error(`Can't read since="${since}". Use e.g. "24h", "3d" or an ISO time.`);
	return t;
}
