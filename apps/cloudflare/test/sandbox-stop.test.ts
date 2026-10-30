import { describe, expect, it } from "vitest";
import { type StoppableContainer, stopContainer } from "../src/sandbox-stop.ts";

/**
 * A container as the Durable Object sees it (`running`, from its own monitor) and as Cloudflare has it (`live`, what
 * `inspect()` reports). `destroy()` is Workers': it does nothing unless `running` is true.
 */
function fakeContainer(state: {
	running: boolean;
	live?: boolean | "unknown" | "absent";
	destroyFails?: boolean;
	timeoutFails?: boolean;
}) {
	const calls: string[] = [];
	const container: StoppableContainer & { calls: string[] } = {
		calls,
		get running() {
			return state.running;
		},
		async destroy() {
			if (!state.running) return;
			calls.push("destroy");
			if (state.destroyFails === true) throw new Error("destroy failed");
			state.running = false;
		},
		async setInactivityTimeout(ms) {
			calls.push(`timeout ${ms}`);
			if (state.timeoutFails === true) throw new Error("no container");
		},
		...(state.live === "absent"
			? {}
			: {
					async inspect() {
						calls.push("inspect");
						if (state.live === "unknown") throw new Error("inspect failed");
						return state.live === true ? { image: "sandbox", labels: {} } : null;
					},
				}),
	};
	return container;
}

const options = { releaseMs: 1_000 };

describe("stopping a closed session's container", () => {
	it("destroys one the object sees running", async () => {
		const container = fakeContainer({ running: true, live: true });
		expect(await stopContainer(container, options)).toBe("destroyed");
		expect(container.calls).toEqual(["destroy"]);
	});

	it("gives one Cloudflare still runs, but the object no longer sees, a short inactivity timeout", async () => {
		// The burst case: `running` false, so `destroy()` would return at once and stop nothing.
		const container = fakeContainer({ running: false, live: true });
		expect(await stopContainer(container, options)).toBe("inactivity");
		expect(container.calls).toEqual(["inspect", "timeout 1000"]);
	});

	it("sets the short timeout when Cloudflare can't say, or can't be asked", async () => {
		for (const live of ["unknown", "absent"] as const) {
			const container = fakeContainer({ running: false, live });
			expect(await stopContainer(container, options)).toBe("inactivity");
			expect(container.calls.at(-1)).toBe("timeout 1000");
		}
	});

	it("reports nothing stopped when there is no container, and starts none", async () => {
		const container = fakeContainer({ running: false, live: false });
		expect(await stopContainer(container, options)).toBe("none");
		// Only asked: nothing that could start a container.
		expect(container.calls).toEqual(["inspect"]);
	});

	it("falls back to the short timeout when a destroy fails", async () => {
		const container = fakeContainer({ running: true, destroyFails: true });
		expect(await stopContainer(container, options)).toBe("inactivity");
		expect(container.calls).toEqual(["destroy", "timeout 1000"]);
	});

	it("never throws, so the close carries on", async () => {
		const container = fakeContainer({ running: false, live: "unknown", timeoutFails: true });
		expect(await stopContainer(container, options)).toBe("none");
	});
});
