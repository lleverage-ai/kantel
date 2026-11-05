// Relayed access lasts only while its grantee may still open the sandbox: a held session is closed at the next check
// once they can't, one check per grantee and sandbox, and a check that fails ends the session rather than keep it.
import { describe, expect, it } from "vitest";
import { createRelayAccess, RELAY_REVOKED_REASON } from "../src/relay-access.ts";

const KEY_1 = JSON.stringify({ kind: "key", keyId: "key_1" });
const KEY_2 = JSON.stringify({ kind: "key", keyId: "key_2" });

describe("relayed access", () => {
	it("ends the held sessions of a grantee who lost access, and only theirs", async () => {
		const revoked = new Set<string>();
		const asked: string[] = [];
		const access = createRelayAccess({
			stillAllowed: async (grantee, sandboxId) => {
				asked.push(`${grantee}@${sandboxId}`);
				return !revoked.has(grantee ?? "");
			},
			log: () => undefined,
		});
		const ended: string[] = [];
		const session = (name: string, grantee: string, sandboxId = "sbx_1") =>
			access.track({ sandboxId, grantee, kind: name, end: (reason) => ended.push(`${name}: ${reason}`) });
		session("desktop", KEY_1);
		session("ssh", KEY_1);
		session("cdp", KEY_2);
		const release = session("port 3000", KEY_1, "sbx_2");
		await access.check();
		expect(ended).toEqual([]);
		// One question per grantee and sandbox.
		expect(asked.sort()).toEqual([`${KEY_1}@sbx_1`, `${KEY_1}@sbx_2`, `${KEY_2}@sbx_1`]);

		release();
		revoked.add(KEY_1);
		await access.check();
		expect(ended.sort()).toEqual([`desktop: ${RELAY_REVOKED_REASON}`, `ssh: ${RELAY_REVOKED_REASON}`]);
		expect(access.size).toBe(1);
	});

	it("ends a session when the check itself fails", async () => {
		const access = createRelayAccess({
			stillAllowed: async () => {
				throw new Error("database down");
			},
			log: () => undefined,
		});
		const ended: string[] = [];
		access.track({ sandboxId: "sbx_1", grantee: KEY_1, kind: "ssh", end: (reason) => ended.push(reason) });
		await access.check();
		expect(ended).toEqual([RELAY_REVOKED_REASON]);
		expect(await access.allowed(KEY_1, "sbx_1")).toBe(false);
	});

	it("reuses an answer for new requests only briefly", async () => {
		let now = 0;
		let allowed = true;
		let asked = 0;
		const access = createRelayAccess({
			stillAllowed: async () => {
				asked += 1;
				return allowed;
			},
			cacheMs: 1000,
			now: () => now,
		});
		expect(await access.allowed(KEY_1, "sbx_1")).toBe(true);
		allowed = false;
		now = 999;
		expect(await access.allowed(KEY_1, "sbx_1")).toBe(true);
		now = 1000;
		expect(await access.allowed(KEY_1, "sbx_1")).toBe(false);
		expect(asked).toBe(2);
	});

	it("checks on its own every interval once started", async () => {
		let allowed = true;
		const access = createRelayAccess({ stillAllowed: async () => allowed, intervalMs: 20, log: () => undefined });
		const ended: string[] = [];
		access.track({ sandboxId: "sbx_1", grantee: KEY_1, kind: "desktop", end: (reason) => ended.push(reason) });
		access.start();
		try {
			allowed = false;
			await expect.poll(() => ended, { timeout: 1000, interval: 10 }).toEqual([RELAY_REVOKED_REASON]);
		} finally {
			access.stop();
		}
	});
});
