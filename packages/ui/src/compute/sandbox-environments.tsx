// A sandbox's environments, on its Overview: in order, each a link to the environment, with what it loses to a later
// one (or to the sandbox's own env) said quietly under it, and Pending where its secret files and repositories come
// when the sandbox next starts. Attach picks one of the account's environments and puts it last, so it wins; Detach
// asks first, since the environment's protected values stop resolving at once. Every call goes through the
// `SandboxEnvironmentsSource` the host binds.

import { useEffect, useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { SelectField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { PlusIcon } from "../primitives/icons.tsx";
import { useLoad, useReloadOn } from "../primitives/load.ts";
import { UnplugIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import {
	type Environment,
	MAX_SANDBOX_ENVIRONMENTS,
	type SandboxEnvironment,
	type SandboxEnvironmentShadowed,
	type SandboxEnvironmentsSource,
	type SandboxState,
} from "./compute-model.ts";
import { messageOf, SectionHeading } from "./parts.tsx";
import type { SandboxNotice } from "./sandbox-actions.tsx";

/** What of an environment a later one takes over, a line for each kind it loses any of. */
export function shadowedLines(shadowed: SandboxEnvironmentShadowed): { label: string; items: readonly string[] }[] {
	return [
		{ label: "Variables set later", items: shadowed.variables },
		{ label: "Files written by a later one", items: shadowed.files },
		{ label: "Repositories cloned by a later one", items: shadowed.repos },
	].filter((line) => line.items.length > 0);
}

export interface SandboxEnvironmentsProps {
	readonly source: SandboxEnvironmentsSource;
	readonly sandboxId: string;
	/** Its state: a stopped sandbox gets an attached environment's files and repositories when it next starts. */
	readonly state: SandboxState;
	/** The account's environments, which Attach offers. Absent: no Attach. */
	readonly available?: () => Promise<readonly Environment[]>;
	/** An environment's page. */
	readonly environmentHref?: (environmentId: string) => string;
	/** Changes when the sandbox is read again, so its environments are too: a start clears Pending. */
	readonly refreshKey?: unknown;
	/** After an attach or a detach: the page reads the sandbox again. */
	readonly onChanged?: () => void;
	readonly onNotice: (notice: SandboxNotice | undefined) => void;
	/** Open Attach on mount, for a story. */
	readonly attachOpen?: boolean;
}

export function SandboxEnvironments({
	source,
	sandboxId,
	state,
	available,
	environmentHref,
	refreshKey,
	onChanged,
	onNotice,
	attachOpen = false,
}: SandboxEnvironmentsProps) {
	const { state: read, reload } = useLoad(() => source.list(sandboxId), [source, sandboxId]);
	useReloadOn(refreshKey, reload);
	// What an attach or a detach answered, ahead of the next read.
	const [answered, setAnswered] = useState<readonly SandboxEnvironment[]>();
	// Each read replaces what a change answered.
	useEffect(() => {
		if (read.status === "ready") setAnswered(undefined);
	}, [read]);
	const [attaching, setAttaching] = useState(attachOpen);
	const [detaching, setDetaching] = useState<SandboxEnvironment>();
	const listed = answered ?? (read.status === "ready" ? read.value : undefined);
	const changed = (next: readonly SandboxEnvironment[]) => {
		setAnswered(next);
		onChanged?.();
	};
	const full = listed !== undefined && listed.length >= MAX_SANDBOX_ENVIRONMENTS;

	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby="sandbox-environments">
			<SectionHeading
				id="sandbox-environments"
				title="Environments"
				actions={
					available === undefined || listed === undefined ? undefined : (
						<Button
							size="sm"
							variant="ghost"
							className="-mr-3"
							icon={<PlusIcon size="sm" />}
							disabled={full}
							{...(full ? { title: `A sandbox has at most ${MAX_SANDBOX_ENVIRONMENTS} environments.` } : {})}
							onClick={() => setAttaching(true)}
						>
							Attach
						</Button>
					)
				}
			/>
			{listed === undefined && read.status === "error" ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					{messageOf(read.error, "Kantel couldn't read its environments.")}
				</Notice>
			) : listed === undefined ? (
				<Skeleton lines={2} />
			) : listed.length === 0 ? (
				<p className="m-0 text-sm text-muted">
					None. Attach one to give it an environment's variables, secret files, repositories and grants.
				</p>
			) : (
				<>
					{listed.length > 1 ? (
						<p className="m-0 text-sm text-muted">
							In order: where two set the same variable, file or repository, the later one wins. Grants add up.
						</p>
					) : null}
					<ol className="m-0 flex min-w-0 flex-col rounded-panel border border-border bg-raised p-0 text-sm">
						{listed.map((env, at) => (
							<EnvironmentRow
								key={env.id}
								env={env}
								position={at + 1}
								{...(environmentHref === undefined ? {} : { href: environmentHref(env.id) })}
								onDetach={() => setDetaching(env)}
							/>
						))}
					</ol>
				</>
			)}
			{attaching && available !== undefined ? (
				<AttachDialog
					available={available}
					attached={listed ?? []}
					stopped={state !== "running"}
					onClose={() => setAttaching(false)}
					onAttach={async (environmentId) => {
						const next = await source.attach(sandboxId, environmentId);
						setAttaching(false);
						changed(next);
						const name = next.find((env) => env.id === environmentId)?.name ?? "The environment";
						onNotice({
							level: "info",
							text:
								state === "running"
									? `${name} is attached. New commands see its variables now; running processes keep theirs.`
									: `${name} is attached. Its files and repositories come when the sandbox next starts.`,
						});
					}}
				/>
			) : null}
			{detaching === undefined ? null : (
				<DetachDialog
					env={detaching}
					onClose={() => setDetaching(undefined)}
					onDetach={async () => {
						const next = await source.detach(sandboxId, detaching.id);
						setDetaching(undefined);
						changed(next);
						onNotice({ level: "info", text: `${detaching.name} is detached.` });
					}}
				/>
			)}
		</section>
	);
}

function EnvironmentRow({
	env,
	position,
	href,
	onDetach,
}: {
	env: SandboxEnvironment;
	position: number;
	href?: string;
	onDetach: () => void;
}) {
	const lines = shadowedLines(env.shadowed);
	return (
		<li
			className="flex min-w-0 gap-3 border-b border-border py-2.5 pr-2 pl-4 last:border-b-0"
			data-environment={env.id}
		>
			<span className="mt-0.5 w-4 flex-none text-right text-faint tabular-nums" aria-hidden="true">
				{position}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex min-h-control-xs min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					{href === undefined ? (
						<span className="min-w-0 truncate font-medium text-fg" title={env.name}>
							{env.name}
						</span>
					) : (
						<a
							className="min-w-0 truncate font-medium text-fg underline decoration-border-strong underline-offset-2"
							href={href}
							title={env.name}
						>
							{env.name}
						</a>
					)}
					{env.pending ? <Badge tone="approval">On next start</Badge> : null}
				</div>
				{env.pending ? (
					<span className="text-muted">Its secret files and repositories come when the sandbox next starts.</span>
				) : null}
				{lines.map((line) => (
					<span key={line.label} className="min-w-0 text-faint wrap-anywhere">
						{line.label}: <span className="font-mono text-code">{line.items.join(", ")}</span>
					</span>
				))}
			</div>
			<IconButton
				size="xs"
				variant="ghost"
				icon={<UnplugIcon size="sm" />}
				label={`Detach ${env.name}`}
				onClick={onDetach}
			/>
		</li>
	);
}

function AttachDialog({
	available,
	attached,
	stopped,
	onClose,
	onAttach,
}: {
	available: () => Promise<readonly Environment[]>;
	attached: readonly SandboxEnvironment[];
	stopped: boolean;
	onClose: () => void;
	onAttach: (environmentId: string) => Promise<void>;
}) {
	const { state, reload } = useLoad(available, []);
	const [chosen, setChosen] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const offered =
		state.status === "ready" ? state.value.filter((env) => !attached.some((each) => each.id === env.id)) : [];
	const submit = () => {
		if (chosen === "" || busy) return;
		setBusy(true);
		setFailure(undefined);
		onAttach(chosen).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't attach it. Try again."));
			},
		);
	};
	return (
		<Dialog
			open
			title="Attach an environment"
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={chosen === ""}>
						Attach
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-3 pt-2">
				{state.status === "error" ? (
					<Notice
						level="error"
						action={
							<Button size="sm" onClick={reload}>
								Try again
							</Button>
						}
					>
						{messageOf(state.error, "Kantel couldn't read the environments.")}
					</Notice>
				) : state.status === "loading" ? (
					<Skeleton lines={1} />
				) : offered.length === 0 ? (
					<p className="m-0 text-sm text-muted">
						{state.value.length === 0
							? "This account has no environments yet."
							: "It has every environment in this account already."}
					</p>
				) : (
					<SelectField
						label="Environment"
						value={chosen}
						onChange={(event) => setChosen(event.currentTarget.value)}
						options={[
							{ value: "", label: "Pick an environment" },
							...offered.map((env) => ({ value: env.id, label: env.name })),
						]}
						hint={
							attached.length === 0
								? "Its variables reach new commands at once, and its grants and protected variables apply at once."
								: "It goes last, so it wins where it sets what another does. Its variables reach new commands at once, and its grants and protected variables apply at once."
						}
					/>
				)}
				<p className="m-0 text-sm text-muted">
					{stopped
						? "Its secret files and repositories come when the sandbox next starts."
						: "Its secret files and repositories are set up now. Running processes keep the env they started with."}
				</p>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

function DetachDialog({
	env,
	onClose,
	onDetach,
}: {
	env: SandboxEnvironment;
	onClose: () => void;
	onDetach: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	return (
		<Dialog
			open
			title="Detach this environment?"
			onClose={onClose}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							setBusy(true);
							setFailure(undefined);
							onDetach().then(
								() => setBusy(false),
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't detach it. Try again."));
								},
							);
						}}
					>
						Detach
					</Button>
				</>
			}
		>
			<p>
				<strong>{env.name}</strong>'s variables go from new commands, its grants go, and its protected variables stop
				resolving at once, so requests that use them fail.
			</p>
			<p>Files it wrote and repositories it cloned stay. Running processes keep the env they started with.</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
