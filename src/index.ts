import { localhostAllowedOrigins } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { authMode, oauthProviderFor } from "./auth";
import { refreshPlayers } from "./players";
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

	// Daily cron: refresh the players cache (Sleeper asks for at most one /players/nfl fetch per day).
	async scheduled(_controller, env, ctx): Promise<void> {
		ctx.waitUntil(
			refreshPlayers(env.PLAYERS).then(
				(r) => console.log(`players cache refreshed: ${r.count} players at ${r.updated}`),
				(e) => {
					console.error("players cache refresh failed", e);
					throw e;
				},
			),
		);
	},
} satisfies ExportedHandler<Env>;

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
		...(hosts.length ? { allowedHostnames: hosts } : {}),
		allowedOriginHostnames: [...origins],
	};
}
