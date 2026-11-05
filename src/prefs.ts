// League preferences set on the server (wrangler.jsonc vars), so every client and scheduled
// scan applies them without repeating them in prompts.
//
//   UNTOUCHABLES         comma-separated players never offered in trades or suggested as drops
//   DEFAULT_TRADE_FOCUS  win_now | balanced | long_term (default for find_trades/evaluate_trade)

import type { PlayerDb } from "./players";

export type Focus = "win_now" | "balanced" | "long_term";

export interface Prefs {
	untouchables: Set<string>;
	untouchableNames: string[];
	focus: Focus;
}

export function readPrefs(env: Env, players: PlayerDb): Prefs {
	const e = env as { UNTOUCHABLES?: string; DEFAULT_TRADE_FOCUS?: string };
	const names = (e.UNTOUCHABLES ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const ids = new Set<string>();
	for (const n of names) {
		try {
			ids.add(players.resolve(n).id);
		} catch {
			// An unknown name is ignored rather than breaking every tool.
		}
	}
	const f = (e.DEFAULT_TRADE_FOCUS ?? "").trim();
	return { untouchables: ids, untouchableNames: names, focus: f === "balanced" || f === "long_term" || f === "win_now" ? f : "balanced" };
}
