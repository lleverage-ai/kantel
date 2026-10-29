// `Workspaces.read`'s `maxBytes`: a file over it is refused (`refused`, with the sizes), and the stored workspaces refuse
// it from the tree's size, before the body is fetched.
import { type CallContext, HarbourError } from "@harbour/contracts";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@harbour/workspace/stored";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;
const files = { "small.txt": "1234", "big.txt": "x".repeat(32) };

async function refusal(read: Promise<unknown>): Promise<HarbourError | undefined> {
	try {
		await read;
		return undefined;
	} catch (error) {
		if (error instanceof HarbourError) return error;
		throw error;
	}
}

describe("Workspaces.read with maxBytes", () => {
	it("stored: refuses a larger file before fetching its body, and reads one within it", async () => {
		let bodyReads = 0;
		const inner = createMemoryWorkspaceStore();
		const store = {
			...inner,
			getObject: async (key: string) => {
				if (key.includes("/blobs/")) bodyReads++;
				return inner.getObject(key);
			},
		};
		const workspaces = createStoredWorkspaces({ store });
		const record = await workspaces.create(ctx, { owner, seed: { name: "s", sources: [{ kind: "files", files }] } });
		bodyReads = 0;
		const refused = await refusal(workspaces.read(ctx, record.id, "big.txt", { maxBytes: 16 }));
		expect(refused?.code).toBe("refused");
		expect(refused?.details).toEqual({ path: "big.txt", maxBytes: 16, bytes: 32 });
		expect(bodyReads).toBe(0);
		const read = await workspaces.read(ctx, record.id, "small.txt", { maxBytes: 16 });
		expect(new TextDecoder().decode(read.content)).toBe("1234");
		// No limit, no refusal.
		expect((await workspaces.read(ctx, record.id, "big.txt")).content.byteLength).toBe(32);
	});

	it("memory: refuses a larger file", async () => {
		const workspaces = createMemoryWorkspaces();
		const record = await workspaces.create(ctx, { owner, seed: { name: "s", sources: [{ kind: "files", files }] } });
		expect((await refusal(workspaces.read(ctx, record.id, "big.txt", { maxBytes: 31 })))?.code).toBe("refused");
		expect((await workspaces.read(ctx, record.id, "big.txt", { maxBytes: 32 })).content.byteLength).toBe(32);
	});
});
