// Calls every tool against a running server and prints a short summary.
// Usage: node scripts/smoke.mjs [url]                      # all tools
//        node scripts/smoke.mjs [url] <tool> ['{"json":1}'] # one tool, full output
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = new URL(process.argv[2] ?? "http://localhost:8787/mcp");
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(url));

if (process.argv[3]) {
	const res = await client.callTool({ name: process.argv[3], arguments: JSON.parse(process.argv[4] ?? "{}") });
	console.log(res.content?.[0]?.text);
	await client.close();
	process.exit(res.isError ? 1 : 0);
}

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

const calls = [
	["get_league_settings", {}],
	["get_rosters", {}],
	["get_my_roster", {}],
	["get_matchup", {}],
	["get_matchup", { team: "all" }],
	["get_matchup", { week: 1 }],
	["get_transactions", { week: 1 }],
	["get_traded_picks", {}],
	["get_trending_players", { kind: "both", limit: 5 }],
	["search_players", { name: "allen" }],
	["search_players", { position: "QB", available_only: true, limit: 5 }],
	["project_player", { player: "Josh Allen", include_weekly: true }],
	["compare_players", { players: ["Bijan Robinson", "Jahmyr Gibbs", "Lamar Jackson"] }],
	["evaluate_trade", { give: [process.env.GIVE ?? "Josh Allen"], get: [process.env.GET ?? "Ja'Marr Chase"] }],
];

let failed = 0;
for (const [name, args] of calls) {
	const t0 = Date.now();
	const res = await client.callTool({ name, arguments: args });
	const text = res.content?.[0]?.text ?? "";
	if (res.isError) failed++;
	console.log(`\n### ${name} ${JSON.stringify(args)} ${res.isError ? "ERROR" : "ok"} ${Date.now() - t0}ms ${text.length}B`);
	console.log(process.env.FULL ? text : text.slice(0, 700));
}
await client.close();
process.exit(failed ? 1 : 0);
