import { describe, expect, it } from "vitest";
import { isNoInstanceError, type StartableContainer, startContainer } from "../src/sandbox-start.ts";

const NO_INSTANCE = "There is no container instance that can be provided to this Durable Object, try again later";

/** A container whose first `refusals` starts find no instance, as Cloudflare answers when all are in use. */
function fakeContainer(options: { refusals?: number; refuseAt?: "timeout" | "health"; listensAfter?: number } = {}) {
	let refusals = options.refusals ?? 0;
	let healthChecks = 0;
	const calls: string[] = [];
	const container: StartableContainer & { calls: string[]; running: boolean } = {
		running: false,
		calls,
		start() {
			if (container.running) throw new Error("already running");
			calls.push("start");
			container.running = true;
		},
		async setInactivityTimeout(ms) {
			calls.push(`timeout ${ms}`);
			if (refusals > 0 && (options.refuseAt ?? "timeout") === "timeout") {
				refusals--;
				container.running = false;
				throw new Error(NO_INSTANCE);
			}
		},
		getTcpPort() {
			return {
				async fetch() {
					if (refusals > 0 && options.refuseAt === "health") {
						refusals--;
						container.running = false;
						throw new Error(NO_INSTANCE);
					}
					healthChecks++;
					if (healthChecks <= (options.listensAfter ?? 0)) throw new Error("connection refused");
					return new Response("{}");
				},
			};
		},
	};
	return container;
}

/** A clock that only moves when the start sleeps. */
function clock() {
	let t = 0;
	const slept: number[] = [];
	return {
		slept,
		now: () => t,
		sleep: async (ms: number) => {
			slept.push(ms);
			t += ms;
		},
	};
}

const options = (time: ReturnType<typeof clock>, instanceWaitMs = 20_000) => ({
	startup: { enableInternet: false },
	port: 8080,
	inactivityMs: 600_000,
	readyTimeoutMs: 60_000,
	instanceWaitMs,
	sleep: time.sleep,
	now: time.now,
});

describe("starting a sandbox container", () => {
	it("starts it once, with its inactivity timeout, and waits for /health", async () => {
		const container = fakeContainer({ listensAfter: 3 });
		const time = clock();
		const timings = await startContainer(container, options(time));
		expect(container.calls).toEqual(["start", "timeout 600000"]);
		expect(time.slept).toEqual([50, 50, 50]);
		expect(timings["container.instanceAttempts"]).toBeUndefined();
	});

	it("asks again, backing off, while Cloudflare has no instance free", async () => {
		const container = fakeContainer({ refusals: 3 });
		const time = clock();
		const timings = await startContainer(container, options(time));
		expect(container.calls.filter((call) => call === "start")).toHaveLength(4);
		expect(time.slept).toEqual([250, 500, 1000]);
		expect(timings["container.instanceAttempts"]).toBe(4);
		expect(timings["container.instanceWait"]).toBe(1750);
	});

	it("asks again when the refusal comes at the first /health", async () => {
		const container = fakeContainer({ refusals: 1, refuseAt: "health" });
		const time = clock();
		await startContainer(container, options(time));
		expect(container.calls.filter((call) => call === "start")).toHaveLength(2);
	});

	it("gives up after instanceWaitMs with Cloudflare's error", async () => {
		const container = fakeContainer({ refusals: 100 });
		const time = clock();
		await expect(startContainer(container, options(time, 5_000))).rejects.toThrow(NO_INSTANCE);
		expect(time.now()).toBeGreaterThanOrEqual(5_000);
		expect(time.now()).toBeLessThan(8_000);
	});

	it("never retries another failure", async () => {
		const container = fakeContainer();
		container.setInactivityTimeout = async () => {
			throw new Error("container exited with code 1");
		};
		const time = clock();
		await expect(startContainer(container, options(time))).rejects.toThrow("exited");
		expect(container.calls).toEqual(["start"]);
		expect(time.slept).toEqual([]);
	});

	it("times out when the agent never answers", async () => {
		const container = fakeContainer({ listensAfter: Number.POSITIVE_INFINITY });
		const time = clock();
		await expect(startContainer(container, options(time))).rejects.toThrow("did not start in 60 s");
	});

	it("knows Cloudflare's error by its message", () => {
		expect(isNoInstanceError(new Error(NO_INSTANCE))).toBe(true);
		expect(isNoInstanceError(new Error("connection refused"))).toBe(false);
		expect(isNoInstanceError(NO_INSTANCE)).toBe(false);
	});
});
