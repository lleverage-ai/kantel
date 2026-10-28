// The audit log page: the library's AuditView over the console's audit seam. When the seam reads its credentials
// rather than listing them up front (the gateway, which has no vault API for the console yet), they are read each time
// the page opens and become the Credential filter's choices and the names rows give items.

import { type AuditDirectory, AuditView, type Choice } from "@harbour/ui";
import { useEffect, useMemo, useState } from "react";
import type { ConsoleAudit } from "../api/oversight.ts";

export function AuditScreen({ audit }: { audit: ConsoleAudit }) {
	const [credentials, setCredentials] = useState<readonly Choice[]>();
	useEffect(() => {
		if (audit.credentials === undefined) return;
		let live = true;
		audit.credentials().then(
			(found) => live && setCredentials(found),
			// The log itself says when it can't be read; without credentials the filter stays hidden.
			() => {},
		);
		return () => {
			live = false;
		};
	}, [audit]);

	const choices = useMemo(
		() => (credentials === undefined ? audit.choices : { ...audit.choices, credentials }),
		[audit.choices, credentials],
	);
	const directory = useMemo((): AuditDirectory => {
		if (credentials === undefined) return audit.directory;
		const names = new Map(credentials.map((choice) => [choice.value, choice.label]));
		return { ...audit.directory, item: (itemId) => names.get(itemId) ?? audit.directory.item?.(itemId) };
	}, [audit.directory, credentials]);

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
