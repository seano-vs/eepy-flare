// Advisor tools: FAAB bids grounded in this league's own bidding history, and a trade
// finder that searches every roster for mutually useful deals.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { asOf } from "./asof";
import { dynastyAdp, dynastyMarket, dynastyValue, isDynasty } from "./dynasty";
import { LeagueContext } from "./league";
import { isUnavailable, playerContext } from "./nflverse/context";
import { waiverSchedule, waiverStatuses } from "./waivers";
import { rankWaiverTargets } from "./waiver-targets";
import { readPrefs } from "./prefs";
import { applyConfirmedStarter } from "./starters";
import { confirmedStart, latestHeadlines, newsLine, playerNews, roleSignal } from "./news";
import { NflData, expectedPoints } from "./nflverse/stats";
import { READ_ONLY, fail, fmt, ok } from "./result";
import { computeReplacement, lastFantasyWeek, optimalLineup, round, weekPool, type SkillPos } from "./scoring";
import { loadSeason, runOdds, standingsFromMatchups } from "./playoffs";
import { sleeper, type Roster } from "./sleeper";

// ================================================================ FAAB

export interface Claim {
	week: number;
	playerId: string;
	pos: string;
	bid: number;
	won: boolean;
	rosterId: number;
}

export interface BidComp {
	player: string;
	week: number;
	xfp_before: number;
	winning_bid: number;
	runner_up?: number;
}

export interface BidSuggestion {
	low: number;
	likely: number;
	aggressive: number;
	basis: string;
	comps: BidComp[];
}

function quantile(sorted: number[], q: number): number {
	if (!sorted.length) return 0;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Suggest a bid for a player with `xfp` expected points per game at `pos`, from past winning
 * claims at that position (each with the player's xfp in the weeks before the claim).
 * Pure; exported for tests.
 */
export function suggestBid(
	pos: string,
	xfp: number,
	history: { label: string; pos: string; week: number; xfp: number | null; winning: number; runnerUp?: number }[],
	maxBid: number,
): BidSuggestion | null {
	const atPos = history.filter((h) => h.pos === pos && h.xfp != null);
	if (!atPos.length) return null;
	const tol = Math.max(3, 0.35 * xfp);
	const comps = atPos
		.map((h) => ({ h, d: Math.abs((h.xfp ?? 0) - xfp) }))
		.filter((x) => x.d <= tol)
		.sort((a, b) => a.d - b.d)
		.slice(0, 6)
		.map((x) => x.h);
	let bids: number[];
	let basis: string;
	if (comps.length >= 2) {
		bids = comps.map((c) => c.winning).sort((a, b) => a - b);
		basis = `${comps.length} past ${pos} claims with similar expected points`;
	} else {
		// Few close comparables: place the player within the position's claim history by xfp.
		const xs = atPos.map((h) => h.xfp ?? 0).sort((a, b) => a - b);
		const q = xs.filter((x) => x <= xfp).length / xs.length;
		const all = atPos.map((h) => h.winning).sort((a, b) => a - b);
		const center = quantile(all, q);
		bids = [quantile(all, Math.max(0, q - 0.2)), center, quantile(all, Math.min(1, q + 0.2))];
		basis = `percentile of ${atPos.length} past ${pos} claims (few close comparables)`;
	}
	const cap = (x: number) => Math.max(0, Math.min(maxBid, Math.round(x)));
	return {
		low: cap(quantile(bids, 0.25)),
		likely: cap(quantile(bids, 0.5)),
		aggressive: cap(Math.max(quantile(bids, 0.75), ...comps.map((c) => (c.runnerUp ?? 0) + 1))),
		basis,
		comps: comps.map((c) => ({ player: c.label, week: c.week, xfp_before: round(c.xfp ?? 0, 1), winning_bid: c.winning, ...(c.runnerUp != null ? { runner_up: c.runnerUp } : {}) })),
	};
}

async function leagueClaims(lc: LeagueContext): Promise<Claim[]> {
	const weeks = Array.from({ length: Math.max(1, lc.week) }, (_, i) => i + 1);
	const txs = (await Promise.all(weeks.map((w) => sleeper.transactions(lc.config.leagueId, w).catch(() => [])))).flat();
	const out: Claim[] = [];
	for (const t of txs) {
		if (t.type !== "waiver" || t.settings?.waiver_bid == null || !t.adds) continue;
		if (t.status !== "complete" && t.status !== "failed") continue;
		for (const [pid, rid] of Object.entries(t.adds)) {
			const p = lc.players.get(pid);
			if (!p) continue;
			out.push({ week: t.leg ?? 0, playerId: pid, pos: p.pos, bid: t.settings.waiver_bid, won: t.status === "complete", rosterId: rid });
		}
	}
	return out;
}

// ================================================================ trade values

export interface TradeAsset {
	id: string;
	pos: string;
	/** Projected league points per game over the next few weeks, in weeks he's projected to play (0 if none). */
	ppg: number;
	/** How many of those weeks he's projected to play. */
	games: number;
	/** Rest-of-season value over replacement. */
	ros_vor: number;
	dynasty_value: number;
}

/**
 * Average league-scored projection per game over the next `n` weeks, skipping byes,
 * plus the weeks the player is projected to play. Built from cached weekly pools.
 */
async function nearTermPpg(lc: LeagueContext, fromWeek: number, n: number) {
	const last = Math.min(18, lastFantasyWeek(lc.league));
	const weeks = Array.from({ length: n }, (_, i) => fromWeek + i).filter((w) => w <= Math.max(last, fromWeek));
	const pools = await Promise.all(weeks.map((w) => weekPool(lc.env.PLAYERS, lc.league, lc.season, w, lc.seasonType)));
	const acc = new Map<string, { pos: string; sum: number; games: number }>();
	for (const pool of pools) {
		for (const e of pool) {
			const a = acc.get(e.id) ?? { pos: e.pos, sum: 0, games: 0 };
			a.sum += e.pts;
			a.games++;
			acc.set(e.id, a);
		}
	}
	const ppg = new Map<string, { pos: string; pts: number; games: number }>();
	for (const [id, a] of acc) ppg.set(id, { pos: a.pos, pts: round(a.sum / a.games, 2), games: a.games });
	// Per-week maps, so lineups can be scored week by week (a bye or projected absence counts as 0).
	const byWeek = pools.map((pool) => new Map(pool.map((e) => [e.id, { pos: e.pos, pts: e.pts }])));
	return { ppg, current: pools[0] ?? [], weeks, byWeek };
}

// ================================================================ draft picks

export interface PickSpec {
	season: string;
	round: number;
	/** "early" | "mid" | "late" or an exact pick number within the round. */
	slot?: "early" | "mid" | "late" | number;
	/** Original owner (team/owner name or roster id); sets the slot from standings when slot is omitted. */
	from?: string;
}

/**
 * Value of a rookie draft pick on the same 0-10000 scale as dynasty_value: the pick's overall
 * slot is matched to the dynasty value of the player at that rank in this year's rookie class
 * (their current market value after a season of information), discounted 10% per extra year out.
 * Pure given its inputs; exported for tests.
 */
export function pickValue(overall: number, rookieValues: number[], yearsOut: number): number {
	if (!rookieValues.length) return 0;
	const sorted = [...rookieValues].sort((a, b) => b - a);
	const i = Math.min(sorted.length - 1, Math.max(0, Math.round(overall) - 1));
	const base = sorted[i]!;
	return Math.round(base * Math.pow(0.9, Math.max(0, yearsOut - 1)));
}

export function slotNumber(slot: PickSpec["slot"], teams: number): number {
	if (typeof slot === "number") return Math.min(teams, Math.max(1, slot));
	if (slot === "early") return Math.round(teams / 6);
	if (slot === "late") return teams - Math.round(teams / 6) + 1;
	return (teams + 1) / 2;
}

/** Rank teams from worst to best (record, then points for): worst picks first. */
export function draftOrder(lc: LeagueContext): number[] {
	return [...lc.rosters]
		.sort((a, b) => {
			const wa = a.settings.wins ?? 0;
			const wb = b.settings.wins ?? 0;
			if (wa !== wb) return wa - wb;
			return (a.settings.fpts ?? 0) - (b.settings.fpts ?? 0);
		})
		.map((r) => r.roster_id);
}

export interface ValuedPick {
	label: string;
	season: string;
	round: number;
	overall: number;
	original_owner?: string;
	value: number;
	owned_by?: string;
	warning?: string;
}

/** Who owns which future picks: every team owns its own unless traded_picks says otherwise. */
async function pickOwnership(lc: LeagueContext): Promise<(season: string, round: number, original: number) => number> {
	const traded = (await sleeper.tradedPicks(lc.config.leagueId).catch(() => [])) ?? [];
	return (season, round, original) => {
		const t = traded.find((p) => p.season === season && p.round === round && p.roster_id === original);
		return t ? t.owner_id : original;
	};
}

export async function valuePicks(lc: LeagueContext, picks: PickSpec[], sideRosterId: number | undefined): Promise<ValuedPick[]> {
	if (!picks.length) return [];
	const [adp, market] = await Promise.all([dynastyAdp(lc.env.PLAYERS, lc.league), dynastyMarket(lc).catch(() => null)]);
	// This year's rookie class at current dynasty market value (same blend as players).
	const rookieValues = Object.keys(adp)
		.filter((id) => lc.players.get(id)?.exp === 0)
		.map((id) => market?.get(id)?.value ?? dynastyValue(adp[id]));
	const teams = lc.league.total_rosters;
	const order = draftOrder(lc);
	const owner = await pickOwnership(lc);
	const season = Number(lc.season);
	return picks.map((p) => {
		const rosterFrom = p.from ? lc.findRoster(p.from) : sideRosterId != null ? lc.rosters.find((r) => r.roster_id === sideRosterId) : undefined;
		let slot = p.slot;
		if (slot == null && rosterFrom) {
			// Draft order follows standings: worst record picks first.
			const idx = order.indexOf(rosterFrom.roster_id);
			slot = idx >= 0 ? idx + 1 : undefined;
		}
		const within = slotNumber(slot, teams);
		const overall = (p.round - 1) * teams + within;
		const yearsOut = Math.max(1, Number(p.season) - season);
		const value = pickValue(overall, rookieValues, yearsOut);
		const label = `${p.season} R${p.round}${typeof slot === "number" ? `.${String(Math.round(slot)).padStart(2, "0")}` : slot ? ` (${slot})` : " (mid)"}`;
		const out: ValuedPick = { label, season: p.season, round: p.round, overall: round(overall, 1), value };
		if (rosterFrom) {
			out.original_owner = lc.team(rosterFrom.roster_id).owner;
			const holder = owner(p.season, p.round, rosterFrom.roster_id);
			out.owned_by = lc.team(holder).owner;
			if (sideRosterId != null && holder !== sideRosterId) out.warning = `${out.owned_by} owns this pick, not ${lc.team(sideRosterId).owner}.`;
		}
		return out;
	});
}

export const pickSchema = z.object({
	season: z.string().regex(/^\d{4}$/).describe("Draft year, e.g. '2027'."),
	round: z.number().int().min(1).max(10),
	slot: z.union([z.enum(["early", "mid", "late"]), z.number().int().min(1).max(32)]).optional().describe("early/mid/late or exact pick in the round. Default: from the original owner's standings."),
	from: z.string().optional().describe("Original owner (team/owner name); default: the side trading it."),
});

// ================================================================ value-based bids

/**
 * "Your max": what he's worth to your roster at this league's going rate, keeping a reserve.
 * Pure; exported for tests.
 */
export function valueBid(gainPerWeek: number, weeksCounted: number, dollarsPerPoint: number, remaining: number, reserve: number): number {
	const value = Math.max(0, gainPerWeek) * weeksCounted * dollarsPerPoint;
	return Math.max(0, Math.min(Math.round(value), remaining - reserve));
}

/** Keep more in reserve early in the season: 5% per week left, between 10% and 40%. */
export function reserveFor(remaining: number, weeksLeft: number): number {
	return Math.round(remaining * Math.min(0.4, Math.max(0.1, 0.05 * weeksLeft)));
}

// ================================================================ tools

export function registerAdvisorTools(server: McpServer, env: Env): void {
	// ------------------------------------------------------------ FAAB
	server.registerTool(
		"get_faab_advice",
		{
			title: "FAAB bid advice",
			description:
				"Suggest FAAB bids from this league's own bidding history: past claims are matched to the target by position and expected fantasy points (league scoring) in the weeks before the claim. " +
				"Includes your remaining budget and how many teams could outbid you. Omit player to get bids for the best available players, ranked on this week's projection and recent expected points and re-ranked by their latest headline " +
				"(benched, No. 3, traded or released demotes; named starter promotes). Read role_news and news before bidding.",
			inputSchema: z.object({
				player: z.string().optional().describe("Target player (name or Sleeper id). Omit for top available targets."),
				position: z.enum(["QB", "RB", "WR", "TE"]).optional(),
				limit: z.number().int().min(1).max(15).optional().describe("Targets when no player is given (default 8)."),
				include_injured: z.boolean().optional().describe("Keep players listed Out/Doubtful/IR/suspended in the target list (default false)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ player, position, limit, include_injured }) => {
			try {
				const lc = await LeagueContext.load(env);
				if (lc.league.settings.waiver_type !== 2) return ok({ note: "This league doesn't use FAAB." });
				const nfl = NflData.from(env, lc.season);
				const budget = Number(lc.league.settings.waiver_budget) || 100;
				const remaining = (r: Roster) => budget - (r.settings.waiver_budget_used ?? 0);
				const me = lc.myRoster();
				const others = lc.rosters.filter((r) => r.roster_id !== me.roster_id).map(remaining).sort((a, b) => b - a);

				const [claims, latest, maps] = await Promise.all([leagueClaims(lc), nfl.latestWeek(), nfl.idMaps()]);
				const scoring = lc.league.scoring_settings;
				// Expected points per game for any player over [from, to].
				const opp = latest ? await nfl.weekRange("nfl_opportunity", 1, latest) : [];
				const xfpBy = new Map<string, Map<number, number>>();
				for (const o of opp) {
					const sid = maps.byGsis.get(String(o.gsis_id));
					if (!sid) continue;
					const m = xfpBy.get(sid) ?? new Map<number, number>();
					m.set(Number(o.week), expectedPoints(o, scoring));
					xfpBy.set(sid, m);
				}
				const xfpWindow = (sid: string, from: number, to: number): number | null => {
					const m = xfpBy.get(sid);
					if (!m) return null;
					const xs = [...m.entries()].filter(([w]) => w >= from && w <= to).map(([, v]) => v);
					return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
				};

				// One history entry per (week, player): the winning bid and the best losing bid.
				const groups = new Map<string, Claim[]>();
				for (const c of claims) groups.set(`${c.week}|${c.playerId}`, [...(groups.get(`${c.week}|${c.playerId}`) ?? []), c]);
				const history = [...groups.values()]
					.map((cs) => {
						const win = cs.find((c) => c.won);
						if (!win) return null;
						const losing = cs.filter((c) => !c.won).map((c) => c.bid);
						return {
							label: fmt(lc.ref(win.playerId)),
							pos: win.pos,
							week: win.week,
							xfp: xfpWindow(win.playerId, win.week - 3, win.week - 1),
							winning: win.bid,
							...(losing.length ? { runnerUp: Math.max(...losing) } : {}),
						};
					})
					.filter((h): h is NonNullable<typeof h> => h != null);

				const owned = lc.ownership();
				const from = Math.max(1, latest - 2);
				// Ranked on this week's projection and recent expected points, re-ranked by headlines.
				const ranked = player ? null : await rankWaiverTargets(lc, { position, includeInjured: include_injured, limit: limit ?? 8 });
				const rankedBy = new Map((ranked?.targets ?? []).map((t) => [t.id, t]));
				const targets: string[] = player ? [lc.players.resolve(player).id] : (ranked?.targets ?? []).map((t) => t.id);
				const singleNews = player ? await playerNews(targets[0]!, { limit: 1, maxAgeHours: 96 }) : [];
				const [ctx, waivers, schedule] = await Promise.all([playerContext(lc, targets), waiverStatuses(lc, targets), waiverSchedule(lc).catch(() => null)]);
				const myLeft = remaining(me);

				// Value to this roster (price at value, keep a reserve, let a higher bidder win).
				const prefs = readPrefs(lc.env, lc.players);
				const slots = lc.league.roster_positions.filter((x) => x !== "BN");
				const lastWeek = lastFantasyWeek(lc.league);
				const playoffStart = Number(lc.league.settings.playoff_week_start) || 15;
				// From the next week to be played (Sleeper's display week lags until Wednesday).
				const fromWeek = lc.upcomingWeek;
				const [{ byWeek, current, weeks: weekNums }, season] = await Promise.all([
					nearTermPpg(lc, fromWeek, Math.min(4, Math.max(1, lastWeek - fromWeek + 1))),
					loadSeason(lc).catch(() => null),
				]);
				const myOdds = season?.schedule.length ? (runOdds(lc, season).odds.get(me.roster_id)?.playoffs ?? 0) / 100 : 1;
				const regLeft = Math.max(0, playoffStart - fromWeek);
				const playoffWeeks = Math.max(0, lastWeek - Math.max(fromWeek, playoffStart) + 1);
				const weeksCounted = round(regLeft + playoffWeeks * myOdds, 1);
				const activeOf = (r: Roster) => {
					const res = new Set([...(r.reserve ?? []), ...(r.taxi ?? [])]);
					return (r.players ?? []).filter((id) => !res.has(id));
				};
				const myActive = activeOf(me);
				const lineupAvg = (ids: string[]) => (byWeek.length ? byWeek.reduce((a, m) => a + optimalLineup(ids, slots, m).total, 0) / byWeek.length : 0);
				const myBase = lineupAvg(myActive);
				// Going rate: winning bid per point over replacement per remaining week, at claim time.
				const repl = current.length ? computeReplacement(current, lc.league.roster_positions, lc.league.total_rosters) : null;
				const rates = repl
					? history
							.filter((h) => h.winning > 0 && h.xfp != null)
							.map((h) => {
								const por = (h.xfp ?? 0) - (repl.level[h.pos as SkillPos] ?? 0);
								return por > 0.5 ? h.winning / (por * Math.max(1, lastWeek - h.week + 1)) : null;
							})
							.filter((x): x is number => x != null)
							.sort((a, b) => a - b)
					: [];
				const dollarsPerPoint = rates.length ? round(quantile(rates, 0.5), 3) : 0.5;
				const reserve = reserveFor(myLeft, lastWeek - fromWeek);
				const needsDrop = (me.players ?? []).length - (me.reserve ?? []).length - (me.taxi ?? []).length >= lc.league.roster_positions.length;
				// Lowest-value droppable player: smallest drop in your best lineup, never an untouchable.
				const dropCandidate = needsDrop
					? myActive
							.filter((id) => !prefs.untouchables.has(id))
							.map((id) => ({ id, loss: myBase - lineupAvg(myActive.filter((x) => x !== id)) }))
							.sort((a, b) => a.loss - b.loss)[0]
					: undefined;
				const teamName = (rid: number) => lc.team(rid).team_name ?? lc.team(rid).owner;
				// A confirmed new starter whose projection hasn't caught up (Carson Beck, week 10: "set to start",
				// no Sleeper projection, no usage) is priced at what Sleeper projected his team's previous starter
				// at that position in the most recent week it projected one (this week, else the two before; a
				// bye leaves a gap: Arizona's week 8): the role he's stepping into.
				const recentWeeks = [fromWeek, fromWeek - 1, fromWeek - 2].filter((w) => w >= 1);
				const recentPools = await Promise.all(recentWeeks.map((w) => weekPool(lc.env.PLAYERS, lc.league, lc.season, w, lc.seasonType).catch(() => [])));
				const headlineOf = (sid: string) => rankedBy.get(sid)?.news ?? (player ? singleNews[0] : undefined);
				/** The team's previous starter at his position in the most recent projected week (fallback price). */
				const recentIncumbent = (sid: string): { id: string; pts: number; week: number } | null => {
					const p = lc.players.get(sid);
					if (!p?.team) return null;
					for (const [i, pool] of recentPools.entries()) {
						const top = pool.filter((e) => e.id !== sid && e.pos === p.pos && e.pts > 0 && lc.players.get(e.id)?.team === p.team).sort((a, b) => b.pts - a.pts)[0];
						if (top) return { id: top.id, pts: top.pts, week: recentWeeks[i]! };
					}
					return null;
				};
				const teamOf = (id: string) => lc.players.get(id)?.team ?? undefined;
				const advice = targets.map((sid) => {
					const p = lc.players.get(sid)!;
					// A confirmed new starter takes the role's projection in every week Sleeper still gives it to
					// someone else (and that player loses it): lineup value and the market bid use those weeks.
					const headline = headlineOf(sid);
					const confirmed = !!headline && confirmedStart(headline.title);
					const inc = confirmed ? recentIncumbent(sid) : null;
					const swap = confirmed ? applyConfirmedStarter(byWeek, weekNums, sid, p.pos, teamOf, inc?.pts) : null;
					const weeks = swap?.weeks ?? byWeek;
					const priced =
						swap && swap.swaps.length
							? {
									pts: round(swap.swaps[0]!.pts, 1),
									by_week: Object.fromEntries(swap.swaps.map((x) => [x.week, round(x.pts, 1)])),
									basis:
										`Headline "${headline!.title}" (${headline!.source}, ${headline!.age_hours}h ago) says he starts. Sleeper still projects ` +
										swap.swaps.map((x) => `week ${x.week}: ${x.incumbent ? fmt(lc.ref(x.incumbent)) : "no one"} ${round(x.pts, 1)}, him ${round(x.was, 1)}`).join("; ") +
										`. Those weeks are valued with the roles swapped. An assumption: check the starter news before bidding.`,
								}
							: null;
					const xUsage = xfpWindow(sid, from, latest);
					// Without usage (a new starter), comparable claims are matched on the projection other managers
					// see (Sleeper's, this week), else the starter-level price: the market bids on what it's shown,
					// not on our role swap (Beck: 12.1 vs a 13.3 swap price that landed among $0 claims).
					const projNow = byWeek[0]?.get(sid)?.pts ?? null;
					const x = xUsage ?? (projNow != null && projNow > 0 ? projNow : (priced?.pts ?? null));
					const s = x != null ? suggestBid(p.pos, x, history, myLeft) : null;
					const c = ctx.get(sid);
					return {
						player: fmt(p),
						league_status: owned.has(sid) ? lc.team(owned.get(sid)!).owner : waivers.get(sid)?.status === "on waivers" ? `on waivers until ${waivers.get(sid)!.clears_after} (claim)` : "free agent",
						...(waivers.get(sid) ? { waiver: waivers.get(sid) } : {}),
						...(rankedBy.get(sid)?.proj_week != null ? { proj_week: rankedBy.get(sid)!.proj_week } : {}),
						...(xUsage != null ? { xfp_recent: round(xUsage, 1) } : {}),
						...(priced ? { priced_as_starter: { by_week: priced.by_week, basis: priced.basis } } : {}),
						...(() => {
							const n = rankedBy.get(sid)?.news ?? singleNews[0];
							const sig = rankedBy.get(sid)?.role_news ?? (n ? roleSignal(n.title) : null);
							return { ...(n ? { news: newsLine(n) } : {}), ...(sig ? { role_news: sig.kind === "negative" ? `Warning: ${sig.reason}` : sig.reason } : {}) };
						})(),
						...(c?.recent ? { recent: { snap_pct: c.recent.snap_pct, targets: c.recent.targets, carries: c.recent.carries, rz_opps: c.recent.rz_opps } } : {}),
						...(c?.ecr?.ros ? { ros_rank: c.ecr.ros } : {}),
						...(waivers.get(sid)?.status === "free agent" && !owned.has(sid)
							? { bid: null, add_now: "Free agent: his game hasn't kicked off and he wasn't just dropped, so add him now for $0 before someone else does." }
							: s
								? { bid: { low: s.low, likely: s.likely, aggressive: s.aggressive }, basis: xUsage == null ? `No usage yet: matched to past ${p.pos} claims at ${projNow != null && projNow > 0 ? `Sleeper's week ${fromWeek} projection (${projNow}), what other managers see` : `his starter-level price (${priced?.pts})`}. ${s.basis}` : s.basis, ...(player ? { comps: s.comps } : {}), teams_that_can_outbid_likely: others.filter((b) => b > s.likely).length }
								: { bid: null, basis: x == null ? "no recent usage data (and no confirmed-starter headline to price from)" : `no ${p.pos} claims in this league yet` }),
						...(() => {
							const avgOver = (ids: string[], ms: typeof byWeek) => (ms.length ? ms.reduce((a, m) => a + optimalLineup(ids, slots, m).total, 0) / ms.length : 0);
							const gain = round(avgOver([...myActive, sid], weeks) - avgOver(myActive, weeks), 1);
							const yourMax = valueBid(gain, weeksCounted, dollarsPerPoint, myLeft, reserve);
							const share = (b: number) => (myLeft ? Math.round((b / myLeft) * 100) : 0);
							const fa = waivers.get(sid)?.status === "free agent" && !owned.has(sid);
							const m = fa ? null : s;
							const market = m?.likely ?? null;
							// Rivals: can afford the likely bid and would start him this week.
							const wk = weeks[0];
							const rivals = wk
								? lc.rosters
										.filter((r) => r.roster_id !== me.roster_id && remaining(r) > (market ?? 0))
										.filter((r) => optimalLineup([...activeOf(r), sid], slots, wk).total - optimalLineup(activeOf(r), slots, wk).total > 1)
										.map((r) => `${teamName(r.roster_id)} ($${remaining(r)})`)
								: [];
							return {
								value_to_you: {
									lineup_gain_per_week: gain,
									your_max: yourMax,
									your_max_pct_of_budget: share(yourMax),
									...(m ? { market_likely_pct_of_budget: share(m.likely), market_aggressive_pct_of_budget: share(m.aggressive) } : {}),
									...(m && share(m.aggressive) > 20 ? { warning: `The aggressive market bid is ${share(m.aggressive)}% of your remaining $${myLeft}.` } : {}),
									...(gain <= 0
										? { note: "He wouldn't start for you over the next few weeks; bid only as a stash." }
										: market != null && yourMax < market
											? { note: "The market will likely pay more than he's worth to you: let a higher bidder win." }
											: {}),
								},
								...(rivals.length && !fa ? { likely_rival_bidders: rivals } : {}),
							};
						})(),
					};
				});
				return ok({
					as_of: await asOf(lc, ["projections", "stats", "news", "transactions", "injury_tags"]),
					budget,
					my_remaining: myLeft,
					...(schedule ? { waivers: { main_run: schedule.main_run, processes_at: schedule.processes_at?.eastern ?? null, clear_days: schedule.clear_days } } : {}),
					others_remaining: { max: others[0] ?? 0, median: round(quantile([...others].sort((a, b) => a - b), 0.5), 0) },
					pricing: {
						reserve,
						dollars_per_point: dollarsPerPoint,
						weeks_counted: weeksCounted,
						your_playoff_odds_pct: round(myOdds * 100, 1),
						rule: "your_max = weekly gain to your best lineup x weeks counted (regular-season weeks left + playoff weeks x your playoff odds) x the league's going $/point, capped at remaining minus reserve. If the market goes higher, let it.",
					},
					...(needsDrop ? { roster_full: true, suggested_drop: dropCandidate ? { player: fmt(lc.ref(dropCandidate.id)), lineup_loss_per_week: round(dropCandidate.loss, 1) } : null } : {}),
					...(prefs.untouchableNames.length ? { untouchables: prefs.untouchableNames } : {}),
					weeks: `${from}-${latest}`,
					claims_in_history: history.length,
					advice,
					note:
						"Bids come from this league's winning bids for players at the same position with similar expected points per game (league scoring) in the 3 weeks before the claim. " +
						"aggressive also clears the best losing bid seen on those comparables. waiver.status: 'on waivers' = a FAAB claim (waiver.reason: dropped within the clear window, and/or his team has kicked off this week: " +
						"Sleeper holds every player from his game's kickoff until the next main run, so after kickoff he can't be added for $0); waiver.clears_after = when he becomes a free agent. 'free agent' = add now for $0.",
				});
			} catch (e) {
				return fail(e);
			}
		},
	);

	// ------------------------------------------------------------ trade finder
	server.registerTool(
		"find_trades",
		{
			title: "Find trades",
			description:
				"Search every other roster for trades that improve both teams' projected starting lineups (league scoring, superflex-aware), checked for fair value: rest-of-season value over replacement, plus dynasty market value in dynasty leagues. " +
				"Considers 1-for-1 and 2-for-1 deals. Optionally target a position you need or a specific partner.",
			inputSchema: z.object({
				need: z.enum(["QB", "RB", "WR", "TE"]).optional().describe("Only trades that bring you this position."),
				partner: z.string().optional().describe("Only this team (owner or team name)."),
				focus: z.enum(["win_now", "balanced", "long_term"]).optional().describe("How to weigh this season vs dynasty value (default from DEFAULT_TRADE_FOCUS, else balanced; long_term needs a dynasty league)."),
				exclude: z.array(z.string()).max(10).optional().describe("Your players who are off the table (configured untouchables are always excluded)."),
				shop: z.string().optional().describe("Only trades that move this player of yours."),
				window: z.enum(["next3", "playoffs"]).optional().describe("Weeks to score lineups on: the next 3 (default) or the fantasy playoff weeks."),
				limit: z.number().int().min(1).max(15).optional().describe("Trades to return (default 6)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ need, partner, focus, exclude, shop, window: windowArg, limit }) => {
			try {
				const lc = await LeagueContext.load(env);
				const me = lc.myRoster();
				const dynasty = isDynasty(lc.league);
				const prefs = readPrefs(lc.env, lc.players);
				const mode = focus ?? prefs.focus;
				const slots = lc.league.roster_positions.filter((s) => s !== "BN");
				const through = Math.max(lc.week, lastFantasyWeek(lc.league));
				const weeksLeft = Math.max(1, through - lc.week + 1);
				const playoffStart = Number(lc.league.settings.playoff_week_start) || 15;
				const usePlayoffs = windowArg === "playoffs" && playoffStart > lc.week;
				const [{ ppg, current, weeks: window, byWeek }, adp, season] = await Promise.all([
					usePlayoffs ? nearTermPpg(lc, playoffStart, Math.max(1, lastFantasyWeek(lc.league) - playoffStart + 1)) : nearTermPpg(lc, lc.week, 3),
					dynasty ? dynastyMarket(lc).catch(() => null) : Promise.resolve(null),
					loadSeason(lc),
				]);
				// Partner outlook from playoff odds: a 4-4 team with 50% odds is a bubble team, not a rebuilder.
				const standings = season.standings;
				const odds = season.schedule.length ? runOdds(lc, season).odds : new Map<number, { playoffs: number }>();
				const outlook = (rid: number): "contending" | "bubble" | "rebuilding" => {
					const o = odds.get(rid)?.playoffs;
					if (o == null) return "bubble";
					return o > 60 ? "contending" : o >= 20 ? "bubble" : "rebuilding";
				};
				const excluded = new Set([...(exclude ?? []).map((q) => lc.players.resolve(q).id), ...prefs.untouchables]);
				const shopId = shop ? lc.players.resolve(shop).id : undefined;
				const repl = current.length ? computeReplacement(current, lc.league.roster_positions, lc.league.total_rosters) : null;

				const asset = (id: string): TradeAsset => {
					const p = ppg.get(id);
					const pos = p?.pos ?? lc.players.get(id)?.pos ?? "?";
					const r = repl?.level[pos as SkillPos] ?? 0;
					return { id, pos, ppg: p?.pts ?? 0, games: p?.games ?? 0, ros_vor: round(Math.max(0, (p?.pts ?? 0) - r) * weeksLeft, 1), dynasty_value: dynasty ? (adp?.get(id)?.value ?? 0) : 0 };
				};
				const active = (r: Roster) => {
					const res = new Set([...(r.reserve ?? []), ...(r.taxi ?? [])]);
					return (r.players ?? []).filter((id) => !res.has(id) && ["QB", "RB", "WR", "TE"].includes(lc.players.get(id)?.pos ?? ""));
				};
				// Average of each window week's best lineup: a player out or on bye that week adds nothing.
				const lineup = (ids: string[]) => (byWeek.length ? byWeek.reduce((a, m) => a + optimalLineup(ids, slots, m).total, 0) / byWeek.length : 0);
				// One number per trade side, blending the two lenses by focus.
				const worth = (a: TradeAsset[]) => {
					const vor = a.reduce((s, x) => s + x.ros_vor, 0);
					const dyn = a.reduce((s, x) => s + x.dynasty_value, 0);
					if (!dynasty || mode === "win_now") return { vor, dyn, score: vor };
					// Put dynasty value on the VOR scale: 10000 dynasty points ~ an elite starter's rest-of-season VOR.
					const dynScaled = (dyn / 10000) * 150;
					const w = mode === "long_term" ? 0.75 : 0.4;
					return { vor, dyn, score: vor * (1 - w) + dynScaled * w };
				};

				const mine = active(me);

				// Discount projections that assume a bigger role than recent usage: halfway to recent xfp.
				const allActive = [...new Set(lc.rosters.flatMap((r) => active(r)))];
				const ctxAll = await playerContext(lc, allActive, { projections: new Map(allActive.map((id) => [id, byWeek[0]?.get(id)?.pts ?? null])) });
				const discounted = new Map<string, number>();
				for (const [id, c] of ctxAll) {
					const proj = ppg.get(id)?.pts;
					const x = c.recent?.xfp;
					if (proj && x != null && c.projection_check?.some((f) => f.includes("bigger role"))) discounted.set(id, Math.min(1, (proj + x) / 2 / proj));
				}
				for (const m of byWeek) for (const [id, f] of discounted) { const e = m.get(id); if (e) m.set(id, { ...e, pts: round(e.pts * f, 2) }); }
				for (const [id, f] of discounted) { const e = ppg.get(id); if (e) ppg.set(id, { ...e, pts: round(e.pts * f, 2) }); }
				const myBase = lineup(mine);
				const partners = lc.rosters.filter((r) => r.roster_id !== me.roster_id && (!partner || r.roster_id === lc.findRoster(partner).roster_id));
				type Deal = { partner: Roster; give: string[]; get: string[]; myGain: number; theirGain: number; fair: number; giveW: ReturnType<typeof worth>; getW: ReturnType<typeof worth> };
				const deals: Deal[] = [];
				// Only players with real value are worth searching over.
				const tradable = (ids: string[]) => ids.filter((id) => asset(id).ros_vor > 0 || asset(id).dynasty_value > 1500);
				const myTradable = tradable(mine).filter((id) => !excluded.has(id));
				if (shopId && !mine.includes(shopId)) return fail(`${fmt(lc.ref(shopId))} isn't on your active roster.`);
				for (const r of partners) {
					const theirs = active(r);
					const theirBase = lineup(theirs);
					const theirTradable = tradable(theirs).filter((id) => !need || asset(id).pos === need);
					const tryDeal = (give: string[], get: string[]) => {
						const myAfter = lineup([...mine.filter((id) => !give.includes(id)), ...get]);
						const theirAfter = lineup([...theirs.filter((id) => !get.includes(id)), ...give]);
						const myGain = round(myAfter - myBase, 1);
						const theirGain = round(theirAfter - theirBase, 1);
						// They may accept a small weekly dip when the value is fair (or favors them long-term).
						if (shopId && !give.includes(shopId)) return;
						// Contenders won't take a weekly hit, bubble teams barely, rebuilders accept one for long-term value.
						const look = outlook(r.roster_id);
						const contending = look !== "rebuilding";
						const floor = look === "contending" ? 0 : look === "bubble" ? -0.5 : -2;
						if (myGain <= (shopId ? -0.5 : 0.5) || theirGain < floor) return;
						const giveW = worth(give.map(asset));
						const getW = worth(get.map(asset));
						const fair = Math.max(giveW.score, getW.score) > 0 ? Math.abs(getW.score - giveW.score) / Math.max(giveW.score, getW.score) : 0;
						if (fair > 0.2) return; // a deal the other side would reject on value
						// A rebuilding partner taking a lineup dip should at least gain dynasty value.
						if (dynasty && !contending && theirGain < 0 && getW.dyn > giveW.dyn) return;
						deals.push({ partner: r, give, get, myGain, theirGain, fair, giveW, getW });
					};
					for (const g of myTradable) for (const t of theirTradable) tryDeal([g], [t]);
					// 2-for-1 (consolidation): two of mine for one of theirs.
					for (let i = 0; i < myTradable.length; i++)
						for (let j = i + 1; j < myTradable.length; j++) for (const t of theirTradable) tryDeal([myTradable[i]!, myTradable[j]!], [t]);
				}
				// Best: improves my lineup most while staying fair and helping them; dedupe by received player.
				deals.sort((a, b) => b.myGain + Math.min(a.theirGain, 3) * 0.3 - a.fair * 5 - (a.myGain + Math.min(b.theirGain, 3) * 0.3 - b.fair * 5) || a.fair - b.fair);
				const seen = new Set<string>();
				const picked = deals.filter((d) => {
					const k = `${d.partner.roster_id}|${d.get.join(",")}`;
					if (seen.has(k)) return false;
					seen.add(k);
					return true;
				});
				const windowLabel = window.length ? `${window[0]}-${window[window.length - 1]}` : "";
				const finalDeals = picked.slice(0, limit ?? 6);
				const heads = await latestHeadlines([...new Set(finalDeals.flatMap((d) => [...d.give, ...d.get]))], 96);
				const side = (ids: string[]) =>
					ids.map((id) => {
						const a = asset(id);
						const c = ctxAll.get(id);
						const h = heads.get(id);
						return {
							player: fmt(lc.ref(id)),
							...(c?.injury_report ? { injury_report: c.injury_report } : {}),
							...(c?.role_change ? { role_change: c.role_change } : {}),
							...(c?.projection_check ? { projection_check: c.projection_check } : {}),
							...(h ? { news: newsLine(h) } : {}),
							...(discounted.has(id) ? { projection_discounted: "Sleeper's projection assumes a bigger role than recent usage; scored halfway to recent expected points." } : {}),
							// Sleeper projection per game in the weeks of the window he's projected to play.
							proj_ppg_window: a.ppg,
							games_in_window: `${a.games}/${window.length}`,
							ros_vor: a.ros_vor,
							...(dynasty ? { dynasty_value: a.dynasty_value } : {}),
						};
					});
				return ok({
					as_of: await asOf(lc, ["projections", "stats", "injury_report", "news", "injury_tags", ...(dynasty ? (["adp"] as const) : [])]),
					focus: mode,
					...(prefs.untouchableNames.length ? { untouchables: prefs.untouchableNames } : {}),
					weeks: `${lc.week}-${through}`,
					lineup_window: usePlayoffs ? "playoffs" : "next3",
					projection_window: windowLabel,
					trades: finalDeals.map((d) => ({
						partner: lc.team(d.partner.roster_id).owner,
						partner_record: (() => {
							const st = standings.get(d.partner.roster_id);
							return st ? `${st.wins}-${st.losses}${st.ties ? `-${st.ties}` : ""}` : undefined;
						})(),
						partner_outlook: outlook(d.partner.roster_id),
						...(odds.get(d.partner.roster_id) ? { partner_playoff_odds_pct: odds.get(d.partner.roster_id)!.playoffs } : {}),
						give: side(d.give),
						get: side(d.get),
						your_lineup_change_per_week: d.myGain,
						their_lineup_change_per_week: d.theirGain,
						ros_vor: { give: round(d.giveW.vor, 1), get: round(d.getW.vor, 1) },
						...(dynasty ? { dynasty_value: { give: d.giveW.dyn, get: d.getW.dyn } } : {}),
						value_gap_pct: round(d.fair * 100, 0),
						value_favors: d.fair < 0.05 ? "even" : d.getW.score > d.giveW.score ? "you" : "them",
					})),
					...(picked.length ? {} : { note: "No fair trade improves both lineups under these filters." }),
					method:
						"proj_ppg_window = Sleeper's projection per game (league scoring) averaged over the weeks of projection_window he is projected to play; games_in_window says how many. " +
						"It is not rest-of-season ppg (project_player) or actual ppg (get_player_usage). " +
						"Lineup change = best projected starting lineup in each window week (byes and projected absences count as 0), averaged, after minus before. " +
						"partner_outlook comes from playoff odds (>60% contending, 20-60% bubble, <20% rebuilding). Trades must help you, cost a contender nothing and a bubble team at most 0.5 a week (a rebuilder up to 2, if it gains dynasty value), and be within 20% on value (" +
						(dynasty && mode !== "win_now" ? "a blend of rest-of-season VOR and dynasty market value" : "rest-of-season VOR") +
						"). Run evaluate_trade on any of these for the full picture.",
				});
			} catch (e) {
				return fail(e);
			}
		},
	);
}

