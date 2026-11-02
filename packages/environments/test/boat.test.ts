import { isKantelError } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { boatCwd, boatScript, boatStatus, createBoatProvider, verifyBoatWebhook } from "../src/boat.ts";
import { type BoatAction, createFakeBoat } from "../src/fake-boat.ts";
import { providerContract } from "./provider-contract.ts";

const KEY = "boat_test";
const spec = (environmentId: string) => ({
	environmentId,
	name: environmentId,
	size: "default" as const,
	definition: { version: 1 },
});

function boatFor(options: Parameters<typeof createFakeBoat>[0] = {}) {
	const boat = createFakeBoat(options);
	const provider = createBoatProvider({
		apiKey: KEY,
		fetch: boat.fetch,
		retryDelayMs: 0,
		sleep: async () => undefined,
	});
	return { boat, provider };
}

describe("the boat provider keeps the provider contract", () => {
	providerContract(() => ({ provider: boatFor().provider }));
});

describe("the boat provider", () => {
	it("creates every sandbox with noEnv, its labels and an idempotency key, and none holds the owner's logins", async () => {
		const requests: { url: string; headers: Headers; body: unknown }[] = [];
		const boat = createFakeBoat();
		const provider = createBoatProvider({
			apiKey: KEY,
			fetch: async (input, init) => {
				const request = new Request(input as string, init);
				requests.push({
					url: request.url,
					headers: request.headers,
					body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
				});
				return boat.fetch(input, init);
			},
		});
		const ref = await provider.create({ ...spec("env_x"), labels: { "kantel.project": "proj_1" } });
		const create = requests[0]!;
		expect(create.url).toBe("https://boat.dev/api/v1/sandboxes");
		expect(create.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(create.headers.get("idempotency-key")).toBe("kantel-env_x-v1");
		expect(create.body).toMatchObject({
			noEnv: true,
			type: "default",
			labels: { "kantel.environment": "env_x", "kantel.project": "proj_1" },
			ttlSeconds: 4 * 3600,
		});
		expect((await provider.status(ref)).holdsOwnerLogins).toBeUndefined();
		await provider.stop(ref);
		await provider.start(ref);
		expect(requests.find((request) => request.url.endsWith("/resume"))?.body).toMatchObject({ noEnv: true });
		const fork = await provider.fork!(ref, spec("env_y"));
		expect(requests.find((request) => request.url.endsWith("/fork"))?.body).toMatchObject({ noEnv: true });
		expect(boat.sandboxes.get(fork.machineId)?.noEnv).toBe(true);
	});

	it("reports a sandbox that still holds its creator's logins", async () => {
		const { boat, provider } = boatFor();
		const ref = await provider.create(spec("env_logins"));
		(boat.sandboxes.get(ref.machineId) as { noEnv: boolean }).noEnv = false;
		expect((await provider.status(ref)).holdsOwnerLogins).toBe(true);
	});

	it("maps boat's states", () => {
		expect(boatStatus("provisioning")).toBe("starting");
		expect(boatStatus("ready")).toBe("running");
		expect(boatStatus("idle")).toBe("running");
		expect(boatStatus("archiving")).toBe("stopping");
		expect(boatStatus("archived")).toBe("stopped");
		expect(boatStatus("cancelled")).toBe("gone");
		expect(boatStatus("error")).toBe("error");
	});

	it("exports variables at the top of the script, quoted, and refuses a bad name", () => {
		expect(boatScript("make", { A: "x y", B: "it's" })).toBe("export A='x y'\nexport B='it'\\''s'\nmake");
		expect(boatScript("make", undefined)).toBe("make");
		expect(() => boatScript("make", { "A;rm": "x" })).toThrow(/variable name/);
	});

	it("sends a working directory relative to /home/user, and refuses one outside it", () => {
		expect(boatCwd("/home/user")).toBeUndefined();
		expect(boatCwd("/home/user/kantel/worktrees/ses_1")).toBe("kantel/worktrees/ses_1");
		expect(boatCwd("work")).toBe("work");
		expect(() => boatCwd("/etc")).toThrow(/under \/home\/user/);
	});

	it("caps a command's timeout at boat's 600 seconds", async () => {
		const { provider } = boatFor();
		const ref = await provider.create(spec("env_timeout"));
		const result = await provider.exec(ref, { command: "echo ok", timeoutMs: 3_600_000 });
		expect(result.exitCode).toBe(0);
	});

	it("retries a command a restoring sandbox refused, and it runs once", async () => {
		const { boat, provider } = boatFor({ restoringCommands: 2 });
		const ref = await provider.create(spec("env_restore"));
		await provider.stop(ref);
		await provider.start(ref);
		const result = await provider.exec(ref, { command: "echo back" });
		expect(result.stdout).toBe("back\n");
		expect(boat.sandboxes.get(ref.machineId)?.commands).toEqual(["echo back"]);
	});

	it("turns boat's errors into Kantel's, without the key", async () => {
		const { provider } = boatFor({ startLimit: 1 });
		const ref = await provider.create(spec("env_limit"));
		await provider.stop(ref);
		const error = await provider.start(ref).catch((caught: unknown) => caught);
		expect(isKantelError(error, "exhausted")).toBe(true);
		expect(String((error as Error).message)).toMatch(/rate_limited/);
		expect(String((error as Error).message)).not.toContain(KEY);

		const wrongKey = createBoatProvider({ apiKey: "boat_wrong", fetch: createFakeBoat().fetch });
		const refused = await wrongKey.create(spec("env_key")).catch((caught: unknown) => caught);
		expect(isKantelError(refused, "unavailable")).toBe(true);
		expect((refused as Error).message).toMatch(/refused the API key/);
		expect((refused as Error).message).not.toContain("boat_wrong");
	});

	it("is refused what its scoped key doesn't allow", async () => {
		const readOnly: readonly BoatAction[] = ["sandbox.read"];
		const boat = createFakeBoat({ keys: { [KEY]: readOnly } });
		const provider = createBoatProvider({ apiKey: KEY, fetch: boat.fetch });
		const error = await provider.create(spec("env_scope")).catch((caught: unknown) => caught);
		expect(isKantelError(error, "forbidden")).toBe(true);
	});

	it("stops a running sandbox before deleting it, naming it in the confirmation", async () => {
		const { boat, provider } = boatFor();
		const ref = await provider.create(spec("env_delete"));
		await provider.destroy(ref);
		expect(boat.calls.filter((call) => call.startsWith("POST /sandboxes/") || call.startsWith("DELETE"))).toEqual([
			`POST /sandboxes/${ref.machineId}/stop`,
			`DELETE /sandboxes/${ref.machineId}`,
		]);
		expect(boat.sandboxes.get(ref.machineId)?.deleted).toBe(true);
	});

	it("reads usage as milliseconds and dollars", async () => {
		let now = Date.UTC(2026, 10, 2, 12);
		const boat = createFakeBoat({ now: () => now });
		const provider = createBoatProvider({ apiKey: KEY, fetch: boat.fetch });
		const ref = await provider.create(spec("env_usage"));
		now += 90_000;
		const usage = await provider.usage!(ref, Date.UTC(2026, 10, 1));
		expect(usage.runningMs).toBe(90_000);
		expect(usage.dollars).toBeCloseTo(0.0009);
	});
});

describe("boat webhooks", () => {
	const SECRET = `whsec_${"ab".repeat(32)}`;
	const AT = Date.UTC(2026, 10, 2, 12);

	it("reads a signed delivery as a state report", async () => {
		const boat = createFakeBoat({ now: () => AT });
		const delivery = await boat.webhook(SECRET, "sandbox.archived", "bx_23456789");
		const report = await verifyBoatWebhook({ secret: SECRET, ...delivery, now: AT + 1000 });
		expect(report).toMatchObject({ ref: { provider: "boat", machineId: "bx_23456789" }, status: "stopped", at: AT });
		expect(report?.deliveryId).toMatch(/^evt_/);
	});

	it("refuses a wrong signature, a changed body and an old delivery", async () => {
		const boat = createFakeBoat({ now: () => AT });
		const delivery = await boat.webhook(SECRET, "sandbox.ready", "bx_23456789");
		await expect(verifyBoatWebhook({ secret: `${SECRET}0`, ...delivery, now: AT })).rejects.toThrow(/signature/);
		await expect(
			verifyBoatWebhook({
				secret: SECRET,
				headers: delivery.headers,
				body: delivery.body.replace("ready", "error"),
				now: AT,
			}),
		).rejects.toThrow(/signature/);
		await expect(verifyBoatWebhook({ secret: SECRET, ...delivery, now: AT + 10 * 60_000 })).rejects.toThrow(/too old/);
		await expect(verifyBoatWebhook({ secret: SECRET, headers: new Headers(), body: "{}" })).rejects.toThrow(/signed/);
	});
});
