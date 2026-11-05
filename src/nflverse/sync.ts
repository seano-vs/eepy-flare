// Mirrors nflverse CSVs into D1.
//
// Each run, per dataset:
//   1. Conditional GET with the stored ETag. 304 => nothing to do (no download, no parsing).
//   2. Otherwise parse, keep fantasy-relevant rows/columns, group rows into chunks
//      (usually one NFL week) and hash each chunk.
//   3. Rewrite only chunks whose hash changed. Stat corrections touch one or two
//      weeks, so a normal refresh writes a few hundred rows, not the whole season.
// Each chunk's rows and its new hash are written in the same D1 batch, so a
// failure leaves the old hash in place and the chunk is retried next run.

import { parquetReadObjects } from "hyparquet";
import { parseCsvColumns } from "./csv";
import { DATASETS, type ColumnSpec, type Dataset } from "./datasets";

/** Bump when a table definition changes; tables are then dropped and rebuilt on the next sync. */
export const SCHEMA_VERSION = "3";

type Value = string | number | null;

export interface SyncResult {
	dataset: string;
	status: "unchanged" | "updated" | "missing" | "error";
	rows?: number;
	chunks_changed?: number;
	rows_written?: number;
	error?: string;
}

function columnDdl(c: ColumnSpec): string {
	return `${c.name} ${c.type}`;
}

function schemaStatements(): string[] {
	const out = [
		"CREATE TABLE IF NOT EXISTS nfl_meta (key TEXT PRIMARY KEY, value TEXT)",
		"CREATE TABLE IF NOT EXISTS nfl_sync (key TEXT PRIMARY KEY, dataset TEXT, season TEXT, etag TEXT, last_modified TEXT, checked_at TEXT, changed_at TEXT, rows INTEGER, note TEXT)",
		"CREATE TABLE IF NOT EXISTS nfl_chunk (dataset TEXT, chunk TEXT, hash TEXT, PRIMARY KEY (dataset, chunk))",
		// Last failure per dataset, cleared by the next successful sync; surfaced by get_nfl_data_status.
		"CREATE TABLE IF NOT EXISTS nfl_sync_errors (dataset TEXT PRIMARY KEY, error TEXT, failed_at TEXT, failures INTEGER)",
	];
	for (const d of DATASETS) {
		out.push(
			`CREATE TABLE IF NOT EXISTS ${d.table} (${d.columns.map(columnDdl).join(", ")}, PRIMARY KEY (${d.primaryKey.join(", ")}))`,
		);
		for (const idx of d.indexes ?? []) {
			out.push(`CREATE INDEX IF NOT EXISTS ${d.table}_${idx.join("_")} ON ${d.table} (${idx.join(", ")})`);
		}
	}
	return out;
}

/** Same column names, ignoring order. Exported for tests. */
export function sameColumns(have: string[], want: string[]): boolean {
	return have.length === want.length && want.every((c) => have.includes(c));
}

export async function ensureSchema(db: D1Database): Promise<void> {
	await db.prepare("CREATE TABLE IF NOT EXISTS nfl_meta (key TEXT PRIMARY KEY, value TEXT)").run();
	const current = await db.prepare("SELECT value FROM nfl_meta WHERE key = 'schema_version'").first<string>("value");
	const stmts: string[] = [];
	if (current !== SCHEMA_VERSION) {
		// Fresh install or definitions changed: rebuild everything from upstream.
		for (const d of DATASETS) stmts.push(`DROP TABLE IF EXISTS ${d.table}`);
		stmts.push("DROP TABLE IF EXISTS nfl_chunk", "DROP TABLE IF EXISTS nfl_sync");
	} else {
		// One dataset's columns changed: rebuild only that table (and forget its ETags and chunk hashes).
		const actual = await db.batch(DATASETS.map((d) => db.prepare(`SELECT name FROM pragma_table_info('${d.table}')`)));
		for (const [i, d] of DATASETS.entries()) {
			const have = ((actual[i]?.results ?? []) as { name: string }[]).map((r) => r.name);
			if (have.length && !sameColumns(have, d.columns.map((c) => c.name))) {
				stmts.push(
					`DROP TABLE IF EXISTS ${d.table}`,
					`DELETE FROM nfl_sync WHERE dataset = '${d.id}'`,
					`DELETE FROM nfl_chunk WHERE dataset = '${d.id}' OR dataset LIKE '${d.id}:%'`,
				);
			}
		}
	}
	stmts.push(...schemaStatements());
	stmts.push(`INSERT OR REPLACE INTO nfl_meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`);
	await db.batch(stmts.map((s) => db.prepare(s)));
}

// ---------------------------------------------------------------- parsing

function convert(raw: string | undefined, type: ColumnSpec["type"]): Value {
	if (raw == null) return null;
	const s = raw.trim();
	if (s === "" || s === "NA" || s === "NaN") return null;
	if (type === "TEXT") return s;
	const n = type === "INTEGER" ? Number.parseInt(s, 10) : Number.parseFloat(s);
	if (!Number.isFinite(n)) return null;
	return type === "REAL" ? Math.round(n * 10000) / 10000 : n;
}

/** CSV text -> typed rows for a dataset (exported for tests). */
export function extractRows(d: Dataset, csvText: string, season: string): Value[][] {
	// Source columns we need: every mapped column plus whatever keep()/computed() read.
	const wanted = [...new Set([...d.columns.filter((c) => !d.computed?.[c.name]).map((c) => c.from ?? c.name), ...(d.reads ?? [])])];
	const { header, rows } = parseCsvColumns(csvText, wanted, d.prefilter?.(season));
	const present = new Set(header);
	const idx = new Map(wanted.map((w, i) => [w, i]));
	const missing = d.columns.filter((c) => !d.computed?.[c.name] && !present.has(c.from ?? c.name));
	if (missing.length) {
		throw new Error(`${d.id}: upstream columns missing: ${missing.map((c) => c.from ?? c.name).join(", ")}`);
	}
	const out: Value[][] = [];
	for (const r of rows) {
		const get = (col: string) => {
			const i = idx.get(col);
			return i == null ? "" : (r[i] ?? "");
		};
		if (d.keep && !d.keep(get, season)) continue;
		out.push(
			d.columns.map((c) => {
				const fn = d.computed?.[c.name];
				if (fn) return fn(get);
				return convert(get(c.from ?? c.name), c.type);
			}),
		);
	}
	return out;
}

/** Rows for any dataset: plain CSV mapping, or a derived dataset built from CSV/Parquet records. */
export async function extractAny(d: Dataset, body: string | ArrayBuffer, season: string): Promise<Value[][]> {
	if (!d.derive) {
		if (typeof body !== "string") throw new Error(`${d.id}: expected CSV text`);
		return extractRows(d, body, season);
	}
	const cols = d.derive.columns;
	let records: Record<string, unknown>[];
	if (d.format === "parquet") {
		if (typeof body === "string") throw new Error(`${d.id}: expected Parquet bytes`);
		records = (await parquetReadObjects({ file: body, columns: cols })) as Record<string, unknown>[];
		const missing = cols.filter((c) => records.length && !(c in records[0]!));
		if (missing.length) throw new Error(`${d.id}: upstream columns missing: ${missing.join(", ")}`);
		// Parquet INT64 columns come back as BigInt; normalise to numbers.
		for (const r of records) for (const k of cols) if (typeof r[k] === "bigint") r[k] = Number(r[k]);
	} else {
		if (typeof body !== "string") throw new Error(`${d.id}: expected CSV text`);
		const { header, rows } = parseCsvColumns(body, cols, d.prefilter?.(season));
		const missing = cols.filter((c) => !header.includes(c));
		if (missing.length) throw new Error(`${d.id}: upstream columns missing: ${missing.join(", ")}`);
		records = rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] === "NA" ? "" : r[i]])));
	}
	return d.derive.build(records, season);
}

// ---------------------------------------------------------------- SQL helpers

function literal(v: Value): string {
	if (v == null) return "NULL";
	if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
	return `'${v.replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

const MAX_STATEMENT_BYTES = 90_000;
const STATEMENTS_PER_BATCH = 50;
const MAX_BATCH_BYTES = 900_000;

/** Multi-row INSERTs with inlined literals: far fewer D1 calls than one bound statement per row. */
function insertStatements(d: Dataset, rows: Value[][]): string[] {
	const head = `INSERT OR REPLACE INTO ${d.table} (${d.columns.map((c) => c.name).join(", ")}) VALUES `;
	const out: string[] = [];
	let parts: string[] = [];
	let size = head.length;
	for (const r of rows) {
		const tuple = `(${r.map(literal).join(",")})`;
		if (parts.length && size + tuple.length + 1 > MAX_STATEMENT_BYTES) {
			out.push(head + parts.join(","));
			parts = [];
			size = head.length;
		}
		parts.push(tuple);
		size += tuple.length + 1;
	}
	if (parts.length) out.push(head + parts.join(","));
	return out;
}

async function sha256(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- sync

async function fetchCsv(d: Dataset, url: string, etag: string | null) {
	const get = () =>
		fetch(url, {
			headers: { accept: "text/csv,application/gzip,*/*", ...(etag ? { "if-none-match": etag } : {}) },
			cache: "no-store",
		});
	// GitHub release downloads occasionally return a transient 5xx: retry once before failing.
	let res = await get().catch(() => null);
	if (!res || res.status >= 500) {
		await new Promise((r) => setTimeout(r, 2000));
		res = await get();
	}
	if (res.status === 304) return { status: 304 as const };
	if (res.status === 404) return { status: 404 as const };
	if (!res.ok) throw new Error(`${d.id}: HTTP ${res.status} from ${new URL(url).hostname}`);
	const body: string | ArrayBuffer =
		d.format === "parquet"
			? await res.arrayBuffer()
			: d.gzip && res.body
				? await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text()
				: await res.text();
	return { status: 200 as const, body, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
}

export async function syncDataset(db: D1Database, d: Dataset, season: string, force = false): Promise<SyncResult> {
	const key = d.perSeason ? `${d.id}:${season}` : d.id;
	const now = new Date().toISOString();
	const state = await db
		.prepare("SELECT etag FROM nfl_sync WHERE key = ?")
		.bind(key)
		.first<{ etag: string | null }>();

	const res = await fetchCsv(d, d.url(season), force ? null : (state?.etag ?? null));
	if (res.status === 304) {
		await db.prepare("UPDATE nfl_sync SET checked_at = ? WHERE key = ?").bind(now, key).run();
		return { dataset: d.id, status: "unchanged" };
	}
	if (res.status === 404) {
		await db
			.prepare(
				"INSERT INTO nfl_sync (key, dataset, season, checked_at, note) VALUES (?, ?, ?, ?, 'not published yet') ON CONFLICT(key) DO UPDATE SET checked_at = excluded.checked_at, note = excluded.note",
			)
			.bind(key, d.id, season, now)
			.run();
		return { dataset: d.id, status: "missing" };
	}

	const rows = await extractAny(d, res.body, season);
	const chunkIdx = d.chunkBy.map((c) => d.columns.findIndex((x) => x.name === c));
	const pkIdx = d.primaryKey.map((c) => d.columns.findIndex((x) => x.name === c));
	const chunks = new Map<string, Value[][]>();
	for (const r of rows) {
		const k = JSON.stringify(chunkIdx.map((i) => r[i]));
		let list = chunks.get(k);
		if (!list) chunks.set(k, (list = []));
		list.push(r);
	}

	const existing = new Map(
		(
			await db
				.prepare("SELECT chunk, hash FROM nfl_chunk WHERE dataset = ?")
				.bind(key)
				.all<{ chunk: string; hash: string }>()
		).results.map((x) => [x.chunk, x.hash]),
	);

	// Per-season datasets only own chunks of their season.
	const ownsChunk = (chunk: string) => !d.perSeason || !d.chunkBy.includes("season") || JSON.parse(chunk)[d.chunkBy.indexOf("season")] == Number(season);

	let changed = 0;
	let written = 0;
	const writer = new BatchWriter(db);
	const deleteWhere = (chunk: string) => {
		const vals = JSON.parse(chunk) as Value[];
		return d.chunkBy.map((c, i) => `${c} = ${literal(vals[i] ?? null)}`).join(" AND ");
	};

	for (const [chunk, list] of chunks) {
		list.sort((a, b) => {
			const ka = pkIdx.map((i) => String(a[i])).join("|");
			const kb = pkIdx.map((i) => String(b[i])).join("|");
			return ka < kb ? -1 : ka > kb ? 1 : 0;
		});
		const hash = await sha256(list.map((r) => JSON.stringify(r)).join("\n"));
		if (!force && existing.get(chunk) === hash) continue;
		const stmts = [
			`DELETE FROM ${d.table} WHERE ${deleteWhere(chunk)}`,
			...insertStatements(d, list),
			`INSERT OR REPLACE INTO nfl_chunk (dataset, chunk, hash) VALUES (${literal(key)}, ${literal(chunk)}, '${hash}')`,
		];
		await writer.addChunk(stmts);
		changed++;
		written += list.length;
	}
	// Chunks that disappeared upstream (rare: a week re-labelled) are removed.
	for (const chunk of existing.keys()) {
		if (chunks.has(chunk) || !ownsChunk(chunk)) continue;
		await writer.addChunk([
			`DELETE FROM ${d.table} WHERE ${deleteWhere(chunk)}`,
			`DELETE FROM nfl_chunk WHERE dataset = ${literal(key)} AND chunk = ${literal(chunk)}`,
		]);
		changed++;
	}
	await writer.flush();

	await db
		.prepare(
			`INSERT INTO nfl_sync (key, dataset, season, etag, last_modified, checked_at, changed_at, rows, note)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
			 ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified,
			   checked_at = excluded.checked_at, changed_at = CASE WHEN ? > 0 THEN excluded.changed_at ELSE nfl_sync.changed_at END,
			   rows = excluded.rows, note = NULL`,
		)
		.bind(key, d.id, season, res.etag, res.lastModified, now, now, rows.length, changed)
		.run();
	return { dataset: d.id, status: "updated", rows: rows.length, chunks_changed: changed, rows_written: written };
}

/**
 * Packs whole chunks into D1 batches (each batch is a transaction), so a chunk's rows and
 * its hash land together. A chunk too big for one batch spans several, hash last, so an
 * interrupted chunk is simply rewritten next run.
 */
class BatchWriter {
	private pending: string[] = [];
	private pendingBytes = 0;
	constructor(private readonly db: D1Database) {}

	async addChunk(stmts: string[]): Promise<void> {
		const bytes = stmts.reduce((n, s) => n + s.length, 0);
		if (this.pending.length && (this.pending.length + stmts.length > STATEMENTS_PER_BATCH || this.pendingBytes + bytes > MAX_BATCH_BYTES)) {
			await this.flush();
		}
		if (stmts.length > STATEMENTS_PER_BATCH || bytes > MAX_BATCH_BYTES) {
			for (let i = 0; i < stmts.length; i += STATEMENTS_PER_BATCH) await this.run(stmts.slice(i, i + STATEMENTS_PER_BATCH));
			return;
		}
		this.pending.push(...stmts);
		this.pendingBytes += bytes;
	}

	async flush(): Promise<void> {
		if (!this.pending.length) return;
		const stmts = this.pending;
		this.pending = [];
		this.pendingBytes = 0;
		await this.run(stmts);
	}

	private async run(stmts: string[]): Promise<void> {
		await this.db.batch(stmts.map((s) => this.db.prepare(s)));
	}
}

/** Sync every dataset (sequentially, one failure doesn't stop the rest). */
export async function syncAll(db: D1Database, season: string, opts: { force?: boolean; only?: string[] } = {}): Promise<SyncResult[]> {
	await ensureSchema(db);
	const results: SyncResult[] = [];
	for (const d of DATASETS) {
		if (opts.only && !opts.only.includes(d.id)) continue;
		try {
			results.push(await syncDataset(db, d, season, opts.force));
			await db.prepare("DELETE FROM nfl_sync_errors WHERE dataset = ?").bind(d.id).run();
		} catch (e) {
			const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
			results.push({ dataset: d.id, status: "error", error });
			await db
				.prepare(
					`INSERT INTO nfl_sync_errors (dataset, error, failed_at, failures) VALUES (?, ?, ?, 1)
					 ON CONFLICT(dataset) DO UPDATE SET error = excluded.error, failed_at = excluded.failed_at, failures = nfl_sync_errors.failures + 1`,
				)
				.bind(d.id, error, new Date().toISOString())
				.run()
				.catch(() => {});
		}
	}
	return results;
}
