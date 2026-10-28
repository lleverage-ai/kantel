// The audit log page: the library's AuditView over the console's audit seam. When the seam reads its filter options
// rather than listing them up front (the gateway, which has no vault API for the console yet and lists projects and
// sessions on their own routes), they are read each time the page opens. Credentials become the Credential filter's
// choices and the names rows give items; the lookups add the Project, Agent and Session filters and their names.

import { type AuditDirectory, AuditView, type Choice } from "@harbour/ui";
import { useEffect, useMemo, useState } from "react";
import type { AuditLookups, ConsoleAudit } from "../api/oversight.ts";

/** Calls `read` once per `audit`, keeping what it resolves to; a failure leaves it undefined. */
function useRead<T>(read: (() => Promise<T>) | undefined): T | undefined {
	const [value, setValue] = useState<T>();
	useEffect(() => {
		if (read === undefined) return;
		let live = true;
		read().then(
			(found) => live && setValue(() => found),
			// The log itself says when it can't be read; without the options their filters stay hidden.
			() => {},
		);
		return () => {
			live = false;
		};
	}, [read]);
	return value;
}

export function AuditScreen({ audit }: { audit: ConsoleAudit }) {
	const credentials = useRead<readonly Choice[]>(audit.credentials);
	const lookups = useRead<AuditLookups>(audit.lookups);

	const choices = useMemo(
		() => ({
			...audit.choices,
			...lookups?.choices,
			...(credentials === undefined ? {} : { credentials }),
		}),
		[audit.choices, lookups, credentials],
	);
	const directory = useMemo((): AuditDirectory => {
		const base: AuditDirectory = audit.directory;
		const found = lookups?.directory ?? {};
		const names =
			credentials === undefined ? undefined : new Map(credentials.map((choice) => [choice.value, choice.label]));
		// Each name from the lookups or credentials first, then the seam's own.
		const either =
			(
				first: ((id: string) => string | undefined) | undefined,
				second: ((id: string) => string | undefined) | undefined,
			) =>
			(id: string) =>
				first?.(id) ?? second?.(id);
		return {
			...base,
			project: either(found.project, base.project),
			agent: either(found.agent, base.agent),
			session: either(found.session, base.session),
			person: either(found.person, base.person),
			item: either(names === undefined ? found.item : (id) => names.get(id) ?? found.item?.(id), base.item),
		};
	}, [audit.directory, lookups, credentials]);

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
