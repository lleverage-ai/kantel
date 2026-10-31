// The public docs site's Astro and Starlight configuration, and its sidebar. Nothing installs or builds the site yet:
// see README.md for how to. Pages live in src/content/docs; a page's path there is its URL.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
	integrations: [
		starlight({
			title: "Kantel",
			description: "Kantel, by Lleverage: AI agents for people and for apps, on Cloudflare or your own machines.",
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/tvdavies/harbour" }],
			editLink: { baseUrl: "https://github.com/tvdavies/harbour/edit/main/docs/site/" },
			sidebar: [
				{ label: "Introduction", items: [{ label: "What Kantel is", link: "/" }, "gaps"] },
				{
					label: "Getting started",
					items: [
						"console/getting-started/install",
						"console/getting-started/onboarding",
						"console/getting-started/tour",
					],
				},
				{
					label: "Using the console",
					items: [
						"console/models",
						"console/connectors",
						"console/sessions",
						"console/workspace-and-files",
						"console/browsers",
						"console/connection-requests",
						"console/skills",
						"console/memory",
						"console/prompt-rules",
						"console/schedules",
						"console/audit",
						"console/projects-and-sharing",
					],
				},
				{
					label: "Deploying",
					items: ["deploy/overview", "deploy/cloudflare", "deploy/self-hosted"],
				},
				{
					label: "Building apps",
					items: [
						"api/concepts",
						"api/authentication",
						"api/quick-start",
						"api/streaming",
						"api/approvals",
						"api/results-and-usage",
						"api/errors",
						"api/host-tools",
						"api/packaging-an-agent",
						"api/lleverage",
					],
				},
				// Generated from the OpenAPI document by scripts/api-reference.ts, ordered by each page's `sidebar.order`.
				{ label: "API reference", collapsed: true, autogenerate: { directory: "api/reference" } },
			],
		}),
	],
});
