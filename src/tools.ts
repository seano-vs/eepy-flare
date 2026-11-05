import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { asOf } from "./asof";
import { LeagueContext } from "./league";
import {
	poolFetchedAt,
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
import { dynastyAdp, dynastyValue, isDynasty } from "./dynasty";
import { READ_ONLY, fail, fmt, ok } from "./result";
import { impliedDelta, impliedNorms, impliedTotals, injuryReportState, isUnavailable, matchups, matchups as matchups_, playerContext, teamByes, type PlayerContext } from "./nflverse/context";
import { registerNflTools } from "./nfl-tools";
import { pickSchema, registerAdvisorTools, valuePicks } from "./advisor";
import { registerLeagueTools } from "./league-tools";
import { readPrefs } from "./prefs";
import { gameWeather, weatherFetchedAt, type GameWeather } from "./weather";
import { lockTimeline, type LockCandidate, type LockStarter } from "./locks";
import { clock, eastern } from "./waivers";
import { parseSince } from "./changes";
import { NflData, sleeperTeam } from "./nflverse/stats";
import { latestHeadlines, newsLine, playerNews, practiceFromNews, practiceLine, type PracticeNews, roleSignal } from "./news";
import { waiverSchedule, waiverStatuses } from "./waivers";
import { activeIds, computedRecords, loadSeason, recordString, runOdds } from "./playoffs";
import { sleeper, type Roster, type Transaction } from "./sleeper";

export { fmt };

export const SERVER_NAME = "sleeper-fantasy";
export const SERVER_VERSION = "1.6.0";

/**
 * Server instructions sent to every MCP client. The second half matters as much
 * as the first: projections and values are Sleeper's estimates, and models
 * otherwise tend to repeat them as fact.
 */
export const INSTRUCTIONS =
	"Read-only tools for one Sleeper fantasy football league (call get_league_settings for its format and scoring). " +
	"Players can be referenced by name (optionally with team/position, e.g. 'Josh Allen BUF') or Sleeper id. " +
	"'me' / omitted team means the configured user's roster. Projections are Sleeper's, re-scored with this league's scoring; " +
	"VOR is value over a replacement-level starter given the league's lineup slots.\n\n" +
	"What to trust: rosters, lineups, scores, transactions and league settings are authoritative. " +
	"Projections, VOR, projected out and return weeks, injury tags, optimal lineups, trade verdicts and dynasty values are " +
	"Sleeper's estimates, not facts. They lag news, and some assume changes nobody has announced (a benching, a return date). " +
	"Never present them as fact; attribute them (\"Sleeper projects...\"). Before recommending a start/sit, add/drop, bid or trade, " +
	"check current, dated news for each player it depends on: injury and practice reports, suspensions, depth chart, recent snap " +
	"and target share, QB changes. Explain any zero, drop or return date you rely on. Each player's `verify` list names the " +
	"projection assumptions to check first. A gap of a point or two between players is noise; decide close calls on role, health " +
	"and matchup. Every response has an as_of block: when each source it used was last updated (Eastern time), marked stale past its limit. Injury tags come from a once-a-day players cache and the official report reaches the mirror hours after teams post, so weigh old data accordingly and cite times when they matter.";

const PREGAME_NOTE =
	"proj and projected_pregame are pregame projections. Once a player's game is over, count his pts instead of his proj; projected_pregame still uses the proj.";

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
		{ instructions: INSTRUCTIONS },
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
				"League name, season, status, roster slots, playoff/waiver/trade settings and a summary of the scoring rules that matter for skill players. " +
				"trade_review_days is how long an accepted trade waits before it processes (null when Sleeper doesn't report it); the commissioner can process a trade early. " +
				"waiver_schedule says when claims actually process in this league (inferred from completed claims) and how many days a dropped player stays on waivers. " +
				"Check it before saying a trade will help this week.",
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
					waiver_schedule: await waiverSchedule(lc).catch(() => null),
					trade_deadline_week: s.trade_deadline ?? null,
					// Read defensively: Sleeper's docs don't list the league settings keys.
					trade_review_days: s.trade_review_days ?? null,
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
				"Every team's roster with owner, record, points for/against, starters by slot, bench, IR and taxi. Players shown as 'Name POS TEAM (injury)'. " +
				"Injury tags come from the once-a-day players cache (players_cache_updated in get_league_settings).",
			inputSchema: z.object({}),
			annotations: READ_ONLY,
		},
		async () => {
			try {
				const lc = await ctx();
				const me = lc.config.userId;
				const records = await computedRecords(lc).catch(() => new Map());
				return ok(
					lc.rosters
						.slice()
						.sort((a, b) => a.roster_id - b.roster_id)
						.map((r) => ({
							...withComputedRecord(lc.team(r.roster_id), records.get(r.roster_id)),
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
				"The configured user's roster: starters by slot and bench with this week's league-scored projections, FantasyPros weekly rank, official injury/practice report, team implied total and recent usage (snap %, targets, red-zone looks, expected points), plus the projection-optimal lineup and any suggested swaps. " +
				"Projections and the optimal lineup are Sleeper's pregame estimates: check injury reports, inactives and role news before acting on a swap.",
			inputSchema: z.object({ week: weekArg }),
			annotations: READ_ONLY,
		},
		async ({ week }) => {
			try {
				const lc = await ctx();
				const r = lc.myRoster();
				const w = week ?? lc.week;
				const poolArr = await weekPool(env.PLAYERS, lc.league, lc.season, w, lc.seasonType);
				const pool = poolMap(poolArr);
				const proj = (id: string) => pool.get(id)?.pts ?? (pool.size ? 0 : null);
				const ids = r.players ?? [];
				const [nflCtx, implied, matchup, reports, headlines, weather, norms] = await Promise.all([
					playerContext(lc, ids, { dynasty: isDynasty(lc.league), projections: new Map(ids.map((id) => [id, proj(id)])) }),
					impliedTotals(lc, w),
					matchups(lc, w),
					injuryReportState(lc),
					latestHeadlines(ids, 72),
					w >= lc.week ? rosterWeather(lc, w, ids) : Promise.resolve(new Map<string, GameWeather>()),
					impliedNorms(lc, w),
				]);
				// nflverse context per player: weekly consensus rank, injury report, team implied total, recent usage.
				const extra = (id: string) => {
					const c = nflCtx.get(id);
					const pl = lc.players.get(id);
					const team = pl?.team;
					const m = matchup(team, pl?.pos);
					const projection = proj(id);
					const n = headlines.get(id);
					const verify = zeroProjectionNote(projection, !!m, pl?.injury ?? pl?.status, c?.injury_report, n);
					return {
						...(m ? { vs: `${m.home ? "" : "@"}${m.opp}`, ...(m.def_rank ? { def_rank: m.def_rank } : {}) } : team && implied.size ? { vs: "BYE" } : {}),
						...(c?.ecr?.week ? { ecr: c.ecr.week } : {}),
						...(c?.ecr?.ros ? { ros_rank: c.ecr.ros } : {}),
						...(c?.injury_report ? { injury_report: c.injury_report } : {}),
						...(pl?.injury_start ? { injured_since: pl.injury_start } : {}),
						...(pl?.depth ? { depth: pl.depth } : {}),
						...(team && implied.has(team) ? { implied: implied.get(team), ...impliedDelta(implied.get(team), norms.get(team)) } : {}),
						...(c?.play_pct != null ? { play_pct: c.play_pct, ...(c.play_basis ? { play_basis: c.play_basis } : {}), ...(c.play_note ? { play_note: c.play_note } : {}) } : {}),
						...(c?.recent ? { recent: compactRecent(c.recent) } : {}),
						...(c?.role_change ? { role_change: c.role_change } : {}),
				...(c?.projection_check ? { projection_check: c.projection_check } : {}),
						...(n ? { news: newsLine(n) } : {}),
						...(team && weather.get(team)?.flags ? { weather: `${weather.get(team)!.flags!.join("; ")} (${weather.get(team)!.wind_mph} mph, ${weather.get(team)!.temp_f}F)` } : {}),
						...(verify ? { verify } : {}),
					};
				};

				const slots = lc.league.roster_positions.filter((s) => s !== "BN");
				const starters = (r.starters ?? []).map((id, i) => ({
					slot: slots[i] ?? "?",
					player: fmt(lc.ref(id)),
					proj: id === "0" ? null : proj(id),
					...(id === "0" ? {} : extra(id)),
				}));
				const starterSet = new Set(r.starters ?? []);
				const reserve = new Set([...(r.reserve ?? []), ...(r.taxi ?? [])]);
				const bench = (r.players ?? [])
					.filter((id) => !starterSet.has(id) && !reserve.has(id))
					.map((id) => ({ player: fmt(lc.ref(id)), proj: proj(id), ...extra(id) }))
					.sort((a, b) => (b.proj ?? 0) - (a.proj ?? 0));

				const out: Record<string, unknown> = {
					...withComputedRecord(lc.team(r.roster_id), (await computedRecords(lc).catch(() => new Map())).get(r.roster_id)),
					week: w,
					starters,
					bench,
				};
				if (r.reserve?.length) out.ir = r.reserve.map((id) => fmt(lc.ref(id)));
				if (r.taxi?.length) out.taxi = r.taxi.map((id) => fmt(lc.ref(id)));
				if (nflCtx.size) out.legend = CONTEXT_LEGEND;
				// A player with no report row isn't necessarily healthy if his team hasn't posted yet.
				if (reports && w === lc.week) {
					const myTeams = new Set((r.players ?? []).map((id) => lc.players.get(id)?.team).filter((t): t is string => !!t && !!matchup(t, undefined)));
					const pending = [...myTeams].filter((t) => !reports.published.has(t)).sort();
					if (pending.length) {
						// nflverse mirrors reports a few times a day, so a team can have posted already: check headlines.
						const pendingSet = new Set(pending);
						const ids = (r.players ?? []).filter((id) => pendingSet.has(lc.players.get(id)?.team ?? ""));
						const prac = await practiceFromNews(ids, 72).catch(() => new Map<string, PracticeNews>());
						out.injury_reports_not_in_nflverse = {
							week: reports.week,
							teams: pending,
							...(prac.size
								? { practice_from_news: Object.fromEntries([...prac].map(([id, p]) => [fmt(lc.ref(id)), practiceLine(p)])) }
								: {}),
							note: "These teams' week reports aren't in nflverse yet (it updates a few times a day; the team may already have posted). No row doesn't mean healthy. practice_from_news is read from headlines.",
						};
					}
				}
				// Lock timeline: kickoffs for each starter, and later-game pivots for the ones at risk.
				if (w === lc.week && pool.size) {
					try {
						const games = (await NflData.from(env, lc.season).games(w)).filter((g) => typeof g.home_score !== "number");
						const kick = new Map<string, string>();
						const shown = new Map<string, string>();
						for (const g of games) {
							const key = `${g.gameday} ${g.gametime}`;
							const [hh, mm] = String(g.gametime ?? "00:00").split(":").map(Number);
							shown.set(key, `${String(g.weekday ?? "").slice(0, 3)} ${clock(hh ?? 0, mm ?? 0)} ET`);
							for (const t of [sleeperTeam(g.home_team), sleeperTeam(g.away_team)]) if (t) kick.set(t, key);
						}
						if (kick.size) {
							const owned = lc.ownership();
							const kickOf = (id: string) => kick.get(lc.players.get(id)?.team ?? "") ?? null;
							const lockStarters: LockStarter[] = (r.starters ?? [])
								.map((id, i) => ({ id, slot: slots[i] ?? "?" }))
								.filter(({ id }) => id !== "0")
								.map(({ id, slot }) => {
									const pl = lc.players.get(id);
									const c = nflCtx.get(id);
									const k = kickOf(id);
									const risk =
										pl?.injury && /^(Questionable|Doubtful)$/.test(pl.injury)
											? `listed ${pl.injury}${c?.play_pct != null ? ` (${c.play_pct}% play rate)` : ""}`
											: c?.play_pct != null && c.play_pct < 90
												? `${c.play_pct}% play rate`
												: k && proj(id) === 0
													? "projected 0"
													: undefined;
									return { slot, label: fmt(lc.ref(id)), pos: pl?.pos ?? "?", kickoff: k, proj: proj(id), ...(risk ? { risk } : {}) };
								});
							const benchIds = (r.players ?? []).filter((id) => !starterSet.has(id) && !reserve.has(id));
							const fas = poolArr
								.filter((e) => e.pts > 0 && !owned.has(e.id) && !isUnavailable(lc.players.get(e.id)))
								.sort((a, b) => b.pts - a.pts)
								.slice(0, 60)
								.map((e) => e.id);
							const cands: LockCandidate[] = [
								...benchIds.map((id) => ({ id, source: "bench" as const })),
								...fas.map((id) => ({ id, source: "free agent" as const })),
							]
								.filter(({ id }) => (proj(id) ?? 0) > 0 && !isUnavailable(lc.players.get(id)))
								.map(({ id, source }) => ({ label: fmt(lc.ref(id)), pos: lc.players.get(id)?.pos ?? "?", kickoff: kickOf(id), proj: proj(id) ?? 0, source }));
							const tl = lockTimeline(lockStarters, cands);
							const pretty = (k: string) => shown.get(k) ?? k;
							out.lock_timeline = {
								windows: tl.windows.map((x) => ({
									kickoff: pretty(x.kickoff),
									starters: x.starters,
									...(x.pivots ? { pivots: x.pivots.map((p) => ({ ...p, options: p.options.map((o) => o.replace(/kicks off (\d{4}-\d\d-\d\d \d\d:\d\d)/, (_m, k: string) => `kicks off ${pretty(k)}`)) })) } : {}),
								})),
								...(tl.no_game.length ? { no_game: tl.no_game } : {}),
								note: "Each starter locks at his kickoff; inactives come out about 90 minutes before. Free-agent pivots must be free agents, not on waivers (players also lock onto waivers once their game starts).",
							};
						}
					} catch (e) {
						console.warn("lock timeline unavailable:", e instanceof Error ? e.message : e);
					}
				}

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
				out.as_of = await asOf(lc, ["injury_tags", "projections", "injury_report", "lines", "rankings", "stats", "news", ...(weather.size ? (["weather"] as const) : [])], {
					teams: ids.map((id) => lc.players.get(id)?.team),
					weatherAt: weatherFetchedAt(weather.values()),
				});
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
				"Head-to-head matchup for a team and week: both lineups with actual points and pregame league-scored projections. team='all' returns the whole week's scoreboard. " +
				"Projections are not replaced by actual points when a game ends, so projected_pregame is not a live total: for players whose games are over, use pts.",
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
				const [matchups, poolArr, games] = await Promise.all([
					sleeper.matchups(lc.config.leagueId, w),
					w >= lc.week ? weekPool(env.PLAYERS, lc.league, lc.season, w, lc.seasonType) : Promise.resolve([]),
					w >= lc.week ? matchups_(lc, w) : Promise.resolve(() => undefined),
				]);
				if (!matchups?.length) return ok({ week: w, matchups: [], note: "No matchups for this week." });
				const pool = poolMap(poolArr);
				const slots = lc.league.roster_positions.filter((s) => s !== "BN");
				// Headlines only for starters projected 0 with a game: those notes need a reason.
				const focusMatch = team === "all" ? undefined : matchups.find((m) => m.roster_id === lc.findRoster(team).roster_id);
				const detailed = focusMatch ? matchups.filter((m) => m === focusMatch || (focusMatch.matchup_id != null && m.matchup_id === focusMatch.matchup_id)) : [];
				const zeroIds = pool.size
					? [...new Set(detailed.flatMap((m) => m.starters ?? []))].filter((id) => id !== "0" && (pool.get(id)?.pts ?? 0) === 0 && !!games(lc.players.get(id)?.team, lc.players.get(id)?.pos))
					: [];
				const zeroNews = zeroIds.length ? await latestHeadlines(zeroIds, 72).catch(() => new Map()) : new Map();

				const side = (m: (typeof matchups)[number], detail: boolean) => {
					const info = lc.team(m.roster_id);
					const starters = m.starters ?? [];
					const projected = pool.size ? round(starters.reduce((s, id) => s + (pool.get(id)?.pts ?? 0), 0), 1) : undefined;
					const base: Record<string, unknown> = {
						roster_id: m.roster_id,
						owner: info.owner,
						...(info.team_name ? { team_name: info.team_name } : {}),
						points: round(m.custom_points ?? m.points ?? 0, 2),
						// Pregame: a finished player still counts at his projection here, not his pts.
						...(projected !== undefined ? { projected_pregame: projected } : {}),
					};
					if (!detail) return base;
					const pp = m.players_points ?? {};
					base.starters = starters.map((id, i) => {
						const pl = lc.players.get(id);
						const proj = pool.size && id !== "0" ? (pool.get(id)?.pts ?? 0) : undefined;
						const verify = proj != null ? zeroProjectionNote(proj, !!games(pl?.team, pl?.pos), pl?.injury ?? pl?.status, undefined, zeroNews.get(id)) : undefined;
						return {
							slot: slots[i] ?? "?",
							player: fmt(lc.ref(id)),
							pts: m.starters_points?.[i] ?? pp[id] ?? 0,
							...(proj != null ? { proj } : {}),
							...(verify ? { verify } : {}),
						};
					});
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
						as_of: await asOf(lc, ["projections"]),
						week: w,
						matchups: [...byId.entries()]
							.sort((a, b) => a[0] - b[0])
							.map(([id, ms]) => ({ matchup_id: id, teams: ms.map((m) => side(m, false)) })),
						...(pool.size ? { note: PREGAME_NOTE } : {}),
					});
				}

				const roster = lc.findRoster(team);
				const mine = matchups.find((m) => m.roster_id === roster.roster_id);
				if (!mine) return ok({ week: w, note: `${lc.team(roster.roster_id).owner} has no matchup in week ${w}.` });
				const opp = mine.matchup_id != null ? matchups.find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== mine.roster_id) : undefined;
				return ok({
					as_of: await asOf(lc, ["injury_tags", "projections", "news"]),
					week: w,
					status: w < lc.week ? "final" : w === lc.week ? "current" : "upcoming",
					team: side(mine, true),
					opponent: opp ? side(opp, true) : null,
					...(pool.size ? { note: PREGAME_NOTE } : {}),
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
			description:
				"League transactions (trades, waiver claims, free-agent adds/drops), newest first: for a week, or across weeks with since/until (one waiver run can land in two weeks' lists, so use since/until for 'what happened in the last run').",
			inputSchema: z.object({
				week: weekArg,
				since: z.string().optional().describe("Only moves at or after this time: '24h', '3d' or an ISO time. Searches every week as needed (ignores week)."),
				until: z.string().optional().describe("Only moves before this time (same formats; default now)."),
				type: z.enum(["trade", "waiver", "free_agent"]).optional().describe("Only this transaction type."),
				include_failed: z.boolean().optional().describe("Include failed/pending waiver claims. Default false."),
				limit: z.number().int().min(1).max(200).optional().describe("Max transactions (default 50)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ week, since, until, type, include_failed, limit }) => {
			try {
				const lc = await ctx();
				const w = week ?? lc.week;
				const from = since ? parseSince(since) : null;
				const to = until ? parseSince(until) : null;
				const at = (t: Transaction) => t.status_updated ?? t.created;
				// A time range spans weeks: read every week up to the current one, then filter by time.
				const txs =
					from != null || to != null
						? (await Promise.all(Array.from({ length: Math.max(1, lc.week) }, (_, i) => sleeper.transactions(lc.config.leagueId, i + 1).catch(() => [] as Transaction[])))).flat().filter((t) => (from == null || at(t) >= from) && (to == null || at(t) < to))
						: ((await sleeper.transactions(lc.config.leagueId, w)) ?? []);
				const list = txs
					.filter((t) => (include_failed ? true : t.status === "complete"))
					.filter((t) => (type ? t.type === type : true))
					.sort((a, b) => (b.status_updated ?? b.created) - (a.status_updated ?? a.created))
					.slice(0, limit ?? 50)
					.map((t) => formatTransaction(lc, t));
				return ok({ ...(from != null || to != null ? { since: from != null ? eastern(from) : null, until: to != null ? eastern(to) : "now" } : { week: w }), count: list.length, transactions: list });
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
				"Players trending on Sleeper waivers league-wide (most added and/or dropped), filtered to players available in this league by default, with this week's league-scored projection, recent usage (snap %, targets, red-zone looks, expected points) and FantasyPros rest-of-season rank.",
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
					const picked = raw
						.filter((t) => !onlyAvail || !owned.has(t.player_id))
						.map((t) => ({ t, p: lc.players.get(t.player_id) }))
						.filter(({ p }) => p && (!position || p.pos === position) && ["QB", "RB", "WR", "TE"].includes(p.pos))
						.slice(0, limit ?? 25);
					// Recent usage separates a real role change from a one-week blip.
					const [nflCtx, waivers, heads] = await Promise.all([
						playerContext(lc, picked.map(({ t }) => t.player_id), { projections: new Map(picked.map(({ t }) => [t.player_id, pool.get(t.player_id)?.pts ?? null])) }),
						k === "add" ? waiverStatuses(lc, picked.map(({ t }) => t.player_id)) : Promise.resolve(new Map()),
						latestHeadlines(picked.map(({ t }) => t.player_id), 96),
					]);
					out[k === "add" ? "adds" : "drops"] = picked.map(({ t, p }) => {
						const c = nflCtx.get(t.player_id);
						return {
							player: fmt(p!),
							count: t.count,
							...(pool.size ? { proj_week: pool.get(t.player_id)?.pts ?? 0 } : {}),
							...(c?.recent ? { recent: compactRecent(c.recent) } : {}),
							...(c?.ecr?.ros ? { ros_rank: c.ecr.ros } : {}),
							...(c?.role_change ? { role_change: c.role_change } : {}),
				...(c?.projection_check ? { projection_check: c.projection_check } : {}),
							...(() => {
								const h = heads.get(t.player_id);
								const sig = h ? roleSignal(h.title) : null;
								return { ...(h ? { news: newsLine(h) } : {}), ...(sig ? { role_news: sig.kind === "negative" ? `Warning: ${sig.reason}` : sig.reason } : {}) };
							})(),
							...(waivers.get(t.player_id) ? { waiver: waivers.get(t.player_id) } : {}),
							...(!onlyAvail && owned.has(t.player_id) ? { rostered_by: lc.team(owned.get(t.player_id)!).owner } : {}),
						};
					});
					if (nflCtx.size) out.legend = CONTEXT_LEGEND + " ros_rank = FantasyPros rest-of-season positional rank.";
				}
				out.as_of = await asOf(lc, ["projections", "stats", "rankings", "news", "transactions"]);
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
				include_teamless: z.boolean().optional().describe("Include players with no NFL team (unsigned or retired). Default false, unless team is 'FA'; teamless players on a roster here always show."),
				limit: z.number().int().min(1).max(50).optional().describe("Default 10."),
			}),
			annotations: READ_ONLY,
		},
		async ({ name, team, position, available_only, include_teamless, limit }) => {
			try {
				if (!name && !team && !position) return fail("Give at least one of name, team or position.");
				const lc = await ctx();
				const owned = lc.ownership();
				const pool = poolMap(await weekPool(env.PLAYERS, lc.league, lc.season, lc.week, lc.seasonType));
				const n = limit ?? 10;
				const keepTeamless = include_teamless || team?.toUpperCase() === "FA";
				let hits = lc.players
					.search({ name, team, position, limit: 500 })
					.filter((p) => !available_only || !owned.has(p.id))
					// Retired and unsigned players clutter results; keep them only on request or when rostered here.
					.filter((p) => keepTeamless || ((!!p.team && p.active !== false) || owned.has(p.id)));
				// Sleeper keeps some retired players on a team (Roethlisberger on PIT): hide those DynastyProcess
				// lists as free agents and Sleeper has on no depth chart, unless rostered here.
				if (!keepTeamless) {
					const dpFa = await NflData.from(env, lc.season)
						.dpFreeAgents(hits.filter((p) => p.team && !p.depth && !owned.has(p.id)).map((p) => p.id))
						.catch(() => new Set<string>());
					if (dpFa.size) hits = hits.filter((p) => !dpFa.has(p.id));
				}
				const hidden = keepTeamless ? 0 : lc.players.search({ name, team, position, limit: 500 }).filter((p) => (!p.team || p.active === false) && !owned.has(p.id)).length;
				hits = hits.slice(0, n);
				// Without a name, rank by this week's projection when we have one.
				if (!name && pool.size) hits.sort((a, b) => (pool.get(b.id)?.pts ?? -1) - (pool.get(a.id)?.pts ?? -1));
				const rows = hits.map((p) => ({
						id: p.id,
						name: p.name,
						pos: p.pos,
						team: p.team ?? "FA",
						...(p.injury ? { injury: p.injury } : {}),
						...(p.age ? { age: p.age } : {}),
				...(p.depth ? { depth: p.depth } : {}),
				...(p.injury_start ? { injured_since: p.injury_start } : {}),
						...(p.depth ? { depth: p.depth } : {}),
						...(p.injury_start ? { injured_since: p.injury_start } : {}),
						...(p.status ? { status: p.status } : {}),
						league_status: owned.has(p.id) ? lc.team(owned.get(p.id)!).owner : "available",
						...(pool.size ? { proj_week: pool.get(p.id)?.pts ?? 0 } : {}),
					}));
				return ok(hidden && !rows.length ? { players: rows, teamless_hidden: hidden, note: "Players with no NFL team (unsigned or retired) are hidden; pass include_teamless: true to see them." } : rows);
			} catch (e) {
				return fail(e);
			}
		},
	);

	// -------------------------------------------------------------- projection
	async function valuations(lc: LeagueContext, queries: string[], week: number | undefined, includeWeeks: boolean) {
		const w = week ?? lc.week;
		const through = lastFantasyWeek(lc.league);
		const dynasty = isDynasty(lc.league);
		const [{ pool, repl }, adp] = await Promise.all([
			replacementFor(lc, w),
			dynasty ? dynastyAdp(env.PLAYERS, lc.league) : Promise.resolve({} as Record<string, number>),
		]);
		const hasAdp = Object.keys(adp).length > 0;
		const owned = lc.ownership();
		const ranks = positionRanks(pool);
		const players = queries.map((q) => lc.players.resolve(q));
		const nflCtxP = playerContext(lc, players.map((p) => p.id), { dynasty, projections: new Map(players.map((p) => [p.id, pool.find((e) => e.id === p.id)?.pts ?? (pool.length ? 0 : null)])) });
		const [byes, matchup, implied, news, norms] = await Promise.all([
			teamByes(lc),
			matchups(lc, w),
			impliedTotals(lc, w),
			Promise.all(players.map((p) => playerNews(p.id, { limit: 2, maxAgeHours: 7 * 24 }))),
			impliedNorms(lc, w),
		]);
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
					injury: p.injury,
					status: p.status,
					...(p.team && byes.has(p.team) ? { teamByes: byes.get(p.team) } : {}),
				}),
			),
		);
		const nflCtx = await nflCtxP;
		const rows = players.map((p, i) => {
			const c = nflCtx.get(p.id);
			return {
				player: fmt(p),
				id: p.id,
				league_status: owned.has(p.id) ? lc.team(owned.get(p.id)!).owner : "available",
				...(p.age ? { age: p.age } : {}),
				...(p.status ? { status: p.status } : {}),
				...(ranks.has(p.id) ? { week_pos_rank: ranks.get(p.id) } : {}),
				...(vals[i] ?? { projection: "unavailable" }),
				...(hasAdp ? { dynasty_adp: adp[p.id] ?? null, dynasty_value: dynastyValue(adp[p.id]) } : {}),
				// Matchup context, same as get_my_roster.
				...(() => {
					const m = matchup(p.team, p.pos);
					return m ? { vs: `${m.home ? "" : "@"}${m.opp}`, ...(m.def_rank ? { def_rank: m.def_rank } : {}) } : p.team && implied.size ? { vs: "BYE" } : {};
				})(),
				...(p.team && implied.has(p.team) ? { implied: implied.get(p.team), ...impliedDelta(implied.get(p.team), norms.get(p.team)) } : {}),
				// FantasyPros consensus (a second opinion next to Sleeper's projections/ADP) and recent nflverse usage.
				...(c?.ecr ? { consensus: c.ecr } : {}),
				...(c?.recent ? { recent: c.recent } : {}),
				...(c?.role_change ? { role_change: c.role_change } : {}),
				...(c?.projection_check ? { projection_check: c.projection_check } : {}),
				...(c?.injury_report ? { injury_report: c.injury_report } : {}),
				...(c?.play_pct != null ? { play_pct: c.play_pct, ...(c.play_basis ? { play_basis: c.play_basis } : {}) } : {}),
				...(news[i]!.length ? { news: news[i]!.map((n) => newsLine(n)) } : {}),
			};
		});
		return { week: w, through_week: Math.max(w, through), repl, rows, vals, players, dynasty: dynasty && hasAdp };
	}

	server.registerTool(
		"project_player",
		{
			title: "Project player",
			description:
				"League-scored projection for one player: this week's points and key stats, rest-of-season total and per-game, value over replacement (superflex-aware), " +
				"bye weeks, weeks Sleeper projects him out, a verify list of assumptions to check, FantasyPros consensus ranks, recent usage and the official injury report. These are Sleeper's estimates, not facts: " +
				"confirm status and role with current news before recommending anything, and explain any zero, drop or return date you rely on.",
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
					as_of: await asOf(lc, ["injury_tags", "projections", "injury_report", "lines", "rankings", "stats", "news", ...(v.dynasty ? (["adp"] as const) : [])], { teams: v.players.map((p) => p.team) }),
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
				"Compare 2-8 players under this league's scoring: this week's projection (start/sit), rest-of-season points and value over replacement, and in dynasty leagues long-term value from Sleeper dynasty ADP. " +
				"These are Sleeper's estimates: when players are within a couple of points, decide on role, health and matchup rather than the gap, and check each player's verify list.",
			inputSchema: z.object({
				players: z.array(z.string()).min(2).max(8).describe("Names or Sleeper ids."),
				week: weekArg,
				focus: z.enum(["win_now", "balanced", "long_term"]).optional().describe("win_now hides dynasty values (default from DEFAULT_TRADE_FOCUS)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ players, week, focus }) => {
			try {
				const lc = await ctx();
				const v = await valuations(lc, players, week, false);
				const hide = v.dynasty && (focus ?? readPrefs(env, lc.players).focus) === "win_now";
				if (hide) v.rows = v.rows.map(withoutDynasty);
				const byWeek = [...v.rows].sort((a, b) => num(b, "week_pts") - num(a, "week_pts"));
				const byRos = [...v.rows].sort((a, b) => num(b, "ros_vor") - num(a, "ros_vor"));
				return ok({
					as_of: await asOf(lc, ["injury_tags", "projections", "injury_report", "lines", "rankings", "stats", "news", ...(v.dynasty && !hide ? (["adp"] as const) : [])], { teams: v.players.map((p) => p.team) }),
					week: v.week,
					through_week: v.through_week,
					...(v.repl ? { replacement_level_week: v.repl.level, league_starters: v.repl.starters } : {}),
					players: v.rows,
					best_this_week: byWeek[0]?.player,
					best_rest_of_season: byRos[0]?.player,
					...(hide ? { dynasty_hidden: DYNASTY_HIDDEN } : {}),
					...(v.dynasty && !hide
						? { best_dynasty: [...v.rows].sort((a, b) => num(b, "dynasty_value") - num(a, "dynasty_value"))[0]?.player }
						: {}),
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
				"Evaluate a trade under this league's scoring: rest-of-season projected points and value over replacement given vs received (superflex-aware, so QBs carry their real value), plus the effect on this week's optimal lineup for both teams. In dynasty leagues it also compares long-term market value (Sleeper dynasty ADP, plus draft picks) and gives separate win-now and long-term verdicts. " +
				"The verdicts inherit Sleeper's projections and ADP, which lag injuries, suspensions and role changes: before pitching a trade, check each player's verify list and current news, " +
				"and check trade_review_days (get_league_settings) before saying it helps this week.",
			inputSchema: z.object({
				give: z.array(z.string()).max(8).optional().describe("Players you send (names or ids)."),
				get: z.array(z.string()).max(8).optional().describe("Players you receive (names or ids)."),
				give_picks: z.array(pickSchema).max(6).optional().describe("Draft picks you send."),
				get_picks: z.array(pickSchema).max(6).optional().describe("Draft picks you receive."),
				team: z.string().optional().describe("Whose side 'give' is. Default: the configured user ('me')."),
				focus: z.enum(["win_now", "balanced", "long_term"]).optional().describe("win_now hides dynasty values (default from DEFAULT_TRADE_FOCUS)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ give: giveIn, get: getIn, give_picks, get_picks, team, focus }) => {
			try {
				const give = giveIn ?? [];
				const get = getIn ?? [];
				if (!give.length && !give_picks?.length) return fail("Nothing given: pass give and/or give_picks.");
				if (!get.length && !get_picks?.length) return fail("Nothing received: pass get and/or get_picks.");
				const lc = await ctx();
				const v = await valuations(lc, [...give, ...get], undefined, false);
				const prefs = readPrefs(env, lc.players);
				// Picks only have dynasty value, so a pick trade always shows it.
				const hide = v.dynasty && (focus ?? prefs.focus) === "win_now" && !give_picks?.length && !get_picks?.length;
				const g = v.rows.slice(0, give.length);
				const r = v.rows.slice(give.length);
				const sum = (rows: typeof v.rows, k: keyof PlayerValuation | "dynasty_value") => round(rows.reduce((s, x) => s + num(x, k), 0), 1);
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
					if (mine.roster_id === lc.myRoster().roster_id && prefs.untouchables.has(p.id)) warnings.push(`${p.name} is on your untouchables list.`);
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

				// Playoff odds before and after, re-simulating the rest of the regular season with both rosters swapped.
				let playoffOdds: Record<string, unknown> | undefined;
				try {
					const season = await loadSeason(lc);
					if (season.schedule.length) {
						const swap = (ro: Roster, remove: Set<string>, add: Set<string>) => [...activeIds(ro).filter((id) => !remove.has(id)), ...add];
						const overrides = new Map<number, string[]>([[mine.roster_id, swap(mine, giveIds, getIds)]]);
						if (partner) overrides.set(partner.roster_id, swap(partner, getIds, giveIds));
						const before = runOdds(lc, season);
						const after = runOdds(lc, season, overrides);
						const pair = (id: number) => ({ before: before.odds.get(id)!.playoffs, after: after.odds.get(id)!.playoffs, change: round(after.odds.get(id)!.playoffs - before.odds.get(id)!.playoffs, 1) });
						playoffOdds = { you: pair(mine.roster_id), ...(partner ? { partner: pair(partner.roster_id) } : {}), weeks: `${season.weeks[0]}-${season.regEnd}` };
					}
				} catch {
					playoffOdds = undefined;
				}

				// Draft picks: valued on the dynasty scale (no rest-of-season points).
				const pickPartnerId = partner?.roster_id ?? (get_picks?.find((p) => p.from) ? lc.findRoster(get_picks.find((p) => p.from)!.from).roster_id : undefined);
				const [givePicks, getPicks] = await Promise.all([
					valuePicks(lc, give_picks ?? [], mine.roster_id),
					valuePicks(lc, get_picks ?? [], pickPartnerId),
				]);
				for (const p of [...givePicks, ...getPicks]) if (p.warning) warnings.push(p.warning);
				if ((givePicks.length || getPicks.length) && !v.dynasty) warnings.push("Draft picks only carry value in dynasty/keeper formats; they're shown but not counted.");
				const pickSum = (ps: typeof givePicks) => ps.reduce((a, p) => a + p.value, 0);

				const verdict =
					Math.abs(diff) < 5 ? "roughly even" : diff > 0 ? (diff > 25 ? "clearly favors you" : "favors you") : diff < -25 ? "clearly favors them" : "favors them";
				// Dynasty: also compare long-term market value (players + picks), as a share of the bigger side.
				const giveDyn = sum(g, "dynasty_value") + (v.dynasty ? pickSum(givePicks) : 0);
				const getDyn = sum(r, "dynasty_value") + (v.dynasty ? pickSum(getPicks) : 0);
				const dynDiff = round(getDyn - giveDyn, 0);
				const dynPct = Math.max(giveDyn, getDyn) > 0 ? dynDiff / Math.max(giveDyn, getDyn) : 0;
				const dynastyVerdict =
					Math.abs(dynPct) < 0.1 ? "roughly even" : dynPct > 0 ? (dynPct > 0.25 ? "clearly favors you" : "favors you") : dynPct < -0.25 ? "clearly favors them" : "favors them";
				return ok({
					as_of: await asOf(lc, ["injury_tags", "projections", "injury_report", "lines", "rankings", "stats", "news", ...(v.dynasty && !hide ? (["adp"] as const) : [])], { teams: v.players.map((p) => p.team) }),
					from_perspective_of: lc.team(mine.roster_id).owner,
					...(partner ? { partner: lc.team(partner.roster_id).owner } : {}),
					weeks: `${v.week}-${v.through_week}`,
					give: hide ? g.map(withoutDynasty) : g,
					get: hide ? r.map(withoutDynasty) : r,
					...(givePicks.length ? { give_picks: givePicks.map(({ warning: _w, ...p }) => p) } : {}),
					...(getPicks.length ? { get_picks: getPicks.map(({ warning: _w, ...p }) => p) } : {}),
					totals: {
						give: { ros_pts: sum(g, "ros_pts"), ros_vor: giveVor },
						get: { ros_pts: sum(r, "ros_pts"), ros_vor: getVor },
						vor_diff: diff,
						...(v.dynasty && !hide ? { dynasty_value_give: giveDyn, dynasty_value_get: getDyn, dynasty_value_diff: dynDiff } : {}),
					},
					...(v.dynasty && !hide ? { verdict: { win_now: verdict, long_term: dynastyVerdict } } : { verdict }),
					...(hide ? { dynasty_hidden: DYNASTY_HIDDEN } : {}),
					...(pool.size
						? {
								lineup_this_week: {
									you: lineup(mine, giveIds, getIds),
									...(partner ? { partner: lineup(partner, getIds, giveIds) } : {}),
								},
							}
						: {}),
					...(playoffOdds ? { playoff_odds_pct: playoffOdds } : {}),
					...(v.repl ? { replacement_level_week: v.repl.level, league_starters: v.repl.starters } : {}),
					...(warnings.length ? { warnings } : {}),
					note:
						"VOR = projected points above a replacement-level starter at the same position, summed over remaining weeks. Roster-spot cost of 2-for-1 deals and injuries/news are not modeled: " +
						"the verdicts are only as good as Sleeper's projections, so check each player's verify list and current news before acting." +
						(v.dynasty && !hide
							? " dynasty_value = market value from Sleeper dynasty ADP (10000 = 1st overall); it is additive, so it overrates trading one star for several depth pieces. " +
								"A pick is valued as this year's rookie drafted at that overall slot (current dynasty value), minus 10% per extra year out; slot defaults to the original owner's current standing."
							: ""),
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	registerNflTools(server, env);
	registerAdvisorTools(server, env);
	registerLeagueTools(server, env);

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

/** Recent-usage block for list views: drop the window label (shown once in the legend). */
function compactRecent(r: NonNullable<PlayerContext["recent"]>) {
	const { weeks: _w, ...rest } = r;
	return rest;
}

const CONTEXT_LEGEND =
	"ecr = FantasyPros consensus positional rank this week (omitted until this week's rankings are published); ros_rank = rest-of-season rank. " +
	"vs = this week's opponent (@ = away, BYE = no game); def_rank = that defense's rank in points allowed to the player's position this season (1 = most allowed, best matchup; 32 = toughest). implied = team's Vegas implied points; implied_vs_norm = that minus the team's average implied total this season (+3 or more historically adds ~0.7 pts, -3 or less costs ~1.0). " +
	"play_pct = chance a Questionable player plays, from 2016-2025 base rates by last practice (DNP 50, Limited 75, Full 92; QBs 55; Doubtful ~10). " +
	"recent = per-game over the last 3 weeks with stats: snap %, targets and target share, carries, rz_opps (red-zone targets + carries), " +
	"pts under league scoring and xfp (expected points for that usage). injury_report = official report: status (injury), practice. " +
	"role_change = usage trends: usage that moved sharply in the last 3 weeks vs earlier (context; injury-shortened games are left out of the baseline). projection_check = Sleeper's projection far from recent usage: check these before acting. news = latest headline in the last 72h (get_player_news for more). " +
	"depth = Sleeper depth chart slot (RB1, QB2; WRs as LWR/RWR/SWR + order). injured_since = when the current injury began.";

/**
 * A projection of 0 for a player whose team plays this week needs a reason before anyone
 * relies on it: Sleeper's projections lag announcements and sometimes assume unannounced
 * benchings. Returns a note, or undefined when nothing needs checking.
 */
export function zeroProjectionNote(
	proj: number | null,
	hasGame: boolean,
	tag: string | undefined,
	report: string | undefined,
	news?: { title: string; age_hours: number; published_et?: string },
): string | undefined {
	if (proj !== 0 || !hasGame) return undefined;
	if (news && news.age_hours <= 72) return `Projected 0 with a game this week. Latest news (${news.published_et ? `${news.published_et}, ` : ""}${news.age_hours}h ago): "${news.title}". Confirm before benching or dropping.`;
	if (report) return `Projected 0 with a game this week. Official report: ${report}. Confirm he's ruled out before benching or dropping.`;
	if (tag) return `Projected 0 with a game this week; listed ${tag}. Confirm his status in current news.`;
	return "Projected 0 with a game this week and no injury or status listed. Sleeper doesn't say why (injury news, benching, depth chart?), so find a dated source before relying on it.";
}

const DYNASTY_HIDDEN = "Focus is win_now, so dynasty ADP and values are left out. Pass focus: 'balanced' or 'long_term' to include them.";

/** Drop the dynasty market fields from a valuation row. */
function withoutDynasty<T extends object>(row: T): T {
	const { dynasty_adp: _a, dynasty_value: _v, ...rest } = row as T & { dynasty_adp?: unknown; dynasty_value?: unknown };
	return rest as T;
}

/** Weather for the games your players are in (only outdoor games get a forecast). */
async function rosterWeather(lc: LeagueContext, week: number, ids: string[]): Promise<Map<string, GameWeather>> {
	try {
		const teams = new Set(ids.map((id) => lc.players.get(id)?.team).filter(Boolean));
		const games = (await NflData.from(lc.env, lc.season).games(week)).filter(
			(g) => typeof g.home_score !== "number" && (teams.has(sleeperTeam(g.home_team) ?? "") || teams.has(sleeperTeam(g.away_team) ?? "")),
		);
		return await gameWeather(games);
	} catch {
		return new Map();
	}
}

/** Prefer the record computed from matchup results; keep Sleeper's when it differs, so the lag is visible. */
function withComputedRecord<T extends { record: string; pf: number; pa: number }>(info: T, computed: { wins: number; losses: number; ties: number; pf: number; pa: number } | undefined): T & { sleeper_record?: string } {
	if (!computed || computed.wins + computed.losses + computed.ties === 0) return info;
	const rec = recordString(computed as Parameters<typeof recordString>[0]);
	return { ...info, record: rec, pf: computed.pf, pa: computed.pa, ...(rec !== info.record ? { sleeper_record: info.record } : {}) };
}

