import { defineConfig } from "vitest/config";

// One run covers every package's tests. Other workspace folders (apps/*, targets/*) can add their own
// vitest config and a `test` script; CI runs `pnpm test` at the root and `pnpm -r --if-present test` for those.
export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts", "images/isolate-host/test/**/*.test.ts", "tools/*/test/**/*.test.ts"],
		environment: "node",
		testTimeout: 10_000,
	},
});
