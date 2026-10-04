import { localhostAllowedOrigins } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { refreshPlayers } from "./players";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./tools";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/mcp") {
			// Stateless Streamable HTTP: a fresh MCP server per request, no Durable Object.
			return createMcpHandler(() => createServer(env), mcpOptions(env, url))(request, env, ctx);
		}
		if (url.pathname === "/" || url.pathname === "/health") {
			return Response.json({ name: SERVER_NAME, version: SERVER_VERSION, mcp: `${url.origin}/mcp` });
		}
		return new Response("Not found", { status: 404 });
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
