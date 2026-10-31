// What the registry's tests share: an access check by role, an audit that records, and a socket that hands its frames
// to an in-memory MCP server.
import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	KantelError,
	type ProjectAccess,
	type Role,
} from "@kantel/contracts";
import type { TunnelSocket } from "../src/connection.ts";
import type { AcceptedTunnel } from "../src/hub.ts";
import { type FakeHandler, fakeServer } from "./fake-server.ts";

export const ORG = "org-tools";
export const person = (userId: string, organisationId = ORG): CallContext => ({
	actor: { kind: "human", userId },
	organisationId,
});

const RANK: { readonly [role in Role]: number } = { viewer: 1, operator: 2, admin: 3 };

/**
 * Roles by user: `"*"` is the organisation, which counts in every project as `createProjectAccess`'s does; a project ID
 * is that project alone.
 */
export function roleAccess(roles: { readonly [userId: string]: { readonly [scope: string]: Role } }): ProjectAccess {
	const passes = (ctx: CallContext, check: { readonly projectId?: string; readonly needed: Role }) => {
		if (ctx.actor.kind === "system") return true;
		if (ctx.actor.kind !== "human") return false;
		const mine = roles[ctx.actor.userId] ?? {};
		const organisation = mine["*"];
		const project = check.projectId === undefined ? undefined : mine[check.projectId];
		const held = Math.max(
			organisation === undefined ? 0 : RANK[organisation],
			project === undefined ? 0 : RANK[project],
		);
		return held >= RANK[check.needed];
	};
	return {
		async require(ctx, check) {
			if (!passes(ctx, check)) throw new KantelError("forbidden", "The caller may not do this in this project");
			return { scope: { kind: "organisation", organisationId: ctx.organisationId } } as never;
		},
		async allows(ctx, check) {
			return passes(ctx, check);
		},
		async resource() {
			throw new KantelError("forbidden", "no");
		},
		async allowsResource() {
			return undefined;
		},
	};
}

export function recordingAudit(): AuditSink & { readonly events: AuditEventInput[] } {
	const events: AuditEventInput[] = [];
	return { events, append: async (_ctx, batch) => void events.push(...batch) };
}

/**
 * A socket whose far end is a fake MCP server, as the hub would be given by a host: frames from the server go to the
 * accepted tunnel's `receive`, and a close from either side reaches the other.
 */
export function fakeSocket(handler?: FakeHandler) {
	const server = fakeServer(handler);
	const closes: { readonly code: number; readonly reason: string }[] = [];
	let tunnel: AcceptedTunnel | undefined;
	const socket: TunnelSocket = {
		send: (text) => {
			if (text !== "pong" && closes.length === 0) server.send(text);
		},
		close: (code, reason) => {
			closes.push({ code, reason });
		},
	};
	return {
		server,
		socket,
		closes,
		/** Wires the accepted tunnel to the server's answers. */
		attach(accepted: AcceptedTunnel) {
			tunnel = accepted;
			server.attach((text) => tunnel?.receive(text));
		},
		/** The client hung up. */
		hangUp(code = 1000, reason = "") {
			tunnel?.closed(code, reason);
		},
	};
}

/** Waits for the event loop to run what the fake server answered. */
export async function settle(times = 5): Promise<void> {
	for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
