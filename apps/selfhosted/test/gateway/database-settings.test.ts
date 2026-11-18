// The gateway's Postgres timeouts as settings (main.ts): read from the environment, refused when malformed, and passed
// through by the Compose stack. Their effect on a real Postgres is in durable.stack.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectionSettings, DATABASE_TIMEOUTS, settingMs } from "../../src/gateway/durable.ts";
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

	it("gives up on an answer 5 s after the statement timeout the connection ends up with, the URL's when it sets one", () => {
		const answerMs = (url: string, statementMs = DATABASE_TIMEOUTS.statementMs) =>
			connectionSettings(url, "harbour_m1", { ...DATABASE_TIMEOUTS, statementMs }).query_timeout;
		expect(answerMs("postgres://u@db/kantel")).toBe(35_000);
		expect(answerMs("postgres://u@db/kantel", 2_000)).toBe(7_000);
		expect(answerMs("postgres://u@db/kantel", 0)).toBeUndefined();
		// Raised, in units, or turned off in the URL's options: the last one wins, as in Postgres.
		expect(answerMs("postgres://u@db/kantel?options=-c%20statement_timeout%3D90000")).toBe(95_000);
		expect(answerMs("postgres://u@db/kantel?options=-c%20statement_timeout%3D2min")).toBe(125_000);
		expect(answerMs("postgres://u@db/kantel?options=--statement_timeout%3D90s")).toBe(95_000);
		expect(answerMs("postgres://u@db/kantel?options=-c%20statement_timeout%3D0")).toBeUndefined();
		expect(
			answerMs("postgres://u@db/kantel?options=-c%20statement_timeout%3D0%20-c%20statement_timeout%3D10s", 0),
		).toBe(15_000);
		// Its own query parameter, which Postgres applies after `options`.
		expect(answerMs("postgres://u@db/kantel?statement_timeout=60000")).toBe(65_000);
		expect(answerMs("postgres://u@db/kantel?statement_timeout=0")).toBeUndefined();
		// One it can't read: no client limit, rather than a wrong one.
		expect(answerMs("postgres://u@db/kantel?options=-c%20statement_timeout%3Dlots")).toBeUndefined();
		// The migrations' connections have none.
		expect(
			connectionSettings("postgres://u@db/kantel", "harbour_m1", DATABASE_TIMEOUTS, { statements: false })
				.query_timeout,
		).toBeUndefined();
		expect([settingMs("250"), settingMs("1.5s"), settingMs("'2 min'"), settingMs("1h"), settingMs("5 weeks")]).toEqual([
			250,
			1_500,
			120_000,
			3_600_000,
			undefined,
		]);
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
