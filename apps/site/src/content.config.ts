// The docs collection: the pages scripts/sync-docs.mjs copies from docs/site, with Starlight's frontmatter schema.
import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
