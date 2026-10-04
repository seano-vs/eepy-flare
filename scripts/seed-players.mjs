// Fill the PLAYERS KV cache from your machine instead of waiting for the cron.
// Useful right after the first deploy, or on the Workers free plan where the
// in-Worker refresh of a ~15 MB JSON can exceed the CPU limit.
//
//   npm run seed-players            # writes to the deployed (remote) KV namespace
//   npm run seed-players -- --local # writes to wrangler dev's local KV
//
// Fetches /players/nfl once (Sleeper asks for at most once per day).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYERS_KV_KEY, compactPlayers } from "../src/compact-players.ts";

const local = process.argv.includes("--local");

console.log("Fetching https://api.sleeper.app/v1/players/nfl ...");
const res = await fetch("https://api.sleeper.app/v1/players/nfl", { headers: { accept: "application/json" } });
if (!res.ok) throw new Error(`Sleeper returned ${res.status}`);
const blob = compactPlayers(await res.json());
if (blob.count < 500) throw new Error(`Only ${blob.count} fantasy players in the dump; refusing to write.`);

const file = join(mkdtempSync(join(tmpdir(), "players-")), "players.json");
writeFileSync(file, JSON.stringify(blob));
console.log(`Compacted to ${blob.count} players. Writing ${PLAYERS_KV_KEY} to ${local ? "local" : "remote"} KV ...`);

execFileSync(
	"npx",
	["wrangler", "kv", "key", "put", PLAYERS_KV_KEY, "--path", file, "--binding", "PLAYERS", local ? "--local" : "--remote"],
	{ stdio: "inherit" },
);
console.log("Done.");
