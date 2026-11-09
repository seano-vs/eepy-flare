#!/usr/bin/env node
// Independent check of the league-format multipliers (src/format.ts).
//
// Shares no code with the Worker. It recomputes each position's multiplier from two data
// sources the Worker's mirror doesn't touch:
//   sleeper   Sleeper's weekly stats (keys match the scoring settings, so no column mapping)
//   nflverse  the raw stats_player_week CSV from GitHub (its own column mapping, written here)
// and prints how sensitive each multiplier is to the starter count. Compare its output with
// the server's format_adjustment (compare_players / evaluate_trade, focus "balanced").
//
//   node scripts/verify-format.mjs [--league ID] [--season 2026] [--through 9]
//        [--starters QB=24,RB=27,WR=33,TE=12] [--expect QB=1.116,RB=1,WR=1,TE=1]
//
// --expect exits 1 if either source differs from an expected multiplier by more than 0.002.

import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const args = Object.fromEntries(
	process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const kv = (s) => Object.fromEntries((s ?? "").split(",").filter(Boolean).map((p) => p.split("=")).map(([k, v]) => [k, Number(v)]));

const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const leagueId = args.league ?? /"SLEEPER_LEAGUE_ID"\s*:\s*"(\d+)"/.exec(wrangler)?.[1];
const league = await (await fetch(`https://api.sleeper.app/v1/league/${leagueId}`)).json();
const season = args.season ?? league.season;
const state = await (await fetch("https://api.sleeper.app/v1/state/nfl")).json();
const through = Number(args.through ?? state.week);
const starters = { QB: 24, RB: 27, WR: 33, TE: 12, ...kv(args.starters) };
const expect = kv(args.expect);

// What the market rankings assume, laid over the league's rules. Kept in sync with
// MARKET_STANDARD in src/format.ts deliberately by hand: a test asserts they match.
const STANDARD = { pass_td: 4, rec: 1, bonus_rec_rb: 0, bonus_rec_wr: 0, bonus_rec_te: 0, pass_fd: 0, rush_fd: 0, rec_fd: 0 };
const scoring = league.scoring_settings;
const standard = { ...scoring, ...STANDARD };
const POS = ["QB", "RB", "WR", "TE"];
const MIN_GAMES = 4;
/** Replacement = average ppg of this many players after the starters (1 = the single next player). */
const BAND = Number(args.band ?? 1);

const score = (stats, rules) => Object.entries(rules).reduce((s, [k, m]) => s + (Number(stats[k]) || 0) * m, 0);

/** players: Map id -> {pos, g, lg, st}. Returns per-position {repl, par} for league and standard. */
function multipliers(players, n) {
	const out = {};
	for (const pos of POS) {
		const ps = [...players.values()].filter((p) => p.pos === pos && p.g >= MIN_GAMES);
		const side = (k) => {
			const ppg = ps.map((p) => p[k] / p.g).sort((a, b) => b - a);
			if (ppg.length < n[pos] + BAND) return null;
			const band = ppg.slice(n[pos], n[pos] + BAND);
			const repl = band.reduce((a, b) => a + b, 0) / band.length;
			return { repl, par: ppg.slice(0, n[pos]).reduce((s, x) => s + (x - repl), 0) / n[pos] };
		};
		const lg = side("lg");
		const st = side("st");
		out[pos] = lg && st && st.par > 0 ? { m: lg.par / st.par, lg, st, players: ps.length } : null;
	}
	return out;
}

// ---------------------------------------------------------------- source 1: Sleeper weekly stats
async function fromSleeper() {
	const players = new Map();
	for (let w = 1; w <= through; w++) {
		const url = `https://api.sleeper.com/stats/nfl/${season}/${w}?season_type=regular&${POS.map((p) => `position[]=${p}`).join("&")}`;
		const rows = await (await fetch(url)).json();
		for (const r of rows) {
			const pos = r.player?.position;
			if (!POS.includes(pos) || !(Number(r.stats?.gp) > 0)) continue;
			const p = players.get(r.player_id) ?? { pos, g: 0, lg: 0, st: 0 };
			p.g++;
			p.lg += score(r.stats, scoring);
			p.st += score(r.stats, standard);
			players.set(r.player_id, p);
		}
	}
	return players;
}

// ---------------------------------------------------------------- source 2: raw nflverse CSV
function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = "";
	let q = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q) {
			if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
			else if (c === '"') q = false;
			else field += c;
		} else if (c === '"') q = true;
		else if (c === ",") row.push(field), (field = "");
		else if (c === "\n") row.push(field), rows.push(row), (row = []), (field = "");
		else if (c !== "\r") field += c;
	}
	if (field || row.length) row.push(field), rows.push(row);
	const [head, ...body] = rows;
	return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** nflverse columns -> Sleeper scoring keys (independent of src/nflverse/stats.ts). */
function nflverseStats(r) {
	const x = (k) => Number(r?.[k]) || 0;
	return {
		pass_yd: x("passing_yards"),
		pass_td: x("passing_tds"),
		pass_int: x("passing_interceptions"),
		pass_2pt: x("passing_2pt_conversions"),
		rush_yd: x("rushing_yards"),
		rush_td: x("rushing_tds"),
		rush_2pt: x("rushing_2pt_conversions"),
		rec: x("receptions"),
		rec_yd: x("receiving_yards"),
		rec_td: x("receiving_tds"),
		rec_2pt: x("receiving_2pt_conversions"),
		fum_lost: x("rushing_fumbles_lost") + x("receiving_fumbles_lost") + x("sack_fumbles_lost"),
		fum_rec_td: x("fumble_recovery_tds"),
		st_td: x("special_teams_tds"),
		pass_fd: x("passing_first_downs"),
		rush_fd: x("rushing_first_downs"),
		rec_fd: x("receiving_first_downs"),
		bonus_rec_rb: r?.position === "RB" ? x("receptions") : 0,
		bonus_rec_wr: r?.position === "WR" ? x("receptions") : 0,
		bonus_rec_te: r?.position === "TE" ? x("receptions") : 0,
	};
}

async function fromNflverse() {
	const url = `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv.gz`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`nflverse ${res.status}`);
	const rows = parseCsv(gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8"));
	const players = new Map();
	for (const r of rows) {
		if (r.season_type !== "REG" || !POS.includes(r.position) || Number(r.week) > through) continue;
		const s = nflverseStats(r);
		const p = players.get(r.player_id) ?? { pos: r.position, g: 0, lg: 0, st: 0 };
		p.g++;
		p.lg += score(s, scoring);
		p.st += score(s, standard);
		players.set(r.player_id, p);
	}
	return players;
}

/** A pinned JSON array of nflverse rows (test/fixtures), for reproducible expected values. */
function fromFixture(path) {
	const players = new Map();
	for (const r of JSON.parse(readFileSync(path, "utf8"))) {
		if (!POS.includes(r.position) || Number(r.week) > through) continue;
		const s = nflverseStats(r);
		const p = players.get(r.gsis_id) ?? { pos: r.position, g: 0, lg: 0, st: 0 };
		p.g++;
		p.lg += score(s, scoring);
		p.st += score(s, standard);
		players.set(r.gsis_id, p);
	}
	return players;
}

// ---------------------------------------------------------------- report
const unknown = Object.entries(scoring).filter(([k, v]) => v && !(k in nflverseStats({})) && /^(pass|rush|rec|fum|bonus_rec|st_td)/.test(k));
console.log(`League ${league.name} (${leagueId}), ${season} weeks 1-${through}; starters ${JSON.stringify(starters)}`);
console.log(`League vs standard differences: ${JSON.stringify(Object.fromEntries(Object.entries(STANDARD).filter(([k, v]) => (scoring[k] ?? 0) !== v).map(([k, v]) => [k, `${scoring[k] ?? 0} vs ${v}`])))}`);
if (unknown.length) console.log(`Note: nflverse source has no column for scoring keys ${unknown.map(([k]) => k).join(", ")} (Sleeper source does).`);

let failed = false;
const results = {};
const sources = args.fixture ? [["fixture", async () => fromFixture(args.fixture)]] : [["sleeper", fromSleeper], ["nflverse", fromNflverse]];
for (const [name, load] of sources) {
	const players = await load();
	const m = multipliers(players, starters);
	results[name] = m;
	console.log(`\n${name}`);
	for (const pos of POS) {
		const r = m[pos];
		if (!r) {
			console.log(`  ${pos}: not enough players`);
			continue;
		}
		const sens = [-2, -1, 1, 2].map((d) => multipliers(players, { ...starters, [pos]: starters[pos] + d })[pos]?.m.toFixed(3)).join(" ");
		console.log(
			`  ${pos}: x${r.m.toFixed(3)}  repl ${r.st.repl.toFixed(2)} -> ${r.lg.repl.toFixed(2)} ppg, above repl ${r.st.par.toFixed(3)} -> ${r.lg.par.toFixed(3)}  (${r.players} players)  starters -2,-1,+1,+2: ${sens}`,
		);
		if (expect[pos] != null && Math.abs(r.m - expect[pos]) > 0.002) {
			console.log(`  MISMATCH: expected ${expect[pos]}`);
			failed = true;
		}
	}
}
if (results.sleeper && results.nflverse) {
	const d = POS.map((p) => (results.sleeper[p] && results.nflverse[p] ? Math.abs(results.sleeper[p].m - results.nflverse[p].m) : 0));
	console.log(`\nLargest difference between sources: ${Math.max(...d).toFixed(4)}`);
}
process.exit(failed ? 1 : 0);
