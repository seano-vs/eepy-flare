// Compaction of Sleeper's /players/nfl dump into the blob stored in KV.
// Dependency-free so scripts/seed-players.mjs can import it with plain Node.

export const PLAYERS_KV_KEY = "players:nfl:v1";

export const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
const KEEP = new Set<string>(FANTASY_POSITIONS);

/**
 * [name, position, team, injury_status, age, years_exp, search_rank, status,
 *  depth_chart_position, depth_chart_order, injury_start_date, injury_body_part, active (1/0)]
 * The last five were added in 1.5; blobs written before then simply lack them.
 */
export type PlayerTuple = [
	string,
	string,
	string | null,
	string | null,
	number | null,
	number | null,
	number | null,
	string | null,
	(string | null)?,
	(number | null)?,
	(string | null)?,
	(string | null)?,
	(0 | 1 | null)?,
];

export interface PlayersBlob {
	v: 1;
	updated: string;
	count: number;
	players: Record<string, PlayerTuple>;
}

export interface RawPlayer {
	player_id?: string;
	full_name?: string | null;
	first_name?: string | null;
	last_name?: string | null;
	position?: string | null;
	fantasy_positions?: string[] | null;
	team?: string | null;
	injury_status?: string | null;
	age?: number | null;
	years_exp?: number | null;
	search_rank?: number | null;
	status?: string | null;
	depth_chart_position?: string | null;
	depth_chart_order?: number | null;
	injury_start_date?: string | null;
	injury_body_part?: string | null;
	active?: boolean | null;
}

/** Reduce the raw Sleeper dump to the compact blob we store. Pure; exported for tests. */
export function compactPlayers(raw: Record<string, RawPlayer>, now = new Date()): PlayersBlob {
	const players: Record<string, PlayerTuple> = {};
	for (const [id, p] of Object.entries(raw)) {
		if (!p || typeof p !== "object") continue;
		const pos = p.position ?? p.fantasy_positions?.[0] ?? null;
		const relevant =
			(pos && KEEP.has(pos)) || (p.fantasy_positions ?? []).some((fp) => KEEP.has(fp));
		if (!relevant || !pos) continue;
		const name =
			p.full_name?.trim() ||
			[p.first_name, p.last_name].filter(Boolean).join(" ").trim() ||
			id;
		players[id] = [
			name,
			pos,
			p.team ?? null,
			p.injury_status ?? null,
			p.age ?? null,
			p.years_exp ?? null,
			// 9999999 is Sleeper's "unranked" sentinel; drop it to save space.
			p.search_rank != null && p.search_rank < 9_999_999 ? p.search_rank : null,
			p.status ?? null,
			p.depth_chart_position ?? null,
			p.depth_chart_order ?? null,
			p.injury_start_date ?? null,
			p.injury_body_part ?? null,
			p.active == null ? null : p.active ? 1 : 0,
		];
	}
	return { v: 1, updated: now.toISOString(), count: Object.keys(players).length, players };
}
