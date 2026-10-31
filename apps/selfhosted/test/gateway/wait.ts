/**
 * Retries `assertion` until it stops throwing, then returns what it returned; after `timeoutMs` the last failure is
 * thrown. As vitest's `vi.waitFor`, which `bun test` (the `test:stack` run of these same suites) doesn't have.
 */
export async function waitFor<T>(assertion: () => T | Promise<T>, timeoutMs = 3000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await assertion();
		} catch (error) {
			if (Date.now() > deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}
