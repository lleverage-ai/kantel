// The console client with this browser's cache in front (state/local-cache.ts): what was last shown comes at once, the
// API's answers replace it and are written back. Only made once `GET /v1/me` has said who is signed in, with that
// person's cache.

import type { SessionSummary } from "@harbour/ui";
import type { LocalCache } from "../state/local-cache.ts";
import type { ConsoleClient } from "./client.ts";

/** A cached row is as the list last showed it, less whether it was unread: that is worked out afresh on each load. */
const asCached = ({ unread: _unread, ...summary }: SessionSummary): SessionSummary => summary;

export function withLocalCache(client: ConsoleClient, opening: Promise<LocalCache | undefined>): ConsoleClient {
	// A cache that fails to open is no cache.
	const cache = opening.catch(() => undefined);
	return {
		...client,
		async projects() {
			const projects = await client.projects();
			void cache.then((opened) => opened?.setProjects(projects));
			return projects;
		},
		cachedProjects: async () => (await cache)?.projects(),
		watchSessions(projectId, onChange) {
			let stopped = false;
			let answered = false;
			void cache
				.then((opened) => opened?.sessions(projectId))
				.then((cached) => {
					if (stopped || answered || cached === undefined || cached.length === 0) return;
					onChange({ sessions: cached, loading: false });
				});
			const stop = client.watchSessions(projectId, (state) => {
				answered = true;
				onChange(state);
				if (state.loading || state.error !== undefined) return;
				void cache.then((opened) => opened?.setSessions(projectId, state.sessions.map(asCached)));
			});
			return () => {
				stopped = true;
				stop();
			};
		},
		cachedSession: async (sessionId) => (await cache)?.session(sessionId),
		rememberSession(snapshot) {
			void cache.then((opened) => opened?.setSession(snapshot));
		},
	};
}
