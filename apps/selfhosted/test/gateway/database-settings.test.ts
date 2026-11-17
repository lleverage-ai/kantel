// The gateway's Postgres timeouts as settings (main.ts): read from the environment, refused when malformed, and passed
// through by the Compose stack. Their effect on a real Postgres is in durable.stack.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectionSettings, DATABASE_TIMEOUTS } from "../../src/gateway/durable.ts";
import { databaseTimeouts, durableConfig } from "../../src/gateway/main.ts";

describe("the gateway's Postgres timeouts", () => {
	it("keeps the defaults for settings left unset or empty, and takes the ones set", () => {
		expect(databaseTimeouts({})).toEqual({});
		expect(databaseTimeouts({ KANTEL_DATABASE_CONNECT_TIMEOUT_MS: " " })).toEqual({});
		expect(
			databaseTimeouts({
				KANTEL_DATABASE_CONNECT_TIMEOUT_MS: "2000",
				KANTEL_DATABASE_STATEMENT_TIMEOUT_MS: "0",
				KANTEL_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "120000",
				KANTEL_DATABASE_KEEPALIVE_MS: "5000",
			}),
		).toEqual({ connectMs: 2_000, statementMs: 0, idleInTransactionMs: 120_000, keepAliveMs: 5_000 });
		expect(
			durableConfig({ KANTEL_DATABASE_URL: "postgres://u@db/kantel", KANTEL_DATABASE_STATEMENT_TIMEOUT_MS: "45000" }),
		).toEqual({ databaseUrl: "postgres://u@db/kantel", schema: "harbour_m1", timeouts: { statementMs: 45_000 } });
	});

	it("refuses a value that isn't a whole number of milliseconds", () => {
		for (const value of ["5s", "-1", "1.5", "99999999999"]) {
			expect(() => databaseTimeouts({ KANTEL_DATABASE_STATEMENT_TIMEOUT_MS: value })).toThrow(
				"KANTEL_DATABASE_STATEMENT_TIMEOUT_MS must be a whole number of milliseconds",
			);
		}
	});

	it("turns each off at 0: no statement or answer limit, no keepalive", () => {
		const settings = connectionSettings("postgres://u@db/kantel", "harbour_m1", {
			...DATABASE_TIMEOUTS,
			statementMs: 0,
			keepAliveMs: 0,
		});
		expect(settings.query_timeout).toBeUndefined();
		expect(settings.keepAlive).toBe(false);
		expect(settings.options).toBe(
			"-c statement_timeout=0 -c idle_in_transaction_session_timeout=30000 -c search_path=harbour_m1",
		);
	});

	it("puts the URL's own options after the defaults, so they win, and the search path last", () => {
		const settings = connectionSettings(
			"postgres://u@db/kantel?options=-c%20statement_timeout%3D90000",
			"harbour_m1",
			DATABASE_TIMEOUTS,
		);
		expect(settings.options).toBe(
			"-c statement_timeout=30000 -c idle_in_transaction_session_timeout=30000 -c statement_timeout=90000 -c search_path=harbour_m1",
		);
	});

	it("is given every setting by the Compose stack, the defaults unless set", () => {
		const compose = readFileSync(new URL("../../../../deploy/compose/compose.yaml", import.meta.url), "utf8");
		for (const name of [
			"KANTEL_DATABASE_CONNECT_TIMEOUT_MS",
			"KANTEL_DATABASE_STATEMENT_TIMEOUT_MS",
			"KANTEL_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS",
			"KANTEL_DATABASE_KEEPALIVE_MS",
		]) {
			expect(compose).toContain(`${name}: \${${name}:-}`);
		}
	});
});
