// Tools backed by the nflverse mirror in D1: usage trends, expected points,
// injury/practice reports and the schedule with Vegas lines.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LeagueContext } from "./league";
import { NflData, expectedPoints, leaguePoints, sleeperTeam, unmappedRules } from "./nflverse/stats";
import { describeInjury } from "./nflverse/context";
import { READ_ONLY, fail, fmt, ok } from "./result";
import { round } from "./scoring";

type Row = Record<string, unknown>;

const num = (r: Row | undefined, k: string): number => {
	const v = r?.[k];
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => round(x * 100, 1);

const SORTS = ["xfp", "buy_low", "sell_high", "targets", "target_share", "wopr", "carries", "snap_pct", "air_yards", "red_zone", "points"] as const;

export function registerNflTools(server: McpServer, env: Env): void {
	const load = async () => {
		const lc = await LeagueContext.load(env);
		return { lc, nfl: NflData.from(env, lc.season) };
	};

	/** Display for an nflverse row: the Sleeper player when mapped, else the nflverse name. */
	const label = (lc: LeagueContext, sleeperId: string | undefined, r: Row) =>
		sleeperId && lc.players.get(sleeperId) ? fmt(lc.ref(sleeperId)) : `${String(r.name ?? "?")} ${String(r.position ?? "")} ${sleeperTeam(r.team) ?? "FA"}`;

	const ownerOf = (lc: LeagueContext, owned: Map<string, number>, sleeperId: string | undefined) =>
		sleeperId && owned.has(sleeperId) ? lc.team(owned.get(sleeperId)!).owner : "available";

	// ------------------------------------------------------------ usage
	server.registerTool(
		"get_player_usage",
		{
			title: "Player usage trends",
			description:
				"Week-by-week usage from nflverse for 1-6 players: snap share, targets, target share, air-yards share, WOPR, carries, red-zone/goal-line/end-zone/deep usage (play-by-play), production, " +
				"points under this league's scoring, expected fantasy points (ffopportunity, re-scored for this league), Next Gen Stats (separation, YAC over expected, rush yards over expected, CPOE, time to throw) and the current injury/practice report.",
			inputSchema: z.object({
				players: z.array(z.string()).min(1).max(6).describe("Names (e.g. 'Puka Nacua') or Sleeper ids."),
				weeks: z.number().int().min(1).max(18).optional().describe("How many recent weeks (default 4)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ players, weeks }) => {
			try {
				const { lc, nfl } = await load();
				const latest = await nfl.latestWeek();
				if (!latest) return ok({ note: "No nflverse stats for this season yet." });
				const from = Math.max(1, latest - (weeks ?? 4) + 1);
				const resolved = players.map((q) => lc.players.resolve(q));
				const ids = await nfl.ids(resolved.map((p) => p.id));
				const owned = lc.ownership();
				const scoring = lc.league.scoring_settings;
				// Only each team's current report: an older entry would read as a current injury.
				const gsisIds = [...ids.values()].map((x) => x.gsis_id).filter((x): x is string => !!x);
				const injuries = gsisIds.length
					? (await nfl.currentInjuries(`AND gsis_id IN (${gsisIds.map(() => "?").join(",")})`, ...gsisIds)).rows
					: [];
				const out = [];
				for (const p of resolved) {
					const id = ids.get(p.id);
					const base = { player: fmt(p), league_status: ownerOf(lc, owned, p.id) };
					if (!id?.gsis_id) {
						out.push({ ...base, note: "No nflverse id mapping for this player." });
						continue;
					}
					const ngsTable = p.pos === "QB" ? "nfl_ngs_passing" : p.pos === "RB" ? "nfl_ngs_rushing" : "nfl_ngs_receiving";
					const [stats, opp, snaps, pbp, ngs] = await Promise.all([
						nfl.byPlayer("nfl_player_week", "gsis_id", id.gsis_id, from, latest),
						nfl.byPlayer("nfl_opportunity", "gsis_id", id.gsis_id, from, latest),
						id.pfr_id ? nfl.byPlayer("nfl_snaps", "pfr_id", id.pfr_id, from, latest) : Promise.resolve([] as Row[]),
						nfl.byPlayer("nfl_pbp_week", "gsis_id", id.gsis_id, from, latest),
						nfl.byPlayer(ngsTable, "gsis_id", id.gsis_id, from, latest),
					]);
					const oppBy = new Map(opp.map((r) => [r.week as number, r]));
					const snapBy = new Map(snaps.map((r) => [r.week as number, r]));
					const pbpBy = new Map(pbp.map((r) => [r.week as number, r]));
					const isQb = p.pos === "QB";
					const rows = stats.map((r) => {
						const w = r.week as number;
						const o = oppBy.get(w);
						const s = snapBy.get(w);
						const pts = leaguePoints(r, scoring);
						const xfp = o ? expectedPoints(o, scoring) : null;
						const pb = pbpBy.get(w);
						return {
							week: w,
							opp: sleeperTeam(r.opp),
							...(s ? { snap_pct: pct(num(s, "offense_pct")) } : {}),
							...(isQb
								? {
										att: num(r, "attempts"),
										pass_yd: num(r, "passing_yards"),
										pass_td: num(r, "passing_tds"),
										int: num(r, "passing_interceptions"),
									}
								: {}),
							carries: num(r, "carries"),
							rush_yd: num(r, "rushing_yards"),
							...(isQb
								? {}
								: {
										targets: num(r, "targets"),
										tgt_share: pct(num(r, "target_share")),
										air_share: pct(num(r, "air_yards_share")),
										wopr: round(num(r, "wopr"), 2),
										rec: num(r, "receptions"),
										rec_yd: num(r, "receiving_yards"),
									}),
							td: num(r, "rushing_tds") + num(r, "receiving_tds"),
							...(pb ? redZone(pb, p.pos) : {}),
							pts,
							...(xfp != null ? { xfp, diff: round(pts - xfp, 1) } : {}),
						};
					});
					const per = (k: string) => round(avg(rows.map((x) => num(x as Row, k))), 1);
					const inj = injuries.find((i) => i.gsis_id === id.gsis_id);
					const rzTotals = pbp.length ? redZoneTotals(pbp, p.pos, rows.length) : {};
					out.push({
						...base,
						weeks: rows,
						per_game: {
							games: rows.length,
							...(snaps.length ? { snap_pct: per("snap_pct") } : {}),
							...(isQb ? { pass_yd: per("pass_yd"), pass_td: per("pass_td") } : { targets: per("targets"), tgt_share: per("tgt_share"), wopr: round(avg(rows.map((x) => num(x as Row, "wopr"))), 2) }),
							carries: per("carries"),
							...rzTotals,
							pts: per("pts"),
							...(opp.length ? { xfp: per("xfp"), diff: per("diff") } : {}),
						},
						...(ngs.length ? { next_gen: nextGen(ngs, p.pos) } : {}),
						...(inj ? { injury_report: `${describeInjury(inj) ?? "On report"} (week ${inj.week})` } : {}),
					});
				}
				const gaps = unmappedRules(scoring);
				return ok({
					weeks: `${from}-${latest}`,
					players: out,
					note:
						"pts = this league's scoring applied to nflverse box scores. xfp = expected points for the same usage (ffopportunity model), re-scored for this league; diff = pts - xfp (negative = unlucky). " +
						"Red zone from play-by-play: rz_tgt/rz_car inside the 20 (with share of team), ez_tgt = targets at or past the goal line, gl_car = carries inside the 5, deep_tgt = 20+ air yards. " +
						"next_gen = NFL Next Gen Stats averages over the weeks the player qualified." +
						(gaps.length ? ` Not reproduced: ${gaps.join(", ")}.` : ""),
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ------------------------------------------------------------ leaders
	server.registerTool(
		"get_opportunity_leaders",
		{
			title: "Opportunity leaders",
			description:
				"Rank players by usage or expected fantasy points over recent weeks (nflverse + ffopportunity, scored for this league). " +
				"Use available_only for waiver targets; sort buy_low (scoring well below expected) or sell_high (well above expected) for trade targets.",
			inputSchema: z.object({
				position: z.enum(["QB", "RB", "WR", "TE"]).optional(),
				weeks: z.number().int().min(1).max(18).optional().describe("Recent weeks to aggregate (default 3)."),
				sort: z.enum(SORTS).optional().describe("Default xfp (expected points per game)."),
				available_only: z.boolean().optional().describe("Only players not on a roster in this league."),
				limit: z.number().int().min(1).max(50).optional().describe("Default 15."),
			}),
			annotations: READ_ONLY,
		},
		async ({ position, weeks, sort, available_only, limit }) => {
			try {
				const { lc, nfl } = await load();
				const latest = await nfl.latestWeek();
				if (!latest) return ok({ note: "No nflverse stats for this season yet." });
				const span = weeks ?? 3;
				const from = Math.max(1, latest - span + 1);
				const posFilter = position ? "AND position = ?" : "";
				const posArgs = position ? [position] : [];
				const [stats, opps, snaps, pbp, maps] = await Promise.all([
					nfl.weekRange("nfl_player_week", from, latest, posFilter, ...posArgs),
					nfl.weekRange("nfl_opportunity", from, latest, posFilter, ...posArgs),
					nfl.weekRange("nfl_snaps", from, latest, posFilter, ...posArgs),
					nfl.weekRange("nfl_pbp_week", from, latest),
					nfl.idMaps(),
				]);
				const scoring = lc.league.scoring_settings;
				type Agg = { r: Row; games: number; pts: number; xfp: number; oppGames: number; tgt: number; share: number[]; wopr: number[]; car: number; air: number; snap: number[]; rz: number };
				const agg = new Map<string, Agg>();
				for (const r of stats) {
					const g = String(r.gsis_id);
					let a = agg.get(g);
					if (!a) agg.set(g, (a = { r, games: 0, pts: 0, xfp: 0, oppGames: 0, tgt: 0, share: [], wopr: [], car: 0, air: 0, snap: [], rz: 0 }));
					a.games++;
					a.pts += leaguePoints(r, scoring);
					a.tgt += num(r, "targets");
					a.car += num(r, "carries");
					a.air += num(r, "receiving_air_yards");
					a.share.push(num(r, "target_share"));
					a.wopr.push(num(r, "wopr"));
				}
				for (const o of opps) {
					const a = agg.get(String(o.gsis_id));
					if (!a) continue;
					a.xfp += expectedPoints(o, scoring);
					a.oppGames++;
				}
				for (const p of pbp) {
					const a = agg.get(String(p.gsis_id));
					if (a) a.rz += num(p, "rz_targets") + num(p, "rz_carries");
				}
				const gsisOfSleeper = maps.bySleeper;
				const sleeperOfGsis = maps.byGsis;
				for (const s of snaps) {
					const sid = maps.byPfr.get(String(s.pfr_id));
					const g = sid ? gsisOfSleeper.get(sid) : undefined;
					const a = g ? agg.get(g) : undefined;
					if (a) a.snap.push(num(s, "offense_pct"));
				}
				const owned = lc.ownership();
				const minGames = Math.min(2, span);
				let rows = [...agg.entries()]
					.filter(([, a]) => a.games >= minGames)
					.map(([g, a]) => {
						const sid = sleeperOfGsis.get(g);
						const ppg = a.pts / a.games;
						const xpg = a.oppGames ? a.xfp / a.oppGames : null;
						return {
							sid,
							player: label(lc, sid, a.r),
							league_status: ownerOf(lc, owned, sid),
							games: a.games,
							...(a.snap.length ? { snap_pct: pct(avg(a.snap)) } : {}),
							targets: round(a.tgt / a.games, 1),
							tgt_share: pct(avg(a.share)),
							wopr: round(avg(a.wopr), 2),
							carries: round(a.car / a.games, 1),
							air_yards: round(a.air / a.games, 1),
							rz_opps: round(a.rz / a.games, 1),
							pts: round(ppg, 1),
							...(xpg != null ? { xfp: round(xpg, 1), diff: round(ppg - xpg, 1) } : {}),
						};
					});
				if (available_only) rows = rows.filter((r) => r.league_status === "available");
				const key = sort ?? "xfp";
				const val = (r: (typeof rows)[number]): number => {
					const x = r as unknown as Row;
					switch (key) {
						case "buy_low":
							return -num(x, "diff") + num(x, "xfp") / 100; // most below expected first
						case "sell_high":
							return num(x, "diff");
						case "target_share":
							return num(x, "tgt_share");
						case "points":
							return num(x, "pts");
						case "red_zone":
							return num(x, "rz_opps");
						default:
							return num(x, key);
					}
				};
				if (key === "buy_low" || key === "sell_high") rows = rows.filter((r) => "xfp" in r && (r.xfp ?? 0) >= 6);
				rows.sort((a, b) => val(b) - val(a));
				const compact = ({ sid: _sid, ...r }: (typeof rows)[number]) =>
					Object.fromEntries(
						Object.entries(r).filter(([k, v]) => !(v === 0 && ["targets", "tgt_share", "wopr", "carries", "air_yards"].includes(k))),
					);
				return ok({
					weeks: `${from}-${latest}`,
					sort: key,
					players: rows.slice(0, limit ?? 15).map(compact),
					note: "Per-game averages. pts/xfp use this league's scoring; diff = pts - xfp. rz_opps = red-zone targets + carries. buy_low/sell_high only consider players with 6+ xfp per game.",
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ------------------------------------------------------------ injuries
	server.registerTool(
		"get_injury_report",
		{
			title: "Injury report",
			description:
				"Official NFL injury report from nflverse: game status (Out/Doubtful/Questionable) and practice participation (DNP/Limited/Full). " +
				"Default: players on your roster. Or pass an NFL team (e.g. 'DET') or a fantasy team/owner name.",
			inputSchema: z.object({
				team: z.string().optional().describe("'me' (default), an NFL team abbreviation, or a fantasy team/owner name."),
				week: z.number().int().min(1).max(22).optional().describe("Report week (default: latest published)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ team, week }) => {
			try {
				const { lc, nfl } = await load();
				const q = (team ?? "me").trim();
				const nflTeam = /^[A-Za-z]{2,3}$/.test(q) && q.toLowerCase() !== "me" ? q.toUpperCase() : null;
				const teamArgs = nflTeam ? [nflTeam === "LAR" ? "LA" : nflTeam] : [];
				let w: number;
				let reportRows: Row[];
				if (week) {
					w = week;
					reportRows = await nfl.weekRange("nfl_injuries", w, w, nflTeam ? "AND team = ?" : "", ...teamArgs);
				} else {
					const cur = await nfl.currentInjuries(nflTeam ? "AND team = ?" : "", ...teamArgs);
					w = cur.week;
					reportRows = cur.rows;
				}
				if (!w) return ok({ note: "No injury reports published for this season yet." });
				const maps = await nfl.idMaps();
				const owned = lc.ownership();
				const fmtRow = (r: Row) => {
					const sid = maps.byGsis.get(String(r.gsis_id));
					return {
						player: label(lc, sid, r),
						...(r.week !== w ? { report_week: r.week } : {}),
						...(nflTeam ? { league_status: ownerOf(lc, owned, sid) } : {}),
						game_status: (r.report_status as string) || null,
						injury: (r.report_injury as string) || (r.practice_injury as string) || null,
						practice: (r.practice_status as string) || null,
					};
				};
				const note =
					"game_status is the final designation (empty until the team's last report of the week). " +
					(reportRows.some((r) => r.week !== w) ? `report_week marks teams that haven't posted their week ${w} report yet.` : "");
				if (nflTeam) {
					return ok({ week: w, team: nflTeam, report: reportRows.map(fmtRow), note });
				}
				const roster = lc.findRoster(q);
				const mine = new Set(roster.players ?? []);
				const onReport = reportRows.filter((r) => mine.has(maps.byGsis.get(String(r.gsis_id)) ?? ""));
				const reported = new Set(onReport.map((r) => maps.byGsis.get(String(r.gsis_id))));
				const sleeperOnly = [...mine]
					.filter((id) => !reported.has(id))
					.map((id) => lc.players.get(id))
					.filter((p) => p?.injury)
					.map((p) => fmt(p!));
				return ok({
					week: w,
					team: lc.team(roster.roster_id).owner,
					report: onReport.map(fmtRow),
					...(sleeperOnly.length ? { flagged_by_sleeper_only: sleeperOnly } : {}),
					note,
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ------------------------------------------------------------ schedule
	server.registerTool(
		"get_nfl_schedule",
		{
			title: "NFL schedule and lines",
			description:
				"NFL games for a week with kickoff time, Vegas spread and total, implied team totals, scores, and which of your players are in each game.",
			inputSchema: z.object({
				week: z.number().int().min(1).max(22).optional().describe("Default: the current week."),
				team: z.string().optional().describe("Only this NFL team's game (e.g. 'KC')."),
			}),
			annotations: READ_ONLY,
		},
		async ({ week, team }) => {
			try {
				const { lc, nfl } = await load();
				const w = week ?? lc.week;
				let games = await nfl.games(w);
				const t = team?.trim().toUpperCase();
				if (t) games = games.filter((g) => sleeperTeam(g.home_team) === t || sleeperTeam(g.away_team) === t);
				let mine: Map<string, string[]> = new Map();
				try {
					for (const id of lc.myRoster().players ?? []) {
						const p = lc.players.get(id);
						if (!p?.team) continue;
						mine.set(p.team, [...(mine.get(p.team) ?? []), p.name]);
					}
				} catch {
					mine = new Map();
				}
				return ok({
					week: w,
					games: games.map((g) => {
						const home = sleeperTeam(g.home_team)!;
						const away = sleeperTeam(g.away_team)!;
						const spread = typeof g.spread_line === "number" ? g.spread_line : null; // + = home favored
						const total = typeof g.total_line === "number" ? g.total_line : null;
						const played = typeof g.home_score === "number" && typeof g.away_score === "number";
						const my = [...(mine.get(away) ?? []), ...(mine.get(home) ?? [])];
						return {
							game: `${away} @ ${home}`,
							kickoff: [g.weekday, g.gameday, g.gametime ? `${g.gametime} ET` : null].filter(Boolean).join(" "),
							...(spread != null ? { line: spread === 0 ? "PK" : spread > 0 ? `${home} -${spread}` : `${away} -${-spread}` } : {}),
							...(total != null ? { total } : {}),
							...(spread != null && total != null
								? { implied: { [away]: round((total - spread) / 2, 1), [home]: round((total + spread) / 2, 1) } }
								: {}),
							...(played ? { score: `${away} ${g.away_score} - ${home} ${g.home_score}` } : {}),
							...(my.length ? { my_players: my } : {}),
						};
					}),
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ------------------------------------------------------------ status
	server.registerTool(
		"get_nfl_data_status",
		{
			title: "NFL data freshness",
			description: "When each nflverse dataset mirrored by this server was last checked and last changed, any sync errors, and the latest week with stats.",
			inputSchema: z.object({}),
			annotations: READ_ONLY,
		},
		async () => {
			try {
				const { nfl } = await load();
				const [status, latest] = await Promise.all([nfl.status(), nfl.latestWeek()]);
				const failing = status.filter((r) => r.last_error).map((r) => r.dataset);
				return ok({
					latest_stats_week: latest,
					...(failing.length ? { failing } : { healthy: true }),
					datasets: status,
					refresh: "hourly; files are only downloaded when they change upstream. A failing dataset keeps its last good data.",
				});
			} catch (e) {
				return fail(e);
			}
		},
	);
}

/** Per-week red-zone fields for a player row (position-appropriate, zeros dropped). */
function redZone(p: Row, pos: string): Row {
	const out: Row = {};
	const put = (k: string, v: number) => {
		if (v) out[k] = v;
	};
	if (pos === "QB") {
		put("rz_att", num(p, "rz_pass_att"));
		put("rz_car", num(p, "rz_carries"));
		return out;
	}
	put("rz_tgt", num(p, "rz_targets"));
	put("ez_tgt", num(p, "ez_targets"));
	put("deep_tgt", num(p, "deep_targets"));
	put("rz_car", num(p, "rz_carries"));
	put("gl_car", num(p, "i5_carries"));
	return out;
}

/** Window totals plus team shares for the per_game block. */
function redZoneTotals(rows: Row[], pos: string, games: number): Row {
	const sum = (k: string) => rows.reduce((a, r) => a + num(r, k), 0);
	const share = (k: string) => {
		const xs = rows.map((r) => r[k]).filter((v): v is number => typeof v === "number");
		return xs.length ? pct(avg(xs)) : undefined;
	};
	if (pos === "QB") return { rz_att: round(sum("rz_pass_att") / games, 1), rz_car: round(sum("rz_carries") / games, 1) };
	const out: Row = {
		rz_tgt: round(sum("rz_targets") / games, 1),
		ez_tgt: round(sum("ez_targets") / games, 1),
		deep_tgt: round(sum("deep_targets") / games, 1),
	};
	const tShare = share("rz_target_share");
	if (tShare != null && sum("rz_targets")) out.rz_tgt_share = tShare;
	if (pos === "RB" || sum("rz_carries")) {
		out.rz_car = round(sum("rz_carries") / games, 1);
		out.gl_car = round(sum("i5_carries") / games, 1);
		const cShare = share("rz_carry_share");
		if (cShare != null && sum("rz_carries")) out.rz_car_share = cShare;
	}
	return out;
}

/** Next Gen Stats averaged over the weeks a player qualified. */
function nextGen(rows: Row[], pos: string): Row {
	const m = (k: string, digits = 1) => round(avg(rows.map((r) => num(r, k))), digits);
	const base = { weeks: rows.length };
	if (pos === "QB") {
		return { ...base, cpoe: m("cpoe"), time_to_throw: m("avg_time_to_throw", 2), aggressiveness: m("aggressiveness"), adot: m("avg_intended_air_yards"), air_to_sticks: m("avg_air_yards_to_sticks") };
	}
	if (pos === "RB") {
		return { ...base, ryoe_per_att: m("ryoe_per_att", 2), rush_pct_over_expected: pct(m("rush_pct_over_expected", 3)), eight_box_pct: m("eight_box_pct"), time_to_los: m("avg_time_to_los", 2), efficiency: m("efficiency", 2) };
	}
	return { ...base, separation: m("avg_separation", 2), cushion: m("avg_cushion", 2), adot: m("avg_intended_air_yards"), share_of_team_air_yards: m("share_of_intended_air_yards"), yac_over_expected: m("avg_yac_above_expectation", 2), catch_pct: m("catch_percentage") };
}

