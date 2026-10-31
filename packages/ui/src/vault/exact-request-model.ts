/**
 * The request page's view of one exact request (#333): its URL as it goes out, its body formatted when that helps,
 * and every character a person can't see marked, so what they approve is what they read.
 */
import type { ApprovalRequest, ConnectionRuleInput, Proposal } from "@kantel/contracts";

/** A run of text: as it reads, or one character no one can see, named by its code point. */
export type TextRun =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "hidden"; readonly code: string; readonly name: string };

/** Names for the characters most often used to hide something in plain sight. */
const NAMES: Readonly<Record<number, string>> = {
	0: "NUL",
	13: "CR",
	27: "ESC",
	127: "DEL",
	160: "NBSP",
	173: "SHY",
	8203: "ZWSP",
	8204: "ZWNJ",
	8205: "ZWJ",
	8206: "LRM",
	8207: "RLM",
	8234: "LRE",
	8235: "RLE",
	8236: "PDF",
	8237: "LRO",
	8238: "RLO",
	8288: "WJ",
	8294: "LRI",
	8295: "RLI",
	8296: "FSI",
	8297: "PDI",
	65279: "BOM",
};

/**
 * Whether a character can't be seen, or reads as another: control characters (but a newline or tab, which show as
 * layout), bidirectional overrides, zero-width characters, odd spaces, tag characters and private-use ones.
 */
export function isHidden(code: number): boolean {
	if (code === 0x0a || code === 0x09) return false;
	return (
		code < 0x20 ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0xa0 ||
		code === 0xad ||
		code === 0x034f ||
		code === 0x061c ||
		code === 0x115f ||
		code === 0x1160 ||
		code === 0x17b4 ||
		code === 0x17b5 ||
		code === 0x180e ||
		(code >= 0x2000 && code <= 0x200f) ||
		(code >= 0x2028 && code <= 0x202f) ||
		(code >= 0x205f && code <= 0x206f) ||
		code === 0x3000 ||
		code === 0x3164 ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		code === 0xfeff ||
		code === 0xffa0 ||
		(code >= 0xfff0 && code <= 0xfffb) ||
		(code >= 0xe0000 && code <= 0xe007f) ||
		(code >= 0xe000 && code <= 0xf8ff) ||
		(code >= 0xf0000 && code <= 0x10ffff)
	);
}

/** `text` as runs, with each hidden character on its own. */
export function markHidden(text: string): TextRun[] {
	const runs: TextRun[] = [];
	let plain = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (!isHidden(code)) {
			plain += char;
			continue;
		}
		if (plain !== "") runs.push({ kind: "text", text: plain });
		plain = "";
		const hex = code.toString(16).toUpperCase().padStart(4, "0");
		runs.push({ kind: "hidden", code: `U+${hex}`, name: NAMES[code] ?? `U+${hex}` });
	}
	if (plain !== "") runs.push({ kind: "text", text: plain });
	return runs;
}

/** How many hidden characters `text` has. */
export function hiddenCount(text: string): number {
	let count = 0;
	for (const char of text) if (isHidden(char.codePointAt(0) ?? 0)) count += 1;
	return count;
}

/** The URL as it goes out: the default port left out, the query exactly as written, which the digest covers. */
export function requestUrl(request: Pick<ApprovalRequest, "scheme" | "host" | "port" | "path" | "search">): string {
	const port = request.port === (request.scheme === "https" ? 443 : 80) ? "" : `:${request.port}`;
	return `${request.scheme}://${request.host}${port}${request.path}${request.search === "" ? "" : `?${request.search}`}`;
}

/** The body, formatted for reading when it is JSON; otherwise as sent. `formatted` says which. */
export function readableBody(body: string, contentType: string | undefined): { text: string; formatted: boolean } {
	const json = contentType === undefined || /json/i.test(contentType);
	if (!json || body.trim() === "") return { text: body, formatted: false };
	try {
		const pretty = JSON.stringify(JSON.parse(body), null, 2);
		return pretty === body ? { text: body, formatted: false } : { text: pretty, formatted: true };
	} catch {
		return { text: body, formatted: false };
	}
}

/** A size in bytes, in words. */
export function byteSize(text: string): string {
	const bytes = new TextEncoder().encode(text).byteLength;
	if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
	return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/**
 * "Always allow requests like this" (#333): an allow rule for the agent that sent the request (its session when it has
 * no agent), on the same method and path, or the same MCP tool. Not the body or the query: those vary in requests
 * like it. The server refuses a rule that doesn't cover the request it came from.
 */
export function alwaysAllowRule(
	proposal: Pick<Proposal, "id" | "requester" | "terms">,
): ConnectionRuleInput | undefined {
	const request = proposal.terms.request;
	if (request === undefined) return undefined;
	const { agentId, sessionId } = proposal.requester;
	const who: ConnectionRuleInput["who"] | undefined =
		agentId !== undefined
			? { kind: "agent", agentId }
			: sessionId !== undefined
				? { kind: "session", sessionId }
				: undefined;
	if (who === undefined || request.kind === "mcp_tools") return undefined;
	return {
		who,
		what:
			request.kind === "mcp_call" && request.tool !== undefined
				? { kind: "tool", tool: request.tool }
				: { kind: "endpoint", method: request.method, path: request.path, host: request.host },
		action: "allow",
		note: `From approval ${proposal.id}`,
	};
}

/** The rule in a few words, for the button that saves it. */
export function ruleSummary(rule: ConnectionRuleInput): string {
	const what =
		rule.what.kind === "tool"
			? `the ${rule.what.tool} tool`
			: rule.what.kind === "endpoint"
				? `${rule.what.method} ${rule.what.path}`
				: "anything";
	const who = rule.who.kind === "agent" ? "this agent" : rule.who.kind === "session" ? "this session" : "any agent";
	return `${what}, for ${who}`;
}
