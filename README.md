# eepy-flare: Sleeper fantasy football MCP server

A remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that wraps the
public [Sleeper API](https://docs.sleeper.com/) for one league. It is built to be added to
claude.ai (web and mobile) as a **custom connector**, so it speaks **Streamable HTTP** on a
single `/mcp` endpoint.

Projections are Sleeper's, **re-scored with the league's own `scoring_settings`** (6-point
passing TDs, full PPR, and so on). Trade and hold value is measured as **value over replacement**,
using a replacement level computed from the league's starting slots. That makes superflex QB value
come out right without hand-tuned multipliers.

## Tools

| Tool | What it returns |
| --- | --- |
| `get_league_settings` | Format, roster slots, playoff/waiver/trade settings and a scoring summary |
| `get_rosters` | Every roster with owner, record, PF/PA, starters by slot, bench, IR and taxi |
| `get_my_roster` | Your roster with this week's projections, the projection-optimal lineup and suggested start/sit swaps |
| `get_matchup` | Your matchup (or any team's, or `team: "all"` for the scoreboard) with actual and projected points |
| `get_transactions` | Trades, waivers and free-agent moves for a week |
| `get_traded_picks` | Draft picks that have changed hands |
| `get_trending_players` | Sleeper-wide trending adds and drops, filtered to players available in your league |
| `search_players` | Player lookup by name, team or position, showing who rosters each player |
| `project_player` | One player: this week's projection and key stats, rest-of-season points, VOR and season to date |
| `compare_players` | 2–8 players side by side, for this week (start/sit) and rest of season |
| `evaluate_trade` | Rest-of-season points and VOR given versus received, plus the effect on both teams' best lineup this week |

All output is compact JSON, and player IDs are always resolved to `Name POS TEAM (injury)`.
Any tool that takes a player accepts a name (`"Josh Allen"`, `"Allen BUF"`, `"St. Brown"`) or a
Sleeper ID.

## How it works

```
claude.ai ──POST /mcp──▶ Worker ──▶ createMcpHandler (stateless, MCP SDK v2)
                            │
                            ├── Sleeper API (edge-cached via cf.cacheTtl + per-isolate memo)
                            ├── KV PLAYERS: compact players map  ◀── daily cron refresh
                            └── KV PLAYERS: league-scored weekly projection pool (6h TTL)
```

- **Transport.** The server uses `createMcpHandler` from `agents/mcp/server` together with
  `@modelcontextprotocol/server@2`. Cloudflare's docs now mark `McpAgent` as deprecated and
  feature-frozen, and recommend this handler for new servers. It is stateless, creating one MCP
  server per request, so **no Durable Object is needed**. It accepts both the current and the
  older ("legacy") Streamable HTTP clients. `GET /mcp` returns `405`, which the spec allows for
  servers without a standalone SSE stream.
- **Players cache.** `/players/nfl` is about 15 MB, and Sleeper asks that it be fetched at most once
  a day. The cron (`17 9 * * *` UTC) fetches it, keeps only QB/RB/WR/TE/K/DEF, compacts each player
  to a tuple, and writes one KV value of about 400 KB. Tools only read KV and never dump the map.
  If KV is empty on a fresh deploy, the first tool call bootstraps it once. A KV marker keeps that
  bootstrap to once a day.
- **Projections.** Sleeper's projection and stats endpoints are **undocumented**, so every response
  is shape-checked. If an endpoint fails or changes shape, tools still answer and report
  `"projection": "unavailable"` instead of erroring. The endpoints used are:
  - `api.sleeper.app/projections/nfl/{season}/{week}?season_type=regular&position[]=QB…`: every
    player for one week, about 2 MB. It is reduced to `[id, pos, leaguePts, opp]` and cached in KV
    for 6 hours.
  - `api.sleeper.com/projections/nfl/player/{id}?season=…&grouping=week`: one player for every week.
    Bye weeks come back as `null`.
  - `api.sleeper.com/stats/nfl/player/{id}?season=…&grouping=week`: actual stats, used for season
    to date.
- **Scoring.** `points = Σ scoring_settings[stat] × stat`. Run on actual stats, this matches
  Sleeper's own `players_points` to the hundredth.
- **VOR and superflex.** Using the current week's projected pool, every team's slots are filled
  league-wide: dedicated QB/RB/WR/TE slots first, then `WRRB_FLEX`, `REC_FLEX`, `FLEX` and
  `SUPER_FLEX`, each taking the best player left. A position's replacement level is its best
  non-starter. In a 12-team superflex league about 24 QBs start, so replacement-level QB is roughly
  QB25, and QBs carry their real trade value. Rest-of-season runs from the current week through the
  league's last playoff week.

## Setup

You need Node 20+ and a Cloudflare account. The Workers free plan is enough to serve tools; see
[plan limits](#plan-limits) for the daily refresh.

```sh
npm install
npx wrangler login
```

### 1. Find your league and user IDs

- **League ID:** the number in your league's URL, `https://sleeper.com/leagues/<LEAGUE_ID>/…`.
- **User ID:** run `curl https://api.sleeper.app/v1/user/<your_username>` and take `user_id`.

### 2. Create the KV namespaces

```sh
npx wrangler kv namespace create PLAYERS
npx wrangler kv namespace create OAUTH_KV    # only used in phase 2, but the binding must exist
```

Paste each returned `id` into `wrangler.jsonc`, replacing `REPLACE_WITH_PLAYERS_KV_ID` and
`REPLACE_WITH_OAUTH_KV_ID`. Answer **no** if Wrangler offers to add the bindings for you, because
they're already in the file.

### 3. Set the vars

In `wrangler.jsonc`:

```jsonc
"vars": {
  "SLEEPER_LEAGUE_ID": "1234567890",
  "SLEEPER_USER_ID": "987654321",
  "ALLOWED_HOSTNAMES": ""   // only for a custom domain, e.g. "sleeper.example.com"
}
```

Both IDs are public, so they're plain vars, not secrets. For local dev you can override them in
`.dev.vars` (gitignored):

```sh
SLEEPER_LEAGUE_ID="1234567890"
SLEEPER_USER_ID="987654321"
```

After changing `wrangler.jsonc`, run `npm run cf-typegen` to regenerate `worker-configuration.d.ts`.

### 4. Run locally

```sh
npm run dev                         # http://localhost:8787/mcp
npm run seed-players -- --local     # fill local KV (or let the first tool call do it)
node scripts/smoke.mjs              # call every tool once
```

To trigger the cron locally instead, run `npx wrangler dev --test-scheduled` and then
`curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+9+*+*+*"`.

#### MCP Inspector

```sh
npx @modelcontextprotocol/inspector@latest
# Transport: Streamable HTTP, URL: http://localhost:8787/mcp, then Connect → List Tools
```

To skip the UI, use the CLI mode:

```sh
npx @modelcontextprotocol/inspector@latest --cli http://localhost:8787/mcp --transport http --method tools/list
npx @modelcontextprotocol/inspector@latest --cli http://localhost:8787/mcp --transport http \
  --method tools/call --tool-name project_player --tool-arg player="Josh Allen"
```

### 5. Deploy

```sh
npm run deploy
npm run seed-players          # optional: fill the remote KV now instead of on first use
```

Your server is now at `https://eepy-flare.<your-subdomain>.workers.dev/mcp`. The cron trigger in
`wrangler.jsonc` is deployed along with the Worker. You can check it in the dashboard under
**Workers → eepy-flare → Settings → Triggers**.

### 6. Add it to claude.ai

In claude.ai, open **Settings → Connectors → Add custom connector** and paste
`https://eepy-flare.<your-subdomain>.workers.dev/mcp`. The connector syncs to the mobile apps.

Phase 1 is authless because all Sleeper data is public. Anyone with the URL can read your league
through the server, but nothing can be changed. Phase 2 below puts a login in front of it.

## Phase 2: OAuth 2.1 with GitHub login

When `AUTH_MODE` is `"github"`, the Worker becomes its own OAuth 2.1 authorization server, built on
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider), and
`/mcp` requires a bearer token. claude.ai can't send a static header, so it runs the standard MCP
auth flow:

1. `POST /mcp` without a token returns `401` with
   `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
2. claude.ai reads the protected resource metadata (RFC 9728), then
   `/.well-known/oauth-authorization-server` (RFC 8414).
3. claude.ai registers itself, through dynamic client registration at `/register` (RFC 7591) or a
   Client ID Metadata Document, and starts `/authorize` with PKCE S256.
4. You see a consent page showing the client's name and where tokens will go. Click **Allow**.
5. You sign in with GitHub. The callback accepts only accounts listed in `ALLOWED_GITHUB_USERS`;
   anyone else is sent back with `access_denied`.
6. claude.ai exchanges the code at `/token` for a 1-hour access token and a refresh token. The
   allowlist is checked again on every `/mcp` call, so removing someone takes effect immediately.

The GitHub token is used once to read your login and is never stored. CSRF protection, browser-bound
one-time `state`, frame blocking and escaping on the consent page all come from the library's
consent and upstream helpers.

### Setup

1. **Create two GitHub OAuth apps** at <https://github.com/settings/developers> (**OAuth Apps → New**):
   - Local: homepage `http://localhost:8787`, callback `http://localhost:8787/callback`
   - Production: homepage `https://eepy-flare.<subdomain>.workers.dev`, callback
     `https://eepy-flare.<subdomain>.workers.dev/callback`
2. **Set the secrets** for production:
   ```sh
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put COOKIE_ENCRYPTION_KEY   # e.g. `openssl rand -hex 32`; remembers consent for 30 days
   ```
   For local dev, put the same three names in `.dev.vars`, using the local app's ID and secret.
3. **Set the vars** in `wrangler.jsonc`:
   ```jsonc
   "AUTH_MODE": "github",
   "ALLOWED_GITHUB_USERS": "your-github-login"   // comma-separated logins and/or numeric user ids
   ```
   An empty allowlist lets nobody in. A numeric ID still matches after a username change.
4. Run `npm run deploy`. In claude.ai, remove the old connector and add the same `/mcp` URL again.
   claude.ai detects that the server needs auth and opens the login.

To switch back to authless, set `AUTH_MODE` to `"none"`. If you use GitHub Enterprise Server, set
`GITHUB_URL` and `GITHUB_API_URL` as secrets.

To test locally, run `npm run dev` with the phase 2 values in `.dev.vars`. In MCP Inspector, open
**Auth Settings → Quick OAuth Flow** and connect to `http://localhost:8787/mcp`.

## Plan limits

- **Requests to Sleeper.** League endpoints are cached for 30 seconds to 5 minutes, and projections
  for 30 minutes, at the edge and in memory. Normal use stays far below Sleeper's limit of
  1000 requests per minute.
- **CPU.** Tool calls do little work. The two heavier steps are parsing the 15 MB players dump in
  the cron and the 2 MB weekly projection pool, which happens at most every 6 hours. On the
  **Workers Paid** plan both fit comfortably. On the free plan (10 ms CPU), the cron refresh may hit
  the CPU limit. If it does, run `npm run seed-players` from your machine once a day, or whenever
  rosters change a lot. It does the parsing locally and only uploads the compact blob.

## Custom domain

The handler validates `Host` and `Origin` headers to protect against DNS rebinding.
`*.workers.dev` and localhost work out of the box, and requests from claude.ai are accepted. If you
serve `/mcp` from a custom domain, add it to `ALLOWED_HOSTNAMES`.

## Development

```sh
npm run typecheck
npm test                 # vitest: scoring, replacement level, lineup optimizer, name resolution, allowlist
```

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Worker entry: `/mcp`, `/health`, the cron handler, and the auth mode switch |
| `src/auth.ts` | Phase 2 OAuth provider, consent page and GitHub login |
| `src/auth-config.ts` | `AUTH_MODE` and the GitHub allowlist check |
| `src/tools.ts` | MCP server factory and all tool definitions |
| `src/league.ts` | League context: config, rosters, owners, team lookup |
| `src/scoring.ts` | League scoring, projections parsing, replacement level, VOR, lineup optimizer |
| `src/players.ts` | KV players cache: load, refresh, search and resolve |
| `src/compact-players.ts` | Dump compaction, shared with `scripts/seed-players.mjs` |
| `src/sleeper.ts` | Sleeper API client and types |
