// The session header's "who can see this" chip and its dialog (#335), over `ConsoleConnections.sessionVisibility`.
// It reads the session's visibility once, shows nothing until it knows it (or if it can't be read), and keeps the
// answer of a change it makes.

import {
	type SessionPlace,
	type SessionVisibility,
	SessionVisibilityButton,
	SessionVisibilityDialog,
} from "@kantel/ui";
import { useEffect, useState } from "react";
import type { SessionVisibilityAccess } from "../api/oversight.ts";

export function SessionVisibilityControl({
	access,
	place,
}: {
	readonly access: SessionVisibilityAccess;
	readonly place: SessionPlace;
}) {
	const [state, setState] = useState<{ readonly visibility: SessionVisibility; readonly locked?: string }>();
	const [open, setOpen] = useState(false);
	useEffect(() => {
		let live = true;
		setState(undefined);
		access
			.read()
			.then((read) => {
				if (live) setState(read);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [access]);
	if (state === undefined) return null;
	return (
		<>
			<SessionVisibilityButton visibility={state.visibility} place={place} onClick={() => setOpen(true)} />
			<SessionVisibilityDialog
				open={open}
				visibility={state.visibility}
				place={place}
				source={access.source}
				locked={state.locked}
				onClose={() => setOpen(false)}
				onChanged={(visibility) => setState({ ...state, visibility })}
			/>
		</>
	);
}
