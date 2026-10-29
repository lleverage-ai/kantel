// The audit log page: the library's AuditView over the console's audit seam. When the seam reads its choices rather
// than listing them up front (the gateway), they are read each time the page opens: the credentials become the
// Credential filter's choices, the projects, agents and sessions the Project, Agent and Session filters', the people
// the Who filter's and the organisations the Organisation filter's, and each names its records in rows.

import { type AuditDirectory, AuditView, type Choice } from "@harbour/ui";
import { useEffect, useMemo, useState } from "react";
import { personKey } from "../api/audit-http.ts";
import type { ConsoleAudit } from "../api/oversight.ts";

/** What `read` resolves to, once it has; undefined before, without `read`, or when it fails. */
function useRead<T>(read: (() => Promise<T>) | undefined): T | undefined {
	const [value, setValue] = useState<T>();
	useEffect(() => {
		if (read === undefined) return;
		let live = true;
		read().then(
			(found) => live && setValue(found),
			// The log itself says when it can't be read; without choices their filters stay hidden.
			() => {},
		);
		return () => {
			live = false;
		};
	}, [read]);
	return value;
}

type Named = "item" | "project" | "agent" | "session";

/** `directory` with each of `named`'s choices naming its records first, and the directory the ones they don't hold. */
function withNames(
	directory: AuditDirectory,
	named: Partial<Record<Named, readonly Choice[] | undefined>>,
): AuditDirectory {
	const result: AuditDirectory = { ...directory };
	for (const [key, choices] of Object.entries(named) as [Named, readonly Choice[] | undefined][]) {
		if (choices === undefined) continue;
		const names = new Map(choices.map((choice) => [choice.value, choice.label]));
		result[key] = (id: string) => names.get(id) ?? directory[key]?.(id);
	}
	return result;
}

export function AuditScreen({ audit }: { audit: ConsoleAudit }) {
	const credentials = useRead(audit.credentials);
	const scope = useRead(audit.scope);
	const people = useRead(audit.people);

	const choices = useMemo(
		() => ({
			...audit.choices,
			...(credentials === undefined ? {} : { credentials }),
			...(scope === undefined ? {} : { projects: scope.projects, agents: scope.agents, sessions: scope.sessions }),
			...(people === undefined ? {} : { actors: people.actors }),
			...(people?.organisations === undefined ? {} : { organisations: people.organisations }),
		}),
		[audit.choices, credentials, scope, people],
	);
	const directory = useMemo(() => {
		const named = withNames(audit.directory, {
			item: credentials,
			project: scope?.projects,
			agent: scope?.agents,
			session: scope?.sessions,
		});
		if (people === undefined) return named;
		const names = new Map(people.actors.map((choice) => [choice.value, choice.label]));
		return { ...named, person: (userId: string) => names.get(personKey(userId)) ?? audit.directory.person?.(userId) };
	}, [audit.directory, credentials, scope, people]);

	return (
		<AuditView
			source={audit.source}
			directory={directory}
			links={audit.links}
			choices={choices}
			{...(audit.pollMs === undefined ? {} : { pollMs: audit.pollMs })}
		/>
	);
}
