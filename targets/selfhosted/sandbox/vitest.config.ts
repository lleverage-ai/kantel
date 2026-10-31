import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		// Each container case starts gVisor sandboxes; the Docker tests are skipped unless KANTEL_TEST_DOCKER=1.
		testTimeout: 180_000,
		hookTimeout: 120_000,
	},
});
