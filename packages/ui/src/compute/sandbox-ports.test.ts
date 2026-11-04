import { describe, expect, it } from "vitest";
import { portChanges } from "./sandbox-ports.tsx";

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
		const changes = portChanges((changing) => seen.push([...changing]));
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
		const changes = portChanges(() => {});
		await expect(changes.run(8080, () => Promise.reject(new Error("no")))).rejects.toThrow("no");
		await expect(changes.run(8080, async () => "again")).resolves.toBe("again");
	});

	it("lets other ports change meanwhile", async () => {
		const changes = portChanges(() => {});
		const slow = deferred<void>();
		const first = changes.run(3000, () => slow.promise);
		await expect(changes.run(8080, async () => "other")).resolves.toBe("other");
		slow.resolve();
		await first;
	});
});
