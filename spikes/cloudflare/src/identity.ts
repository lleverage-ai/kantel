/**
 * Who the spike acts as. The spike has no identity service (M0-BE1's `Identity` is out of scope for M0-CF1), so every
 * session runs in one organisation and project, as an agent actor named after its session.
 */
import type { Actor, CallContext, OwnerRef } from "@harbour/contracts";

export const SPIKE_ORGANISATION = "org-harbour-m0";
export const SPIKE_PROJECT = "proj-m0-cf1";
export const SPIKE_AGENT = "agent-m0-cf1";
export const SPIKE_OWNER: OwnerRef = { kind: "project", organisationId: SPIKE_ORGANISATION, projectId: SPIKE_PROJECT };
export const SPIKE_SERVICE: Actor = { kind: "service", serviceId: "harbour-m0-cf1" };

export function sessionContext(sessionId: string): CallContext {
	return {
		actor: { kind: "agent", agentId: SPIKE_AGENT, sessionId },
		organisationId: SPIKE_ORGANISATION,
		projectId: SPIKE_PROJECT,
	};
}

export function serviceContext(): CallContext {
	return { actor: SPIKE_SERVICE, organisationId: SPIKE_ORGANISATION, projectId: SPIKE_PROJECT };
}
