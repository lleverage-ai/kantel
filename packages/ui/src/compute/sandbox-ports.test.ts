import { describe, expect, it } from "vitest";
import { portChanges, sandboxPortChanges } from "./sandbox-ports.tsx";

/** A call that answers when told to. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("portChanges", () => {
	it("refuses a second change to a port while the first is on its way, so a later Hide can't be undone", async () => {
		const seen: number[][] = [];
		const changes = portChanges();
		changes.subscribe(() => seen.push([...changes.changing()]));
		const publish = deferred<string>();
		const calls: string[] = [];
		const first = changes.run(3000, () => {
			calls.push("public");
			return publish.promise;
		});
		await expect(
			changes.run(3000, async () => {
				calls.push("hide");
			}),
		).rejects.toThrow("Port 3000 is still changing");
		expect(calls).toEqual(["public"]);
		publish.resolve("done");
		await expect(first).resolves.toBe("done");
		expect(seen).toEqual([[3000], []]);
	});

	it("frees a port when its change fails, for another try", async () => {
		const changes = portChanges();
		await expect(changes.run(8080, () => Promise.reject(new Error("no")))).rejects.toThrow("no");
		await expect(changes.run(8080, async () => "again")).resolves.toBe("again");
	});

	it("lets other ports change meanwhile", async () => {
		const changes = portChanges();
		const slow = deferred<void>();
		const first = changes.run(3000, () => slow.promise);
		await expect(changes.run(8080, async () => "other")).resolves.toBe("other");
		slow.resolve();
		await first;
	});

	it("keeps a sandbox's guard when its view goes and comes back, so leaving the tab mid-change can't drop it", async () => {
		const publish = deferred<void>();
		// The Overview tab's view starts a change, then unmounts; the view mounted later asks for the guard again.
		const first = sandboxPortChanges("sbx_tabs").run(3000, () => publish.promise);
		const again = sandboxPortChanges("sbx_tabs");
		expect(again.changing().has(3000)).toBe(true);
		await expect(again.run(3000, async () => {})).rejects.toThrow("Port 3000 is still changing");
		// Another sandbox's port 3000 is its own.
		await expect(sandboxPortChanges("sbx_other").run(3000, async () => "other")).resolves.toBe("other");
		publish.resolve();
		await first;
		expect(again.changing().size).toBe(0);
	});
});
