// A sandbox's ports with an HTTPS URL of their own, on its Overview: each private (only with the token from when it
// was exposed) or public (anyone with the URL). Expose gives a port a URL; a private port's link carries its token and
// is shown once, to copy. A private port's listed address has no token, so it's shown as an address, not a link: New
// link gives it another. One change to a port at a time, so a later Hide can't be undone by an earlier change landing
// after it; the guard belongs to the sandbox, not to this view, so leaving the tab mid-change doesn't drop it. Every
// call goes through the `SandboxesSource` the host binds.

import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../primitives/button.tsx";
import { CheckboxField, CopyButton, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { GlobeIcon, LockIcon, PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { EllipsisIcon, NewLinkIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu } from "../primitives/menu.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import type { SandboxesSource, SandboxPort } from "./compute-model.ts";
import { type Changes, oneChangeEach } from "./one-change.ts";
import { messageOf, SectionHeading, table } from "./parts.tsx";
import type { SandboxNotice } from "./sandbox-actions.tsx";

type PortsSource = Required<Pick<SandboxesSource, "ports" | "exposePort" | "hidePort">>;

/** The tag on a port: a lock for private, a globe in the highlight colour for public. */
function Visibility({ isPublic }: { isPublic: boolean }) {
	return (
		<span
			className={`inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${isPublic ? "bg-status-approval-soft text-status-approval" : "bg-active text-muted"}`}
		>
			{isPublic ? <GlobeIcon size="sm" /> : <LockIcon size="sm" />}
			{isPublic ? "Public" : "Private"}
		</span>
	);
}

export type PortChanges = Changes<number>;

/**
 * One change at a time to each port: `run` refuses a port with one on its way, and frees it once that answers, either
 * way. Listeners hear each start and end. Other ports go on as they like.
 */
export const portChanges = (): PortChanges =>
	oneChangeEach((port) => `Port ${port} is still changing. Try again in a moment.`);

const bySandbox = new Map<string, PortChanges>();

/**
 * The one guard for a sandbox's ports, for as long as the console runs: a view that unmounts (another tab) and mounts
 * again mid-change finds the change still on its way.
 */
export function sandboxPortChanges(sandboxId: string): PortChanges {
	let changes = bySandbox.get(sandboxId);
	if (changes === undefined) {
		changes = portChanges();
		bySandbox.set(sandboxId, changes);
	}
	return changes;
}

export function SandboxPorts({
	source,
	sandboxId,
	onNotice,
}: {
	source: PortsSource;
	sandboxId: string;
	onNotice: (notice: SandboxNotice | undefined) => void;
}) {
	const { state, reload } = useLoad(() => source.ports(sandboxId), [source, sandboxId]);
	const [exposing, setExposing] = useState(false);
	// A private port's URL with its token, as exposing it answered: shown once.
	const [issued, setIssued] = useState<SandboxPort>();
	// The ports with a change on its way: another to the same port waits for it to answer.
	const changes = sandboxPortChanges(sandboxId);
	const busy = useSyncExternalStore(changes.subscribe, changes.changing);
	const one = <T,>(port: number, call: () => Promise<T>): Promise<T> => changes.run(port, call);
	// Read the ports again whenever a change to one ends, including one started before this view mounted.
	const before = useRef(busy);
	useEffect(() => {
		const ended = [...before.current].some((port) => !busy.has(port));
		before.current = busy;
		if (ended) reload();
	}, [busy, reload]);

	const expose = (port: number, isPublic: boolean) =>
		one(port, async () => {
			const made = await source.exposePort(sandboxId, port, isPublic);
			setIssued(made.public ? (current) => (current?.port === port ? undefined : current) : made);
		});
	const change = (port: SandboxPort, isPublic: boolean) => {
		expose(port.port, isPublic).catch((caught: unknown) =>
			onNotice({ level: "error", text: messageOf(caught, `Kantel couldn't change port ${port.port}. Try again.`) }),
		);
	};
	const hide = (port: SandboxPort) => {
		one(port.port, () => source.hidePort(sandboxId, port.port)).then(
			() => {
				setIssued((current) => (current?.port === port.port ? undefined : current));
				onNotice({ level: "info", text: `Port ${port.port}'s URL no longer works.` });
			},
			(caught: unknown) =>
				onNotice({ level: "error", text: messageOf(caught, `Kantel couldn't hide port ${port.port}. Try again.`) }),
		);
	};

	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby="sandbox-ports">
			<SectionHeading
				id="sandbox-ports"
				title="Ports"
				actions={
					<Button
						size="sm"
						variant="ghost"
						className="-mr-3"
						icon={<PlusIcon size="sm" />}
						onClick={() => setExposing(true)}
					>
						Expose
					</Button>
				}
			/>
			{issued === undefined ? null : (
				<Notice
					level="info"
					action={
						<span className="flex gap-1">
							<CopyButton text={issued.url} size="xs" />
							<Button size="xs" variant="ghost" onClick={() => setIssued(undefined)}>
								Dismiss
							</Button>
						</span>
					}
				>
					<span className="block">Copy port {issued.port}'s link now. Its token isn't shown again.</span>
					<code className="block truncate font-mono text-code">{issued.url}</code>
				</Notice>
			)}
			{state.status === "error" ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					{messageOf(state.error, "Kantel couldn't read the ports.")}
				</Notice>
			) : state.status === "loading" ? (
				<Skeleton lines={2} />
			) : state.value.length === 0 ? (
				<p className="m-0 text-sm text-muted">No ports yet. Expose one to give it an HTTPS URL.</p>
			) : (
				// Each port is two lines: its number, visibility and actions over its whole address, never broken mid-host.
				<div className="rounded-panel border border-border bg-raised px-3 sm:px-4 [&_tr:last-child]:border-b-0">
					<table className={`${table} block`}>
						<tbody className="block">
							{state.value.map((port) => {
								// A link that opens it: the listed URL for a public port, the one just issued for a private one.
								const link = port.public ? port.url : issued?.port === port.port ? issued.url : undefined;
								const address = port.url.replace(/^https:\/\//, "").replace(/\?.*$/, "");
								const pending = busy.has(port.port);
								return (
									<tr
										key={port.port}
										data-port={port.port}
										className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border py-2.5"
									>
										<td className="col-start-1 row-start-1 p-0 font-mono text-code tabular-nums">{port.port}</td>
										<td className="col-span-3 row-start-2 p-0 font-mono text-code wrap-break-word">
											{link === undefined ? (
												<span
													className="kt-selectable text-muted"
													title="Private: it opens only with a link's token. New link gives it one."
												>
													<Address address={address} />
												</span>
											) : (
												<a
													className="text-fg no-underline hover:underline"
													href={link}
													target="_blank"
													rel="noopener noreferrer"
												>
													<Address address={address} />
												</a>
											)}
										</td>
										<td className="col-start-2 row-start-1 p-0">
											<Visibility isPublic={port.public} />
										</td>
										<td className="col-start-3 row-start-1 p-0 text-right">
											<span className="inline-flex items-center gap-0.5">
												{/* The copy slot is kept on every row, so the menus line up. */}
												{link === undefined ? (
													<span className="inline-block size-control-xs" aria-hidden="true" />
												) : (
													<CopyButton
														text={link}
														iconOnly
														size="xs"
														variant="ghost"
														label={port.public ? "Copy URL" : "Copy link"}
													/>
												)}
												<Menu
													label={`Actions for port ${port.port}`}
													icon={<EllipsisIcon />}
													align="end"
													entries={[
														...(port.public
															? [
																	{
																		kind: "item" as const,
																		id: "private",
																		label: "Make private",
																		icon: <LockIcon size="sm" />,
																		disabled: pending,
																		onSelect: () => change(port, false),
																	},
																]
															: [
																	{
																		kind: "item" as const,
																		id: "link",
																		label: "New link",
																		icon: <NewLinkIcon size="sm" />,
																		disabled: pending,
																		onSelect: () => change(port, false),
																	},
																	{
																		kind: "item" as const,
																		id: "public",
																		label: "Make public",
																		icon: <GlobeIcon size="sm" />,
																		disabled: pending,
																		onSelect: () => change(port, true),
																	},
																]),
														{ kind: "separator", id: "sep-hide" },
														{
															kind: "item",
															id: "hide",
															label: "Hide",
															icon: <TrashIcon />,
															danger: true,
															disabled: pending,
															onSelect: () => hide(port),
														},
													]}
												/>
											</span>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			<ExposeDialog open={exposing} onClose={() => setExposing(false)} onExpose={expose} />
		</section>
	);
}

function ExposeDialog({
	open,
	onClose,
	onExpose,
}: {
	open: boolean;
	onClose: () => void;
	onExpose: (port: number, isPublic: boolean) => Promise<void>;
}) {
	const [port, setPort] = useState("");
	const [isPublic, setPublic] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const number = Number(port);
	const valid = /^\d+$/.test(port) && number >= 1 && number <= 65535;
	const close = () => {
		setPort("");
		setPublic(false);
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={open}
			title="Expose a port"
			onClose={close}
			onSubmit={() => {
				if (!valid) return;
				setBusy(true);
				onExpose(number, isPublic).then(
					() => {
						setBusy(false);
						close();
					},
					(caught: unknown) => {
						setBusy(false);
						setFailure(messageOf(caught, "Kantel couldn't expose it. Try again."));
					},
				);
			}}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={!valid}>
						Expose
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-3 pt-2">
				<TextField
					label="Port"
					inputMode="numeric"
					width="short"
					mono
					placeholder="3000"
					value={port}
					onChange={(event) => setPort(event.currentTarget.value.trim())}
					{...(port === "" || valid ? {} : { error: "A port from 1 to 65535." })}
				/>
				<CheckboxField
					label="Public"
					hint="Anyone with the URL can open it. Private needs the link's token."
					checked={isPublic}
					onChange={(event) => setPublic(event.currentTarget.checked)}
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

/** A port's address with a break opportunity after each dot, so it wraps at its labels rather than mid-word. */
function Address({ address }: { address: string }) {
	const parts = address.split(/(?<=\.)/);
	return (
		<>
			{parts.map((part, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed split of one string.
				<Fragment key={index}>
					{part}
					{index < parts.length - 1 ? <wbr /> : null}
				</Fragment>
			))}
		</>
	);
}
