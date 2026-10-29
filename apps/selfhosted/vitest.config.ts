import { defineConfig } from "vitest/config";

// The gateway's and the browser host's in-process tests run on Node in CI's check job. Everything else in test/ needs
// the compose stack and runs with `bun test` (spike/conformance/run.ts --target=selfhosted).
export default defineConfig({
	test: {
		include: ["test/gateway/**/*.test.ts", "test/browser/**/*.test.ts"],
		environment: "node",
		testTimeout: 20_000,
	},
});
