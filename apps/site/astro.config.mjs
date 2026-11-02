// kantel.dev: the marketing page at /, install.sh beside it (public/), and the usage docs at /docs, built by
// Starlight from the pages scripts/sync-docs.mjs copies out of docs/site, with docs/site's own sidebar.
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { sidebar } from "../../docs/site/sidebar.mjs";
import { GITHUB_URL, SITE_URL } from "./src/site.mjs";

/** docs/site's sidebar, with every page moved under docs/ (its root is this site's /docs). */
function underDocs(entry) {
	if (typeof entry === "string") return `docs/${entry}`;
	if ("link" in entry) return { ...entry, link: `/docs${entry.link}` };
	if ("autogenerate" in entry) return { ...entry, autogenerate: { directory: `docs/${entry.autogenerate.directory}` } };
	if ("items" in entry) return { ...entry, items: entry.items.map(underDocs) };
	return entry;
}

export default defineConfig({
	site: SITE_URL,
	trailingSlash: "ignore",
	integrations: [
		starlight({
			title: "Kantel docs",
			description: "Kantel, by Lleverage: AI agents for people and for apps, on Cloudflare or your own machines.",
			logo: {
				light: "./src/assets/brand/kantel-lockup-horizontal-on-light.svg",
				dark: "./src/assets/brand/kantel-lockup-horizontal-on-dark.svg",
				replacesTitle: true,
			},
			favicon: "/favicon.svg",
			social: [{ icon: "github", label: "GitHub", href: GITHUB_URL }],
			customCss: ["./src/styles/docs.css"],
			sidebar: sidebar.map(underDocs),
		}),
	],
	vite: { plugins: [tailwindcss()] },
});
