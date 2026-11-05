# Sunday lineup check (routine)

A scheduled Claude routine that checks the lineup before kickoff using the Sleeper MCP connector
and pushes a notification only when something needs changing.

- **Schedule:** Sundays at 8:51 and 11:51 AM Eastern (`CRON_TZ=America/New_York 51 8,11 * * 0`).
  The first run is before the 9:30 international games; the second is after the 90-minute
  inactive lists, before the 1:00 games.
- **Connector:** Sleeper MCP (`https://eepy.seance.sh/mcp`). This must be attached to the routine,
  so create or edit it in claude.ai's Routines UI. Routines created from a coding session can't
  carry connectors.
- **Notifications:** push.

## Prompt

```
Check my Sleeper fantasy lineup before today's NFL kickoffs, using the Sleeper MCP connector tools. Do not change anything (the tools are read-only); just report.

1. Call get_my_roster. For each starter, look at: injury_report and the injury tag in the player name (Out, Doubtful, IR, Suspended), vs = "BYE", proj of 0 or null, and def_rank (1 = best matchup, 32 = worst).
2. Call get_injury_report for the latest official game statuses (Out/Doubtful/Questionable) and practice participation, and get_player_news with players ["roster"] and days 2 for anything announced after the reports (rulings, inactives, role news). Trust a dated headline over a stale tag or projection.
3. A starter needs attention if he is Out, Doubtful, on IR, suspended, on bye, projected 0, or carries a verify note or a role_change flag that says his projection assumes a bigger role than he's had. For each one, recommend the best bench replacement that is eligible for that slot (superflex accepts QB/RB/WR/TE; FLEX accepts RB/WR/TE), using proj first, then recent usage (snap_pct, targets, rz_opps, xfp) and def_rank as tie-breakers. Also flag a Questionable starter when a bench player at an eligible slot projects within 2 points of him.
4. If the roster's suggested.start / suggested.sit fields recommend swaps, include them with a one-line reason.
5. If no eligible bench player exists for an empty slot, run get_faab_advice for that position and name the best available free agent (note that only players already through waivers can be added before kickoff).

If the Sleeper MCP tools are not available in this session, say exactly that in one line and stop.

Output: if nothing needs changing, reply exactly "No lineup changes needed." Otherwise give a short list: "Start X over Y (reason)", most urgent first, plus any free-agent pickup. Keep it under 120 words.
```
