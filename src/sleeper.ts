// Thin client for the public Sleeper API.
//
// Every GET goes through a small per-isolate memo plus Cloudflare's edge cache
// (`cf.cacheTtl`), so repeated tool calls inside a conversation don't hit
// Sleeper again. Sleeper's limit is 1000 req/min; we stay far below it.

export const SLEEPER_V1 = "https://api.sleeper.app/v1";
// Undocumented endpoints used by the Sleeper web app. Shapes are checked by
// callers; anything unexpected is treated as "no projection" rather than thrown.
export const SLEEPER_APP = "https://api.sleeper.app";
export const SLEEPER_COM = "https://api.sleeper.com";

const USER_AGENT = "eepy-flare-sleeper-mcp/1.0 (+https://github.com/seano-vs/eepy-flare)";

export class SleeperError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "SleeperError";
	}
}

type MemoEntry = { expires: number; value: Promise<unknown> };
const memo = new Map<string, MemoEntry>();
const MEMO_MAX = 200;

export async function getJson<T>(url: string, ttlSeconds = 60): Promise<T> {
	const now = Date.now();
	const hit = memo.get(url);
	if (hit && hit.expires > now) return hit.value as Promise<T>;

	const value = (async () => {
		const res = await fetch(url, {
			headers: { accept: "application/json", "user-agent": USER_AGENT },
			cf: { cacheTtl: ttlSeconds, cacheEverything: true },
		});
		if (!res.ok) {
			throw new SleeperError(`Sleeper ${res.status} for ${new URL(url).pathname}`, res.status);
		}
		return (await res.json()) as T;
	})();

	if (memo.size >= MEMO_MAX) {
		for (const [k, v] of memo) if (v.expires <= now) memo.delete(k);
		if (memo.size >= MEMO_MAX) memo.clear();
	}
	memo.set(url, { expires: now + ttlSeconds * 1000, value });
	// Don't memoize failures.
	value.catch(() => memo.delete(url));
	return value;
}

// ---------- Types (only the fields we use) ----------

export interface NflState {
	week: number;
	display_week?: number;
	leg?: number;
	season: string;
	season_type: string;
	league_season?: string;
}

export interface League {
	league_id: string;
	name: string;
	season: string;
	status: string;
	total_rosters: number;
	roster_positions: string[];
	scoring_settings: Record<string, number>;
	settings: Record<string, number | null | undefined>;
	previous_league_id?: string | null;
	draft_id?: string | null;
}

export interface Roster {
	roster_id: number;
	owner_id: string | null;
	co_owners?: string[] | null;
	players: string[] | null;
	starters: string[] | null;
	reserve?: string[] | null;
	taxi?: string[] | null;
	settings: Record<string, number | undefined>;
	metadata?: Record<string, string> | null;
}

export interface LeagueUser {
	user_id: string;
	display_name: string;
	metadata?: { team_name?: string } & Record<string, unknown>;
}

export interface Matchup {
	roster_id: number;
	matchup_id: number | null;
	points: number | null;
	custom_points?: number | null;
	starters: string[] | null;
	starters_points?: number[] | null;
	players: string[] | null;
	players_points?: Record<string, number> | null;
}

export interface DraftPick {
	season: string;
	round: number;
	roster_id: number;
	previous_owner_id: number;
	owner_id: number;
}

export interface Transaction {
	transaction_id: string;
	type: string;
	status: string;
	created: number;
	status_updated?: number;
	leg?: number;
	creator?: string;
	roster_ids: number[];
	adds: Record<string, number> | null;
	drops: Record<string, number> | null;
	draft_picks: DraftPick[] | null;
	waiver_budget?: { sender: number; receiver: number; amount: number }[] | null;
	settings?: { waiver_bid?: number; priority?: number } | null;
	metadata?: { notes?: string } | null;
}

export interface TrendingEntry {
	player_id: string;
	count: number;
}

// ---------- Endpoints ----------

export const sleeper = {
	state: () => getJson<NflState>(`${SLEEPER_V1}/state/nfl`, 300),
	league: (id: string) => getJson<League>(`${SLEEPER_V1}/league/${enc(id)}`, 300),
	rosters: (id: string) => getJson<Roster[]>(`${SLEEPER_V1}/league/${enc(id)}/rosters`, 60),
	users: (id: string) => getJson<LeagueUser[]>(`${SLEEPER_V1}/league/${enc(id)}/users`, 300),
	matchups: (id: string, week: number) =>
		getJson<Matchup[]>(`${SLEEPER_V1}/league/${enc(id)}/matchups/${week}`, 30),
	transactions: (id: string, week: number) =>
		getJson<Transaction[]>(`${SLEEPER_V1}/league/${enc(id)}/transactions/${week}`, 60),
	tradedPicks: (id: string) => getJson<DraftPick[]>(`${SLEEPER_V1}/league/${enc(id)}/traded_picks`, 300),
	trending: (kind: "add" | "drop", lookbackHours: number, limit: number) =>
		getJson<TrendingEntry[]>(
			`${SLEEPER_V1}/players/nfl/trending/${kind}?lookback_hours=${lookbackHours}&limit=${limit}`,
			600,
		),
	/** Undocumented: every projected player at the given positions for one week. ~2 MB. */
	weekProjections: (season: string, week: number, seasonType: string, positions: readonly string[]) =>
		getJson<unknown>(
			`${SLEEPER_APP}/projections/nfl/${enc(season)}/${week}?season_type=${enc(seasonType)}&${positions
				.map((p) => `position[]=${enc(p)}`)
				.join("&")}`,
			1800,
		),
	/** Undocumented: season-long projections (incl. ADP such as adp_dynasty_2qb) per player. ~3 MB. */
	seasonProjections: (season: string, seasonType: string, positions: readonly string[]) =>
		getJson<unknown>(
			`${SLEEPER_APP}/projections/nfl/${enc(season)}?season_type=${enc(seasonType)}&${positions
				.map((p) => `position[]=${enc(p)}`)
				.join("&")}`,
			3600,
		),
	/** Undocumented: one player's projections for every week of a season, keyed by week. */
	playerProjections: (playerId: string, season: string, seasonType: string) =>
		getJson<unknown>(
			`${SLEEPER_COM}/projections/nfl/player/${enc(playerId)}?season_type=${enc(seasonType)}&season=${enc(season)}&grouping=week`,
			1800,
		),
	/** Undocumented: one player's actual stats for every week of a season, keyed by week. */
	playerStats: (playerId: string, season: string, seasonType: string) =>
		getJson<unknown>(
			`${SLEEPER_COM}/stats/nfl/player/${enc(playerId)}?season_type=${enc(seasonType)}&season=${enc(season)}&grouping=week`,
			900,
		),
};

function enc(s: string): string {
	return encodeURIComponent(s);
}
