import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { chainVectors, sessionVector, vectorFiles } from "./vectors.ts";

const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

// The Go host checks itself against these files (apps/host/internal/e2e); this keeps them what the TypeScript makes.
// After a deliberate change: node packages/e2e/test/vectors.ts --write && pnpm biome format --write packages/e2e/vectors
describe("cross-language vectors", () => {
	it("vectors/chain.json is what the TypeScript verifier says", async () => {
		expect(await read(vectorFiles.chain)).toEqual(plain(await chainVectors()));
	});

	it("vectors/session.json is the session the TypeScript device and host have", async () => {
		expect(await read(vectorFiles.session)).toEqual(plain(await sessionVector()));
	});

	it("covers what the gateway must not be able to do", async () => {
		const { cases } = await chainVectors();
		const verdict = (prefix: string) => cases.find((c) => c.name.startsWith(prefix))?.ok;
		expect(verdict("an organisation")).toBe(true);
		expect(verdict("the gateway adds a device of its own")).toBe(false);
		expect(verdict("the gateway adds a device, claiming")).toBe(false);
		expect(verdict("the gateway, holding a ticket but not its seed")).toBe(false);
		expect(verdict("the gateway sends another space's genesis")).toBe(false);
		expect(verdict("a fork")).toBe(false);
		expect(verdict("a rollback")).toBe(true);
		expect(verdict("a member adds a member")).toBe(false);
		expect(verdict("the admin removes a member")).toBe(true);
	});
});
