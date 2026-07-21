import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";

const [lockPath, readyPath] = process.argv.slice(2);

if (!lockPath || !readyPath) {
	throw new Error("memory lock holder received incomplete arguments");
}

const database = new Database(lockPath, { create: false, strict: true });
database.exec("PRAGMA busy_timeout = 0");
database.exec("BEGIN IMMEDIATE");
await writeFile(readyPath, "locked", "utf8");

for (;;) {
	// Keep the SQLite wrapper live so GC cannot close the connection and roll
	// back the transaction while this fixture is deliberately idle.
	database.query("SELECT 1").get();
	await Bun.sleep(60_000);
}
