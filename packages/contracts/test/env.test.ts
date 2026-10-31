// The KANTEL_* → HARBOUR_* fallback (TASK-4231): an environment set before the rename keeps working.

import { describe, expect, it } from "vitest";
import { applyKantelEnv, legacyEnvAliases, withKantelEnv } from "../src/env.ts";

describe("withKantelEnv", () => {
	it("fills in an unset KANTEL_* from its HARBOUR_* name", () => {
		const env: Record<string, unknown> = withKantelEnv({
			HARBOUR_HOSTNAME: "harbour.myslop.app",
			HARBOUR_VAULT_KEY: "k",
		});
		expect(env.KANTEL_HOSTNAME).toBe("harbour.myslop.app");
		expect(env.KANTEL_VAULT_KEY).toBe("k");
		expect(env.HARBOUR_HOSTNAME).toBe("harbour.myslop.app");
	});

	it("lets the new name win, even when it is empty", () => {
		const env = withKantelEnv({
			HARBOUR_CODEMODE: "on",
			KANTEL_CODEMODE: "off",
			HARBOUR_USAGE: "on",
			KANTEL_USAGE: "",
		});
		expect(env.KANTEL_CODEMODE).toBe("off");
		expect(env.KANTEL_USAGE).toBe("");
	});

	it("returns the same object when nothing needs filling in, keeping bindings as they are", () => {
		const binding = { get: () => undefined };
		const env = { STACK: binding, KANTEL_HOSTNAME: "x", HARBOUR_HOSTNAME: "y" };
		expect(withKantelEnv(env)).toBe(env);
		const filled = withKantelEnv({ STACK: binding, HARBOUR_HOSTNAME: "y" });
		expect(filled.STACK).toBe(binding);
	});

	it("passes non-string values through (Worker bindings named HARBOUR_*)", () => {
		const binding = { fetch: () => undefined };
		const env: Record<string, unknown> = withKantelEnv({ HARBOUR_THING: binding });
		expect(env.KANTEL_THING).toBe(binding);
	});

	it("ignores names that only contain the old prefix", () => {
		expect(legacyEnvAliases({ VITE_HARBOUR_SOURCE: "api", HARBOUR_: "x" })).toEqual({ KANTEL_: "x" });
	});
});

describe("applyKantelEnv", () => {
	it("fills process.env-like records in place", () => {
		const env: Record<string, string | undefined> = {
			HARBOUR_DATABASE_URL: "postgres://h",
			KANTEL_SMTP_URL: "smtp://k",
		};
		applyKantelEnv(env);
		expect(env).toEqual({
			HARBOUR_DATABASE_URL: "postgres://h",
			KANTEL_DATABASE_URL: "postgres://h",
			KANTEL_SMTP_URL: "smtp://k",
		});
	});
});
