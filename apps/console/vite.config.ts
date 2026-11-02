// First: HARBOUR_GATEWAY and HARBOUR_DEV_EMAIL from before the rename still count.
import "@kantel/contracts/legacy-env";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { themeBootScript } from "@kantel/ui/theme-boot";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { devGateway } from "./scripts/dev-gateway.ts";

// Recorded sessions, as protocol frames, live at the repo root in fixtures/sessions, outside this app.
const fixtures = fileURLToPath(new URL("../../fixtures/sessions", import.meta.url));

// The default theme's font files (@kantel/ui's src/tokens/fonts.css), which the dev server serves from their packages,
// outside this app. A build copies them into its assets.
const fromUi = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const fonts = ["@fontsource-variable/public-sans", "@fontsource/abhaya-libre", "@fontsource-variable/roboto-mono"].map(
	(name) => dirname(fromUi.resolve(`${name}/package.json`)),
);

/**
 * @kantel/ui's theme boot script, inline at the top of <head>: the first paint is in the theme this browser last
 * showed, with no flash of the default before the bundle loads.
 */
const themeBoot = (): Plugin => ({
	name: "kantel-theme-boot",
	transformIndexHtml: () => [{ tag: "script", children: themeBootScript, injectTo: "head" }],
});

export default defineConfig(({ mode }) => ({
	// `pnpm dev` forwards /v1 to a local gateway; KANTEL_GATEWAY points it elsewhere, and KANTEL_DEV_EMAIL signs in as
	// another invited person than the dev admin.
	plugins: [
		themeBoot(),
		// @kantel/ui's components are styled with Tailwind utilities, built from its src/tokens/tailwind.css.
		tailwindcss(),
		react(),
		devGateway(process.env.KANTEL_GATEWAY ?? "http://127.0.0.1:8787", process.env.KANTEL_DEV_EMAIL || undefined),
	],
	resolve: {
		// `vite build --mode profiling` keeps React's Profiler timings in a production bundle.
		alias: mode === "profiling" ? [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] : [],
	},
	server: {
		host: "127.0.0.1",
		port: 5173,
		fs: { allow: [".", fixtures, ...fonts] },
	},
	preview: { host: "127.0.0.1", port: 4173 },
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
}));
