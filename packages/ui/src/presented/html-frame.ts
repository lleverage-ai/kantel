// How a presented HTML page is shown: in an iframe sandboxed without `allow-same-origin`, so the page runs in an opaque
// origin and can reach neither the console nor its credentials; its own policy, put at the top of the page, also keeps
// it from calling out or posting a form. Scripts, styles, images and fonts from the web still load, so a chart page
// that pulls its library from a CDN works.

/** The iframe's sandbox: scripts and popups only. Never `allow-same-origin`, `allow-forms` or top navigation. */
export const HTML_FRAME_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** The page's own Content Security Policy: no requests from script, no forms, no frames, no plugins. */
export const HTML_FRAME_POLICY = [
	"default-src 'none'",
	"script-src 'unsafe-inline' https: data: blob:",
	"style-src 'unsafe-inline' https: data:",
	"img-src https: data: blob:",
	"font-src https: data:",
	"media-src https: data: blob:",
	"connect-src 'none'",
	"form-action 'none'",
	"frame-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
].join("; ");

const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_FRAME_POLICY}">`;

/** A doctype at the start of a page, after any byte order mark, white space and comments. */
const LEADING_DOCTYPE = /^(\uFEFF?(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>)/i;

/**
 * The page with its policy first: right after its doctype when it has one (so it keeps its rendering mode), else at
 * the very start. A `<meta>` there opens the document's head, so the policy holds before any of the page's own
 * markup, scripts included, is parsed.
 */
export function framedHtml(html: string): string {
	const doctype = LEADING_DOCTYPE.exec(html);
	if (doctype === null) return `${POLICY_META}${html}`;
	const end = doctype[1]?.length ?? 0;
	return `${html.slice(0, end)}${POLICY_META}${html.slice(end)}`;
}
