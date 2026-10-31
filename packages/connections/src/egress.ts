/**
 * The egress gate as a sandbox's way out (#331): `connectionEgress` gives the in-process isolate (Cloudflare and
 * self-hosted alike, `IsolateEgress` in `@kantel/sandbox/egress`) its fetch and environment.
 *
 * - Each command gets `KANTEL_CONNECTION_<NAME>` set to the placeholder of each connection its session may use.
 * - Each request goes to `ConnectionsService.egress`: refused, it answers 403 with an `EgressRefusal` as JSON; with a
 *   placeholder, the service sends it with the credential on and the credential cut out of the answer; with none, it
 *   goes out as it is (`pass`), with no credential, as the isolate's requests did before the gate.
 */
import { type CallContext, isKantelError, type SandboxLease, systemContext } from "@kantel/contracts";
import { type EgressDraft, refusal, refusalResponse } from "./egress-gate.ts";
import type { Fetch } from "./ports.ts";
import type { ConnectionsService } from "./service.ts";

const CONTEXT = systemContext("sandbox.egress");
/** The most of a passed-through answer read back to the sandbox. */
const PASS_LIMIT = 10 * 1024 * 1024;

/** One request as the sandbox made it (`EgressRequest` in `@kantel/sandbox/egress`). */
export interface SandboxEgressRequest extends EgressDraft {
	readonly signal?: AbortSignal;
}

export interface SandboxEgressResponse {
	readonly status: number;
	readonly statusText: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
	readonly url: string;
}

export interface ConnectionEgress {
	forCommand(input: { readonly ctx: CallContext; readonly lease: SandboxLease }): Promise<{
		readonly fetch: (request: SandboxEgressRequest) => Promise<SandboxEgressResponse>;
		readonly env?: { readonly [name: string]: string };
	}>;
}

export interface ConnectionEgressOptions {
	/** The service, or a function for one built later (`undefined` until then: requests go out as they are). */
	readonly connections: ConnectionsService | (() => ConnectionsService | undefined);
	/** How a request with no placeholder goes out. Default: the global fetch. */
	readonly fetch?: Fetch;
}

async function readAll(response: Response): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (reader === undefined) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < PASS_LIMIT) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.byteLength;
	}
	await reader.cancel().catch(() => undefined);
	const out = new Uint8Array(Math.min(size, PASS_LIMIT));
	let offset = 0;
	for (const chunk of chunks) {
		const part = chunk.subarray(0, Math.max(0, out.length - offset));
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function refused(body: Parameters<typeof refusalResponse>[0], url: string): SandboxEgressResponse {
	const response = refusalResponse(body);
	return { status: response.status, statusText: "Forbidden", headers: response.headers, body: response.body, url };
}

/** The egress gate for the in-process isolate. */
export function connectionEgress(options: ConnectionEgressOptions): ConnectionEgress {
	const fetch: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const service = () => (typeof options.connections === "function" ? options.connections() : options.connections);
	return {
		async forCommand({ ctx, lease }) {
			const session = { organisationId: ctx.organisationId, sessionId: lease.sessionId };
			const connections = service();
			const env =
				connections === undefined
					? {}
					: await connections.egressEnvironment(CONTEXT, session).catch(() => ({}) as Record<string, string>);
			return {
				env,
				async fetch(request) {
					const { signal, ...draft } = request;
					const current = service();
					if (current !== undefined) {
						let outcome: Awaited<ReturnType<ConnectionsService["egress"]>>;
						try {
							outcome = await current.egress(
								{ ...CONTEXT, ...(signal === undefined ? {} : { signal }) },
								session,
								draft,
							);
						} catch (error) {
							// The gate failing never lets a request out unchecked.
							const message = isKantelError(error) ? error.message : "The egress gate could not decide";
							return refused(refusal("egress_unavailable", `${message}; nothing was sent.`), request.url);
						}
						if (outcome.kind === "refused") return refused(outcome.refusal, request.url);
						if (outcome.kind === "sent") {
							return {
								status: outcome.status,
								statusText: outcome.statusText,
								headers: outcome.headers,
								body: outcome.body,
								url: outcome.url,
							};
						}
					}
					// No placeholder and no raw secret: it goes out as it is, with no credential.
					const method = draft.method.toUpperCase();
					const response = await fetch(draft.url, {
						method,
						headers: draft.headers.map(([name, value]) => [name, value] as [string, string]),
						...(draft.body === undefined || method === "GET" || method === "HEAD"
							? {}
							: { body: new Uint8Array(draft.body) }),
						redirect: "manual",
						...(signal === undefined ? {} : { signal }),
					});
					const headers: Record<string, string> = {};
					response.headers.forEach((value, name) => {
						if (name !== "content-length" && name !== "content-encoding") headers[name] = value;
					});
					return {
						status: response.status,
						statusText: response.statusText,
						headers,
						body: await readAll(response),
						url: draft.url,
					};
				},
			};
		},
	};
}
