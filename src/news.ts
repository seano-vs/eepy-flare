// Player news from Sleeper's own (undocumented) per-player feed: the RotoWire, RotoBaller and
// FantasyPros blurbs the Sleeper app shows. Headlines move before projections and injury tags
// do, so tools surface them next to the numbers. Fail-soft: any error means "no news".

import { sleeper } from "./sleeper";
import { eastern } from "./waivers";

export interface NewsItem {
	title: string;
	source: string;
	published: string;
	/** Publish time in Eastern, e.g. "Wed, Nov 4, 9:14 PM ET". */
	published_et?: string;
	/** Hours since published, at the time of the request. */
	age_hours: number;
	url?: string;
	/** Other outlets that reported the same event within a few hours (merged into this item). */
	also?: string[];
	summary?: string;
}

/** Sources whose feed time is Eastern wall-clock time stored as if it were UTC. */
const EASTERN_AS_UTC = new Set(["rotoballer"]);

/** Milliseconds New York is behind UTC at instant `t` (5h in winter, 4h in summer). */
function nyOffsetMs(t: number): number {
	const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date(t));
	const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
	return t - Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"), new Date(t).getUTCMilliseconds());
}

/**
 * Correct a feed timestamp. RotoBaller items in Sleeper's feed are Eastern wall time stored as UTC
 * (recaps stamped before kickoff, e.g. a Week 8 recap at 11:31 AM ET on game day), so they read
 * 4-5 hours early. Reinterpret the UTC wall time as New York time; if that lands in the future,
 * the feed was right (or has been fixed) and the raw time is kept. Pure; exported for tests.
 */
export function fixPublished(ms: number, source: string, now = Date.now()): number {
	if (!EASTERN_AS_UTC.has(source)) return ms;
	const fixed = ms + nyOffsetMs(ms + 5 * 3_600_000);
	return fixed > now + 10 * 60_000 ? ms : fixed;
}

/** Parse Sleeper's news payload defensively (exported for tests). */
export function parseNews(data: unknown, now = Date.now()): NewsItem[] {
	if (!Array.isArray(data)) return [];
	const out: NewsItem[] = [];
	for (const x of data) {
		if (!x || typeof x !== "object") continue;
		const r = x as { published?: unknown; source?: unknown; metadata?: { title?: unknown; url?: unknown; description?: unknown } };
		const title = typeof r.metadata?.title === "string" ? r.metadata.title.trim() : "";
		const raw = typeof r.published === "number" ? r.published : Number(r.published);
		if (!title || !Number.isFinite(raw)) continue;
		const ms = fixPublished(raw, typeof r.source === "string" ? r.source : "", now);
		const summary = typeof r.metadata?.description === "string" ? r.metadata.description.trim() : "";
		out.push({
			title,
			source: typeof r.source === "string" ? r.source : "unknown",
			published: new Date(ms).toISOString(),
			published_et: eastern(ms),
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
		return dedupeNews(items.filter((n) => opts.maxAgeHours == null || n.age_hours <= opts.maxAgeHours)).slice(0, opts.limit ?? 5);
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

export interface PracticeNews {
	practice: "DNP" | "Limited" | "Full";
	day?: string;
	source: string;
	age_hours: number;
	published_et?: string;
	title: string;
}

const PRACTICE_RE: [RegExp, PracticeNews["practice"]][] = [
	[/\b(did not|didn't|does not|doesn't|won't|will not) practice\b|\bnot practicing\b|\bsits out practice\b|\bmisses practice\b|\babsent from practice\b|\bDNP\b|\bno practice\b/i, "DNP"],
	[/\blimited\b/i, "Limited"],
	[/\b(full(y)? (participant|participation|practice|go)|practices? fully|practiced in full|full practice|no limitations)\b/i, "Full"],
];
const DAY_RE = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i;

/** Practice participation stated in a headline (or its summary). Pure; exported for tests. */
export function practiceFromText(text: string): { practice: PracticeNews["practice"]; day?: string } | null {
	if (!/practic|\bDNP\b|\blimited\b|participa/i.test(text)) return null;
	// Headlines lead with the latest status ("full practice Thursday after limited Wednesday"),
	// so the earliest mention wins.
	let best: { practice: PracticeNews["practice"]; at: number } | null = null;
	for (const [re, practice] of PRACTICE_RE) {
		const m = re.exec(text);
		if (m && (!best || m.index < best.at)) best = { practice, at: m.index };
	}
	if (!best) return null;
	const day = text.slice(best.at).match(DAY_RE)?.[1] ?? text.match(DAY_RE)?.[1];
	return { practice: best.practice, ...(day ? { day: day.charAt(0).toUpperCase() + day.slice(1).toLowerCase() } : {}) };
}

/** Latest practice participation per player from the last few days of headlines. */
export async function practiceFromNews(ids: string[], maxAgeHours = 72): Promise<Map<string, PracticeNews>> {
	const out = new Map<string, PracticeNews>();
	await Promise.all(
		ids.map(async (id) => {
			for (const n of await playerNews(id, { limit: 5, maxAgeHours })) {
				const p = practiceFromText(n.title) ?? (n.summary ? practiceFromText(n.summary) : null);
				if (p) {
					out.set(id, { ...p, source: n.source, age_hours: n.age_hours, ...(n.published_et ? { published_et: n.published_et } : {}), title: n.title });
					return;
				}
			}
		}),
	);
	return out;
}

/** What a headline reports, coarsely, so different outlets' takes on one event match. */
function eventKey(title: string): string | null {
	const p = practiceFromText(title);
	if (p) return `practice:${p.practice}:${p.day ?? ""}`;
	if (/\bruled out\b|\bwon't play\b|\bwill not play\b|\bout for (week|sunday|monday|thursday)\b|\binactive\b/i.test(title)) return "out";
	const r = roleSignal(title);
	if (r) return `role:${r.reason}`;
	if (/\bdoubtful\b/i.test(title)) return "doubtful";
	if (/\bquestionable\b/i.test(title)) return "questionable";
	return null;
}

const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 4));

/**
 * Merge items about the same event within 12 hours (newest kept, other sources in `also`).
 * Items match on the event they report, else on title overlap. Pure; exported for tests.
 */
export function dedupeNews(items: NewsItem[]): NewsItem[] {
	const kept: (NewsItem & { _key: string | null; _w: Set<string> })[] = [];
	// Words in most of a player's items are his name: they don't say two items match.
	const freq = new Map<string, number>();
	for (const n of items) for (const w of words(n.title)) freq.set(w, (freq.get(w) ?? 0) + 1);
	const common = new Set([...freq].filter(([, c]) => items.length >= 2 && c >= Math.max(2, 0.8 * items.length)).map(([w]) => w));
	for (const n of items) {
		const key = eventKey(n.title);
		const w = new Set([...words(n.title)].filter((x) => !common.has(x)));
		const dup = kept.find((k) => {
			if (Math.abs(k.age_hours - n.age_hours) > 12) return false;
			if (key && k._key) return key === k._key;
			const inter = [...w].filter((x) => k._w.has(x)).length;
			return w.size >= 2 && k._w.size >= 2 && inter / Math.min(w.size, k._w.size) >= 0.6;
		});
		if (dup) {
			if (dup.source !== n.source && !(dup.also ?? []).includes(n.source)) dup.also = [...(dup.also ?? []), n.source];
		} else kept.push({ ...n, _key: key, _w: w });
	}
	return kept.map(({ _key: _k, _w: _ww, ...n }) => n);
}

/** One-line headline with source(s) and an absolute time: `Title (rotowire +fantasy_pros, Wed, Nov 4, 9:14 PM ET, 12h ago)`. */
export function newsLine(n: Pick<NewsItem, "title" | "source" | "age_hours" | "published_et" | "also">): string {
	const src = [n.source, ...(n.also ?? []).map((a) => `+${a}`)].join(" ");
	return `${n.title} (${src}, ${n.published_et ? `${n.published_et}, ` : ""}${n.age_hours}h ago)`;
}

/** Practice status from a headline, with when it was reported. */
export function practiceLine(p: PracticeNews): string {
	return `${p.practice}${p.day ? ` ${p.day}` : ""} (${p.source}, ${p.published_et ? `${p.published_et}, ` : ""}${p.age_hours}h ago)`;
}

/** Reported starts, not speculation ("could start", "may start" don't count). */
const CONFIRMED_START = /\b(set to start|will start|expected to start|in line to start|named (the )?starter|named (the )?\w+ (starting|starter)|named \w+ starting|(set|slated|poised|expected) to take over|tak(es|ing) over as|to start (week|sunday|monday|thursday))\b/i;
const SPECULATIVE = /\b(could|may|might|possible|possibly|potential|competing|in the mix|if)\b/i;

/** True when a headline reports that the player will start (pricing uses it). Pure; exported for tests. */
export function confirmedStart(title: string): boolean {
	return CONFIRMED_START.test(title) && !SPECULATIVE.test(title);
}
