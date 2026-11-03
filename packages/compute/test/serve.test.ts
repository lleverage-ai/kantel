import { describe, expect, it } from "vitest";
import { startComputeServer } from "../src/serve.ts";

describe("the dev server", () => {
	it("answers /healthz and /v1/whoami over HTTP with the bootstrap key", async () => {
		const server = await startComputeServer({ port: 0 });
		try {
			expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			expect(server.apiKey).toMatch(/^ksk_/);

			const health = await fetch(`${server.url}/healthz`);
			expect(health.status).toBe(200);
			expect(await health.json()).toEqual({ ok: true });

			const whoami = await fetch(`${server.url}/v1/whoami`, {
				headers: { authorization: `Bearer ${server.apiKey}` },
			});
			expect(whoami.status).toBe(200);
			const caller = (await whoami.json()) as { superAdmin: boolean; apiKey?: { scopes: string[] } };
			expect(caller.superAdmin).toBe(true);
			expect(caller.apiKey?.scopes).toContain("hosts:admin");

			const anonymous = await fetch(`${server.url}/v1/whoami`);
			expect(anonymous.status).toBe(401);
			expect(await anonymous.json()).toMatchObject({ error: { code: "unauthenticated" } });

			const elsewhere = await fetch(`${server.url}/nowhere`);
			expect(elsewhere.status).toBe(404);
			await elsewhere.body?.cancel();
		} finally {
			await server.close();
		}
	});

	it("keeps a fixed bootstrap key", async () => {
		const key = `ksk_${"a".repeat(32)}`;
		const server = await startComputeServer({ port: 0, bootstrapKey: key });
		try {
			expect(server.apiKey).toBe(key);
			const whoami = await fetch(`${server.url}/v1/whoami`, { headers: { authorization: `Bearer ${key}` } });
			expect(whoami.status).toBe(200);
			await whoami.body?.cancel();
		} finally {
			await server.close();
		}
	});
});
