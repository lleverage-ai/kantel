import { defineConfig } from "vitest/config";

// The gateway's in-process tests run on Node in CI's check job. durable.stack.test.ts needs a Postgres
// (KANTEL_TEST_POSTGRES_URL) and skips without one; test/bindings.ts runs it against the compose stack's.
export default defineConfig({
	test: {
		include: ["test/gateway/**/*.test.ts"],
		environment: "node",
		testTimeout: 20_000,
	},
});
