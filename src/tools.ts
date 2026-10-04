import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LeagueContext } from "./league";
import type { Player, PlayerRef } from "./players";
import {
	computeReplacement,
	lastFantasyWeek,
	optimalLineup,
	round,
	valuePlayer,
	weekPool,
	type PlayerValuation,
	type ProjectedEntry,
	type Replacement,
} from "./scoring";
import { sleeper, type Roster, type Transaction } from "./sleeper";

export const SERVER_NAME = "sleeper-fantasy";
export const SERVER_VERSION = "1.0.0";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function fail(err: unknown): ToolResult {
	const message = err instanceof Error ? err.message : String(err);
	return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** "Josh Allen QB BUF (Questionable)" — the compact form used in every list. */
export function fmt(p: PlayerRef | Player): string {
	if (p.id === "0") return "(empty)";
	return `${p.name} ${p.pos} ${p.team ?? "FA"}${p.injury ? ` (${p.injury})` : ""}`;
}

const weekArg = z
	.number()
	.int()
	.min(1)
	.max(18)
	.optional()
	.describe("NFL week (1-18). Defaults to the current week.");

export function createServer(env: Env): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			instructions:
				"Read-only tools for one Sleeper fantasy football league (call get_league_settings for its format and scoring). " +
				"Players can be referenced by name (optionally with team/position, e.g. 'Josh Allen BUF') or Sleeper id. " +
				"'me' / omitted team means the configured user's roster. Projections are Sleeper's, re-scored with this league's scoring; " +
				"VOR is value over a replacement-level starter given the league's lineup slots.",
		},
	);

	const ctx = () => LeagueContext.load(env);

	async function replacementFor(lc: LeagueContext, week: number): Promise<{ pool: ProjectedEntry[]; repl: Replacement | null }> {
		const pool = await weekPool(env.PLAYERS, lc.league, lc.season, week, lc.seasonType);
		if (pool.length === 0) return { pool, repl: null };
		return { pool, repl: computeReplacement(pool, lc.league.roster_positions, lc.league.total_rosters) };
	}

	function poolMap(pool: ProjectedEntry[]) {
		return new Map(pool.map((p) => [p.id, p]));
	}

	// ---------------------------------------------------------------- settings
	server.registerTool(
		"get_league_settings",
		{
			title: "League settings",
			description:
				"League name, season, status, roster slots, playoff/waiver/trade settings and a summary of the scoring rules that matter for skill players.",
			inputSchema: z.object({}),
			annotations: READ_ONLY,
		},
		async () => {
			try {
				const lc = await ctx();
				const l = lc.league;
				const s = l.settings;
				const waiverType = s.waiver_type === 2 ? `FAAB ($${s.waiver_budget ?? 100} budget)` : s.waiver_type === 1 ? "rolling" : "reverse standings";
				return ok({
					name: l.name,
					league_id: l.league_id,
					season: l.season,
					status: l.status,
					current_week: lc.week,
					teams: l.total_rosters,
					type: s.type === 2 ? "dynasty" : s.type === 1 ? "keeper" : "redraft",
					roster_positions: summarizeSlots(l.roster_positions),
					superflex: l.roster_positions.includes("SUPER_FLEX"),
					scoring: summarizeScoring(l.scoring_settings, l.roster_positions),
					playoffs: {
						start_week: s.playoff_week_start ?? null,
						teams: s.playoff_teams ?? null,
						last_fantasy_week: lastFantasyWeek(l),
					},
					waivers: waiverType,
					trade_deadline_week: s.trade_deadline ?? null,
					players_cache_updated: lc.players.updated,
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ----------------------------------------------------------------- rosters
	server.registerTool(
		"get_rosters",
		{
			title: "All rosters",
			description:
				"Every team's roster with owner, record, points for/against, starters by slot, bench, IR and taxi. Players shown as 'Name POS TEAM (injury)'.",
			inputSchema: z.object({}),
			annotations: READ_ONLY,
		},
		async () => {
			try {
				const lc = await ctx();
				const me = lc.config.userId;
				return ok(
					lc.rosters
						.slice()
						.sort((a, b) => a.roster_id - b.roster_id)
						.map((r) => ({
							...lc.team(r.roster_id),
							...(r.owner_id === me ? { is_me: true } : {}),
							...rosterLists(lc, r),
						})),
				);
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.registerTool(
		"get_my_roster",
		{
			title: "My roster",
			description:
				"The configured user's roster: starters by slot and bench with this week's league-scored projections, plus the projection-optimal lineup and any suggested swaps.",
			inputSchema: z.object({ week: weekArg }),
			annotations: READ_ONLY,
		},
		async ({ week }) => {
			try {
				const lc = await ctx();
				const r = lc.myRoster();
				const w = week ?? lc.week;
				const pool = poolMap(await weekPool(env.PLAYERS, lc.league, lc.season, w, lc.seasonType));
				const proj = (id: string) => pool.get(id)?.pts ?? (pool.size ? 0 : null);

				const slots = lc.league.roster_positions.filter((s) => s !== "BN");
				const starters = (r.starters ?? []).map((id, i) => ({
					slot: slots[i] ?? "?",
					player: fmt(lc.ref(id)),
					proj: id === "0" ? null : proj(id),
				}));
				const starterSet = new Set(r.starters ?? []);
				const reserve = new Set([...(r.reserve ?? []), ...(r.taxi ?? [])]);
				const bench = (r.players ?? [])
					.filter((id) => !starterSet.has(id) && !reserve.has(id))
					.map((id) => ({ player: fmt(lc.ref(id)), proj: proj(id) }))
					.sort((a, b) => (b.proj ?? 0) - (a.proj ?? 0));

				const out: Record<string, unknown> = {
					...lc.team(r.roster_id),
					week: w,
					starters,
					bench,
				};
				if (r.reserve?.length) out.ir = r.reserve.map((id) => fmt(lc.ref(id)));
				if (r.taxi?.length) out.taxi = r.taxi.map((id) => fmt(lc.ref(id)));

				if (pool.size) {
					const active = (r.players ?? []).filter((id) => !reserve.has(id));
					const best = optimalLineup(active, slots, pool);
					const current = round(starters.reduce((s, x) => s + (x.proj ?? 0), 0), 1);
					const bestIds = new Set(best.starters.map((x) => x.id));
					out.projected_total = current;
					out.optimal_total = best.total;
					const benchIn = active.filter((id) => bestIds.has(id) && !starterSet.has(id));
					const startOut = (r.starters ?? []).filter((id) => id !== "0" && !bestIds.has(id));
					if (benchIn.length || startOut.length) {
						out.suggested = {
							start: benchIn.map((id) => fmt(lc.ref(id))),
							sit: startOut.map((id) => fmt(lc.ref(id))),
							note: "Based purely on projections; check injuries and news.",
						};
					}
				} else {
					out.projections = "unavailable (Sleeper projections endpoint did not respond as expected)";
				}
				return ok(out);
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ----------------------------------------------------------------- matchup
	server.registerTool(
		"get_matchup",
		{
			title: "Matchup",
			description:
				"Head-to-head matchup for a team and week: both lineups with actual points and league-scored projections. team='all' returns the whole week's scoreboard.",
			inputSchema: z.object({
				week: weekArg,
				team: z
					.string()
					.optional()
					.describe("Owner display name, team name, roster id, 'me' (default) or 'all'."),
			}),
			annotations: READ_ONLY,
		},
		async ({ week, team }) => {
			try {
				const lc = await ctx();
				const w = week ?? lc.week;
				const [matchups, poolArr] = await Promise.all([
					sleeper.matchups(lc.config.leagueId, w),
					w >= lc.week ? weekPool(env.PLAYERS, lc.league, lc.season, w, lc.seasonType) : Promise.resolve([]),
				]);
				if (!matchups?.length) return ok({ week: w, matchups: [], note: "No matchups for this week." });
				const pool = poolMap(poolArr);
				const slots = lc.league.roster_positions.filter((s) => s !== "BN");

				const side = (m: (typeof matchups)[number], detail: boolean) => {
					const info = lc.team(m.roster_id);
					const starters = m.starters ?? [];
					const projected = pool.size ? round(starters.reduce((s, id) => s + (pool.get(id)?.pts ?? 0), 0), 1) : undefined;
					const base: Record<string, unknown> = {
						roster_id: m.roster_id,
						owner: info.owner,
						...(info.team_name ? { team_name: info.team_name } : {}),
						points: round(m.custom_points ?? m.points ?? 0, 2),
						...(projected !== undefined ? { projected } : {}),
					};
					if (!detail) return base;
					const pp = m.players_points ?? {};
					base.starters = starters.map((id, i) => ({
						slot: slots[i] ?? "?",
						player: fmt(lc.ref(id)),
						pts: m.starters_points?.[i] ?? pp[id] ?? 0,
						...(pool.size && id !== "0" ? { proj: pool.get(id)?.pts ?? 0 } : {}),
					}));
					const st = new Set(starters);
					base.bench = (m.players ?? [])
						.filter((id) => !st.has(id))
						.map((id) => ({
							player: fmt(lc.ref(id)),
							pts: pp[id] ?? 0,
							...(pool.size ? { proj: pool.get(id)?.pts ?? 0 } : {}),
						}));
					return base;
				};

				if (team && team.trim().toLowerCase() === "all") {
					const byId = new Map<number, typeof matchups>();
					for (const m of matchups) {
						if (m.matchup_id == null) continue;
						byId.set(m.matchup_id, [...(byId.get(m.matchup_id) ?? []), m]);
					}
					return ok({
						week: w,
						matchups: [...byId.entries()]
							.sort((a, b) => a[0] - b[0])
							.map(([id, ms]) => ({ matchup_id: id, teams: ms.map((m) => side(m, false)) })),
					});
				}

				const roster = lc.findRoster(team);
				const mine = matchups.find((m) => m.roster_id === roster.roster_id);
				if (!mine) return ok({ week: w, note: `${lc.team(roster.roster_id).owner} has no matchup in week ${w}.` });
				const opp = mine.matchup_id != null ? matchups.find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== mine.roster_id) : undefined;
				return ok({
					week: w,
					status: w < lc.week ? "final" : w === lc.week ? "current" : "upcoming",
					team: side(mine, true),
					opponent: opp ? side(opp, true) : null,
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ------------------------------------------------------------ transactions
	server.registerTool(
		"get_transactions",
		{
			title: "Transactions",
			description: "League transactions (trades, waiver claims, free-agent adds/drops) for a week, newest first.",
			inputSchema: z.object({
				week: weekArg,
				type: z.enum(["trade", "waiver", "free_agent"]).optional().describe("Only this transaction type."),
				include_failed: z.boolean().optional().describe("Include failed/pending waiver claims. Default false."),
				limit: z.number().int().min(1).max(200).optional().describe("Max transactions (default 50)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ week, type, include_failed, limit }) => {
			try {
				const lc = await ctx();
				const w = week ?? lc.week;
				const txs = (await sleeper.transactions(lc.config.leagueId, w)) ?? [];
				const list = txs
					.filter((t) => (include_failed ? true : t.status === "complete"))
					.filter((t) => (type ? t.type === type : true))
					.sort((a, b) => (b.status_updated ?? b.created) - (a.status_updated ?? a.created))
					.slice(0, limit ?? 50)
					.map((t) => formatTransaction(lc, t));
				return ok({ week: w, count: list.length, transactions: list });
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.registerTool(
		"get_traded_picks",
		{
			title: "Traded draft picks",
			description: "Draft picks that have changed hands in this league, with original and current owners.",
			inputSchema: z.object({}),
			annotations: READ_ONLY,
		},
		async () => {
			try {
				const lc = await ctx();
				const picks = (await sleeper.tradedPicks(lc.config.leagueId)) ?? [];
				return ok(
					picks
						.sort((a, b) => a.season.localeCompare(b.season) || a.round - b.round)
						.map((p) => ({
							season: p.season,
							round: p.round,
							original: lc.team(p.roster_id).owner,
							owner: lc.team(p.owner_id).owner,
						})),
				);
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ---------------------------------------------------------------- trending
	server.registerTool(
		"get_trending_players",
		{
			title: "Trending players",
			description:
				"Players trending on Sleeper waivers league-wide (most added and/or dropped), filtered to players available in this league by default, with this week's league-scored projection.",
			inputSchema: z.object({
				kind: z.enum(["add", "drop", "both"]).optional().describe("Default 'add'."),
				lookback_hours: z.number().int().min(1).max(168).optional().describe("Default 24."),
				limit: z.number().int().min(1).max(50).optional().describe("Max players per list (default 25)."),
				position: z.enum(["QB", "RB", "WR", "TE"]).optional(),
				available_only: z.boolean().optional().describe("Only players not on any roster in this league. Default true."),
			}),
			annotations: READ_ONLY,
		},
		async ({ kind, lookback_hours, limit, position, available_only }) => {
			try {
				const lc = await ctx();
				const kinds: ("add" | "drop")[] = kind === "both" ? ["add", "drop"] : [kind ?? "add"];
				const owned = lc.ownership();
				const onlyAvail = available_only ?? true;
				const pool = poolMap(await weekPool(env.PLAYERS, lc.league, lc.season, lc.week, lc.seasonType));
				const out: Record<string, unknown> = { lookback_hours: lookback_hours ?? 24, week: lc.week };
				for (const k of kinds) {
					// Over-fetch because rostered players get filtered out.
					const raw = (await sleeper.trending(k, lookback_hours ?? 24, 100)) ?? [];
					out[k === "add" ? "adds" : "drops"] = raw
						.filter((t) => !onlyAvail || !owned.has(t.player_id))
						.map((t) => ({ t, p: lc.players.get(t.player_id) }))
						.filter(({ p }) => p && (!position || p.pos === position) && ["QB", "RB", "WR", "TE"].includes(p.pos))
						.slice(0, limit ?? 25)
						.map(({ t, p }) => ({
							player: fmt(p!),
							count: t.count,
							...(pool.size ? { proj_week: pool.get(t.player_id)?.pts ?? 0 } : {}),
							...(!onlyAvail && owned.has(t.player_id) ? { rostered_by: lc.team(owned.get(t.player_id)!).owner } : {}),
						}));
				}
				return ok(out);
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ------------------------------------------------------------------ search
	server.registerTool(
		"search_players",
		{
			title: "Search players",
			description:
				"Search NFL players by name, team and/or position. Shows who rosters each player in this league (or 'available') and this week's league-scored projection.",
			inputSchema: z.object({
				name: z.string().optional().describe("Full or partial name, e.g. 'bijan' or 'St. Brown'."),
				team: z.string().optional().describe("NFL team abbreviation, e.g. 'DET'. Use 'FA' for free agents."),
				position: z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]).optional(),
				available_only: z.boolean().optional().describe("Only players not on a roster in this league."),
				limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
			}),
			annotations: READ_ONLY,
		},
		async ({ name, team, position, available_only, limit }) => {
			try {
				if (!name && !team && !position) return fail("Give at least one of name, team or position.");
				const lc = await ctx();
				const owned = lc.ownership();
				const pool = poolMap(await weekPool(env.PLAYERS, lc.league, lc.season, lc.week, lc.seasonType));
				const n = limit ?? 10;
				let hits = lc.players.search({ name, team, position, limit: available_only ? 500 : n });
				if (available_only) hits = hits.filter((p) => !owned.has(p.id)).slice(0, n);
				// Without a name, rank by this week's projection when we have one.
				if (!name && pool.size) hits.sort((a, b) => (pool.get(b.id)?.pts ?? -1) - (pool.get(a.id)?.pts ?? -1));
				return ok(
					hits.map((p) => ({
						id: p.id,
						name: p.name,
						pos: p.pos,
						team: p.team ?? "FA",
						...(p.injury ? { injury: p.injury } : {}),
						...(p.age ? { age: p.age } : {}),
						...(p.status ? { status: p.status } : {}),
						league_status: owned.has(p.id) ? lc.team(owned.get(p.id)!).owner : "available",
						...(pool.size ? { proj_week: pool.get(p.id)?.pts ?? 0 } : {}),
					})),
				);
			} catch (e) {
				return fail(e);
			}
		},
	);

	// -------------------------------------------------------------- projection
	async function valuations(lc: LeagueContext, queries: string[], week: number | undefined, includeWeeks: boolean) {
		const w = week ?? lc.week;
		const through = lastFantasyWeek(lc.league);
		const { pool, repl } = await replacementFor(lc, w);
		const owned = lc.ownership();
		const ranks = positionRanks(pool);
		const players = queries.map((q) => lc.players.resolve(q));
		const vals = await Promise.all(
			players.map((p) =>
				valuePlayer({
					playerId: p.id,
					pos: p.pos,
					league: lc.league,
					season: lc.season,
					seasonType: lc.seasonType,
					week: w,
					throughWeek: Math.max(w, through),
					replacement: repl,
					includeWeeks,
				}),
			),
		);
		const rows = players.map((p, i) => ({
			player: fmt(p),
			id: p.id,
			league_status: owned.has(p.id) ? lc.team(owned.get(p.id)!).owner : "available",
			...(ranks.has(p.id) ? { week_pos_rank: ranks.get(p.id) } : {}),
			...(vals[i] ?? { projection: "unavailable" }),
		}));
		return { week: w, through_week: Math.max(w, through), repl, rows, vals, players };
	}

	server.registerTool(
		"project_player",
		{
			title: "Project player",
			description:
				"League-scored projection for one player: this week's points and key stats, rest-of-season total and per-game, and value over replacement (superflex-aware).",
			inputSchema: z.object({
				player: z.string().describe("Name (e.g. 'Josh Allen' or 'Allen BUF') or Sleeper player id."),
				week: weekArg,
				include_weekly: z.boolean().optional().describe("Include the week-by-week projection breakdown."),
			}),
			annotations: READ_ONLY,
		},
		async ({ player, week, include_weekly }) => {
			try {
				const lc = await ctx();
				const v = await valuations(lc, [player], week, include_weekly ?? false);
				return ok({
					week: v.week,
					through_week: v.through_week,
					...v.rows[0],
					...(v.repl ? { replacement_level_week: v.repl.level } : { note: "Replacement level unavailable; VOR equals raw points." }),
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.registerTool(
		"compare_players",
		{
			title: "Compare players",
			description:
				"Compare 2-8 players under this league's scoring: this week's projection (start/sit) and rest-of-season points and value over replacement (trade/hold value).",
			inputSchema: z.object({
				players: z.array(z.string()).min(2).max(8).describe("Names or Sleeper ids."),
				week: weekArg,
			}),
			annotations: READ_ONLY,
		},
		async ({ players, week }) => {
			try {
				const lc = await ctx();
				const v = await valuations(lc, players, week, false);
				const byWeek = [...v.rows].sort((a, b) => num(b, "week_pts") - num(a, "week_pts"));
				const byRos = [...v.rows].sort((a, b) => num(b, "ros_vor") - num(a, "ros_vor"));
				return ok({
					week: v.week,
					through_week: v.through_week,
					...(v.repl ? { replacement_level_week: v.repl.level, league_starters: v.repl.starters } : {}),
					players: v.rows,
					best_this_week: byWeek[0]?.player,
					best_rest_of_season: byRos[0]?.player,
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	server.registerTool(
		"evaluate_trade",
		{
			title: "Evaluate trade",
			description:
				"Evaluate a trade under this league's scoring: rest-of-season projected points and value over replacement given vs received (superflex-aware, so QBs carry their real value), plus the effect on this week's optimal lineup for both teams.",
			inputSchema: z.object({
				give: z.array(z.string()).min(1).max(8).describe("Players you send (names or ids)."),
				get: z.array(z.string()).min(1).max(8).describe("Players you receive (names or ids)."),
				team: z.string().optional().describe("Whose side 'give' is. Default: the configured user ('me')."),
			}),
			annotations: READ_ONLY,
		},
		async ({ give, get, team }) => {
			try {
				const lc = await ctx();
				const v = await valuations(lc, [...give, ...get], undefined, false);
				const g = v.rows.slice(0, give.length);
				const r = v.rows.slice(give.length);
				const sum = (rows: typeof v.rows, k: keyof PlayerValuation) => round(rows.reduce((s, x) => s + num(x, k), 0), 1);
				const giveVor = sum(g, "ros_vor");
				const getVor = sum(r, "ros_vor");
				const diff = round(getVor - giveVor, 1);

				const owned = lc.ownership();
				const mine = lc.findRoster(team);
				const givePlayers = v.players.slice(0, give.length);
				const getPlayers = v.players.slice(give.length);
				const warnings: string[] = [];
				for (const p of givePlayers) {
					if (owned.get(p.id) !== mine.roster_id) warnings.push(`${p.name} is not on ${lc.team(mine.roster_id).owner}'s roster.`);
				}
				const partnerIds = new Set(getPlayers.map((p) => owned.get(p.id)).filter((x): x is number => x != null));
				if (partnerIds.size > 1) warnings.push("Players received come from more than one roster.");
				const partner = partnerIds.size === 1 ? lc.rosters.find((x) => x.roster_id === [...partnerIds][0]) : undefined;
				for (const p of getPlayers) if (!owned.has(p.id)) warnings.push(`${p.name} is not on any roster (free agent).`);

				// Effect on each side's best lineup this week.
				const pool = poolMap(await weekPool(env.PLAYERS, lc.league, lc.season, v.week, lc.seasonType));
				const slots = lc.league.roster_positions.filter((s) => s !== "BN");
				const giveIds = new Set(givePlayers.map((p) => p.id));
				const getIds = new Set(getPlayers.map((p) => p.id));
				const lineup = (ro: Roster, remove: Set<string>, add: Set<string>) => {
					const res = new Set([...(ro.reserve ?? []), ...(ro.taxi ?? [])]);
					const before = (ro.players ?? []).filter((id) => !res.has(id));
					const after = [...before.filter((id) => !remove.has(id)), ...add];
					const b = optimalLineup(before, slots, pool).total;
					const a = optimalLineup(after, slots, pool).total;
					return { before: b, after: a, change: round(a - b, 1) };
				};

				const verdict =
					Math.abs(diff) < 5 ? "roughly even" : diff > 0 ? (diff > 25 ? "clearly favors you" : "favors you") : diff < -25 ? "clearly favors them" : "favors them";
				return ok({
					from_perspective_of: lc.team(mine.roster_id).owner,
					...(partner ? { partner: lc.team(partner.roster_id).owner } : {}),
					weeks: `${v.week}-${v.through_week}`,
					give: g,
					get: r,
					totals: {
						give: { ros_pts: sum(g, "ros_pts"), ros_vor: giveVor },
						get: { ros_pts: sum(r, "ros_pts"), ros_vor: getVor },
						vor_diff: diff,
					},
					verdict,
					...(pool.size
						? {
								lineup_this_week: {
									you: lineup(mine, giveIds, getIds),
									...(partner ? { partner: lineup(partner, getIds, giveIds) } : {}),
								},
							}
						: {}),
					...(v.repl ? { replacement_level_week: v.repl.level, league_starters: v.repl.starters } : {}),
					...(warnings.length ? { warnings } : {}),
					note:
						"VOR = projected points above a replacement-level starter at the same position, summed over remaining weeks. Roster-spot cost of 2-for-1 deals and injuries/news are not modeled.",
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	return server;
}

// ------------------------------------------------------------------ helpers

function num(o: object, k: string): number {
	const v = (o as Record<string, unknown>)[k];
	return typeof v === "number" ? v : 0;
}

function rosterLists(lc: LeagueContext, r: Roster) {
	const slots = lc.league.roster_positions.filter((s) => s !== "BN");
	const starters = r.starters ?? [];
	const st = new Set(starters);
	const res = new Set([...(r.reserve ?? []), ...(r.taxi ?? [])]);
	const out: Record<string, unknown> = {
		starters: starters.map((id, i) => `${slots[i] ?? "?"}: ${fmt(lc.ref(id))}`),
		bench: (r.players ?? []).filter((id) => !st.has(id) && !res.has(id)).map((id) => fmt(lc.ref(id))),
	};
	if (r.reserve?.length) out.ir = r.reserve.map((id) => fmt(lc.ref(id)));
	if (r.taxi?.length) out.taxi = r.taxi.map((id) => fmt(lc.ref(id)));
	return out;
}

function positionRanks(pool: ProjectedEntry[]): Map<string, string> {
	const byPos = new Map<string, ProjectedEntry[]>();
	for (const p of pool) byPos.set(p.pos, [...(byPos.get(p.pos) ?? []), p]);
	const ranks = new Map<string, string>();
	for (const [pos, list] of byPos) {
		list.sort((a, b) => b.pts - a.pts).forEach((p, i) => ranks.set(p.id, `${pos}${i + 1}`));
	}
	return ranks;
}

function formatTransaction(lc: LeagueContext, t: Transaction) {
	const out: Record<string, unknown> = {
		type: t.type,
		...(t.status !== "complete" ? { status: t.status } : {}),
		date: new Date(t.status_updated ?? t.created).toISOString().slice(0, 16).replace("T", " ") + "Z",
		teams: t.roster_ids.map((id) => lc.team(id).owner),
	};
	if (t.adds) out.adds = Object.entries(t.adds).map(([pid, rid]) => `${fmt(lc.ref(pid))} → ${lc.team(rid).owner}`);
	if (t.drops) out.drops = Object.entries(t.drops).map(([pid, rid]) => `${fmt(lc.ref(pid))} ← ${lc.team(rid).owner}`);
	if (t.draft_picks?.length) {
		out.picks = t.draft_picks.map(
			(p) => `${p.season} R${p.round} (${lc.team(p.roster_id).owner}'s) ${lc.team(p.previous_owner_id).owner} → ${lc.team(p.owner_id).owner}`,
		);
	}
	if (t.waiver_budget?.length) {
		out.faab = t.waiver_budget.map((b) => `$${b.amount} ${lc.team(b.sender).owner} → ${lc.team(b.receiver).owner}`);
	}
	if (t.type === "waiver" && t.settings?.waiver_bid != null) out.bid = t.settings.waiver_bid;
	if (t.status !== "complete" && t.metadata?.notes) out.notes = t.metadata.notes;
	return out;
}

export function summarizeSlots(positions: string[]): string {
	const counts: [string, number][] = [];
	for (const p of positions) {
		const last = counts[counts.length - 1];
		if (last && last[0] === p) last[1]++;
		else counts.push([p, 1]);
	}
	return counts.map(([p, n]) => (n > 1 ? `${p}x${n}` : p)).join(", ");
}

const YARD_KEYS = new Set(["pass_yd", "rush_yd", "rec_yd"]);
const OFFENSE = /^(pass_|rush_|rec|bonus_(pass|rush|rec|fd)|fum$|fum_lost|fum_rec_td|kr_|pr_|st_td$|def_kr|def_pr)/;

/** Non-zero scoring rules relevant to the league's slots, with yardage shown as "1 pt / N yds". */
export function summarizeScoring(s: Record<string, number>, rosterPositions: string[]): Record<string, number | string> {
	const hasK = rosterPositions.includes("K");
	const hasDef = rosterPositions.includes("DEF");
	const hasIdp = rosterPositions.some((p) => ["DL", "LB", "DB", "IDP_FLEX"].includes(p));
	const out: Record<string, number | string> = {};
	for (const [k, v] of Object.entries(s).sort()) {
		if (!v) continue;
		const offense = OFFENSE.test(k);
		const kicker = /^(fg|xp)/.test(k);
		const idp = k.startsWith("idp_");
		if (!offense && !(hasK && kicker) && !(hasIdp && idp) && !(hasDef && !kicker && !idp)) continue;
		out[k] = YARD_KEYS.has(k) && v > 0 && v < 1 ? `${v} (1 pt / ${round(1 / v, 1)} yds)` : v;
	}
	return out;
}

