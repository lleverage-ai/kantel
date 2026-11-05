// Tunnel tickets: only one the relay issued, for one sandbox's port, until it expires and for an hour at most;
// anything else, guessed, altered, expired or malformed, is refused. The store keeps the secret half's hash, never the
// secret, and every gateway over the same store (or the same one after a restart) accepts the ticket.
import { testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRelayStore, createSqlRelayStore, migrateRelay, type RelayStore } from "../src/relay-store.ts";
import { createTunnelTickets, MAX_TUNNEL_MINUTES, sha256Hex } from "../src/tunnel.ts";

const now = 1_800_000_000_000;
const grant = { sandboxId: "sbx_4kq9x2mt", port: 22, expiresAt: now + 10 * 60_000 };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function behaves(open: () => Promise<RelayStore>) {
	it("replace an exposure by its label, or with ifAbsent only add one where none is, leaving one there as it is", async () => {
		const store = await open();
		const manual = {
			label: "3000-brave-otter-ab12cd",
			sandboxId: "sbx_4kq9x2mt",
			port: 3000,
			tokenHash: "a".repeat(64),
			createdAt: now,
			grantee: JSON.stringify({ kind: "person", userId: "usr_ann" }),
		};
		// A copy as a fork makes it: public, by someone else.
		const { tokenHash: _gate, ...ungated } = manual;
		const copied = { ...ungated, createdAt: now + 1, grantee: "{}" };
		expect(await store.putExposure(manual)).toBe(true);
		expect(await store.putExposure(copied, { ifAbsent: true })).toBe(false);
		expect(await store.getExposure(manual.label)).toEqual(manual);
		// Where none is, it is added; a plain put still replaces it.
		const publicOther = { ...copied, label: "8080-brave-otter-ab12cd", port: 8080 };
		const other = publicOther;
		expect(await store.putExposure(publicOther, { ifAbsent: true })).toBe(true);
		expect(await store.getExposure(other.label)).toEqual(publicOther);
		expect(await store.putExposure({ ...publicOther, tokenHash: "b".repeat(64) })).toBe(true);
		expect((await store.getExposure(other.label))?.tokenHash).toBe("b".repeat(64));
	});

	it("carry their grant until it expires", async () => {
		const tickets = createTunnelTickets(await open(), () => now);
		const ticket = await tickets.issue(grant);
		const expected = { ...grant, ticketId: ticket.split(".")[0] };
		expect(await tickets.verify(ticket, now)).toEqual(expected);
		expect(await tickets.verify(ticket, grant.expiresAt - 1)).toEqual(expected);
		expect(await tickets.verify(ticket, grant.expiresAt)).toBeUndefined();
		expect(await tickets.verify(ticket, grant.expiresAt + 60_000)).toBeUndefined();
	});

	it("carry who they were given to", async () => {
		const tickets = createTunnelTickets(await open(), () => now);
		const grantee = JSON.stringify({ kind: "key", keyId: "key_1" });
		const ticket = await tickets.issue({ ...grant, grantee });
		expect((await tickets.verify(ticket, now))?.grantee).toBe(grantee);
	});

	it("keep only the secret half's hash", async () => {
		const store = await open();
		const tickets = createTunnelTickets(store, () => now);
		const ticket = await tickets.issue(grant);
		const [id = "", secret = ""] = ticket.split(".");
		const row = await store.getTicket(id);
		expect(row?.secretHash).toBe(await sha256Hex(secret));
		expect(JSON.stringify(row)).not.toContain(secret);
	});

	it("keep a desktop ticket's mode in its row, so a view-only ticket can't be made into one that drives", async () => {
		const store = await open();
		const tickets = createTunnelTickets(store, () => now);
		const view = { ...grant, port: 6080, desktop: "view" as const };
		const ticket = await tickets.issue(view);
		expect(await tickets.verify(ticket, now)).toMatchObject(view);
		const control = { ...view, desktop: "control" as const };
		expect(await tickets.verify(await tickets.issue(control), now)).toMatchObject(control);
		// Nothing in the URL says which: only the row does.
		const [id = ""] = ticket.split(".");
		expect(ticket).not.toContain("view");
		expect((await store.getTicket(id))?.desktop).toBe("view");
		// A mode that isn't one, in a row however it got there, is refused.
		const row = await store.getTicket(id);
		if (row === undefined) throw new Error("no row");
		for (const [i, desktop] of ["admin", "", "VIEW"].entries()) {
			const forgedId = `forged_mode_row_${i}`;
			await store.putTicket({ ...row, id: forgedId, desktop });
			expect(await tickets.verify(`${forgedId}.${ticket.split(".")[1]}`, now)).toBeUndefined();
		}
	});

	it("are accepted by another relay over the same store, as after a restart", async () => {
		const store = await open();
		const ticket = await createTunnelTickets(store, () => now).issue(grant);
		expect((await createTunnelTickets(store, () => now).verify(ticket, now))?.sandboxId).toBe(grant.sandboxId);
	});

	it("refuse a ticket with another secret half, or another ticket's ID", async () => {
		const tickets = createTunnelTickets(await open(), () => now);
		const ticket = await tickets.issue(grant);
		const other = await tickets.issue({ ...grant, sandboxId: "sbx_someone" });
		const [id = "", secret = ""] = ticket.split(".");
		const [otherId = "", otherSecret = ""] = other.split(".");
		expect(await tickets.verify(`${id}.${otherSecret}`, now)).toBeUndefined();
		expect(await tickets.verify(`${otherId}.${secret}`, now)).toBeUndefined();
		expect(await tickets.verify(`${id}.${secret.slice(0, -2)}AA`, now)).toBeUndefined();
		expect(await tickets.verify(`${id}.${"A".repeat(43)}`, now)).toBeUndefined();
		// A ticket nobody issued, of the right shape.
		expect(await tickets.verify(`${"B".repeat(16)}.${"A".repeat(43)}`, now)).toBeUndefined();
	});

	it(`refuse a ticket good for more than ${MAX_TUNNEL_MINUTES} minutes, even one the relay issued`, async () => {
		const tickets = createTunnelTickets(await open(), () => now);
		const longest = await tickets.issue({ ...grant, expiresAt: now + MAX_TUNNEL_MINUTES * 60_000 });
		expect(await tickets.verify(longest, now)).toBeDefined();
		const longer = await tickets.issue({ ...grant, expiresAt: now + MAX_TUNNEL_MINUTES * 60_000 + 1 });
		expect(await tickets.verify(longer, now)).toBeUndefined();
	});

	it("refuse malformed tickets", async () => {
		const tickets = createTunnelTickets(await open(), () => now);
		const valid = await tickets.issue(grant);
		for (const ticket of ["", ".", "abc", `${valid}.extra`, "!!!.???", `${valid.split(".")[0]}`, `${valid}x`]) {
			expect(await tickets.verify(ticket, now)).toBeUndefined();
		}
	});

	it("are swept an hour after they expire", async () => {
		const store = await open();
		const tickets = createTunnelTickets(store, () => now);
		const ticket = await tickets.issue(grant);
		const id = ticket.split(".")[0] ?? "";
		await tickets.sweep(grant.expiresAt + 59 * 60_000);
		expect(await store.getTicket(id)).toBeDefined();
		await tickets.sweep(grant.expiresAt + 61 * 60_000);
		expect(await store.getTicket(id)).toBeUndefined();
	});
}

describe("tunnel tickets in memory", () => {
	behaves(async () => createMemoryRelayStore());
});

for (const kind of testDatabaseKinds()) {
	describe(`tunnel tickets on ${kind.name}`, {
		...(kind.testTimeoutMs === undefined ? {} : { timeout: kind.testTimeoutMs }),
	}, () => {
		behaves(async () => {
			const database = await kind.open();
			cleanups.push(() => database.close());
			await migrateRelay(database.driver);
			await migrateRelay(database.driver);
			return createSqlRelayStore(database.driver);
		});
	});
}
