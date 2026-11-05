// Shared helpers for tool results.

import type { Player, PlayerRef } from "./players";

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function ok(data: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function fail(err: unknown): ToolResult {
	const message = err instanceof Error ? err.message : String(err);
	return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** "Josh Allen QB BUF (Questionable)" — the compact form used in every list. */
export function fmt(p: PlayerRef | Player): string {
	if (p.id === "0") return "(empty)";
	return `${p.name} ${p.pos} ${p.team ?? "FA"}${p.injury ? ` (${p.injury})` : ""}`;
}
