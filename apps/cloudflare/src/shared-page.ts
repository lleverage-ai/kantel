/**
 * The page a share link opens (`/shared/<token>`), for someone who may not be signed in: the file read-only, and
 * nothing of the session, the workspace or Kantel's console. A document (Markdown) renders as a page, as the console's
 * document panel shows it; an image shows inline; a PDF in the browser's own viewer; text as text; anything else as a
 * download. The page is one HTML response with its styles inline and no script, under a CSP that runs none.
 *
 * Markdown goes through remark and rehype with raw HTML dropped (remark-rehype's default), and every link and image
 * keeps only an http(s), mailto or same-page address, so an agent's Markdown can't put markup or script on the page.
 */
import type { SharedFile } from "@kantel/workspace/shares-api";
import type { Element, Root, RootContent } from "hast";
import { toHtml } from "hast-util-to-html";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/** The longest text shown as text; a longer one is a download. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);

const html = (text: string) =>
	text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Whether `url` is one a shared page may link to or load: http(s), mailto, or within the page. */
function safeUrl(url: unknown, image: boolean): boolean {
	if (typeof url !== "string") return false;
	if (!image && url.startsWith("#")) return true;
	try {
		const parsed = new URL(url);
		return image ? parsed.protocol === "https:" : ["http:", "https:", "mailto:"].includes(parsed.protocol);
	} catch {
		return false;
	}
}

/** Drops any address that isn't safe, and opens outside links without a referrer. */
function sanitise(node: Root | RootContent): void {
	if (node.type === "element") {
		const element = node as Element;
		const props = element.properties;
		if (element.tagName === "a") {
			if (!safeUrl(props.href, false)) delete props.href;
			else if (!String(props.href).startsWith("#")) props.rel = ["noopener", "noreferrer"];
		}
		if (element.tagName === "img" && !safeUrl(props.src, true)) delete props.src;
	}
	if ("children" in node) for (const child of node.children) sanitise(child);
}

/** A Markdown document as safe HTML. */
export function renderMarkdown(text: string): string {
	const tree = markdown.runSync(markdown.parse(text)) as Root;
	sanitise(tree);
	return toHtml(tree);
}

const STYLES = `
:root {
	--kt-page: #f7f6f2; --kt-paper: #ffffff; --kt-ink: #1d1d1b; --kt-ink-muted: #6b6a66; --kt-rule: #e4e2dc;
	--kt-code: #f1efe9; --kt-accent: #3c63d6; --kt-radius: 10px; --kt-measure: 46rem;
	--kt-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
	--kt-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	color-scheme: light;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--kt-page); color: var(--kt-ink); font: 16px/1.65 var(--kt-font); }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; max-width: var(--kt-measure);
	margin: 0 auto; padding: 1.25rem 1.5rem 0; color: var(--kt-ink-muted); font-size: 0.8125rem; }
header .name { overflow: hidden; color: var(--kt-ink); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
header a { color: var(--kt-ink-muted); }
main { max-width: var(--kt-measure); margin: 1rem auto 3rem; padding: 2.5rem 3rem; border: 1px solid var(--kt-rule);
	border-radius: var(--kt-radius); background: var(--kt-paper); }
main.wide { max-width: 72rem; padding: 0; overflow: hidden; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.6em; }
h1 { font-size: 2rem; margin-top: 0; } h2 { font-size: 1.5rem; } h3 { font-size: 1.2rem; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
a { color: var(--kt-accent); }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid var(--kt-rule); color: var(--kt-ink-muted); }
code { padding: 0.1em 0.3em; border-radius: 4px; background: var(--kt-code); font: 0.875em var(--kt-mono); }
pre { overflow: auto; padding: 1em; border-radius: 6px; background: var(--kt-code); }
pre code { padding: 0; background: none; }
table { width: 100%; border-collapse: collapse; font-size: 0.9375rem; }
th, td { padding: 0.45em 0.7em; border: 1px solid var(--kt-rule); text-align: left; vertical-align: top; }
th { background: var(--kt-code); }
hr { border: 0; border-top: 1px solid var(--kt-rule); margin: 2em 0; }
img { max-width: 100%; }
.media { display: block; margin: 0 auto; }
iframe.media { width: 100%; height: 85vh; border: 0; }
.plain { white-space: pre-wrap; font: 0.875rem/1.6 var(--kt-mono); }
.download { text-align: center; color: var(--kt-ink-muted); }
footer { max-width: var(--kt-measure); margin: 0 auto 2rem; padding: 0 1.5rem; color: var(--kt-ink-muted); font-size: 0.75rem; }
@media (max-width: 40rem) { main { margin: 0.75rem; padding: 1.5rem 1.25rem; } header { padding: 1rem 1rem 0; } }
@media print { header, footer { display: none; } body { background: none; } main { border: 0; margin: 0; padding: 0; } }
`;

const PAGE_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"x-robots-tag": "noindex, nofollow",
};

function page(title: string, body: string, status = 200): Response {
	const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${html(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>`;
	return new Response(document, { status, headers: PAGE_HEADERS });
}

const kindOf = (file: SharedFile): "markdown" | "image" | "pdf" | "text" | "other" => {
	const type = file.contentType.split(";")[0]?.trim() ?? "";
	if (type === "text/markdown") return "markdown";
	if (type.startsWith("image/") && type !== "image/svg+xml") return "image";
	if (type === "application/pdf") return "pdf";
	if (type.startsWith("text/")) return "text";
	return "other";
};

/** The page for one shared file. */
export function renderSharedPage(file: SharedFile): Response {
	const title = file.share.title ?? file.name;
	const kind = kindOf(file);
	const raw = html(file.rawUrl);
	const updated = new Date(file.share.updatedAt).toUTCString().replace(/ GMT$/, " UTC");
	const header = `<header><span class="name">${html(title)}</span><a href="${raw}" download="${html(file.name)}">Download</a></header>`;
	const text = file.size <= MAX_TEXT_BYTES ? new TextDecoder().decode(file.content) : undefined;
	let main: string;
	if (kind === "markdown" && text !== undefined) main = `<main>${renderMarkdown(text)}</main>`;
	else if (kind === "image") main = `<main class="wide"><img class="media" src="${raw}" alt="${html(title)}"></main>`;
	else if (kind === "pdf")
		main = `<main class="wide"><iframe class="media" src="${raw}" title="${html(title)}"></iframe></main>`;
	else if (kind === "text" && text !== undefined) main = `<main><div class="plain">${html(text)}</div></main>`;
	else
		main = `<main class="download"><p>${html(file.name)}</p><p><a href="${raw}" download="${html(file.name)}">Download the file</a></p></main>`;
	const footer = `<footer>Shared read-only from Kantel. Last changed ${html(updated)}.</footer>`;
	return page(title, `${header}\n${main}\n${footer}`);
}

/** The page for a link that doesn't open, whatever the reason. */
export function renderMissingShare(): Response {
	return page(
		"Link unavailable",
		`<main><h1>This link isn't available</h1><p>It may have been turned off, or the file may have been removed. Ask the person who shared it for a new link.</p></main>`,
		404,
	);
}
