import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The measurement harness: a production build of the loop's scenarios with React's profiling build, so <Profiler>
// reports render durations as it does in a real app (the development build is several times slower and would
// measure React's checks, not the components).
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	base: "./",
	plugins: [tailwindcss(), react()],
	resolve: { alias: [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] },
	build: { outDir: fileURLToPath(new URL("../out/harness/", import.meta.url)), emptyOutDir: true },
	logLevel: "warn",
});
