import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Recorded sessions live at the repo root in fixtures/sessions, outside this app.
const fixtures = fileURLToPath(new URL("../../fixtures/sessions", import.meta.url));

export default defineConfig(({ mode }) => ({
	plugins: [react()],
	resolve: {
		// `vite build --mode profiling` keeps React's Profiler timings in a production bundle.
		alias: mode === "profiling" ? [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] : [],
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
		fs: { allow: [".", fixtures] },
	},
	preview: { host: "127.0.0.1", port: 4173 },
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
}));
