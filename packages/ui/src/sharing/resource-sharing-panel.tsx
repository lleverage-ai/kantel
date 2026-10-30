// One resource's sharing, for its own page (a skill, a memory space): who it is shared with, and the requests for it
// waiting on a decision, granted no wider than asked or rejected. The server decides every write; someone who may not
// decide sees the requests, and the error, but nothing changes.

import type { ResourceRef } from "@harbour/contracts";
import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { EmptyState, Notice, Panel } from "../primitives/surface.tsx";
import { readResourceSharing, type SharingDirectory, type SharingSource } from "./sharing-model.ts";
import { InboxRow, ShareList } from "./sharing-page.tsx";
import "./sharing-page.css";

export interface ResourceSharingPanelProps {
	readonly source: SharingSource;
	readonly resource: ResourceRef;
	readonly directory?: SharingDirectory;
	/** The time the panel measures expiry from. Default now. */
	readonly now?: number;
}

export function ResourceSharingPanel({ source, resource, directory = {}, now }: ResourceSharingPanelProps) {
	const [failure, setFailure] = useState<string>();
	const [busy, setBusy] = useState<string>();
	const { state, reload } = useLoad(() => readResourceSharing(source, resource), [source, resource.kind, resource.id]);
	const at = now ?? Date.now();
	const act = async (key: string, write: () => Promise<unknown>) => {
		setBusy(key);
		setFailure(undefined);
		try {
			await write();
			reload();
		} catch (error) {
			setFailure(error instanceof Error ? error.message : "That didn't work");
		} finally {
			setBusy(undefined);
		}
	};

	if (state.status === "loading") {
		return (
			<Panel header={<h3 className="hb-sharing-title">Sharing</h3>} aria-label="Sharing">
				<div aria-busy="true">
					<Skeleton lines={2} />
				</div>
			</Panel>
		);
	}
	if (state.status === "error") {
		return (
			<Notice level="error" action={<Button onClick={reload}>Try again</Button>}>
				This resource's sharing couldn't be read.
			</Notice>
		);
	}
	const { shares, pending } = state.value;
	return (
		<div className="hb-sharing-body">
			{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
			<ShareList
				title="Shared with"
				empty="Not shared outside its owner."
				shares={shares}
				directory={directory}
				now={at}
				busy={busy}
				action="Revoke"
				onRevoke={(share) => act(share.id, () => source.revokeShare(share.id))}
				side="resource"
				heading="h3"
			/>
			<Panel header={<h3 className="hb-sharing-title">Requests for access</h3>} aria-label="Requests for access">
				{pending.length === 0 ? (
					<EmptyState title="No requests waiting" />
				) : (
					<ul className="hb-sharing-rows">
						{pending.map((request) => (
							<InboxRow
								key={request.id}
								request={request}
								directory={directory}
								now={at}
								busy={busy === request.id}
								onDecide={(item, decision) => act(item.id, () => source.decideRequest(item.id, decision))}
							/>
						))}
					</ul>
				)}
			</Panel>
		</div>
	);
}
