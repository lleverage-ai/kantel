/**
 * The sharing API's routes (`@kantel/api`'s `sharingRoutes`) over any `Sharing`: one route per contract call, with the
 * request checked against the route's schemas before the store sees it. Who the caller is stays the host's job
 * (`authenticate`); the store makes every check through `ProjectAccess` (docs/design/sharing.md).
 *
 * | Route | Contract call |
 * | --- | --- |
 * | `GET /sharing/shares` | `listShares` |
 * | `POST /sharing/shares` | `createShare` |
 * | `GET /sharing/shares/{shareId}` | `getShare` |
 * | `POST /sharing/shares/{shareId}/revoke` | `revokeShare` |
 * | `GET /sharing/requests` | `listRequests` |
 * | `POST /sharing/requests` | `requestAccess` |
 * | `GET /sharing/requests/{requestId}` | `getRequest` |
 * | `POST /sharing/requests/{requestId}/withdraw` | `withdrawRequest` |
 * | `POST /sharing/requests/{requestId}/decision` | `decideRequest` |
 * | `GET /sharing/bindings` | `listBindings` |
 * | `POST /sharing/bindings` | `addBinding` |
 * | `POST /sharing/bindings/remove` | `removeBinding` |
 * | `GET /sharing/policies?kind=&id=` | `getPolicy` |
 * | `PUT /sharing/policies` | `setPolicy` |
 * | `POST /sharing/resources` | `registerResource` |
 * | `GET /sharing/uses?sessionId=` | `listUses` |
 */
import { createRouter, STATUS_BY_CODE, sharingRoutes } from "@kantel/api";
import {
	type AccessRequestQuery,
	type BindingObject,
	type BindingQuery,
	type BindingSubject,
	type CallContext,
	isKantelError,
	KantelError,
	type ResourceRef,
	type ShareGrantee,
	type ShareQuery,
	type Sharing,
} from "@kantel/contracts";

export interface SharingApiOptions {
	readonly sharing: Sharing;
	/** Signs the request's caller in, or rejects (a `KantelError` is answered with its status). */
	readonly authenticate: (request: Request) => Promise<CallContext>;
	/** The prefix before every route. Default `/v1`. */
	readonly basePath?: string;
}

export interface SharingApi {
	/** Answers a sharing route, or resolves `undefined` when the request is for none of them. */
	fetch(request: Request): Promise<Response | undefined>;
}

/** A share, request, binding or policy is a small JSON body. */
export const SHARING_BODY_LIMIT = 16 * 1024;

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

/** A `KantelError` as its status and `{ error: { code, message } }`; anything else as a bare 500. */
export function sharingErrorResponse(error: unknown): Response {
	if (isKantelError(error)) {
		return json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
	}
	// Never echo an unexpected error's message: it may hold anything.
	return json({ error: { code: "unavailable", message: "The sharing API failed" } }, 500);
}

/** Whether `path` is one of the sharing routes under `basePath`. */
export function isSharingPath(path: string, basePath = "/v1"): boolean {
	const under = `${basePath.replace(/\/+$/, "")}/sharing`;
	return path === under || path.startsWith(`${under}/`);
}

const pageOf = (query: { readonly limit?: number; readonly cursor?: string }) => ({
	...(query.limit === undefined ? {} : { limit: query.limit }),
	...(query.cursor === undefined ? {} : { cursor: query.cursor }),
});

/** Both or neither: a filter on half a pair is a mistake the caller should hear about. */
function pair(kind: string | undefined, id: string | undefined, what: string): [string, string] | undefined {
	if (kind === undefined && id === undefined) return undefined;
	if (kind === undefined || id === undefined) {
		throw new KantelError("invalid", `Filter by ${what} with both its kind and its ID`);
	}
	return [kind, id];
}

function resourceOf(query: { readonly resourceKind?: string; readonly resourceId?: string }): ResourceRef | undefined {
	const both = pair(query.resourceKind, query.resourceId, "resource");
	return both === undefined ? undefined : { kind: both[0], id: both[1] };
}

function granteeOf(query: { readonly granteeKind?: string; readonly granteeId?: string }): ShareGrantee | undefined {
	const both = pair(query.granteeKind, query.granteeId, "grantee");
	if (both === undefined) return undefined;
	const [kind, id] = both;
	switch (kind) {
		case "project":
			return { kind, projectId: id };
		case "agent":
			return { kind, agentId: id };
		case "user":
			return { kind, userId: id };
		case "session":
			return { kind, sessionId: id };
		default:
			throw new KantelError("invalid", `"${kind}" is not a grantee kind`);
	}
}

function bindingObjectOf(query: {
	readonly objectKind?: string;
	readonly objectId?: string;
}): BindingObject | undefined {
	const both = pair(query.objectKind, query.objectId, "object");
	return both === undefined ? undefined : { kind: both[0], id: both[1] };
}

function bindingSubjectOf(query: {
	readonly subjectKind?: string;
	readonly subjectId?: string;
}): BindingSubject | undefined {
	const both = pair(query.subjectKind, query.subjectId, "subject");
	if (both === undefined) return undefined;
	const [kind, id] = both;
	switch (kind) {
		case "user":
			return { kind, userId: id };
		case "service":
			return { kind, serviceId: id };
		case "group":
			return { kind, groupId: id };
		default:
			throw new KantelError("invalid", `"${kind}" is not a binding subject kind`);
	}
}

export function createSharingApi(options: SharingApiOptions): SharingApi {
	const { sharing } = options;
	const basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
	const router = createRouter(
		sharingRoutes,
		{
			listResourceShares: (ctx: CallContext, { query }) => {
				const resource = resourceOf(query);
				const grantee = granteeOf(query);
				const filter: ShareQuery = {
					...(resource === undefined ? {} : { resource }),
					...(grantee === undefined ? {} : { grantee }),
					...(query.ownerProjectId === undefined ? {} : { ownerProjectId: query.ownerProjectId }),
					...(query.includeInactive === undefined ? {} : { includeInactive: query.includeInactive }),
				};
				return sharing.listShares(ctx, filter, pageOf(query));
			},
			createResourceShare: (ctx: CallContext, { body }) => sharing.createShare(ctx, body),
			getResourceShare: (ctx: CallContext, { params }) => sharing.getShare(ctx, params.shareId),
			revokeResourceShare: (ctx: CallContext, { params, body }) =>
				sharing.revokeShare(ctx, params.shareId, body.reason === undefined ? {} : { reason: body.reason }),
			listAccessRequests: (ctx: CallContext, { query }) => {
				const resource = resourceOf(query);
				const grantee = granteeOf(query);
				const filter: AccessRequestQuery = {
					...(resource === undefined ? {} : { resource }),
					...(grantee === undefined ? {} : { grantee }),
					...(query.status === undefined ? {} : { status: query.status }),
					...(query.ownerProjectId === undefined ? {} : { ownerProjectId: query.ownerProjectId }),
					...(query.decidable === undefined ? {} : { decidable: query.decidable }),
					...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
				};
				return sharing.listRequests(ctx, filter, pageOf(query));
			},
			requestAccess: (ctx: CallContext, { body }) => sharing.requestAccess(ctx, body),
			getAccessRequest: (ctx: CallContext, { params }) => sharing.getRequest(ctx, params.requestId),
			withdrawAccessRequest: (ctx: CallContext, { params }) => sharing.withdrawRequest(ctx, params.requestId),
			decideAccessRequest: (ctx: CallContext, { params, body }) => sharing.decideRequest(ctx, params.requestId, body),
			listResourceBindings: (ctx: CallContext, { query }) => {
				const object = bindingObjectOf(query);
				const subject = bindingSubjectOf(query);
				const filter: BindingQuery = {
					...(object === undefined ? {} : { object }),
					...(subject === undefined ? {} : { subject }),
					...(query.relation === undefined ? {} : { relation: query.relation }),
				};
				return sharing.listBindings(ctx, filter, pageOf(query));
			},
			addResourceBinding: (ctx: CallContext, { body }) => sharing.addBinding(ctx, body),
			removeResourceBinding: async (ctx: CallContext, { body }) => {
				await sharing.removeBinding(ctx, body);
				return undefined;
			},
			getResourcePolicy: (ctx: CallContext, { query }) => sharing.getPolicy(ctx, { kind: query.kind, id: query.id }),
			setResourcePolicy: (ctx: CallContext, { body }) => sharing.setPolicy(ctx, body.resource, body.policy),
			registerResource: (ctx: CallContext, { body }) => sharing.registerResource(ctx, body),
			listShareUses: async (ctx: CallContext, { query }) => ({
				items: await sharing.listUses(ctx, { sessionId: query.sessionId }),
			}),
		},
		{ basePath, maxBodyBytes: SHARING_BODY_LIMIT },
	);

	return {
		async fetch(request) {
			if (!isSharingPath(new URL(request.url).pathname, basePath)) return undefined;
			try {
				const ctx = await options.authenticate(request);
				const answered = await router(ctx, request);
				if (answered !== undefined) return answered;
				return json({ error: { code: "not_found", message: "No such route" } }, 404);
			} catch (error) {
				return sharingErrorResponse(error);
			}
		},
	};
}
