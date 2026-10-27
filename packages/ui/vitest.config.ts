import { defineConfig } from "vitest/config";

// Unit tests for @harbour/ui: pure logic and the token and copy lints. Rendering is checked in a real browser by
// the design loop (loop/), not in a DOM emulation.
export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "loop/**/*.test.ts"],
	},
});
