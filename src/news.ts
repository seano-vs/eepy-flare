// Player news from Sleeper's own (undocumented) per-player feed: the RotoWire, RotoBaller and
// FantasyPros blurbs the Sleeper app shows. Headlines move before projections and injury tags
// do, so tools surface them next to the numbers. Fail-soft: any error means "no news".

import { sleeper } from "./sleeper";

export interface NewsItem {
	title: string;
	source: string;
	published: string;
	/** Hours since published, at the time of the request. */
	age_hours: number;
	url?: string;
	summary?: string;
}

/** Parse Sleeper's news payload defensively (exported for tests). */
export function parseNews(data: unknown, now = Date.now()): NewsItem[] {
	if (!Array.isArray(data)) return [];
	const out: NewsItem[] = [];
	for (const x of data) {
		if (!x || typeof x !== "object") continue;
		const r = x as { published?: unknown; source?: unknown; metadata?: { title?: unknown; url?: unknown; description?: unknown } };
		const title = typeof r.metadata?.title === "string" ? r.metadata.title.trim() : "";
		const ms = typeof r.published === "number" ? r.published : Number(r.published);
		if (!title || !Number.isFinite(ms)) continue;
		const summary = typeof r.metadata?.description === "string" ? r.metadata.description.trim() : "";
		out.push({
			title,
			source: typeof r.source === "string" ? r.source : "unknown",
			published: new Date(ms).toISOString(),
			age_hours: Math.max(0, Math.round((now - ms) / 3_600_000)),
			...(typeof r.metadata?.url === "string" ? { url: r.metadata.url } : {}),
			...(summary ? { summary: summary.length > 280 ? `${summary.slice(0, 277)}...` : summary } : {}),
		});
	}
	return out.sort((a, b) => b.published.localeCompare(a.published));
}

export async function playerNews(playerId: string, opts: { limit?: number; maxAgeHours?: number } = {}): Promise<NewsItem[]> {
	try {
		const items = parseNews(await sleeper.playerNews(playerId));
		return items.filter((n) => opts.maxAgeHours == null || n.age_hours <= opts.maxAgeHours).slice(0, opts.limit ?? 5);
	} catch {
		return [];
	}
}

/** Latest headline per player within `maxAgeHours` (for compact list views). */
export async function latestHeadlines(ids: string[], maxAgeHours = 72): Promise<Map<string, NewsItem>> {
	const out = new Map<string, NewsItem>();
	const results = await Promise.all(ids.map(async (id) => [id, (await playerNews(id, { limit: 1, maxAgeHours }))[0]] as const));
	for (const [id, n] of results) if (n) out.set(id, n);
	return out;
}

export type RoleSignal = { kind: "negative" | "positive"; reason: string };

const NEGATIVE: [RegExp, string][] = [
	[/\b(benched|demoted|to the bench|loses? (the |his )?(starting )?(job|role|spot)|no longer (the )?starter)\b/i, "benched or demoted"],
	[/\b(no\. ?3|third[- ]string|qb3|backup role|relegated)\b/i, "backup role"],
	[/\b(traded|dealt)\b/i, "traded (role on new team unclear)"],
	[/\b(released|waived|cut by|let go)\b/i, "released"],
	[/\b(placed on (ir|injured reserve)|season[- ]ending|out for (the )?(season|year)|suspended)\b/i, "out long-term"],
	[/\b(ruled out|won'?t play|will not play|inactive)\b/i, "ruled out"],
];
const POSITIVE: [RegExp, string][] = [
	[/\b(named (the )?(starter|starting)|will start|to start|set to start|in line to start|expected to start|could start|takes over|promoted|first[- ]team|lead (back|role)|starting role)\b/i, "in line to start"],
];

/** Classify a headline as role news (pure; exported for tests). Negative checks win when both match. */
export function roleSignal(title: string): RoleSignal | null {
	for (const [re, reason] of NEGATIVE) if (re.test(title)) return { kind: "negative", reason };
	for (const [re, reason] of POSITIVE) if (re.test(title)) return { kind: "positive", reason };
	return null;
}
