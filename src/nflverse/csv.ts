// Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF), enough for
// nflverse files. Returns the header and rows as string arrays.

export function parseCsv(text: string): { header: string[]; rows: string[][] } {
	// Fast path: split lines and fields with native split(), which is far cheaper than a
	// character loop, then rejoin fields that contained quoted commas. A quoted field
	// spanning lines (odd number of quotes on a line) sends the whole file to the full parser.
	const lines = text.split(/\r?\n/);
	const rows: string[][] = [];
	for (const line of lines) {
		if (line === "") continue;
		if (!line.includes('"')) {
			rows.push(line.split(","));
			continue;
		}
		const fields = splitQuotedLine(line);
		if (!fields) return parseFull(text);
		rows.push(fields);
	}
	const header = rows.shift() ?? [];
	return { header, rows };
}

/** Split one line containing quotes; null if a quoted field continues on the next line. */
function splitQuotedLine(line: string): string[] | null {
	const parts = line.split(",");
	const out: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		let p = parts[i]!;
		if (p.charCodeAt(0) !== 34) {
			out.push(p);
			continue;
		}
		// Quoted: keep joining until the quotes balance.
		while (countQuotes(p) % 2 === 1) {
			if (++i >= parts.length) return null;
			p += "," + parts[i];
		}
		out.push(p.slice(1, p.lastIndexOf('"')).replace(/""/g, '"'));
	}
	return out;
}

function countQuotes(s: string): number {
	let n = 0;
	for (let i = s.indexOf('"'); i !== -1; i = s.indexOf('"', i + 1)) n++;
	return n;
}

function parseFull(text: string): { header: string[]; rows: string[][] } {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let i = 0;
	const n = text.length;
	let inQuotes = false;
	while (i < n) {
		const c = text.charCodeAt(i);
		if (inQuotes) {
			if (c === 34 /* " */) {
				if (text.charCodeAt(i + 1) === 34) {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			// Copy a run of ordinary characters at once.
			const next = text.indexOf('"', i);
			const end = next === -1 ? n : next;
			field += text.slice(i, end);
			i = end;
			continue;
		}
		if (c === 34) {
			inQuotes = true;
			i++;
		} else if (c === 44 /* , */) {
			row.push(field);
			field = "";
			i++;
		} else if (c === 10 /* \n */ || c === 13 /* \r */) {
			row.push(field);
			field = "";
			if (row.length > 1 || row[0] !== "") rows.push(row);
			row = [];
			i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
		} else {
			// Fast path: copy up to the next delimiter.
			let j = i + 1;
			while (j < n) {
				const d = text.charCodeAt(j);
				if (d === 44 || d === 10 || d === 13 || d === 34) break;
				j++;
			}
			field += text.slice(i, j);
			i = j;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	const header = rows.shift() ?? [];
	return { header, rows };
}

/**
 * Extract only some columns: walks each line with indexOf() and allocates strings for
 * the wanted fields alone. nflverse files have 100+ columns and we keep a third of
 * them, so this is several times cheaper than materialising every field.
 * Returns rows with values in `wanted` order ("" for columns absent from the header).
 */
export function parseCsvColumns(
	text: string,
	wanted: string[],
	/** Skip a line as soon as this column's value fails the test (before reading later columns). */
	prefilter?: { column: string; accept: (value: string) => boolean },
): { header: string[]; rows: string[][] } {
	const nl = text.indexOf("\n");
	const headerLine = (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, "");
	const header = splitQuotedLine(headerLine) ?? headerLine.split(",");
	const col = new Map(header.map((h, i) => [h, i]));
	const targets = wanted.map((w) => col.get(w) ?? -1);
	const order = [...new Set(targets.filter((t) => t >= 0))].sort((a, b) => a - b);
	const last = order.length ? order[order.length - 1]! : -1;
	const filterCol = prefilter ? (col.get(prefilter.column) ?? -1) : -1;
	const rows: string[][] = [];
	let pos = nl === -1 ? text.length : nl + 1;
	const n = text.length;
	const found = new Map<number, string>();
	while (pos < n) {
		let end = text.indexOf("\n", pos);
		if (end === -1) end = n;
		let lineEnd = end;
		if (lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) lineEnd--;
		if (lineEnd > pos) {
			found.clear();
			let skip = false;
			let field = 0;
			let p = pos;
			let k = 0;
			while (p <= lineEnd && field <= last) {
				let value: string;
				let next: number;
				if (text.charCodeAt(p) === 34) {
					// Quoted field: find the closing quote (doubled quotes are escapes).
					let q = p + 1;
					for (;;) {
						q = text.indexOf('"', q);
						if (q === -1 || q >= lineEnd) return parseFull(text); // spans lines: give up on the fast path
						if (text.charCodeAt(q + 1) === 34) q += 2;
						else break;
					}
					value = field === order[k] ? text.slice(p + 1, q).replace(/""/g, '"') : "";
					next = q + 1; // at the comma (or line end)
				} else {
					const c = text.indexOf(",", p);
					next = c === -1 || c > lineEnd ? lineEnd : c;
					value = field === order[k] ? text.slice(p, next) : "";
				}
				if (field === order[k]) {
					found.set(field, value);
					k++;
				}
				if (field === filterCol) {
					const v = field === order[k - 1] ? value : text.slice(p, next).replace(/^"|"$/g, "");
					if (!prefilter!.accept(v)) {
						skip = true;
						break;
					}
				}
				field++;
				p = next + 1;
			}
			if (!skip) rows.push(targets.map((t) => (t >= 0 ? (found.get(t) ?? "") : "")));
		}
		pos = end + 1;
	}
	return { header, rows };
}
