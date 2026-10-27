// Pi Durable's own storage conformance suite, run against the Postgres adapter.
// Needs a disposable Postgres: HARBOUR_DATABASE_URL (the compose stack
// publishes one on 127.0.0.1:55432). Each case gets a fresh schema; they are
// left behind and go away with the database volume.
import { describe, expect, it } from "bun:test";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { openPostgresStorage } from "../src/pi-postgres.ts";

const url = process.env.HARBOUR_DATABASE_URL ?? "postgres://harbour:harbour@127.0.0.1:55432/harbour";
const run = `${Date.now().toString(36)}_${process.pid}`;
let counter = 0;

registerStorageConformance({ describe, expect, it }, "Pi Durable storage on Postgres", async (use) => {
	const storage = await openPostgresStorage({ connectionString: url, schema: `pi_conformance_${run}_${counter++}` });
	try {
		await use(storage);
	} finally {
		try {
			await storage.close({} as never);
		} catch {}
	}
});
