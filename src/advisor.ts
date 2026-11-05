// Advisor tools: FAAB bids grounded in this league's own bidding history, and a trade
// finder that searches every roster for mutually useful deals.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { dynastyAdp, dynastyValue, isDynasty } from "./dynasty";
import { LeagueContext } from "./league";
import { playerContext } from "./nflverse/context";
import { NflData, expectedPoints } from "./nflverse/stats";
import { READ_ONLY, fail, fmt, ok } from "./result";
import { computeReplacement, lastFantasyWeek, optimalLineup, round, weekPool, type SkillPos } from "./scoring";
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
	/** Projected league points per game over the next few weeks (0 if none). */
	ppg: number;
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
	const ppg = new Map<string, { pos: string; pts: number }>();
	for (const [id, a] of acc) ppg.set(id, { pos: a.pos, pts: round(a.sum / a.games, 2) });
	return { ppg, current: pools[0] ?? [] };
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
	const adp = await dynastyAdp(lc.env.PLAYERS, lc.league);
	// This year's rookie class at current dynasty market value.
	const rookieValues = Object.entries(adp)
		.filter(([id]) => lc.players.get(id)?.exp === 0)
		.map(([, a]) => dynastyValue(a));
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

// ================================================================ tools

export function registerAdvisorTools(server: McpServer, env: Env): void {
	// ------------------------------------------------------------ FAAB
	server.registerTool(
		"get_faab_advice",
		{
			title: "FAAB bid advice",
			description:
				"Suggest FAAB bids from this league's own bidding history: past claims are matched to the target by position and expected fantasy points (league scoring) in the weeks before the claim. " +
				"Includes your remaining budget and how many teams could outbid you. Omit player to get bids for the best available players by recent expected points.",
			inputSchema: z.object({
				player: z.string().optional().describe("Target player (name or Sleeper id). Omit for top available targets."),
				position: z.enum(["QB", "RB", "WR", "TE"]).optional(),
				limit: z.number().int().min(1).max(15).optional().describe("Targets when no player is given (default 8)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ player, position, limit }) => {
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
				let targets: string[];
				if (player) {
					targets = [lc.players.resolve(player).id];
				} else {
					targets = [...xfpBy.keys()]
						.filter((sid) => !owned.has(sid))
						.filter((sid) => {
							const p = lc.players.get(sid);
							// Skip players who can't help soon: their recent usage predates the injury.
							const unavailable = /^(IR|Out|PUP|Sus|NA|DNR|COV)$/i.test(p?.injury ?? "") || (p?.status && p.status !== "Active");
							return p && !unavailable && ["QB", "RB", "WR", "TE"].includes(p.pos) && (!position || p.pos === position);
						})
						.map((sid) => ({ sid, x: xfpWindow(sid, from, latest) ?? 0 }))
						.sort((a, b) => b.x - a.x)
						.slice(0, limit ?? 8)
						.map((t) => t.sid);
				}
				const ctx = await playerContext(lc, targets);
				const myLeft = remaining(me);
				const advice = targets.map((sid) => {
					const p = lc.players.get(sid)!;
					const x = xfpWindow(sid, from, latest);
					const s = x != null ? suggestBid(p.pos, x, history, myLeft) : null;
					const c = ctx.get(sid);
					return {
						player: fmt(p),
						league_status: owned.has(sid) ? lc.team(owned.get(sid)!).owner : "available",
						...(x != null ? { xfp_recent: round(x, 1) } : {}),
						...(c?.recent ? { recent: { snap_pct: c.recent.snap_pct, targets: c.recent.targets, carries: c.recent.carries, rz_opps: c.recent.rz_opps } } : {}),
						...(c?.ecr?.ros ? { ros_rank: c.ecr.ros } : {}),
						...(s
							? { bid: { low: s.low, likely: s.likely, aggressive: s.aggressive }, basis: s.basis, ...(player ? { comps: s.comps } : {}), teams_that_can_outbid_likely: others.filter((b) => b > s.likely).length }
							: { bid: null, basis: x == null ? "no recent usage data" : `no ${p.pos} claims in this league yet` }),
					};
				});
				return ok({
					budget,
					my_remaining: myLeft,
					others_remaining: { max: others[0] ?? 0, median: round(quantile([...others].sort((a, b) => a - b), 0.5), 0) },
					weeks: `${from}-${latest}`,
					claims_in_history: history.length,
					advice,
					note:
						"Bids come from this league's winning bids for players at the same position with similar expected points per game (league scoring) in the 3 weeks before the claim. " +
						"aggressive also clears the best losing bid seen on those comparables. Players already through waivers can be added as free agents for $0.",
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
				focus: z.enum(["win_now", "balanced", "long_term"]).optional().describe("How to weigh this season vs dynasty value (default balanced; long_term needs a dynasty league)."),
				limit: z.number().int().min(1).max(15).optional().describe("Trades to return (default 6)."),
			}),
			annotations: READ_ONLY,
		},
		async ({ need, partner, focus, limit }) => {
			try {
				const lc = await LeagueContext.load(env);
				const me = lc.myRoster();
				const dynasty = isDynasty(lc.league);
				const mode = focus ?? "balanced";
				const slots = lc.league.roster_positions.filter((s) => s !== "BN");
				const through = Math.max(lc.week, lastFantasyWeek(lc.league));
				const weeksLeft = Math.max(1, through - lc.week + 1);
				const [{ ppg, current }, adp] = await Promise.all([nearTermPpg(lc, lc.week, 3), dynasty ? dynastyAdp(env.PLAYERS, lc.league) : Promise.resolve({} as Record<string, number>)]);
				const repl = current.length ? computeReplacement(current, lc.league.roster_positions, lc.league.total_rosters) : null;
				const ptsMap = new Map<string, { pos: string; pts: number }>([...ppg].map(([id, v]) => [id, v]));

				const asset = (id: string): TradeAsset => {
					const p = ppg.get(id);
					const pos = p?.pos ?? lc.players.get(id)?.pos ?? "?";
					const r = repl?.level[pos as SkillPos] ?? 0;
					return { id, pos, ppg: p?.pts ?? 0, ros_vor: round(Math.max(0, (p?.pts ?? 0) - r) * weeksLeft, 1), dynasty_value: dynasty ? dynastyValue(adp[id]) : 0 };
				};
				const active = (r: Roster) => {
					const res = new Set([...(r.reserve ?? []), ...(r.taxi ?? [])]);
					return (r.players ?? []).filter((id) => !res.has(id) && ["QB", "RB", "WR", "TE"].includes(lc.players.get(id)?.pos ?? ""));
				};
				const lineup = (ids: string[]) => optimalLineup(ids, slots, ptsMap).total;
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
				const myBase = lineup(mine);
				const partners = lc.rosters.filter((r) => r.roster_id !== me.roster_id && (!partner || r.roster_id === lc.findRoster(partner).roster_id));
				type Deal = { partner: Roster; give: string[]; get: string[]; myGain: number; theirGain: number; fair: number; giveW: ReturnType<typeof worth>; getW: ReturnType<typeof worth> };
				const deals: Deal[] = [];
				// Only players with real value are worth searching over.
				const tradable = (ids: string[]) => ids.filter((id) => asset(id).ros_vor > 0 || asset(id).dynasty_value > 1500);
				const myTradable = tradable(mine);
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
						if (myGain <= 0.5 || theirGain < -1) return;
						const giveW = worth(give.map(asset));
						const getW = worth(get.map(asset));
						const fair = Math.max(giveW.score, getW.score) > 0 ? Math.abs(getW.score - giveW.score) / Math.max(giveW.score, getW.score) : 0;
						if (fair > 0.2) return; // a deal the other side would reject on value
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
				const side = (ids: string[]) => ids.map((id) => ({ player: fmt(lc.ref(id)), ...(() => { const a = asset(id); return { ppg: a.ppg, ros_vor: a.ros_vor, ...(dynasty ? { dynasty_value: a.dynasty_value } : {}) }; })() }));
				return ok({
					focus: mode,
					weeks: `${lc.week}-${through}`,
					trades: picked.slice(0, limit ?? 6).map((d) => ({
						partner: lc.team(d.partner.roster_id).owner,
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
						"Lineup change = best projected starting lineup (avg of the next 3 weeks' Sleeper projections, league scoring) after minus before. " +
						"Trades must help you, cost them at most 1 point a week, and be within 20% on value (" +
						(dynasty && mode !== "win_now" ? "a blend of rest-of-season VOR and dynasty market value" : "rest-of-season VOR") +
						"). Run evaluate_trade on any of these for the full picture.",
				});
			} catch (e) {
				return fail(e);
			}
		},
	);
}

