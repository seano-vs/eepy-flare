// Shared league context for tools: config, NFL state, league, users, rosters
// and the player DB, plus helpers to turn Sleeper ids into readable JSON.

import { loadPlayers, type PlayerDb, type PlayerRef } from "./players";
import { sleeper, type League, type LeagueUser, type NflState, type Roster } from "./sleeper";

export interface Config {
	leagueId: string;
	userId: string;
}

export function readConfig(env: Env): Config {
	const leagueId = (env.SLEEPER_LEAGUE_ID ?? "").trim();
	const userId = (env.SLEEPER_USER_ID ?? "").trim();
	if (!/^\d+$/.test(leagueId)) {
		throw new Error("SLEEPER_LEAGUE_ID is not set. Add it under `vars` in wrangler.jsonc (or .dev.vars locally).");
	}
	return { leagueId, userId };
}

export interface TeamInfo {
	roster_id: number;
	owner: string;
	team_name?: string;
	owner_id: string | null;
	record: string;
	pf: number;
	pa: number;
	waiver_budget_used?: number;
}

export class LeagueContext {
	private constructor(
		readonly env: Env,
		readonly config: Config,
		readonly state: NflState,
		readonly league: League,
		readonly users: LeagueUser[],
		readonly rosters: Roster[],
		readonly players: PlayerDb,
	) {}

	static async load(env: Env): Promise<LeagueContext> {
		const config = readConfig(env);
		const [state, league, users, rosters, players] = await Promise.all([
			sleeper.state(),
			sleeper.league(config.leagueId),
			sleeper.users(config.leagueId),
			sleeper.rosters(config.leagueId),
			loadPlayers(env.PLAYERS),
		]);
		return new LeagueContext(env, config, state, league, users ?? [], rosters ?? [], players);
	}

	/** Season for projections: the league's season. */
	get season(): string {
		return this.league.season;
	}

	/** Current NFL week (1 during the offseason/preseason). */
	get week(): number {
		const st = this.state;
		if (st.season_type !== "regular" && st.season_type !== "post") return 1;
		return Math.max(1, Number(st.display_week ?? st.week) || 1);
	}

	get seasonType(): string {
		return "regular";
	}

	user(userId: string | null | undefined): LeagueUser | undefined {
		return userId ? this.users.find((u) => u.user_id === userId) : undefined;
	}

	team(rosterId: number): TeamInfo {
		const r = this.rosters.find((x) => x.roster_id === rosterId);
		const u = this.user(r?.owner_id);
		const s = r?.settings ?? {};
		const info: TeamInfo = {
			roster_id: rosterId,
			owner: u?.display_name ?? (r?.owner_id ? `user ${r.owner_id}` : "(orphan)"),
			owner_id: r?.owner_id ?? null,
			record: `${s.wins ?? 0}-${s.losses ?? 0}${s.ties ? `-${s.ties}` : ""}`,
			pf: pts(s.fpts, s.fpts_decimal),
			pa: pts(s.fpts_against, s.fpts_against_decimal),
		};
		const teamName = u?.metadata?.team_name;
		if (typeof teamName === "string" && teamName.trim()) info.team_name = teamName.trim();
		if (s.waiver_budget_used != null && this.league.settings.waiver_type === 2) {
			info.waiver_budget_used = s.waiver_budget_used;
		}
		return info;
	}

	/** Roster belonging to the configured user (owner or co-owner). */
	myRoster(): Roster {
		const uid = this.config.userId;
		if (!uid) throw new Error("SLEEPER_USER_ID is not set. Add it under `vars` in wrangler.jsonc.");
		const r = this.rosters.find((x) => x.owner_id === uid || (x.co_owners ?? []).includes(uid));
		if (!r) throw new Error(`No roster in league ${this.league.league_id} belongs to user ${uid}.`);
		return r;
	}

	/**
	 * Find a roster by roster id, owner display name, team name or user id.
	 * "me"/"mine"/empty resolves to the configured user.
	 */
	findRoster(query?: string | number | null): Roster {
		if (query == null || query === "" || /^(me|my|mine|myself)$/i.test(String(query))) return this.myRoster();
		const q = String(query).trim();
		if (/^\d+$/.test(q)) {
			const n = Number(q);
			const byRid = this.rosters.find((r) => r.roster_id === n);
			if (byRid) return byRid;
			const byUid = this.rosters.find((r) => r.owner_id === q);
			if (byUid) return byUid;
		}
		const lq = q.toLowerCase();
		const match = (r: Roster, exact: boolean) => {
			const u = this.user(r.owner_id);
			const names = [u?.display_name, u?.metadata?.team_name].filter((x): x is string => typeof x === "string");
			return names.some((n) => (exact ? n.toLowerCase() === lq : n.toLowerCase().includes(lq)));
		};
		const hit = this.rosters.find((r) => match(r, true)) ?? this.rosters.find((r) => match(r, false));
		if (!hit) {
			const options = this.rosters.map((r) => `${r.roster_id}: ${this.team(r.roster_id).owner}`).join(", ");
			throw new Error(`No team matches "${q}". Teams: ${options}`);
		}
		return hit;
	}

	/** roster_id of whoever has each player, for availability checks. */
	ownership(): Map<string, number> {
		const m = new Map<string, number>();
		for (const r of this.rosters) for (const id of r.players ?? []) m.set(id, r.roster_id);
		return m;
	}

	ref(id: string): PlayerRef {
		return this.players.ref(id);
	}
}

function pts(whole?: number, dec?: number): number {
	return Math.round(((whole ?? 0) + (dec ?? 0) / 100) * 100) / 100;
}
