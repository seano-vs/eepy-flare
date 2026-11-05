// Game-time weather from Open-Meteo (free, no key) for outdoor games, at the home stadium.
// Indoors (fixed dome or covered roof) needs no forecast; retractable roofs get the forecast with
// a note, since the roof decision comes on game day. Neutral-site games are skipped: the
// stadium coordinates below are each team's home.

import { sleeperTeam } from "./nflverse/stats";

type Row = Record<string, unknown>;

/** Home stadium coordinates by Sleeper team abbreviation. */
const STADIUMS: Record<string, [number, number]> = {
	ARI: [33.5276, -112.2626], ATL: [33.7554, -84.4009], BAL: [39.278, -76.6227], BUF: [42.7738, -78.787],
	CAR: [35.2258, -80.8528], CHI: [41.8623, -87.6167], CIN: [39.0955, -84.5161], CLE: [41.5061, -81.6995],
	DAL: [32.7473, -97.0945], DEN: [39.7439, -105.0201], DET: [42.34, -83.0456], GB: [44.5013, -88.0622],
	HOU: [29.6847, -95.4107], IND: [39.7601, -86.1639], JAX: [30.3239, -81.6373], KC: [39.0489, -94.4839],
	LV: [36.0909, -115.1833], LAC: [33.9535, -118.3392], LAR: [33.9535, -118.3392], MIA: [25.958, -80.2389],
	MIN: [44.9738, -93.2581], NE: [42.0909, -71.2643], NO: [29.9511, -90.0812], NYG: [40.8135, -74.0745],
	NYJ: [40.8135, -74.0745], PHI: [39.9008, -75.1675], PIT: [40.4468, -80.0158], SF: [37.403, -121.97],
	SEA: [47.5952, -122.3316], TB: [27.9759, -82.5033], TEN: [36.1665, -86.7713], WAS: [38.9078, -76.8645],
};
const INDOORS = new Set(["DET", "MIN", "NO", "LV", "LAC", "LAR"]);
const RETRACTABLE = new Set(["ARI", "ATL", "DAL", "HOU", "IND"]);

export interface GameWeather {
	game: string;
	kickoff_et: string;
	conditions: "indoors" | "forecast" | "neutral site" | "unavailable";
	temp_f?: number;
	wind_mph?: number;
	gusts_mph?: number;
	precip_chance_pct?: number;
	precip_in?: number;
	flags?: string[];
	note?: string;
	/** When the forecast was fetched from Open-Meteo (ms; responses are edge-cached up to 30 min). */
	fetched_ms?: number;
}

interface Hourly {
	time: string[];
	temperature_2m: number[];
	wind_speed_10m: number[];
	wind_gusts_10m: number[];
	precipitation_probability: number[];
	precipitation: number[];
}

/** Summarize the 3 game hours from kickoff and flag fantasy-relevant weather. Pure; exported for tests. */
export function summarizeForecast(h: Hourly, gameday: string, gametime: string): Omit<GameWeather, "game" | "kickoff_et" | "conditions"> | null {
	const start = h.time.indexOf(`${gameday}T${gametime.slice(0, 2)}:00`);
	if (start < 0) return null;
	const idx = [start, start + 1, start + 2, start + 3].filter((i) => i < h.time.length);
	const max = (xs: number[]) => Math.round(Math.max(...idx.map((i) => xs[i] ?? 0)));
	const temp = Math.round(h.temperature_2m[start] ?? 0);
	const wind = max(h.wind_speed_10m);
	const gusts = max(h.wind_gusts_10m);
	const pop = max(h.precipitation_probability);
	const precip = Math.round(idx.reduce((a, i) => a + (h.precipitation[i] ?? 0), 0) * 100) / 100;
	const flags: string[] = [];
	if (wind >= 20 || gusts >= 30) flags.push("high wind: downgrade passing and kickers");
	else if (wind >= 15) flags.push("windy: deep passing and long kicks suffer");
	if (pop >= 50 && precip >= 0.1) flags.push(temp <= 33 ? "snow likely" : "rain likely");
	if (temp <= 20) flags.push("very cold");
	return { temp_f: temp, wind_mph: wind, gusts_mph: gusts, precip_chance_pct: pop, precip_in: precip, ...(flags.length ? { flags } : {}) };
}

async function forecast(lat: number, lon: number, day: string): Promise<{ hourly: Hourly; fetched: number } | null> {
	const url =
		`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
		"&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,precipitation" +
		`&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FNew_York&start_date=${day}&end_date=${day}`;
	try {
		const res = await fetch(url, { cf: { cacheTtl: 1800, cacheEverything: true } } as RequestInit);
		if (!res.ok) return null;
		const hourly = ((await res.json()) as { hourly?: Hourly }).hourly;
		const age = Number(res.headers.get("age") ?? 0);
		return hourly ? { hourly, fetched: Date.now() - (Number.isFinite(age) ? age * 1000 : 0) } : null;
	} catch {
		return null;
	}
}

/** Weather for each game in `games` (nfl_games rows), keyed by both teams. */
export async function gameWeather(games: Row[], now = Date.now()): Promise<Map<string, GameWeather>> {
	const out = new Map<string, GameWeather>();
	await Promise.all(
		games.map(async (g) => {
			const home = sleeperTeam(g.home_team);
			const away = sleeperTeam(g.away_team);
			if (!home || !away) return;
			const day = String(g.gameday ?? "");
			const time = String(g.gametime ?? "13:00");
			const base = { game: `${away} @ ${home}`, kickoff_et: `${day} ${time}` };
			let w: GameWeather;
			const kickoff = Date.parse(`${day}T${time}:00-05:00`);
			if (String(g.location ?? "") === "Neutral") w = { ...base, conditions: "neutral site", note: `Played at ${g.stadium ?? "a neutral site"}; no forecast.` };
			else if (INDOORS.has(home) || g.roof === "dome") w = { ...base, conditions: "indoors" };
			else if (!STADIUMS[home] || !Number.isFinite(kickoff) || kickoff - now > 15 * 86_400_000) w = { ...base, conditions: "unavailable", note: "Forecast covers the next 15 days only." };
			else {
				const [lat, lon] = STADIUMS[home]!;
				const h = await forecast(lat, lon, day);
				const s = h ? summarizeForecast(h.hourly, day, time) : null;
				w = s
					? { ...base, conditions: "forecast", ...s, fetched_ms: h!.fetched, ...(RETRACTABLE.has(home) ? { note: "Retractable roof: irrelevant if it's closed (decided on game day)." } : {}) }
					: { ...base, conditions: "unavailable" };
			}
			out.set(home, w);
			out.set(away, w);
		}),
	);
	return out;
}

/** Oldest fetch time among these forecasts (for the as_of block). */
export function weatherFetchedAt(ws: Iterable<GameWeather>): number | null {
	const t = [...ws].map((w) => w.fetched_ms).filter((x): x is number => x != null);
	return t.length ? Math.min(...t) : null;
}
