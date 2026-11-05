import { localhostAllowedHostnames, localhostAllowedOrigins } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { authMode, oauthProviderFor } from "./auth";
import { syncAll } from "./nflverse/sync";
import { refreshPlayers } from "./players";
import { sleeper } from "./sleeper";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./tools";

// Stateless Streamable HTTP: a fresh MCP server per request, no Durable Object.
function mcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	return createMcpHandler(() => createServer(env), mcpOptions(env, new URL(request.url)))(request, env, ctx);
}

function site(request: Request, env: Env): Response {
	const url = new URL(request.url);
	if (url.pathname === "/" || url.pathname === "/health") {
		return Response.json({ name: SERVER_NAME, version: SERVER_VERSION, mcp: `${url.origin}/mcp`, auth: authMode(env) });
	}
	return new Response("Not found", { status: 404 });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (authMode(env) === "github") {
			// Phase 2: OAuth 2.1 (GitHub login, allowlisted) in front of /mcp.
			return oauthProviderFor(new URL(request.url).origin, mcp, site).fetch(request, env, ctx);
		}
		if (new URL(request.url).pathname === "/mcp") return mcp(request, env, ctx);
		return site(request, env);
	},

	async scheduled(controller, env, ctx): Promise<void> {
		if (controller.cron === PLAYERS_CRON) {
			// Daily: Sleeper asks for at most one /players/nfl fetch per day.
			ctx.waitUntil(
				refreshPlayers(env.PLAYERS).then(
					(r) => console.log(`players cache refreshed: ${r.count} players at ${r.updated}`),
					(e) => {
						console.error("players cache refresh failed", e);
						throw e;
					},
				),
			);
			return;
		}
		// Hourly: mirror nflverse datasets into D1 (only changed files are downloaded).
		ctx.waitUntil(syncNflverse(env));
	},
} satisfies ExportedHandler<Env>;

/** Must match the first cron in wrangler.jsonc. */
const PLAYERS_CRON = "17 9 * * *";

async function syncNflverse(env: Env): Promise<void> {
	if (!env.NFL_DB) {
		console.warn("nflverse sync skipped: NFL_DB binding not configured");
		return;
	}
	const state = await sleeper.state();
	const results = await syncAll(env.NFL_DB, state.league_season ?? state.season);
	for (const r of results) {
		if (r.status === "error") console.error(`nflverse ${r.dataset}: ${r.error}`);
		else if (r.status === "updated") console.log(`nflverse ${r.dataset}: ${r.rows} rows, ${r.chunks_changed} chunks rewritten (${r.rows_written} rows)`);
	}
	if (results.some((r) => r.status === "error")) throw new Error("nflverse sync had errors");
}

// Browser-based MCP clients we accept an Origin header from, in addition to
// localhost (MCP Inspector) and this Worker's own hostname.
const TRUSTED_CLIENT_ORIGINS = ["claude.ai", "claude.com"];

/**
 * Host/Origin checks (DNS-rebinding protection). workers.dev and localhost work
 * out of the box; a custom domain must be listed in ALLOWED_HOSTNAMES.
 */
function mcpOptions(env: Env, url: URL) {
	const hosts = (env.ALLOWED_HOSTNAMES ?? "")
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean);
	const origins = new Set([...localhostAllowedOrigins(), ...TRUSTED_CLIENT_ORIGINS, ...hosts]);
	if (url.hostname.endsWith(".workers.dev")) origins.add(url.hostname);
	return {
		// Cloudflare only routes this Worker's own hostnames here, so also accepting localhost
		// keeps `wrangler dev` working without weakening the deployed check.
		...(hosts.length ? { allowedHostnames: [...hosts, ...localhostAllowedHostnames()] } : {}),
		allowedOriginHostnames: [...origins],
	};
}
