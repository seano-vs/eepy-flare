// League-level tools: playoff odds, each team's needs, and player news.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LeagueContext } from "./league";
import { isUnavailable } from "./nflverse/context";
import { playerNews } from "./news";
import { activeIds, loadSeason, runOdds } from "./playoffs";
import { READ_ONLY, fail, fmt, ok } from "./result";
import { optimalLineup, round } from "./scoring";
import { sleeper } from "./sleeper";

export function registerLeagueTools(server: McpServer, env: Env): void {
	// ------------------------------------------------------------ playoff odds
	server.registerTool(
		"get_playoff_odds",
		{
			title: "Playoff odds",
			description:
				"Standings computed from actual matchup results, plus playoff and bye odds from 5,000 simulations of the remaining regular season. " +
				"Each team's weekly strength is its best projected lineup that week (Sleeper projections, league scoring; byes and absences count) blended with its scoring so far. " +
				"For your team it also shows the odds if you win or lose this week.",
			inputSchema: z.object({}),
			annotations: READ_ONLY,
		},
		async () => {
			try {
				const lc = await LeagueContext.load(env);
				const season = await loadSeason(lc);
				if (!season.schedule.length) return ok({ note: "The regular season is over; no games left to simulate.", standings: standingRows(lc, season) });
				let mine: number | undefined;
				try {
					mine = lc.myRoster().roster_id;
				} catch {
					mine = undefined;
				}
				const sim = runOdds(lc, season, undefined, mine);
				const rows = standingRows(lc, season).map((r) => ({ ...r, ...sim.odds.get(r.roster_id), ...(r.roster_id === mine ? { is_me: true } : {}) }));
				rows.sort((a, b) => (b.playoffs ?? 0) - (a.playoffs ?? 0));
				return ok({
					completed_weeks: season.completed,
					simulated_weeks: `${season.weeks[0]}-${season.regEnd}`,
					playoff_teams: Number(lc.league.settings.playoff_teams) || 6,
					teams: rows.map(({ roster_id: _r, ...x }) => x),
					...(sim.focus ? { you_this_week: sim.focus } : {}),
					note:
						"Odds are a model, not a forecast to quote as fact: they inherit Sleeper's projections (which lag injuries and role changes) and use a simple seeding of wins then points for. " +
						"Records here come from matchup results, which can be ahead of Sleeper's displayed record.",
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ------------------------------------------------------------ team needs
	server.registerTool(
		"get_team_needs",
		{
			title: "Team needs",
			description:
				"For each team (or one): weak starting slots vs the league, starters missing in the next two weeks (bye or projected out), QB coverage for QB/superflex slots, FAAB left, and the positions it has been chasing on waivers. " +
				"Use it to predict waiver competition and to find trade partners.",
			inputSchema: z.object({ team: z.string().optional().describe("One team (owner/team name, 'me'); default all.") }),
			annotations: READ_ONLY,
		},
		async ({ team }) => {
			try {
				const lc = await LeagueContext.load(env);
				const season = await loadSeason(lc);
				const slots = lc.league.roster_positions.filter((s) => s !== "BN");
				const pools = season.pools.slice(0, 2);
				const qbSlots = slots.filter((s) => s === "QB" || s === "SUPER_FLEX").length;
				const budget = Number(lc.league.settings.waiver_budget) || 100;
				const recentWeeks = [lc.week - 2, lc.week - 1, lc.week].filter((w) => w >= 1);
				const txs = (await Promise.all(recentWeeks.map((w) => sleeper.transactions(lc.config.leagueId, w).catch(() => [])))).flat();

				// League median at each starting slot this week, to call a slot weak.
				const lineups = new Map(lc.rosters.map((r) => [r.roster_id, pools[0] ? optimalLineup(activeIds(r), slots, pools[0]) : null]));
				const medianAt = slots.map((_, i) => {
					const xs = [...lineups.values()].map((l) => l?.starters[i]?.pts ?? 0).sort((a, b) => a - b);
					return xs[Math.floor(xs.length / 2)] ?? 0;
				});

				// Free agents who'd start somewhere this week (unowned, not out), best first.
				const owned = lc.ownership();
				const freeAgents = pools[0]
					? [...pools[0].entries()]
							.filter(([id, e]) => e.pts > 0 && !owned.has(id) && !isUnavailable(lc.players.get(id)))
							.sort((a, b) => b[1].pts - a[1].pts)
							.slice(0, 40)
							.map(([id]) => id)
					: [];

				const target = team ? lc.findRoster(team) : undefined;
				const out = lc.rosters
					.filter((r) => !target || r.roster_id === target.roster_id)
					.map((r) => {
						const lineup = lineups.get(r.roster_id);
						// The two starting slots furthest below the league median.
						const gaps = (lineup?.starters ?? [])
							.map((s, i) => ({ slot: s.slot, starter: s.id ? fmt(lc.ref(s.id)) : "(empty)", proj: s.pts, league_median: round(medianAt[i]!, 1), gap: round(medianAt[i]! - s.pts, 1) }))
							.filter((g) => g.gap > 0)
							.sort((a, b) => b.gap - a.gap)
							.slice(0, 2);
						// Best free-agent adds: biggest gain to this week's best lineup.
						const base = lineup?.total ?? 0;
						const adds = pools[0]
							? freeAgents
									.map((id) => ({ id, gain: round(optimalLineup([...activeIds(r), id], slots, pools[0]!).total - base, 1) }))
									.filter((a) => a.gain >= 1)
									.sort((a, b) => b.gain - a.gain)
									.slice(0, 2)
									.map((a) => ({ player: fmt(lc.ref(a.id)), lineup_gain: a.gain }))
							: [];
						const weak = (lineup?.starters ?? [])
							.map((s, i) => ({ s, i }))
							.filter(({ s, i }) => medianAt[i]! > 0 && s.pts < 0.8 * medianAt[i]!)
							.map(({ s, i }) => `${s.slot}: ${s.id ? fmt(lc.ref(s.id)) : "(empty)"} ${s.pts} vs league median ${round(medianAt[i]!, 1)}`);
						// Starters this week who have no projected game next week, and empty slots either week.
						const holes = pools.flatMap((pool, wi) => {
							const week = season.weeks[wi];
							const best = optimalLineup(activeIds(r), slots, pool);
							return best.starters.filter((s) => !s.id || s.pts === 0).map((s) => `week ${week} ${s.slot}: no projected starter`);
						});
						const qbs = pools.map((pool, wi) => ({
							week: season.weeks[wi],
							qbs_playing: activeIds(r).filter((id) => pool.get(id)?.pos === "QB" && (pool.get(id)?.pts ?? 0) > 0).length,
						}));
						const claims = txs.filter((t) => t.type === "waiver" && t.roster_ids.includes(r.roster_id) && t.adds);
						const chased = new Map<string, number>();
						let maxBid = 0;
						for (const t of claims) {
							for (const pid of Object.keys(t.adds ?? {})) {
								const pos = lc.players.get(pid)?.pos ?? "?";
								chased.set(pos, (chased.get(pos) ?? 0) + 1);
							}
							maxBid = Math.max(maxBid, t.settings?.waiver_bid ?? 0);
						}
						const st = season.standings.get(r.roster_id);
						return {
							team: lc.team(r.roster_id).owner,
							...(lc.team(r.roster_id).team_name ? { team_name: lc.team(r.roster_id).team_name } : {}),
							...(st ? { record: `${st.wins}-${st.losses}${st.ties ? `-${st.ties}` : ""}` } : {}),
							faab_left: budget - (r.settings.waiver_budget_used ?? 0),
							...(gaps.length ? { top_gaps: gaps } : {}),
							...(adds.length ? { best_free_agent_adds: adds } : {}),
							...(weak.length ? { weak_slots: weak } : {}),
							...(holes.length ? { lineup_holes: holes } : {}),
							qb_coverage: { slots: qbSlots, by_week: qbs, ...(qbs.some((q) => q.qbs_playing < qbSlots) ? { short: true } : {}) },
							...(chased.size ? { recent_claims_by_position: Object.fromEntries(chased), max_recent_bid: maxBid } : {}),
						};
					});
				return ok({
					weeks: season.weeks.slice(0, 2).join(", "),
					teams: out,
					note:
						"top_gaps: the two starting slots furthest below the league median this week. best_free_agent_adds: unowned, available players who'd add the most to that team's best lineup this week (on-waivers status not checked). " +
						"weak_slots: this week's best projected starter is below 80% of the league median at that slot. Projections are Sleeper's; check news for the players involved.",
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ------------------------------------------------------------ news
	server.registerTool(
		"get_player_news",
		{
			title: "Player news",
			description:
				"Recent news for 1-10 players from the feed the Sleeper app shows (RotoWire, RotoBaller, FantasyPros): headline, source, time and link. " +
				"Headlines move before projections and injury tags, so check here before trusting a projection.",
			inputSchema: z.object({
				players: z.array(z.string()).min(1).max(10).describe("Names or Sleeper ids. 'roster' alone means every player on your roster."),
				days: z.number().int().min(1).max(30).optional().describe("Only items from the last N days (default 7)."),
				limit: z.number().int().min(1).max(10).optional().describe("Items per player (default 3)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ players, days, limit }) => {
			try {
				const lc = await LeagueContext.load(env);
				const ids = players.length === 1 && /^(roster|my roster|mine)$/i.test(players[0]!) ? (lc.myRoster().players ?? []) : players.map((q) => lc.players.resolve(q).id);
				const maxAgeHours = (days ?? 7) * 24;
				const news = await Promise.all(ids.map((id) => playerNews(id, { limit: limit ?? 3, maxAgeHours })));
				return ok({
					players: ids.map((id, i) => ({ player: fmt(lc.ref(id)), ...(news[i]!.length ? { news: news[i] } : { news: [], note: `No news in the last ${days ?? 7} days.` }) })),
					note: "Sleeper's news feed is undocumented; items are third-party blurbs with their own sourcing. Check the timestamp before acting on one.",
				});
			} catch (e) {
				return fail(e);
			}
		},
	);
}

function standingRows(lc: LeagueContext, season: Awaited<ReturnType<typeof loadSeason>>) {
	return [...season.standings.values()].map((s) => ({
		roster_id: s.roster_id,
		team: lc.team(s.roster_id).owner,
		record: `${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ""}`,
		pf: s.pf,
	}));
}


