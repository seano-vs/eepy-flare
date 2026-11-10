# eepy-flare: Sleeper fantasy football MCP server

A remote [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that wraps the
public [Sleeper API](https://docs.sleeper.com/) for one league. It is built to be added to
claude.ai (web and mobile) as a **custom connector**, so it speaks **Streamable HTTP** on a
single `/mcp` endpoint.

Projections are Sleeper's, **re-scored with the league's own `scoring_settings`** (6-point
passing TDs, full PPR, and so on). Trade and hold value is measured as **value over replacement**,
using a replacement level computed from the league's starting slots. That makes superflex QB value
come out right without hand-tuned multipliers.

Projections, VOR, trade verdicts and dynasty values are still **Sleeper's estimates, not facts**.
The server says so to every client and points at the assumptions worth checking. See
[Projections are estimates](#projections-are-estimates).

## Tools

| Tool | What it returns |
| --- | --- |
| `get_league_settings` | Format, roster slots, playoff/waiver/trade settings (including trade review days) and a scoring summary |
| `get_rosters` | Every roster with owner, record, PF/PA, starters by slot, bench, IR and taxi |
| `get_my_roster` | Your roster with this week's projections, the projection-optimal lineup and suggested start/sit swaps |
| `get_matchup` | Your matchup (or any team's, or `team: "all"` for the scoreboard) with actual points and pregame projections |
| `get_transactions` | Trades, waivers and free-agent moves for a week |
| `get_traded_picks` | Draft picks that have changed hands |
| `get_trending_players` | Sleeper-wide trending adds and drops, filtered to players available in your league |
| `search_players` | Player lookup by name, team or position, showing who rosters each player |
| `project_player` | One player: this week's projection and key stats, rest-of-season points, VOR, season to date, bye and projected-out weeks, and what to verify |
| `compare_players` | 2–8 players side by side, for this week (start/sit) and rest of season |
| `evaluate_trade` | Rest-of-season points and VOR given versus received, plus the effect on both teams' best lineup this week. In dynasty leagues it also values draft picks and gives a long-term verdict |
| `get_player_usage` | Week-by-week usage for 1–6 players: snap share, targets, target and air-yards share, WOPR, carries, league-scored points versus expected points, and the current injury report |
| `get_opportunity_leaders` | Rank players by expected points or usage over recent weeks. `available_only` finds waiver targets; `buy_low` / `sell_high` find players scoring well below or above their usage |
| `get_injury_report` | Official injury report (game status and practice participation) for your roster, an NFL team, or another fantasy team |
| `get_nfl_schedule` | A week's games with kickoff, spread, total, implied team totals, scores, and which of your players are in each game |
| `get_nfl_data_status` | When each nflverse dataset was last checked and last changed, and any sync errors |
| `get_defense_vs_position` | Fantasy points each defense allows per game to QB/RB/WR/TE under league scoring, ranked |
| `get_faab_advice` | FAAB bid ranges from this league's own bidding history, matched by position and expected points, plus remaining budgets |
| `find_trades` | Searches every roster for 1-for-1 and 2-for-1 trades that improve your lineup and are fair on value. Options: `exclude`, `shop` one player, `window: "playoffs"`; partners are labeled contending or rebuilding |
| `get_playoff_odds` | Standings from actual results plus playoff and bye odds from 5,000 simulations of the remaining regular season, including your odds if you win or lose this week |
| `get_team_needs` | Per team: two biggest gaps vs the league median, best free-agent adds, weak slots, lineup holes in the next two weeks, QB coverage, FAAB left, positions chased (claims and free-agent adds) |
| `get_player_news` | Recent headlines for players (or your whole roster) from the feed the Sleeper app shows |
| `get_manager_profiles` | How each manager operates: trades and partners, adds by position (claims vs free agents), FAAB spent, top/median winning bid, losing bids, last move |
| `get_changes` | What changed since a time (`24h`, `3d`, ISO): headlines, tag / game status / practice changes and projection moves over 2 points (hourly snapshots), and transactions |

The nflverse-backed tools use [nflverse](#nflverse-data-d1) data, the same files the
[nflreadpy](https://pypi.org/project/nflreadpy/) and nflreadr packages download.

All output is compact JSON, and player IDs are always resolved to `Name POS TEAM (injury)`.
Any tool that takes a player accepts a name (`"Josh Allen"`, `"Allen BUF"`, `"St. Brown"`) or a
Sleeper ID.

## How it works

```
claude.ai ──POST /mcp──▶ Worker ──▶ createMcpHandler (stateless, MCP SDK v2)
                            │
                            ├── Sleeper API (edge-cached via cf.cacheTtl + per-isolate memo)
                            ├── KV PLAYERS: compact players map  ◀── daily cron refresh
                            ├── KV PLAYERS: league-scored weekly projection pool (6h TTL)
                            └── D1 NFL_DB: nflverse stats, snaps, injuries, xFP, schedule  ◀── hourly cron
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
- **Dynasty.** When Sleeper reports the league as dynasty (`settings.type = 2`), the valuation tools
  also return `dynasty_adp` and `dynasty_value`. These come from Sleeper's dynasty ADP: superflex
  ADP (`adp_dynasty_2qb`) in superflex leagues, otherwise 1QB PPR. The ADP is converted to a
  trade-chart value, where 10000 is the 1st overall pick and value roughly halves every 37 picks.
  `evaluate_trade` then gives two verdicts: `win_now` (rest-of-season VOR) and `long_term` (dynasty
  value). Dynasty value is additive, so it overrates trading one star for several depth pieces, and
  draft picks aren't valued. The ADP comes from the undocumented season-projections endpoint
  (about 3 MB), is cached in KV for 12 hours, and the dynasty fields are left out if it fails.

### nflverse data (D1)

nflreadpy downloads [nflverse](https://github.com/nflverse/nflverse-data) CSV and parquet files and
caches them on disk. Here the same files are mirrored into **D1** (Cloudflare's SQLite database),
reduced to fantasy-relevant columns and QB/RB/WR/TE:

| Table | Source | Upstream refresh |
| --- | --- | --- |
| `nfl_player_week` | `stats_player_week_{season}`: box scores, target share, air-yards share, WOPR, EPA | nightly after game days |
| `nfl_snaps` | `snap_counts_{season}` (PFR) | 4× a day |
| `nfl_injuries` | `injuries_{season}`: game status and practice participation | daily 07:00 UTC |
| `nfl_opportunity` | [ffopportunity](https://github.com/ffverse/ffopportunity) `ep_weekly_{season}`: expected stats | nightly |
| `nfl_games` | `schedules/games`: kickoff, scores, spread, total, moneylines | every 5 min |
| `nfl_pbp_week` | derived from `play_by_play_{season}.parquet`: red-zone targets/carries and team shares, end-zone and deep (20+ air yards) targets, carries inside the 10 and 5 | nightly after game days |
| `nfl_ngs_receiving` / `_rushing` / `_passing` | NFL Next Gen Stats, weekly: separation, cushion, aDOT, YAC over expected; rush yards over expected, 8-man boxes; CPOE, time to throw, aggressiveness | nightly |
| `nfl_ecr` | FantasyPros consensus rankings via DynastyProcess `db_fpecr_latest`: weekly superflex and positional, rest-of-season positional, dynasty superflex | weekly |
| `nfl_player_ids` | [DynastyProcess](https://github.com/dynastyprocess/data) `db_playerids`: Sleeper ↔ GSIS ↔ PFR ↔ FantasyPros ids | daily |

- **Failures.** A dataset that fails to sync (after one retry on a 5xx) keeps its last good data.
  The error is stored in `nfl_sync_errors` and reported by `get_nfl_data_status` until a sync
  succeeds.
- **Refresh.** A cron runs hourly at `:23`. Each file is fetched with its stored `ETag`, so an
  unchanged file returns `304` and costs one request and no parsing. A changed file is parsed with a
  column-selective CSV reader, and its rows are grouped into weeks and hashed. Only weeks whose hash
  changed are rewritten. Stat corrections (by Wednesday night) touch a week or two, so a normal
  update writes a few hundred rows, well inside D1's free 100,000 writes a day. The first sync
  writes about 17,000 rows.
- **Play-by-play.** The season's play-by-play is about 9 MB of Snappy-compressed Parquet with 372
  columns. [`hyparquet`](https://github.com/hyparam/hyparquet) (pure JS) reads just the 10 columns
  needed, and the plays are aggregated into one row per player-week before anything is stored. Raw
  plays aren't kept: the tools only need the aggregates, and a season of plays would be 50,000 rows
  of mostly unused columns. For ad-hoc SQL over full play-by-play history, the Parquet files could
  be registered as Iceberg tables in R2 and queried with Basin SQL, but that's analytics, not
  something a tool call should wait seconds for.
- **Existing tools use this data.** `get_my_roster`, `project_player`, `compare_players`,
  `evaluate_trade` and `get_trending_players` add FantasyPros consensus ranks, recent usage (snap %,
  targets, red-zone looks, points and expected points over the last 3 weeks) and the official injury
  report. `get_my_roster` also shows each player's team implied total. If D1 isn't configured or
  hasn't synced, these fields are simply left out.
- **Rankings freshness.** FantasyPros weekly ranks are hidden once a new NFL week has started
  (Tuesday) until the next scrape. Otherwise last week's ranks would read as this week's.
  Rest-of-season and dynasty ranks are always shown, with their date.
- **Schema.** Tables are created by the first sync, so no migrations need to run in the build.
  Changing a table definition bumps `SCHEMA_VERSION` in `src/nflverse/sync.ts`, and the next sync
  drops and rebuilds everything from upstream.
- **League scoring.** `pts` applies your league's `scoring_settings` to the nflverse box score.
  For week 8 it matched Sleeper's official points for 136 of 137 rostered players; the one
  difference was a stat Sleeper had and nflverse didn't. `xfp` re-scores ffopportunity's expected
  yards, receptions, touchdowns and two-pointers with the same rules, so it reflects 6-point passing
  TDs and any TE premium. Yardage-bucket bonuses can't be reproduced and are listed in the tool output.
- **IDs.** nflverse uses GSIS and PFR ids. The DynastyProcess map links about 99% of fantasy-relevant
  players to Sleeper ids. Unmapped players still appear in rankings under their nflverse name.
- **Licensing.** nflverse, ffopportunity and DynastyProcess data are CC-BY 4.0. Credit:
  nflverse (nflverse.com), ffverse, and DynastyProcess. Next Gen Stats come from the NFL and
  rankings from FantasyPros, both as republished by those projects.

### Advisors

Since 1.2:

- **News.** Sleeper's own per-player news feed (undocumented; the RotoWire, RotoBaller and
  FantasyPros blurbs the app shows). `get_my_roster` adds each player's latest headline from the
  last 72 hours, and the valuation tools add up to two from the last week. A 0 projection with
  fresh news quotes the headline.
- **Role changes.** Each player's last 3 weeks are compared with the rest of his season: snap share
  (±15 points), target share, carries and expected points (each ±30% and a minimum size). The
  check also flags when Sleeper's projection for this week is far from what recent usage supports.
  These show up as `role_change` on roster, valuation and trending output.
- **Projection track record.** `project_player`, `compare_players` and `evaluate_trade` show how
  Sleeper's weekly projections compared with the player's actual points in games played so far:
  average projected vs actual, bias % and average miss.
- **Playoff odds.** Records come from matchup results, which can be ahead of Sleeper's displayed
  record (`sleeper_record` appears when they differ). For each remaining regular-season week, a
  team's mean is its best projected lineup that week, where byes and projected absences count,
  blended 75/25 with its actual points per game. Scores are drawn from a normal distribution with
  sd = max(18, 17% of the mean), 5,000 runs with a fixed seed, seeded by wins then points for.
  `evaluate_trade` re-runs this with both rosters swapped and shows playoff odds before and after.
- **Waivers.** `get_league_settings` adds `waiver_schedule`, built from when this league's claims
  actually completed. Times are read in Pacific (Sleeper's `daily_waivers_hour` is Pacific, so
  UTC drifts with daylight saving) and shown in Eastern: `main_run` is the run that processes the
  most claims (here "Wednesday ~10:06 AM ET"). `get_faab_advice` and trending adds mark each player
  as `on waivers` (dropped within the clear window, with who dropped him and when he clears, in ET)
  or `free agent` (add now, no bid).
- **Byes.** Byes come from the NFL schedule, so a week when the team plays but Sleeper projects the
  player for nothing is `projected_out`, not a bye.
- **Freshness.** `get_nfl_data_status` also reports the players-cache, projection and ADP fetch
  times, the FantasyPros rankings date, and which teams haven't posted this week's injury report.
  `get_my_roster` lists those teams for your players and stamps `fetched_at`.

- **FAAB bids.** Every waiver claim in the league is read from Sleeper's transactions, including
  losing bids. For each claimed player, the server computes expected points per game (league
  scoring) over the 3 weeks before the claim. A target's bid range comes from the closest
  same-position claims by expected points: low, likely and aggressive at the 25th, 50th and 75th
  percentile, with aggressive also clearing the best losing bid seen. With fewer than two close
  comparables, it places the player within the position's whole claim history instead. Without a
  player, it ranks the best available targets, skipping anyone out or on IR. Targets are ranked
  on a 50/50 blend of this week's projection and recent expected points, then re-ranked by
  headlines from the last 4 days: a benching or demotion cuts the score to 35%, a promotion raises
  it to the higher of the two.
- **What he's worth to you.** Next to the market range, each target gets `value_to_you`:
  `your_max` = his average weekly gain to your best lineup (next 4 weeks) × weeks counted
  (regular-season weeks left + playoff weeks × your playoff odds) × the league's going rate
  (median winning bid per expected point over replacement per remaining week), capped at your
  remaining budget minus a reserve (5% per week left, 10–40%). Bids are also shown as a share of
  your remaining budget, with a warning above 20%. `likely_rival_bidders` lists teams that can
  afford the likely bid and would start him. With a full roster, `suggested_drop` is the player
  whose loss costs your lineup least, never an untouchable. If the market pays more than
  `your_max`, let it.
- **Trade finder.** Player value is the average of the next 3 weeks' Sleeper projections under
  league scoring, so byes and current roles count. For every other roster it tries each 1-for-1
  and 2-for-1 swap, recomputes both teams' best starting lineups week by week, and keeps trades
  that improve yours, cost theirs at most a point a week, and are within 20% on value. In dynasty
  leagues, value blends rest-of-season VOR with dynasty market value according to `focus`.
  Projections for players flagged as taking a bigger role are discounted toward their recent
  expected points until the usage shows up. Partners are labeled contending (>60% playoff odds),
  bubble (20–60%) or rebuilding (<20%), and how much lineup loss they'll accept depends on it.
- **Preferences.** `UNTOUCHABLES` (comma-separated names) are never offered in trades or suggested
  as drops; `DEFAULT_TRADE_FOCUS` (`win_now`, `balanced` or `long_term`) is the default `focus`.
  Both are vars in `wrangler.jsonc`, so every client and scheduled scan gets them. With win_now,
  `compare_players` and `evaluate_trade` leave out dynasty ADP and values (pass `focus` to see
  them; trades with picks always show them), and giving an untouchable adds a warning.
- **Injury reports.** nflverse mirrors the official report a few times a day, so a team missing
  from it may already have posted: `get_my_roster` (`injury_reports_not_in_nflverse`) and
  `get_injury_report` (`not_in_nflverse_yet`) name those teams and add practice participation
  (DNP / Limited / Full, with the day) read from the last 3 days of headlines.
- **Team needs.** `get_team_needs` gives each team's two biggest gaps vs the league median at a
  starting slot, the two free agents who'd add most to its lineup this week, and its team name.
- **Search.** `search_players` hides players with no NFL team (unsigned or retired) unless
  they're on a roster here, `team` is `FA`, or `include_teamless` is set.
- **Verify notes.** One note per gap in the projection (a bye doesn't split a gap): the current
  gap names the injury and projected return; a later gap with no listed reason (an old benching
  or injury assumption) gets its own note. `get_matchup` quotes a fresh headline for a starter
  projected 0.

Since 1.5:

- **Lock timeline.** `get_my_roster` adds `lock_timeline` for the current week: starters grouped
  by kickoff (ET), and for each starter at risk (game-time tag, play rate under 90%, or projected
  0) up to three bench or free-agent options at an eligible position whose games start later.
- **Play probability.** `play_pct` on Questionable/Doubtful players: the chance he plays, from
  base rates measured on nflverse 2016–2025 in this project's Nov 4 analysis (74% overall; 50%
  after a DNP last practice, 75% Limited, 92% Full; QBs 55%; Doubtful ~10%). The rates are
  constants in `playProbability` rather than a backfilled table. Before the final report it uses
  Sleeper's tag and the latest practice, marked preliminary.
- **Implied total vs norm.** `implied_vs_norm` = this week's Vegas implied total minus the team's
  average this season. In the same analysis, +3 or more added about 0.7 points and −3 or less
  cost about 1.0; opponent history and home/away splits didn't predict.
- **Weather.** `get_nfl_schedule` adds an Open-Meteo forecast (free, no key) for each upcoming
  outdoor game at the home stadium, for the 3 hours from kickoff: temperature, wind, gusts and
  precipitation, flagged for high wind, rain/snow and cold. Domes and covered stadiums say
  indoors; retractable roofs carry a note; neutral-site games (from nflverse's `location`) are
  skipped. `get_my_roster` shows a player's weather only when it's flagged.
- **Players cache.** Adds Sleeper's depth chart slot (`depth`: RB1, QB2, or LWR/RWR/SWR + order),
  `injured_since` and `active`. `search_players` also hides players DynastyProcess lists as free
  agents who are on no depth chart, since Sleeper keeps some retired players on a team.
- **Snapshots.** After each hourly nflverse sync, the Worker stores every rostered player's
  injury tag, game status, practice status and projection in KV (`snap:<hour>`, 14 days) for
  `get_changes`.
- **Role flags.** `role_change` now holds usage trends only, with injury-shortened games (under
  60% of his median snap share) left out of the baseline. Projection mismatches moved to
  `projection_check`, which cites the injury report when that explains the gap.
- **News.** Items reporting the same event within 12 hours (same practice status, ruling or role
  change, or mostly the same words) are merged; the other outlets are listed in `also`.
- **Transactions.** `get_transactions` takes `since`/`until`, which search across weeks, so one
  waiver run isn't split between two week lists.
- **Data status.** `get_nfl_data_status` warns when the FantasyPros scrape is more than 7 days
  old. As of Nov 5 the upstream DynastyProcess file is stuck at Oct 30.
- **Byes.** `get_player_usage` shows bye weeks and missed weeks as rows; `get_nfl_schedule` with a
  team on bye says so.
- **Schema changes.** When one dataset's columns change, only that table is rebuilt.

Since 1.6:

- **Freshness stamps.** Every response that uses estimates or mirrored data has an `as_of` block:
  when each source it used was last updated, in Eastern time with its age, and `- stale` past a
  limit (injury tags 30h, projections 3h, lines 48h, FantasyPros 7 days, ADP 24h, weather 3h).
  It covers the players cache, projections, ADP, nflverse stats, Vegas lines, FantasyPros,
  weather, and the injury report per team in the response. nflverse's report file has no
  per-row time, so the hourly cron logs when each team's report for the week reached the mirror
  and when it last changed (KV `reports:<season>`). "In mirror by" means the report was already
  there when tracking began.
- **Absolute times on items.** News lines read `Title (rotowire +fantasy_pros, Wed, Nov 4, 9:14 PM
  ET, 12h ago)`, so a report read later still dates correctly; `get_player_news` items carry
  `published_et`. Practice status read from headlines carries its publish time too.
- **Derived numbers name their basis.** `play_basis` says which designation, practice and report
  week a `play_pct` came from, or that it's preliminary.
- `injury_tags_as_of`, `projections_fetched_at` and `fetched_at` are replaced by `as_of`.
- **RotoBaller times (1.6.1).** Sleeper's feed stores RotoBaller's Eastern wall-clock time as if it
  were UTC, so those items read 4–5 hours early (a Week 8 recap stamped 11:31 AM ET on game day).
  They're reinterpreted as New York time, unless that would put them in the future.
- **Dynasty value (1.7.1).** `dynasty_value` blends two superflex sources on the same
  rank-to-value curve: FantasyPros' superflex dynasty consensus rank (experts, from the nflverse
  mirror) and Sleeper's superflex dynasty ADP (the draft market), weighted 80/20 toward
  FantasyPros in-season and 50/50 in the offseason. Sleeper's ADP comes from drafts, so in-season
  it tracks preseason redraft ADP (r = 0.92) and lags breakouts and injuries (Purdy 47.6 vs
  FantasyPros 15; Omarion Hampton 20.9 vs 72 at 9 ppg). It also runs low on QBs across the board
  (Mahomes 37 vs 14): QBs average 838 value points below FantasyPros, RBs 626 above.
- **League format (1.8.1).** The market rankings assume full PPR, 4-pt passing TDs and no TE premium
  or first-down points. For each position, eepy scores this season's games (nflverse, players
  with 4+ games) under the league's rules and under that standard, and compares the starters'
  average points above replacement. Replacement is the average of the 8 players after the
  league's starter count. A single replacement player made the result depend on one player's TD
  mix: QB came out anywhere from x1.12 to x1.46 week to week and x1.40 one starter later. The band
  held x1.23-1.25 over weeks 7-9 and within 0.02 for starters +/- 2. Fewer than 3 players after the
  starters means no adjustment. In this league QBs get x1.248 through week 9; RB/WR/TE stay x1.
  `dynasty_value` is the adjusted value, `dynasty_market_value` the raw blend, `format_multiplier`
  the ratio, and `format_adjustment` in `compare_players` / `evaluate_trade` shows the inputs.
- **Injury history (1.9).** Each injury becomes an episode, rebuilt from public weekly nflverse
  data: the official report, weekly rosters (injured reserve) and snap counts, 2013 onward (2012
  has no snap counts). The report alone misses most absences, because a player placed on IR
  drops off it: Justin Jefferson in 2023 played 71% of snaps in week 5, had no report rows in
  weeks 6-9, and was listed Questionable in weeks 10-12. So a **missed** episode is a run of his
  team's games without his snaps, preceded by games he played, with an injury on a report inside
  the run or the week before, or on injured reserve (R01/R04/R48; with no report row the body part
  is `undisclosed`, as with Derrick Henry's 2021 foot). A game just before it under 75% of his usual
  snaps is where he got hurt. **Played-through** episodes are weeks listed with a game status in
  which he played. Only regulars count (median snap share 40%+); fullbacks are excluded.
  `get_injury_history` lists a player's episodes. For a currently injured player, the roster,
  injury report and valuation rows add `injury_outlook`, with base rates for that injury at his
  position (falling back to all positions under 30 episodes):
  - chance to play when Questionable, by last practice;
  - games missed and the chance he's back within 1/2/4 games (Kaplan-Meier, with season-ending
    episodes censored);
  - first-game-back snap share against his usual;
  - re-aggravation within 8 weeks;
  - his own past episodes, and severity words in the latest headline ("week-to-week", "MCL",
    "placed on injured reserve").
  A separate hourly run at :41 loads one season at a time and rebuilds the current season
  every 6 hours. It has its own run because sharing the :23 nflverse sync, a second season got the
  run killed (production stopped at 2019 with 2020 unfinished).
  Files are read one at a time, keeping skill positions as they're parsed (the Worker has 128 MB),
  except snap counts: their position labels vary ("HB", "RB/W", "WR/R" in 2020), so filtering them
  would drop players like Joe Mixon. Each season's attempt is recorded before it starts. One that
  never finishes shows in `as_of.injury_history_problems`, and is skipped after 2 attempts.
- **1.9.1 fixes.** Outlooks read the mirrored report's `report_injury` / `practice_injury`
  columns. 1.9.0 used nflverse's raw names, so only Sleeper-tagged players got an outlook. Sleeper's
  current body part now comes before the week's report, which predates that week's game. The
  report-change log hashes the same corrected columns.
- **How the injury numbers were checked.** The episodes were compared against public record
  (Jefferson, Kupp, Burrow, Rodgers and Chase in 2022-23, McCaffrey 2021, Henry 2021, Barkley
  2020). A separate Python implementation reproduced the listing outcomes row for row from the
  raw CSVs, and the rates (Kaplan-Meier, medians, ratios) exactly. The Worker's D1 rows match the
  offline run for 2021-2023 exactly. `test/injuries.test.ts` pins all of this on real-data
  fixtures, and deliberate mutations of the thresholds, the return-game rule, the Kaplan-Meier
  risk set and the fullback rules fail it. Knee listings come out at 52% / 72% / 92% play after
  DNP / Limited / Full, in line with an independent 2016-2025 study (50 / 75 / 92).
- **CSV parser fix.** A quoted field spanning lines made `parseCsvColumns` return every column in
  file order, or (past the last wanted column) emit a blank row. Historical nflverse injury files
  have such fields; this season's files don't, so live data wasn't affected. The parser now
  matches Python's `csv` module exactly on 12 full nflverse files.
- **Game-start waiver hold (1.10).** Sleeper holds every player on waivers from his team's
  kickoff until the next main run (Wednesday ~10:06 AM ET here). In that window he can only be
  claimed with FAAB, not added for $0. This league's transactions through week 10 confirm it: none
  of 70 completed free-agent adds came between a player's kickoff and the next Wednesday run, and
  every Wednesday add came after the run. `waiverStatuses` combines this hold with the drop clear
  window and reports the later release time. Players whose team hasn't kicked off this week, is on
  bye, or who have no team stay free agents. `get_faab_advice`, trending adds, `search_players`
  (`league_status`), `get_team_needs` (`best_available_adds`, renamed from `best_free_agent_adds`)
  and `get_opportunity_leaders` all show either "free agent: add now" or "on waivers until …
  (claim)". Lock-timeline pivots only list players who are free agents right now.
  `test/waivers.test.ts` replays the league's real adds against the rule.
- **New starters in FAAB pricing (1.11).** When a target's latest headline reports that he starts
  ("set to start", "named the starter", "set to take over as QB1"; not "could start"), but Sleeper
  projects him under 80% of his team's previous starter at the position, or not at all, he's
  priced at that previous starter's projection from the most recent projected week. That price
  feeds `value_to_you` and the market bid, and shows as `priced_as_starter` with the headline.
  Example: Carson Beck, Nov 10, priced at Gardner Minshew's 12.4. With no usage history yet, the
  market bid is matched to past claims at that price or at this week's projection, instead of
  returning no bid. FAAB value now starts from the next week to be played. Sleeper's
  `display_week` stays on the finished week until Wednesday, so on Mondays and Tuesdays eepy was
  pricing waiver targets against a week already played.
- **Checking the multipliers.** `node scripts/verify-format.mjs --through 9 --band 8` recomputes
  them with no shared code, from Sleeper's weekly stats and from nflverse's raw CSV, prints how
  they move with the starter count, and exits 1 on `--expect QB=1.248` mismatches.
  `test/format.test.ts` pins the server's results on a fixture of real 2026 QB weeks to the values
  that script computes from the same file, plus hand-computed cases.
  Either source alone is used when only one ranks a player, and FantasyPros is dropped when its
  scrape is more than 7 days old. `dynasty_sources` shows both; rookie values for draft picks
  use the same blend.
- **Draft picks.** A pick is valued at the current dynasty value of this year's rookie drafted at
  that overall slot, minus 10% for each extra year out. Without an explicit slot, the slot comes
  from the original owner's standing (worst record picks first). `traded_picks` determines who owns
  each pick, and the tool warns when the side giving a pick doesn't own it.
- **Matchups.** `get_my_roster` shows each player's opponent and that defense's rank in points
  allowed to his position this season.

## Projections are estimates

Sleeper's projections lag the news, and some of them assume changes nobody has announced. In real
use they have projected a return date for a player with no public timeline, projected a starting
QB out after his bye with no injury or announced benching, treated the best case of a 6–10 week
surgery timeline as the plan, and kept projecting a tight end above his replacements after his
snap share fell from 83% to 53%. A model that repeats those numbers as fact gives bad advice with
full confidence, so the server is explicit about what to trust:

- **Authoritative:** rosters, lineups, scores, transactions and league settings.
- **Estimates:** projections, VOR, out and return weeks, injury tags, optimal lineups, trade verdicts
  and dynasty values.

How that shows up in the tools:

- **Server instructions** tell every client to attribute projections to Sleeper, check current news
  before recommending a move, and explain any zero, drop or return date it relies on.
- **`verify`** on each valued player (`project_player`, `compare_players`, `evaluate_trade`) lists
  the projection assumptions worth checking: weeks projected out with no injury or status listed,
  a projected return (treat it as the earliest case), a Questionable player projected for zero or an
  Out player still projected to play, and rest-of-season ppg at least 25% away from actual ppg
  (after 4+ games). It's omitted when nothing stands out.
- **`bye_weeks` and `projected_out_weeks`** replace `out_or_bye_weeks`, so an assumed benching no
  longer looks like a bye. Byes are the weeks Sleeper's per-player projections return as `null`.
- **`get_matchup`** reports `projected_pregame`. It sums pregame projections, so a player whose game
  is over still counts at his projection rather than his actual points, and the total isn't a live
  score.
- **`injury_tags_as_of`** shows when the players cache, and so every injury tag, was last refreshed.
  The cron runs once a day, so Friday's injury report can be missing until the next morning.
- **`trade_review_days`** in `get_league_settings` says how long an accepted trade waits before it
  processes, when Sleeper reports it. It's read defensively, because the docs don't list the
  league settings keys.

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

Then create the D1 database for nflverse data, and paste its `database_id` in place of
`REPLACE_WITH_NFL_D1_ID`:

```sh
npx wrangler d1 create eepy-flare-nfl
```

In the dashboard, this is **Storage & Databases → D1 SQL Database → Create**. You don't need to run
any SQL, because the first hourly sync creates the tables. Locally, trigger it with
`curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=23+*+*+*+*"` under
`npx wrangler dev --test-scheduled`.

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

Your server is now at `https://eepy-flare.<your-subdomain>.workers.dev/mcp`. The cron triggers in
`wrangler.jsonc` are deployed along with the Worker. You can check them in the dashboard under
**Workers → eepy-flare → Settings → Triggers**.

#### Or deploy from GitHub (Workers Builds)

This repo is deployed by Cloudflare's Git integration: **Workers & Pages → Create → Import a
repository**, Worker name `eepy-flare` (it must match `name` in `wrangler.jsonc`), production
branch `main`, no build command, deploy command `npx wrangler deploy`. Every push to `main`
deploys; other branches get preview builds.

- Set secrets (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`) in the
  Worker's **Settings → Variables and Secrets** as type **Secret**. They persist across deploys.
  Plain variables live in `wrangler.jsonc`; dashboard edits to them are overwritten on deploy.
- If a build fails binding the D1 database with a permissions error, add **D1 Edit** to the
  build's API token (**My Profile → API Tokens**).
- The nflverse tables fill on the first hourly sync after deploy (at `:23`).

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

## Setup

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
3. **Check the vars** in `wrangler.jsonc`. This repo is already set to:
   ```jsonc
   "AUTH_MODE": "github",
   "ALLOWED_GITHUB_USERS": "seano-vs,64788907"   // comma-separated logins and/or numeric user ids
   ```
   An empty allowlist lets nobody in. A numeric ID still matches after a username change.
   For authless local testing, put `AUTH_MODE="none"` in `.dev.vars`.
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
- **CPU.** Tool calls do little work. The heavier steps are parsing the 15 MB players dump in the
  daily cron, the 2 MB weekly projection pool (at most every 6 hours), and parsing an nflverse file
  when it changes. That's about 100 ms for play-by-play and 200 ms if every file changed at once;
  unchanged files cost nothing. On the
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
npm test                 # vitest: scoring, replacement level, lineup optimizer, name resolution, allowlist, CSV/nflverse, verify notes, advisors
```

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Worker entry: `/mcp`, `/health`, the cron handler, and the auth mode switch |
| `src/auth.ts` | Phase 2 OAuth provider, consent page and GitHub login |
| `src/auth-config.ts` | `AUTH_MODE` and the GitHub allowlist check |
| `src/tools.ts` | MCP server factory and all tool definitions |
| `src/league.ts` | League context: config, rosters, owners, team lookup |
| `src/scoring.ts` | League scoring, projections parsing, replacement level, VOR, lineup optimizer |
| `src/verify.ts` | The `verify` notes: projection assumptions worth checking against current news |
| `src/players.ts` | KV players cache: load, refresh, search and resolve |
| `src/compact-players.ts` | Dump compaction, shared with `scripts/seed-players.mjs` |
| `src/sleeper.ts` | Sleeper API client and types |
| `src/nfl-tools.ts` | Tools backed by nflverse data |
| `src/nflverse/datasets.ts` | Which nflverse files, columns and rows are mirrored |
| `src/nflverse/sync.ts` | Hourly sync into D1: conditional downloads, per-week hashing, batched writes |
| `src/nflverse/csv.ts` | CSV parsing, including the column-selective fast path |
| `src/nflverse/stats.ts` | League-scored actual and expected points, and D1 queries |
| `src/nflverse/context.ts` | Compact per-player context (usage, rankings, injuries) used by the existing tools |
| `src/result.ts` | Shared tool-result helpers |
| `src/advisor.ts` | FAAB advice, trade finder and draft-pick valuation |
| `src/league-tools.ts` | Playoff odds, team needs and player news tools |
| `src/playoffs.ts` | Standings from matchups and the playoff simulation |
| `src/waivers.ts` | Waiver schedule inference and per-player waiver status |
| `src/news.ts` | Sleeper per-player news feed |
| `src/verify.ts` | Verify notes on valued players (from PR #1) |
| `.github/workflows/ci.yml` | CI: `wrangler types --check`, typecheck, tests, dry-run build |
