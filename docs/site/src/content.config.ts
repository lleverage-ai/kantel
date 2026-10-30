// Starlight's content collection: every page under src/content/docs, with Starlight's frontmatter schema.
import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
	docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
