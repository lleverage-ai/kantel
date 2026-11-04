// The Mounts page (compute console, experimental): an account's bundles and bucket sources, the files its sandboxes
// mount read-only. A bundle is a tar uploaded once with the API and named by its sha256; a bucket source is a bucket
// with the credentials that read it, which are write-only and never shown. Both are made with the API; here they are
// listed, with how many sandboxes mount each, and deleted. Kantel refuses to delete one while a sandbox that still
// exists mounts it, so its Delete waits until those sandboxes are gone and says so. Shown only where the deployment has
// turned mounts on. Every call goes through the `MountsSource` the host binds; stories bind it to fixtures.

import { type ReactNode, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CopyButton } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { type BucketSource, type Bundle, bytesText, type ComputeAccount, type MountsSource } from "./compute-model.ts";
import {
	BUCKET_PROVIDER_LABELS,
	bucketWhereText,
	credentialsText,
	inUseText,
	mountedByText,
	shortDigest,
} from "./mounts.ts";
import {
	cellSub,
	computePage,
	messageOf,
	None,
	SectionHeading,
	TableFrame,
	table,
	tableFrame,
	td,
	th,
} from "./parts.tsx";

export interface MountsPageProps {
	readonly source: MountsSource;
	readonly account: ComputeAccount;
	/** A fixed time, for stories. */
	readonly now?: number;
}

type NoticeState = { level: "info" | "error"; text: string };
type NoticeSetter = (notice: NoticeState | undefined) => void;

export function MountsPage({ source, account, now: fixedNow }: MountsPageProps) {
	const [notice, setNotice] = useState<NoticeState>();
	const now = fixedNow ?? Date.now();
	return (
		<div className={computePage}>
			<PageHeader title="Mounts" lede="Files sandboxes mount read-only. Experimental." />
			{notice === undefined ? null : (
				<Notice
					level={notice.level}
					action={
						<Button size="xs" variant="ghost" onClick={() => setNotice(undefined)}>
							Dismiss
						</Button>
					}
				>
					{notice.text}
				</Notice>
			)}
			<Bundles source={source} account={account} now={now} onNotice={setNotice} />
			<BucketSources source={source} account={account} now={now} onNotice={setNotice} />
		</div>
	);
}

function TableSkeleton() {
	return (
		<div className={tableFrame} aria-busy="true">
			<div className="flex flex-col gap-3 p-4">
				{[0, 1, 2].map((row) => (
					<Skeleton key={row} />
				))}
			</div>
		</div>
	);
}

function ReadFailed({ error, fallback, onRetry }: { error: unknown; fallback: string; onRetry: () => void }) {
	return (
		<Notice
			level="error"
			action={
				<Button size="sm" onClick={onRetry}>
					Try again
				</Button>
			}
		>
			{messageOf(error, fallback)}
		</Notice>
	);
}

/**
 * How many sandboxes mount it, or a dash for none. While any do it can't be deleted, which shows here too: a disabled
 * button's hover text doesn't reach a touch screen.
 */
function MountedBy({ count }: { count: number }) {
	const text = mountedByText(count);
	if (text === undefined) return <None className="text-faint" />;
	return (
		<>
			<span className="block text-fg tabular-nums">{text}</span>
			<span className={cellSub}>Delete {count === 1 ? "it" : "them"} first to delete this</span>
		</>
	);
}

/** When it was made, with the whole date on hover. */
function Created({ at, now }: { at: number; now: number }) {
	return (
		<span className="text-muted" title={new Date(at).toLocaleString("en-GB")}>
			{compactAge(at, now)}
		</span>
	);
}

/**
 * A row's Delete. While a sandbox mounts it Kantel refuses the delete, so it's off, and says why on hover; the row's
 * Mounted by says how many.
 */
function DeleteButton({ name, mountedBy, onDelete }: { name: string; mountedBy: number; onDelete: () => void }) {
	const refusal = inUseText(mountedBy);
	if (refusal === undefined) {
		return (
			<Button size="xs" variant="ghost" onClick={onDelete} aria-label={`Delete ${name}`}>
				Delete
			</Button>
		);
	}
	// A disabled button gets no pointer events in some browsers, so the explanation is on its wrapper.
	return (
		<span className="inline-flex" title={`${refusal}.`}>
			<Button size="xs" variant="ghost" disabled aria-label={`Delete ${name}: ${refusal}`}>
				Delete
			</Button>
		</span>
	);
}

function Bundles({
	source,
	account,
	now,
	onNotice,
}: {
	source: MountsSource;
	account: ComputeAccount;
	now: number;
	onNotice: NoticeSetter;
}) {
	const { state, reload } = useLoad(() => source.bundles(account.id), [source, account.id]);
	// Deleted here, ahead of the next read.
	const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
	const [deleting, setDeleting] = useState<Bundle>();
	const deletingName = deleting === undefined ? "" : shortDigest(deleting.digest);

	let body: ReactNode;
	if (state.status === "error") {
		body = <ReadFailed error={state.error} fallback="Kantel couldn't read the bundles." onRetry={reload} />;
	} else if (state.status === "loading") {
		body = <TableSkeleton />;
	} else {
		const bundles = state.value.filter((bundle) => !removed.has(bundle.digest));
		body =
			bundles.length === 0 ? (
				<EmptyState title="No bundles yet">
					Upload a tar with the API (<code className="font-mono text-code">POST /v1/bundles</code>): Kantel stores it
					once, named by its sha256, for sandboxes to mount.
				</EmptyState>
			) : (
				<TableFrame>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Digest
								</th>
								<th className={`${th} text-right`} scope="col">
									Size
								</th>
								<th className={th} scope="col">
									Mounted by
								</th>
								<th className={th} scope="col">
									Created
								</th>
								<th className={th} scope="col">
									<span className="kt-sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{bundles.map((bundle) => (
								<tr key={bundle.digest} data-bundle={bundle.digest}>
									<td className={td}>
										<span className="flex min-w-0 items-center gap-1">
											<span className="kt-selectable font-mono text-code text-fg" title={bundle.digest}>
												{shortDigest(bundle.digest)}
											</span>
											<CopyButton text={bundle.digest} iconOnly size="xs" variant="ghost" label="Copy digest" />
										</span>
									</td>
									<td className={`${td} text-right tabular-nums`}>{bytesText(bundle.sizeBytes)}</td>
									<td className={td}>
										<MountedBy count={bundle.mountedBy} />
									</td>
									<td className={td}>
										<Created at={bundle.createdAt} now={now} />
									</td>
									<td className={`${td} w-0 text-right`}>
										<DeleteButton
											name={shortDigest(bundle.digest)}
											mountedBy={bundle.mountedBy}
											onDelete={() => setDeleting(bundle)}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</TableFrame>
			);
	}

	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby="mounts-bundles">
			<SectionHeading id="mounts-bundles" title="Bundles" />
			{body}
			<DeleteDialog
				open={deleting !== undefined}
				title="Delete this bundle?"
				onClose={() => setDeleting(undefined)}
				onDelete={async () => {
					if (deleting === undefined) return;
					await source.removeBundle(account.id, deleting.digest);
					setRemoved((current) => new Set(current).add(deleting.digest));
					onNotice({ level: "info", text: `Deleted the bundle ${deletingName}.` });
					reload();
				}}
			>
				<p>
					<strong className="font-mono text-code">{deletingName}</strong> goes for good. New sandboxes can mount its
					files again only once the tar is uploaded again.
				</p>
			</DeleteDialog>
		</section>
	);
}

function BucketSources({
	source,
	account,
	now,
	onNotice,
}: {
	source: MountsSource;
	account: ComputeAccount;
	now: number;
	onNotice: NoticeSetter;
}) {
	const { state, reload } = useLoad(() => source.bucketSources(account.id), [source, account.id]);
	// Deleted here, ahead of the next read.
	const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
	const [deleting, setDeleting] = useState<BucketSource>();

	let body: ReactNode;
	if (state.status === "error") {
		body = <ReadFailed error={state.error} fallback="Kantel couldn't read the bucket sources." onRetry={reload} />;
	} else if (state.status === "loading") {
		body = <TableSkeleton />;
	} else {
		const sources = state.value.filter((bucket) => !removed.has(bucket.id));
		body =
			sources.length === 0 ? (
				<EmptyState title="No bucket sources yet">
					Create one with the API (<code className="font-mono text-code">POST /v1/bucket-sources</code>). Its
					credentials are write-only: Kantel never shows them again.
				</EmptyState>
			) : (
				<TableFrame>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Name
								</th>
								<th className={th} scope="col">
									Provider
								</th>
								<th className={th} scope="col">
									Bucket
								</th>
								<th className={th} scope="col">
									Credentials
								</th>
								<th className={th} scope="col">
									Mounted by
								</th>
								<th className={th} scope="col">
									Created
								</th>
								<th className={th} scope="col">
									<span className="kt-sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{sources.map((bucket) => {
								const where = bucketWhereText(bucket.endpoint, bucket.region);
								return (
									<tr key={bucket.id} data-bucket-source={bucket.id}>
										<td className={td}>
											<span className="block max-w-(--kt-card-width) truncate font-medium text-fg">{bucket.name}</span>
										</td>
										<td className={td}>
											<span className="text-fg">{BUCKET_PROVIDER_LABELS[bucket.provider]}</span>
										</td>
										<td className={td}>
											<span className="kt-selectable block font-mono text-code text-fg">{bucket.bucket}</span>
											{where === undefined ? null : <span className={cellSub}>{where}</span>}
										</td>
										<td className={td}>
											<span className={bucket.hasCredentials ? "text-fg" : "text-muted"}>
												{credentialsText(bucket.hasCredentials)}
											</span>
										</td>
										<td className={td}>
											<MountedBy count={bucket.mountedBy} />
										</td>
										<td className={td}>
											<Created at={bucket.createdAt} now={now} />
										</td>
										<td className={`${td} w-0 text-right`}>
											<DeleteButton
												name={bucket.name}
												mountedBy={bucket.mountedBy}
												onDelete={() => setDeleting(bucket)}
											/>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</TableFrame>
			);
	}

	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby="mounts-bucket-sources">
			<SectionHeading id="mounts-bucket-sources" title="Bucket sources" />
			{body}
			<DeleteDialog
				open={deleting !== undefined}
				title="Delete this bucket source?"
				onClose={() => setDeleting(undefined)}
				onDelete={async () => {
					if (deleting === undefined) return;
					await source.removeBucketSource(deleting.id);
					setRemoved((current) => new Set(current).add(deleting.id));
					onNotice({ level: "info", text: `Deleted ${deleting.name}.` });
					reload();
				}}
			>
				<p>
					<strong>{deleting?.name}</strong> and its credentials go for good. The bucket itself, and the files in it,
					aren't touched.
				</p>
			</DeleteDialog>
		</section>
	);
}

/** Asks before a delete; stays open with the reason when it fails, such as a sandbox mounting it since the read. */
function DeleteDialog({
	open,
	title,
	children,
	onClose,
	onDelete,
}: {
	open: boolean;
	title: string;
	children: ReactNode;
	onClose: () => void;
	onDelete: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const close = () => {
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={open}
			title={title}
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							setBusy(true);
							onDelete().then(
								() => {
									setBusy(false);
									close();
								},
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't delete it. Try again."));
								},
							);
						}}
					>
						Delete
					</Button>
				</>
			}
		>
			{children}
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
