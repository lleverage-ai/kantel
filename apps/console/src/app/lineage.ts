// A session's lineage: the sessions above it, when it is a subagent's. The top bar shows them as breadcrumbs between
// the project and the session, each a link back up.

import { useEffect, useState } from "react";
import type { ConsoleClient, SessionParent } from "../api/client.ts";

/** How many levels up the trail goes; deeper subagents are rare, and a loop in bad data must end. */
export const MAX_LINEAGE = 8;

/**
 * The sessions above `sessionId`, outermost first: its parent's parent, then its parent. Empty for a top-level session.
 * Stops at `MAX_LINEAGE` levels or at a session already in the trail.
 */
export async function lineageOf(
	parentOf: NonNullable<ConsoleClient["parentOf"]>,
	sessionId: string,
	signal?: AbortSignal,
): Promise<SessionParent[]> {
	const trail: SessionParent[] = [];
	const seen = new Set([sessionId]);
	let id = sessionId;
	while (trail.length < MAX_LINEAGE) {
		const parent = await parentOf(id, signal);
		if (parent === undefined || seen.has(parent.id)) break;
		trail.unshift(parent);
		seen.add(parent.id);
		id = parent.id;
	}
	return trail;
}

/**
 * The open session's lineage, read when it opens. Undefined while it is being read; empty for a top-level session, on
 * a client that has no parents, with no session open, and when it can't be read: the breadcrumbs then show the project
 * and the session, which is still right for every session that isn't a subagent's.
 */
export function useLineage(client: ConsoleClient, sessionId: string | undefined): readonly SessionParent[] | undefined {
	const [found, setFound] = useState<{ sessionId: string; trail: readonly SessionParent[] }>();
	useEffect(() => {
		const parentOf = client.parentOf?.bind(client);
		if (sessionId === undefined || parentOf === undefined) return;
		const controller = new AbortController();
		lineageOf(parentOf, sessionId, controller.signal).then(
			(trail) => {
				if (!controller.signal.aborted) setFound({ sessionId, trail });
			},
			() => {
				if (!controller.signal.aborted) setFound({ sessionId, trail: NONE });
			},
		);
		return () => controller.abort();
	}, [client, sessionId]);
	if (sessionId === undefined || client.parentOf === undefined) return NONE;
	return found !== undefined && found.sessionId === sessionId ? found.trail : undefined;
}

const NONE: readonly SessionParent[] = [];
