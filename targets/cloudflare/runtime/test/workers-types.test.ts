import type { DurableObjectStorage } from "@cloudflare/workers-types/index.ts";
import { describe, expect, it } from "vitest";
import type { SessionRuntimeDurableObjectCoreOptions } from "../src/index.ts";

describe("the minimal storage shapes", () => {
	it("are satisfied by a Durable Object's ctx.storage (checked by the typecheck)", () => {
		const fits = (storage: DurableObjectStorage) => {
			const options: Pick<SessionRuntimeDurableObjectCoreOptions, "sql" | "transaction" | "setAlarm" | "getAlarm"> = {
				sql: storage.sql,
				transaction: (work) => storage.transaction(() => work()),
				setAlarm: (at) => storage.setAlarm(at),
				getAlarm: () => storage.getAlarm(),
			};
			return options;
		};
		expect(typeof fits).toBe("function");
	});
});
