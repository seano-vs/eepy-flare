// NFL players cache.
//
// Sleeper's /players/nfl dump is ~15 MB and Sleeper asks that it be fetched at
// most once a day. The daily cron fetches it, keeps only fantasy-relevant
// players (QB/RB/WR/TE/K/DEF), compacts each to a tuple and writes one KV
// value (~400 KB). Tool calls only ever read that KV value.

import {
	FANTASY_POSITIONS,
	PLAYERS_KV_KEY as KV_KEY,
	compactPlayers,
	type PlayerTuple,
	type PlayersBlob,
	type RawPlayer,
} from "./compact-players";
import { SLEEPER_V1, SleeperError } from "./sleeper";

export { FANTASY_POSITIONS, compactPlayers, type PlayerTuple, type PlayersBlob };

export interface Player {
	id: string;
	name: string;
	pos: string;
	team: string | null;
	injury?: string;
	age?: number;
	exp?: number;
	rank?: number;
	status?: string;
}

const KV_ATTEMPT_KEY = "players:nfl:last_attempt";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Fetch the full dump from Sleeper and write the compact version to KV. */
export async function refreshPlayers(kv: KVNamespace): Promise<{ count: number; updated: string }> {
	await kv.put(KV_ATTEMPT_KEY, new Date().toISOString(), { expirationTtl: 2 * 24 * 60 * 60 });
	const res = await fetch(`${SLEEPER_V1}/players/nfl`, {
		headers: { accept: "application/json" },
	});
	if (!res.ok) throw new SleeperError(`Sleeper ${res.status} for /players/nfl`, res.status);
	const raw = (await res.json()) as Record<string, RawPlayer>;
	const blob = compactPlayers(raw);
	if (blob.count < 500) {
		// Sanity check: never overwrite a good cache with a truncated dump.
		throw new SleeperError(`players dump looked truncated (${blob.count} fantasy players)`);
	}
	await kv.put(KV_KEY, JSON.stringify(blob));
	invalidate();
	return { count: blob.count, updated: blob.updated };
}

// Parsed blob memoized per isolate; re-read from KV every 10 minutes so a cron
// refresh is picked up without a redeploy.
let cached: { at: number; db: PlayerDb } | null = null;
const MEMO_MS = 10 * 60 * 1000;

function invalidate() {
	cached = null;
}

export class PlayersNotLoadedError extends Error {
	constructor() {
		super(
			"The players cache in KV is empty. It is filled by the daily cron; to fill it now, run `npm run seed-players` (see README) or trigger the scheduled handler.",
		);
		this.name = "PlayersNotLoadedError";
	}
}

/**
 * Load the player DB from KV. If KV is empty (fresh deploy), bootstrap it once:
 * a KV marker makes sure we hit /players/nfl at most once per day even then.
 */
export async function loadPlayers(kv: KVNamespace): Promise<PlayerDb> {
	const now = Date.now();
	if (cached && now - cached.at < MEMO_MS) return cached.db;

	let blob = await kv.get<PlayersBlob>(KV_KEY, "json");
	if (!blob) {
		const lastAttempt = await kv.get(KV_ATTEMPT_KEY);
		if (lastAttempt && now - Date.parse(lastAttempt) < ONE_DAY_MS) throw new PlayersNotLoadedError();
		await refreshPlayers(kv);
		blob = await kv.get<PlayersBlob>(KV_KEY, "json");
		if (!blob) throw new PlayersNotLoadedError();
	}
	const db = new PlayerDb(blob);
	cached = { at: now, db };
	return db;
}

export function normalizeName(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
		.replace(/[^a-z0-9]/g, "");
}

export interface SearchQuery {
	name?: string;
	team?: string;
	position?: string;
	limit?: number;
}

export class PlayerDb {
	readonly updated: string;
	private readonly byId: Record<string, PlayerTuple>;
	private index: { id: string; key: string; last: string }[] | null = null;

	constructor(blob: PlayersBlob) {
		this.updated = blob.updated;
		this.byId = blob.players;
	}

	get(id: string): Player | undefined {
		const t = this.byId[id];
		if (!t) return undefined;
		const [name, pos, team, injury, age, exp, rank, status] = t;
		const p: Player = { id, name, pos, team };
		if (injury) p.injury = injury;
		if (age != null) p.age = age;
		if (exp != null) p.exp = exp;
		if (rank != null) p.rank = rank;
		if (status && status !== "Active") p.status = status;
		return p;
	}

	/** Compact reference for lists: never throws, unknown ids pass through. */
	ref(id: string): PlayerRef {
		const t = this.byId[id];
		if (!t) return { id, name: id === "0" ? "(empty)" : `Unknown player ${id}`, pos: "?" , team: null };
		const r: PlayerRef = { id, name: t[0], pos: t[1], team: t[2] };
		if (t[3]) r.injury = t[3];
		return r;
	}

	private getIndex() {
		if (!this.index) {
			this.index = Object.entries(this.byId).map(([id, t]) => {
				const parts = t[0].split(" ");
				return { id, key: normalizeName(t[0]), last: normalizeName(parts.slice(1).join(" ") || t[0]) };
			});
		}
		return this.index;
	}

	search(q: SearchQuery): Player[] {
		const name = q.name ? normalizeName(q.name) : "";
		const team = q.team?.toUpperCase();
		const pos = q.position?.toUpperCase();
		const limit = q.limit ?? 10;
		const scored: { id: string; score: number; rank: number }[] = [];
		for (const { id, key, last } of this.getIndex()) {
			const t = this.byId[id]!;
			if (team && (t[2] ?? "FA") !== team) continue;
			if (pos && t[1] !== pos) continue;
			let score = 0;
			if (name) {
				if (key === name || id.toLowerCase() === name) score = 100;
				else if (last === name) score = 80;
				else if (key.startsWith(name)) score = 60;
				else if (last.startsWith(name)) score = 50;
				else if (key.includes(name)) score = 30;
				else continue;
			}
			// Prefer rostered NFL players and prominent ones (low search_rank).
			if (t[2]) score += 5;
			scored.push({ id, score, rank: t[6] ?? 1e7 });
		}
		scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
		return scored.slice(0, limit).map((s) => this.get(s.id)!);
	}

	/**
	 * Resolve a player given either a Sleeper id or a name ("Josh Allen",
	 * "allen buf"). Throws with candidates if nothing matches.
	 */
	resolve(query: string): Player {
		const q = query.trim();
		const direct = this.get(q) ?? this.get(q.toUpperCase());
		if (direct) return direct;

		// Allow a trailing team or position hint: "Josh Allen BUF", "Allen QB".
		const words = q.split(/\s+/);
		let team: string | undefined;
		let position: string | undefined;
		while (words.length > 1) {
			const w = words[words.length - 1]!.toUpperCase().replace(/[()]/g, "");
			if (!position && (FANTASY_POSITIONS as readonly string[]).includes(w)) position = w;
			else if (!team && (w === "FA" || (/^[A-Z]{2,3}$/.test(w) && this.isTeam(w)))) team = w;
			else break;
			words.pop();
		}
		const hits = this.search({ name: words.join(" "), team, position, limit: 5 });
		if (hits.length === 0) throw new Error(`No player matches "${query}". Try search_players.`);
		return hits[0]!;
	}

	private teams: Set<string> | null = null;
	private isTeam(abbr: string): boolean {
		if (!this.teams) {
			this.teams = new Set();
			for (const t of Object.values(this.byId)) if (t[2]) this.teams.add(t[2]);
		}
		return this.teams.has(abbr);
	}
}

export interface PlayerRef {
	id: string;
	name: string;
	pos: string;
	team: string | null;
	injury?: string;
}
