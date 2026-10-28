/**
 * The vault approval API: the HTTP surface the console's vault page calls to read a proposal, decide it (narrowed, with
 * the binding code the approver picked) and list and stop grants. A typed client for it, and `withProjectAccess`, which
 * makes the vault contract's project checks in front of a vault that cannot make them itself. Portable (fetch `Request`
 * and `Response`), so any gateway serves the same handler.
 *
 * Routes, under `basePath` (default `APPROVAL_API_BASE`, `/v1/vault`):
 *
 * | Route | Calls | Returns |
 * | --- | --- | --- |
 * | `GET /viewer` | | `ApprovalViewer` |
 * | `GET /proposals?status=&sessionId=&limit=&cursor=` | `listProposals` | `Page<Proposal>` |
 * | `GET /proposals/:id` | `getProposal` | `Proposal` |
 * | `GET /proposals/:id/approval` | `approvalView` | `ApprovalView` |
 * | `GET /proposals/:id/requester` | `getProposal`, then the host's names | `RequesterNames` |
 * | `POST /proposals/:id/decision` | `decide` | `Decision` |
 * | `GET /items/:id` | `getItem` | `VaultItem` (never a value: the vault holds none in it) |
 * | `GET /grants?status=&sessionId=&limit=&cursor=` | `listGrants` | `Page<Grant>` |
 * | `GET /grants/:id` | `getGrant` | `Grant` |
 * | `POST /grants/:id/revoke` | `revokeGrant` | `Grant` |
 *
 * Every route is a person's call (or a service's acting for one): `authenticate` turns the request into its
 * `CallContext`, and the vault decides what that caller may do, as the contract says. A decision's body is a
 * `DecisionInput` without `proposalId` (the path names it): a wrong binding code is refused (`refused`) and audited by
 * the vault as `vault.binding_code.mismatch`, and a narrowing that widens the terms is `invalid`. Errors are
 * `{ "error": { "code", "message" } }` with one status per `ErrorCode`, never carry a value, and every response is
 * `cache-control: no-store`.
 */
import {
	type ApprovalView,
	type CallContext,
	type Decision,
	type DecisionInput,
	type ErrorCode,
	type Grant,
	type GrantStatus,
	HarbourError,
	isHarbourError,
	type Narrowing,
	type Page,
	type PageRequest,
	type ProjectAccess,
	type Proposal,
	type ProposalStatus,
	type Vault,
	type VaultItem,
} from "@harbour/contracts";
import { itemScope, proposalScope, type Scope, scoped, selectorScope } from "./engine.ts";
import { HTTP_METHODS } from "./index.ts";

export const APPROVAL_API_BASE = "/v1/vault";

/** The vault calls the approval API makes. */
export type ApprovalVault = Pick<
	Vault,
	"getProposal" | "listProposals" | "approvalView" | "decide" | "getItem" | "getGrant" | "listGrants" | "revokeGrant"
>;

/** Who the API took the caller for, and their name when the host knows it. */
export interface ApprovalViewer {
	readonly actor: CallContext["actor"];
	readonly organisationId: string;
	readonly name?: string;
}

/** A proposal's requester in names a person reads, from the host's identity and session directories. */
export interface RequesterNames {
	readonly organisation?: string;
	readonly project?: string;
	/** The agent's name, or the service or person that proposed it. */
	readonly agent?: string;
	readonly session?: string;
	/** The person behind the session, when known. */
	readonly person?: string;
}

/** What `POST /proposals/:id/decision` takes: a `DecisionInput` without the proposal, which the path names. */
export type DecisionBody = Omit<DecisionInput, "proposalId">;

const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["pending", "approved", "denied", "expired", "withdrawn"];
const GRANT_STATUSES: readonly GrantStatus[] = ["active", "exhausted", "expired", "revoked"];
/** The largest decision body: a narrowing, a note and at most one pasted secret. */
export const APPROVAL_BODY_LIMIT = 64 * 1024;

/** Every `ErrorCode` and the status it answers with, as the egress decision API does. */
const STATUS: { readonly [code in ErrorCode]: number } = {
	invalid: 400,
	forbidden: 403,
	refused: 403,
	not_found: 404,
	conflict: 409,
	expired: 410,
	exhausted: 429,
	aborted: 499,
	not_supported: 501,
	unavailable: 503,
};

const isErrorCode = (code: unknown): code is ErrorCode => typeof code === "string" && Object.hasOwn(STATUS, code);

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The vault contract's project checks (CONTRACT.md, "Project access"), made in front of `vault` with `access`, for a
 * vault that has no `ProjectAccess` of its own: the Cloudflare VaultDO, whose project roles and sessions live in the
 * stack's runtime. Each record is read first as the organisation's (the vault's own check), then the caller needs
 * viewer on its project and session to read it and operator to open the approval view, decide or stop it. Agents may
 * neither open the approval view nor decide. A list keeps what the caller may view; its pages may hold fewer than
 * `limit` items, and `nextCursor` still says whether more follow. A list for one session needs viewer on that session.
 * A refusal is `access`'s: `forbidden`, audited once as `access.denied`.
 *
 * Don't put it in front of a vault built with `access`: that vault checks already, and a refusal would be audited twice.
 */
export function withProjectAccess(vault: ApprovalVault, access: ProjectAccess): ApprovalVault {
	const forbidAgent = (ctx: CallContext, what: string) => {
		if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", `An agent cannot ${what}`);
	};
	const visible = async <T>(ctx: CallContext, records: readonly T[], scopeOf: (record: T) => Scope) => {
		const kept: T[] = [];
		for (const record of records) {
			const scope = scopeOf(record);
			if (!scoped(scope) || (await access.allows(ctx, { ...scope, needed: "viewer" }))) kept.push(record);
		}
		return kept;
	};
	const proposalSubject = (id: string) => ({ kind: "vault.proposal", id });
	const grantSubject = (id: string) => ({ kind: "vault.grant", id });
	/** The proposal's project only: approving is decided on the project, as the vault does. */
	const projectOf = (proposal: Proposal): Scope =>
		proposal.projectId === undefined ? {} : { projectId: proposal.projectId };

	return {
		async getProposal(ctx, proposalId) {
			const proposal = await vault.getProposal(ctx, proposalId);
			const scope = proposalScope(proposal);
			if (scoped(scope)) {
				const subject = proposalSubject(proposalId);
				await access.require(ctx, { ...scope, needed: "viewer", operation: "vault.getProposal", subject });
			}
			return proposal;
		},
		async listProposals(ctx, filter, page) {
			const sessionId = filter?.sessionId;
			if (sessionId !== undefined) {
				await access.require(ctx, { sessionId, needed: "viewer", operation: "vault.listProposals" });
				return vault.listProposals(ctx, filter, page);
			}
			const found = await vault.listProposals(ctx, filter, page);
			const items = await visible(ctx, found.items, proposalScope);
			return found.nextCursor === undefined ? { items } : { items, nextCursor: found.nextCursor };
		},
		async approvalView(ctx, proposalId) {
			forbidAgent(ctx, "open the approval view");
			const proposal = await vault.getProposal(ctx, proposalId);
			const subject = proposalSubject(proposalId);
			await access.require(ctx, {
				...projectOf(proposal),
				needed: "operator",
				operation: "vault.approvalView",
				subject,
			});
			return vault.approvalView(ctx, proposalId);
		},
		async decide(ctx, input) {
			forbidAgent(ctx, "decide proposals");
			const proposal = await vault.getProposal(ctx, input.proposalId);
			const subject = proposalSubject(proposal.id);
			await access.require(ctx, { ...projectOf(proposal), needed: "operator", operation: "vault.decide", subject });
			return vault.decide(ctx, input);
		},
		async getItem(ctx, itemId) {
			const item = await vault.getItem(ctx, itemId);
			const scope = itemScope(item);
			if (scoped(scope)) {
				const subject = { kind: "vault.item", id: itemId };
				await access.require(ctx, { ...scope, needed: "viewer", operation: "vault.getItem", subject });
			}
			return item;
		},
		async getGrant(ctx, grantId) {
			const grant = await vault.getGrant(ctx, grantId);
			const scope = selectorScope(grant.selector);
			if (scoped(scope)) {
				const subject = grantSubject(grantId);
				await access.require(ctx, { ...scope, needed: "viewer", operation: "vault.getGrant", subject });
			}
			return grant;
		},
		async listGrants(ctx, filter, page) {
			const sessionId = filter?.sessionId;
			if (sessionId !== undefined) {
				await access.require(ctx, { sessionId, needed: "viewer", operation: "vault.listGrants" });
				return vault.listGrants(ctx, filter, page);
			}
			const found = await vault.listGrants(ctx, filter, page);
			const items = await visible(ctx, found.items, (grant) => selectorScope(grant.selector));
			return found.nextCursor === undefined ? { items } : { items, nextCursor: found.nextCursor };
		},
		async revokeGrant(ctx, grantId, reason) {
			forbidAgent(ctx, "revoke grants");
			const grant = await vault.getGrant(ctx, grantId);
			const scope = selectorScope(grant.selector);
			const subject = grantSubject(grantId);
			await access.require(ctx, { ...scope, needed: "operator", operation: "vault.revokeGrant", subject });
			return vault.revokeGrant(ctx, grantId, reason);
		},
	};
}

export interface VaultApprovalApiOptions {
	readonly vault: ApprovalVault;
	/**
	 * The caller's context, from the request. Throw a `HarbourError` to refuse; its code sets the status. A gateway that
	 * answers sign-in failures itself (401 with a challenge) authenticates before calling the handler.
	 */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/**
	 * Project access, for a vault built without it: the API makes the contract's project checks first
	 * (`withProjectAccess`). Leave it out for a vault that checks itself.
	 */
	readonly access?: ProjectAccess;
	/** The requester's names for `GET /proposals/:id/requester`. Without it that route answers `{}`. */
	readonly describeRequester?: (ctx: CallContext, proposal: Proposal) => Promise<RequesterNames>;
	/** The caller's display name for `GET /viewer`. Without it, or when it fails, the viewer has no name. */
	readonly viewerName?: (ctx: CallContext) => Promise<string | undefined>;
	/** Route prefix, without a trailing slash. Default `APPROVAL_API_BASE`. */
	readonly basePath?: string;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
	});
}

function errorResponse(status: number, code: string, message: string, headers?: Record<string, string>): Response {
	return json(status, { error: { code, message } }, headers);
}

/** The HTTP status for a Harbour error code. */
export function approvalErrorStatus(code: ErrorCode): number {
	return STATUS[code] ?? 500;
}

type Route =
	| { readonly name: "viewer" }
	| { readonly name: "proposals" }
	| { readonly name: "proposal" | "approval" | "requester" | "decision"; readonly id: string }
	| { readonly name: "item"; readonly id: string }
	| { readonly name: "grants" }
	| { readonly name: "grant" | "revoke"; readonly id: string };

const METHOD: { readonly [name in Route["name"]]: "GET" | "POST" } = {
	viewer: "GET",
	proposals: "GET",
	proposal: "GET",
	approval: "GET",
	requester: "GET",
	decision: "POST",
	item: "GET",
	grants: "GET",
	grant: "GET",
	revoke: "POST",
};

function segment(value: string): string | undefined {
	try {
		const decoded = decodeURIComponent(value);
		return decoded === "" ? undefined : decoded;
	} catch {
		return undefined;
	}
}

function routeOf(path: string, base: string): Route | undefined {
	if (!path.startsWith(`${base}/`)) return undefined;
	const parts = path.slice(base.length + 1).split("/");
	const id = parts[1] === undefined ? undefined : segment(parts[1]);
	switch (parts[0]) {
		case "viewer":
			return parts.length === 1 ? { name: "viewer" } : undefined;
		case "proposals":
			if (parts.length === 1) return { name: "proposals" };
			if (id === undefined) return undefined;
			if (parts.length === 2) return { name: "proposal", id };
			if (parts.length !== 3) return undefined;
			if (parts[2] === "approval") return { name: "approval", id };
			if (parts[2] === "requester") return { name: "requester", id };
			if (parts[2] === "decision") return { name: "decision", id };
			return undefined;
		case "items":
			return id !== undefined && parts.length === 2 ? { name: "item", id } : undefined;
		case "grants":
			if (parts.length === 1) return { name: "grants" };
			if (id === undefined) return undefined;
			if (parts.length === 2) return { name: "grant", id };
			return parts.length === 3 && parts[2] === "revoke" ? { name: "revoke", id } : undefined;
		default:
			return undefined;
	}
}

/** Reads `limit` and `cursor`; a limit must be a whole number from 1 to 500. */
function pageOf(params: URLSearchParams): PageRequest {
	const limit = params.get("limit");
	const cursor = params.get("cursor");
	let parsed: number | undefined;
	if (limit !== null) {
		parsed = Number(limit);
		if (!/^\d+$/.test(limit) || parsed < 1 || parsed > 500) {
			throw new HarbourError("invalid", "limit must be a whole number from 1 to 500");
		}
	}
	return {
		...(parsed === undefined ? {} : { limit: parsed }),
		...(cursor === null || cursor === "" ? {} : { cursor }),
	};
}

function filterOf<S extends string>(
	params: URLSearchParams,
	statuses: readonly S[],
): { readonly status?: S; readonly sessionId?: string } {
	for (const name of params.keys()) {
		if (!["status", "sessionId", "limit", "cursor"].includes(name)) {
			throw new HarbourError("invalid", `Unknown parameter ${name}`);
		}
	}
	const status = params.get("status");
	const sessionId = params.get("sessionId");
	if (status !== null && !statuses.includes(status as S)) throw new HarbourError("invalid", `Unknown status ${status}`);
	return {
		...(status === null ? {} : { status: status as S }),
		...(sessionId === null || sessionId === "" ? {} : { sessionId }),
	};
}

const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const optionalCount = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value));

/** Rejects with `invalid` unless `body` has the shape of a `DecisionBody` for `proposalId`. */
function decisionOf(body: unknown, proposalId: string): DecisionInput {
	if (!isRecord(body)) throw new HarbourError("invalid", "A decision must be a JSON object");
	if (body.proposalId !== undefined && body.proposalId !== proposalId) {
		throw new HarbourError("invalid", "The decision names another proposal than its path");
	}
	if (body.outcome !== "approve" && body.outcome !== "deny") {
		throw new HarbourError("invalid", 'A decision\'s outcome is "approve" or "deny"');
	}
	for (const field of ["termsHash", "pickedCode", "secretValue", "note"] as const) {
		if (!optionalString(body[field])) throw new HarbourError("invalid", `${field} must be a string`);
	}
	const narrowing = body.narrowing;
	if (narrowing !== undefined) {
		if (!isRecord(narrowing)) throw new HarbourError("invalid", "A narrowing must be a JSON object");
		const methods = narrowing.methods;
		if (
			methods !== undefined &&
			(!Array.isArray(methods) || !methods.every((method) => HTTP_METHODS.includes(method)))
		) {
			throw new HarbourError("invalid", "A narrowing's methods must be known HTTP methods");
		}
		if (!optionalString(narrowing.pathPrefix) || !optionalCount(narrowing.ttlMs) || !optionalCount(narrowing.maxUses)) {
			throw new HarbourError("invalid", "A narrowing has a path prefix, a ttlMs and a maxUses at most");
		}
	}
	const input: DecisionInput = {
		proposalId,
		outcome: body.outcome,
		...(body.termsHash === undefined ? {} : { termsHash: body.termsHash as string }),
		...(body.pickedCode === undefined ? {} : { pickedCode: body.pickedCode as string }),
		...(narrowing === undefined ? {} : { narrowing: narrowing as Narrowing }),
		...(body.secretValue === undefined ? {} : { secretValue: body.secretValue as string }),
		...(body.note === undefined ? {} : { note: body.note as string }),
	};
	return input;
}

/** The body as JSON, refused past `APPROVAL_BODY_LIMIT` bytes. */
async function readJson(request: Request): Promise<unknown> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > APPROVAL_BODY_LIMIT) throw new HarbourError("invalid", "The body is too large");
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > APPROVAL_BODY_LIMIT) {
		throw new HarbourError("invalid", "The body is too large");
	}
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new HarbourError("invalid", "The body must be JSON");
	}
}

/**
 * Serves the vault approval API. Paths outside it are `not_found`, other methods 405 (`not_supported`), and errors
 * other than `HarbourError`s 500 with no detail.
 */
export function createVaultApprovalApi(options: VaultApprovalApiOptions): (request: Request) => Promise<Response> {
	const base = (options.basePath ?? APPROVAL_API_BASE).replace(/\/+$/, "");
	const vault = options.access === undefined ? options.vault : withProjectAccess(options.vault, options.access);

	return async (request) => {
		const url = new URL(request.url);
		const route = routeOf(url.pathname, base);
		if (route === undefined) return errorResponse(404, "not_found", "No such route");
		const method = METHOD[route.name];
		if (request.method !== method) return errorResponse(405, "not_supported", `Use ${method}`, { allow: method });
		try {
			const caller = await options.authenticate(request);
			const ctx: CallContext = { ...caller, signal: request.signal };
			switch (route.name) {
				case "viewer": {
					const name = await options.viewerName?.(ctx).catch(() => undefined);
					const viewer: ApprovalViewer = {
						actor: ctx.actor,
						organisationId: ctx.organisationId,
						...(name === undefined ? {} : { name }),
					};
					return json(200, viewer);
				}
				case "proposals": {
					const filter = filterOf(url.searchParams, PROPOSAL_STATUSES);
					return json(200, await vault.listProposals(ctx, filter, pageOf(url.searchParams)));
				}
				case "proposal":
					return json(200, await vault.getProposal(ctx, route.id));
				case "approval":
					return json(200, await vault.approvalView(ctx, route.id));
				case "requester": {
					const proposal = await vault.getProposal(ctx, route.id);
					const names = (await options.describeRequester?.(ctx, proposal).catch(() => undefined)) ?? {};
					return json(200, names);
				}
				case "decision":
					return json(200, await vault.decide(ctx, decisionOf(await readJson(request), route.id)));
				case "item":
					return json(200, await vault.getItem(ctx, route.id));
				case "grants": {
					const filter = filterOf(url.searchParams, GRANT_STATUSES);
					return json(200, await vault.listGrants(ctx, filter, pageOf(url.searchParams)));
				}
				case "grant":
					return json(200, await vault.getGrant(ctx, route.id));
				case "revoke": {
					const body = await readJson(request);
					if (!isRecord(body) || !optionalString(body.reason)) {
						throw new HarbourError("invalid", "A revocation's body is { reason? } with a string reason");
					}
					return json(200, await vault.revokeGrant(ctx, route.id, body.reason as string | undefined));
				}
			}
		} catch (error) {
			if (isHarbourError(error) && isErrorCode(error.code)) {
				return errorResponse(approvalErrorStatus(error.code), error.code, error.message);
			}
			return errorResponse(500, "unavailable", "The vault approval API failed");
		}
	};
}

export interface VaultApprovalClientOptions {
	/** Where the API is served, including its base path. Default `APPROVAL_API_BASE`, on the page's own origin. */
	readonly baseUrl?: string;
	/** Headers for every call, such as credentials. The browser behind Cloudflare Access needs none. */
	readonly headers?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
	readonly fetch?: typeof fetch;
}

/** The approval API's calls, as the signed-in caller. */
export interface VaultApprovalClient {
	viewer(signal?: AbortSignal): Promise<ApprovalViewer>;
	getProposal(proposalId: string, signal?: AbortSignal): Promise<Proposal>;
	listProposals(
		filter?: { readonly status?: ProposalStatus; readonly sessionId?: string },
		page?: PageRequest,
		signal?: AbortSignal,
	): Promise<Page<Proposal>>;
	approvalView(proposalId: string, signal?: AbortSignal): Promise<ApprovalView>;
	requester(proposalId: string, signal?: AbortSignal): Promise<RequesterNames>;
	decide(input: DecisionInput, signal?: AbortSignal): Promise<Decision>;
	getItem(itemId: string, signal?: AbortSignal): Promise<VaultItem>;
	getGrant(grantId: string, signal?: AbortSignal): Promise<Grant>;
	listGrants(
		filter?: { readonly status?: GrantStatus; readonly sessionId?: string },
		page?: PageRequest,
		signal?: AbortSignal,
	): Promise<Page<Grant>>;
	revokeGrant(grantId: string, reason?: string, signal?: AbortSignal): Promise<Grant>;
}

/**
 * A client for the vault approval API. Failures reject with a `HarbourError` carrying the server's code; a 401 is
 * `forbidden` with `details.authentication: "invalid"`, and a network failure `unavailable`.
 */
export function createVaultApprovalClient(options: VaultApprovalClientOptions = {}): VaultApprovalClient {
	const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const base = (options.baseUrl ?? APPROVAL_API_BASE).replace(/\/+$/, "");
	const id = (value: string) => encodeURIComponent(value);

	async function call<T>(path: string, init: { body?: unknown; signal: AbortSignal | undefined }): Promise<T> {
		const headers = new Headers((await options.headers?.()) ?? {});
		if (init.body !== undefined) headers.set("content-type", "application/json");
		let response: Response;
		try {
			response = await doFetch(`${base}${path}`, {
				method: init.body === undefined ? "GET" : "POST",
				headers,
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				...(init.signal === undefined ? {} : { signal: init.signal }),
			});
		} catch (error) {
			if (init.signal?.aborted) throw error;
			throw new HarbourError("unavailable", "Can't reach the vault. Check your connection.");
		}
		const parsed = (await response.json().catch(() => undefined)) as unknown;
		if (response.ok) return parsed as T;
		const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
		const message = typeof error?.message === "string" ? error.message : `The vault answered ${response.status}`;
		if (response.status === 401) throw new HarbourError("forbidden", message, { authentication: "invalid" });
		throw new HarbourError(isErrorCode(error?.code) ? error.code : "unavailable", message);
	}
	const query = (filter: { readonly status?: string; readonly sessionId?: string } = {}, page: PageRequest = {}) => {
		const params = new URLSearchParams();
		if (filter.status !== undefined) params.set("status", filter.status);
		if (filter.sessionId !== undefined) params.set("sessionId", filter.sessionId);
		if (page.limit !== undefined) params.set("limit", String(page.limit));
		if (page.cursor !== undefined) params.set("cursor", page.cursor);
		const text = params.toString();
		return text === "" ? "" : `?${text}`;
	};

	return {
		viewer: (signal) => call("/viewer", { signal }),
		getProposal: (proposalId, signal) => call(`/proposals/${id(proposalId)}`, { signal }),
		listProposals: (filter, page, signal) => call(`/proposals${query(filter, page)}`, { signal }),
		approvalView: (proposalId, signal) => call(`/proposals/${id(proposalId)}/approval`, { signal }),
		requester: (proposalId, signal) => call(`/proposals/${id(proposalId)}/requester`, { signal }),
		decide: ({ proposalId, ...body }, signal) => call(`/proposals/${id(proposalId)}/decision`, { body, signal }),
		getItem: (itemId, signal) => call(`/items/${id(itemId)}`, { signal }),
		getGrant: (grantId, signal) => call(`/grants/${id(grantId)}`, { signal }),
		listGrants: (filter, page, signal) => call(`/grants${query(filter, page)}`, { signal }),
		revokeGrant: (grantId, reason, signal) =>
			call(`/grants/${id(grantId)}/revoke`, { body: reason === undefined ? {} : { reason }, signal }),
	};
}

/**
 * The client as the contract's calls, so code written against a `Vault` (such as `@harbour/ui`'s `loadVaultRequest`)
 * runs over HTTP. The context is the API's to decide; the `ctx` passed here only carries the abort signal.
 */
export function approvalClientAsVault(client: VaultApprovalClient): ApprovalVault {
	return {
		getProposal: (ctx, proposalId) => client.getProposal(proposalId, ctx.signal),
		listProposals: (ctx, filter, page) => client.listProposals(filter, page, ctx.signal),
		approvalView: (ctx, proposalId) => client.approvalView(proposalId, ctx.signal),
		decide: (ctx, input) => client.decide(input, ctx.signal),
		getItem: (ctx, itemId) => client.getItem(itemId, ctx.signal),
		getGrant: (ctx, grantId) => client.getGrant(grantId, ctx.signal),
		listGrants: (ctx, filter, page) => client.listGrants(filter, page, ctx.signal),
		revokeGrant: (ctx, grantId, reason) => client.revokeGrant(grantId, reason, ctx.signal),
	};
}
