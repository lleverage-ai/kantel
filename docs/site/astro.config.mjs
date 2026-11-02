// The public docs site's Astro and Starlight configuration, and its sidebar. See README.md for how to build it. Pages live in src/content/docs; a page's path there is its URL.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { sidebar } from "./sidebar.mjs";

export default defineConfig({
	integrations: [
		starlight({
			title: "Kantel",
			description: "Kantel, by Lleverage: AI agents for people and for apps, on Cloudflare or your own machines.",
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/lleverage-ai/kantel" }],
			editLink: { baseUrl: "https://github.com/lleverage-ai/kantel/edit/main/docs/site/" },
			// In sidebar.mjs, which kantel.dev (apps/site) shares.
			sidebar,
		}),
	],
});
