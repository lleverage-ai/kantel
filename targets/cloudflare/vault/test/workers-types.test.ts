import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types/index.ts";
import { describe, expect, it } from "vitest";
import type { SqlStorageLike, VaultDurableObjectCoreOptions } from "../src/index.ts";

describe("the minimal SQL shape", () => {
	it("is satisfied by a Durable Object's ctx.storage.sql and transactionSync (checked by the typecheck)", () => {
		const fits = (storage: DurableObjectStorage, sql: SqlStorage) => {
			const shape: SqlStorageLike = sql;
			const transactionSync: VaultDurableObjectCoreOptions["transactionSync"] = (work) => storage.transactionSync(work);
			return [shape, transactionSync];
		};
		expect(typeof fits).toBe("function");
	});
});
