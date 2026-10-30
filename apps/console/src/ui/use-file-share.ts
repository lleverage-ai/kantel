import type { PresentedFile } from "@harbour/protocol";
import type { ShareAccess, ShareControls } from "@harbour/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileShareRecord, WorkspaceShares } from "../api/client.ts";

// The Share tab of a presented file's popover, over the shares API. A file has no share until the person first changes
// its access, invites someone or copies its link; until then the tab shows it as only theirs.

export type Sharer = { readonly name: string; readonly email?: string };

export function useFileShare(
	/** The file shown, or none: no sharing to load. */
	file: PresentedFile | undefined,
	title: string,
	sharesOf: ((file: PresentedFile) => Promise<WorkspaceShares | undefined>) | undefined,
	sharer: Sharer | undefined,
): ShareControls | undefined {
	const [shares, setShares] = useState<WorkspaceShares>();
	const [record, setRecord] = useState<FileShareRecord | null>();
	const [error, setError] = useState<string>();
	// The share being made, so two quick changes make one.
	const making = useRef<Promise<FileShareRecord> | undefined>(undefined);

	useEffect(() => {
		if (sharesOf === undefined || file === undefined) {
			setShares(undefined);
			return;
		}
		const abort = new AbortController();
		setRecord(undefined);
		making.current = undefined;
		sharesOf(file)
			.then(async (found) => {
				if (found === undefined || abort.signal.aborted) return;
				setShares(found);
				const existing = await found.find(file.path, abort.signal);
				if (!abort.signal.aborted) setRecord(existing ?? null);
			})
			.catch((reason: unknown) => {
				if (abort.signal.aborted) return;
				setRecord(null);
				setError(`Couldn't load who has access: ${reason instanceof Error ? reason.message : String(reason)}`);
			});
		return () => abort.abort();
	}, [file, sharesOf]);

	const ensure = useCallback(async (): Promise<FileShareRecord> => {
		if (shares === undefined || file === undefined) throw new Error("Sharing isn't available");
		if (record) return record;
		making.current ??= shares.share(file.path, title);
		const made = await making.current;
		setRecord(made);
		return made;
	}, [shares, record, file, title]);

	const run = useCallback(async (change: () => Promise<FileShareRecord>) => {
		setError(undefined);
		try {
			setRecord(await change());
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}, []);

	return useMemo(() => {
		if (shares === undefined || sharer === undefined || file === undefined) return undefined;
		return {
			share:
				record === undefined
					? undefined
					: {
							owner: sharer,
							access: record?.access ?? "restricted",
							invites: record?.invites ?? [],
							...(record ? { link: shares.link(record) } : {}),
						},
			error,
			onAccessChange: (access: ShareAccess) => run(async () => shares.setAccess((await ensure()).id, access)),
			onInvite: (email: string) => run(async () => shares.invite((await ensure()).id, email)),
			onRemoveInvite: (email: string) => run(async () => shares.uninvite((await ensure()).id, email)),
			onCopyLink: async () => shares.link(await ensure()),
		};
	}, [shares, sharer, file, record, error, ensure, run]);
}
