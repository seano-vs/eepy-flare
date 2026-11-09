// One season's raw nflverse rows -> PlayerSeason inputs for the stitcher. Pure, so tests feed it
// real rows from fixtures and the Worker feeds it the downloaded files.
//
//   injuries  injuries_{season}.csv          weekly report: status, practice, body part
//   snaps     snap_counts_{season}.csv       offense snaps and share, keyed by PFR id
//   stats     stats_player_week_{season}.csv a row for every game with a stat (gsis id)
//   rosters   roster_weekly_{season}.parquet team and status (IR) by week; maps PFR id -> gsis id

import { median, normalizeBody, normalizePractice, normalizeStatus, RESERVE_CODES, type PlayerSeason } from "./episodes";

type Raw = Record<string, unknown>;
const str = (v: unknown) => (v == null ? "" : String(v));
const num = (v: unknown) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};
const SKILL = new Set(["QB", "RB", "WR", "TE"]);
const REG = (r: Raw) => {
	const t = str(r.game_type ?? r.season_type);
	return t === "" || t === "REG";
};
const team = (t: string) => (t === "LA" ? "LAR" : t);

export interface SeasonRaw {
	injuries: Raw[];
	snaps: Raw[];
	stats: Raw[];
	rosters: Raw[];
}

/** Per-player inputs for one season. priorNorms: gsis id -> previous season's median snap share. */
export function buildSeason(season: number, raw: SeasonRaw, priorNorms: Map<string, number> = new Map(), complete = true): PlayerSeason[] {
	// Team schedule from snaps: a team played week w if any of its players has a snap row.
	const teamWeeks = new Map<string, Set<number>>();
	for (const s of raw.snaps) {
		if (!REG(s)) continue;
		const t = team(str(s.team));
		const w = num(s.week);
		if (!t || w == null) continue;
		(teamWeeks.get(t) ?? teamWeeks.set(t, new Set()).get(t)!).add(w);
	}

	// Roster rows: PFR -> gsis, team by week, IR weeks, name and position.
	const pfrToGsis = new Map<string, string>();
	const teamAt = new Map<string, Map<number, string>>();
	const reserve = new Map<string, Set<number>>();
	const info = new Map<string, { name: string; position: string }>();
	for (const r of raw.rosters) {
		if (!REG(r)) continue;
		const id = str(r.gsis_id);
		const w = num(r.week);
		if (!id || w == null) continue;
		const pfr = str(r.pfr_id);
		if (pfr) pfrToGsis.set(pfr, id);
		if (r.team) (teamAt.get(id) ?? teamAt.set(id, new Map()).get(id)!).set(w, team(str(r.team)));
		if (RESERVE_CODES.has(str(r.status_description_abbr))) (reserve.get(id) ?? reserve.set(id, new Set()).get(id)!).add(w);
		if (SKILL.has(str(r.position))) info.set(id, { name: str(r.full_name), position: str(r.position) });
	}

	// Games played and snap share.
	const played = new Map<string, Map<number, number | null>>();
	const mark = (id: string, w: number, share: number | null) => {
		const m = played.get(id) ?? played.set(id, new Map()).get(id)!;
		if (share != null || !m.has(w)) m.set(w, share ?? m.get(w) ?? null);
	};
	for (const s of raw.snaps) {
		if (!REG(s)) continue;
		const id = pfrToGsis.get(str(s.pfr_player_id));
		const w = num(s.week);
		if (!id || w == null || !(Number(s.offense_snaps) > 0)) continue;
		mark(id, w, num(s.offense_pct));
		const t = team(str(s.team));
		if (t && !teamAt.get(id)?.has(w)) (teamAt.get(id) ?? teamAt.set(id, new Map()).get(id)!).set(w, t);
	}
	for (const s of raw.stats) {
		if (!REG(s)) continue;
		const id = str(s.player_id ?? s.gsis_id);
		const w = num(s.week);
		if (id && w != null) mark(id, w, null);
		if (id && SKILL.has(str(s.position)) && !info.has(id)) info.set(id, { name: str(s.player_display_name ?? s.player_name), position: str(s.position) });
	}

	// Report rows.
	const reports = new Map<string, PlayerSeason["reports"]>();
	for (const r of raw.injuries) {
		if (!REG(r)) continue;
		const id = str(r.gsis_id);
		const w = num(r.week);
		if (!id || w == null) continue;
		const body = normalizeBody(str(r.report_primary_injury) || str(r.practice_primary_injury));
		(reports.get(id) ?? reports.set(id, []).get(id)!).push({
			week: w,
			body,
			status: normalizeStatus(str(r.report_status)),
			practice: normalizePractice(str(r.practice_status)),
			date: str(r.date_modified) || null,
		});
		if (SKILL.has(str(r.position)) && !info.has(id)) info.set(id, { name: str(r.full_name), position: str(r.position) });
	}

	// Fullbacks are listed RB on rosters but FB on the report (Patrick Ricard): not fantasy RBs.
	const fullbacks = new Set<string>();
	for (const r of raw.injuries) if (str(r.position) === "FB") fullbacks.add(str(r.gsis_id));
	for (const r of raw.rosters) if (str(r.depth_chart_position) === "FB" || str(r.position) === "FB") fullbacks.add(str(r.gsis_id));

	const out: PlayerSeason[] = [];
	for (const [id, meta] of info) {
		if (fullbacks.has(id)) continue;
		const pl = played.get(id);
		if (!pl?.size) continue;
		const teams = teamAt.get(id) ?? new Map<number, string>();
		// His team's games: weeks his team at that week played (handles mid-season trades).
		const allWeeks = new Set<number>();
		for (const ws of teamWeeks.values()) for (const w of ws) allWeeks.add(w);
		const lastTeam = (w: number) => {
			let t: string | undefined;
			for (const [k, v] of [...teams.entries()].sort((a, b) => a[0] - b[0])) if (k <= w) t = v;
			return t ?? [...teams.values()][0];
		};
		const weeks = [...allWeeks].filter((w) => {
			const t = teams.get(w) ?? lastTeam(w);
			return t ? teamWeeks.get(t)?.has(w) : pl.has(w);
		});
		const latest = [...teams.entries()].sort((a, b) => b[0] - a[0])[0]?.[1] ?? "";
		const reps = (reports.get(id) ?? []).sort((a, b) => a.week - b.week);
		out.push({
			id,
			name: meta.name,
			position: meta.position,
			team: latest,
			season,
			played: pl,
			reports: reps.filter((r, i) => i === reps.length - 1 || reps[i + 1]!.week !== r.week),
			teamWeeks: weeks.sort((a, b) => a - b),
			reserve: reserve.get(id),
			priorNorm: priorNorms.get(id) ?? null,
			complete,
		});
	}
	return out;
}

/** Median snap share per player for a season, to seed the next season's week-1 norms. */
export function seasonNorms(players: PlayerSeason[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const p of players) {
		const xs = [...p.played.values()].filter((x): x is number => x != null);
		// True median (even count: mean of the middle two), the same as the stitcher's.
		if (xs.length >= 4) out.set(p.id, median(xs)!);
	}
	return out;
}
