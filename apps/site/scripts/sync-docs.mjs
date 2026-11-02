// Copies Kantel's usage docs (docs/site/src/content/docs) into this site's content collection under docs/, so
// kantel.dev serves them at /docs/… with the same Starlight setup and sidebar (docs/site/sidebar.mjs). Run before every
// dev or build (the package's predev and prebuild), so a docs edit in the repository flows through on the next build.
// The copy is generated and ignored by git: edit the pages in docs/site, never here.
//
// Each page keeps its text. Two things change on the way:
// - Root-relative links (`](/console/models/)`, `href="/api/…"`) get the /docs prefix, since the docs site's root is
//   this site's /docs.
// - Each page gets an `editUrl` pointing at its source in docs/site, since Starlight would otherwise point at the copy.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { GITHUB_URL } from "../src/site.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "../../../docs/site/src/content/docs");
const target = join(here, "../src/content/docs/docs");
const editBase = `${GITHUB_URL}/edit/main/docs/site/src/content/docs/`;

/** Prefixes a root-relative link with /docs, leaving protocol-relative (`//host`) and already-prefixed ones alone. */
export function prefixLinks(text) {
	return text
		.replace(/\]\(\/(?!\/|docs\/)/g, "](/docs/")
		.replace(/href="\/(?!\/|docs\/)/g, 'href="/docs/')
		.replace(/^(\[[^\]]+\]:\s*)\/(?!\/|docs\/)/gm, "$1/docs/");
}

/** Adds `editUrl` to a page's frontmatter, after its opening `---`. */
export function withEditUrl(text, path) {
	if (!text.startsWith("---\n")) return text;
	return `---\neditUrl: ${editBase}${path}\n${text.slice(4)}`;
}

function* files(dir) {
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* files(path);
		else yield path;
	}
}

rmSync(target, { recursive: true, force: true });
let pages = 0;
for (const file of files(source)) {
	const path = relative(source, file);
	const out = join(target, path);
	mkdirSync(dirname(out), { recursive: true });
	if (/\.mdx?$/.test(file)) {
		writeFileSync(out, withEditUrl(prefixLinks(readFileSync(file, "utf8")), path));
		pages++;
	} else {
		writeFileSync(out, readFileSync(file));
	}
}
console.log(`sync-docs: ${pages} pages from docs/site into src/content/docs/docs`);
