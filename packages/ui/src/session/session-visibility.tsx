// Who can see a session, and which connections it may use because of it (#335). A personal connection's data must
// never reach a session other people can see, so a session's visibility decides which connections it can pick:
//
// - `private`: only the person the session acts for can open it. Their personal connections work here.
// - `shared`: the project's members (or the organisation's, for an organisation session) can open it. Personal
//   connections are refused unless their owner shared them with the project.
//
// `SessionVisibilityButton` sits in the session's header and says which it is; `SessionVisibilityDialog` changes it,
// and lists the connections the session could use with each choice, with the reason for each one it couldn't, as the
// API's check answers (the same function every request goes through). Making a private session shared warns that what
// is already in it becomes visible too.

import { useId, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { CheckCircleIcon, LockIcon, MinusCircleIcon, PeopleIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";

/** Who can see a session: only the person it acts for, or more people than that. */
export type SessionVisibility = "private" | "shared";

/** One connection as a session sees it: whether it may use it with a given visibility, and if not, why. */
export interface SessionConnectionView {
	readonly id: string;
	readonly name: string;
	readonly icon?: string;
	/** Whose account it is: "tvdavies", "Acme workspace". */
	readonly account?: string;
	readonly owner: "user" | "project" | "organisation";
	/** Whose it is, in words: "Yours", "Ana Ruiz's", "Support project", "Acme". */
	readonly ownerLabel: string;
	readonly usable: boolean;
	/** Why it's refused, in the API's words. */
	readonly reason?: string;
	/** A person's connection that reaches this session because they shared it with the project. */
	readonly viaShare?: boolean;
}

/** Where the session is: its project, or the organisation for an organisation session. */
export type SessionPlace =
	| { readonly kind: "project"; readonly name: string }
	| { readonly kind: "organisation"; readonly name: string };

export interface SessionVisibilitySource {
	/** The connections the session could use with `visibility`, and why each other one is refused. */
	connections(visibility: SessionVisibility): Promise<readonly SessionConnectionView[]>;
	/** Stores the change. */
	setVisibility(visibility: SessionVisibility): Promise<void>;
}

/** Who a shared session's audience is, in words: "Everyone in Support", "Everyone in Acme". */
export function sharedAudience(place: SessionPlace): string {
	return `Everyone in ${place.name}`;
}

/** The header button's words: "Only you" or the project's name. */
export function visibilityLabel(visibility: SessionVisibility, place: SessionPlace): string {
	return visibility === "private" ? "Only you" : place.name;
}

/** What each choice means, under its name in the dialog. */
export function visibilityHint(visibility: SessionVisibility, place: SessionPlace): string {
	return visibility === "private"
		? "Nobody else can open it. Your personal connections work here."
		: `${place.kind === "project" ? "Project" : "Organisation"} members can open it and follow along. Personal connections stay out, unless their owner shared them with ${place.kind === "project" ? place.name : "a project"}.`;
}

export interface SessionVisibilityButtonProps {
	readonly visibility: SessionVisibility;
	readonly place: SessionPlace;
	readonly onClick: () => void;
}

/** The header's chip: a lock and "Only you", or people and the project's name. Opens the dialog. */
export function SessionVisibilityButton({ visibility, place, onClick }: SessionVisibilityButtonProps) {
	const label = visibilityLabel(visibility, place);
	return (
		<Button
			variant="ghost"
			size="sm"
			className="kt-session-visibility"
			icon={visibility === "private" ? <LockIcon size="sm" /> : <PeopleIcon size="sm" />}
			aria-label={`Who can see this session: ${visibility === "private" ? "only you" : sharedAudience(place)}`}
			onClick={onClick}
		>
			<span className="max-w-32 truncate max-sm:max-w-20">{label}</span>
		</Button>
	);
}

export interface SessionVisibilityDialogProps {
	readonly open: boolean;
	readonly visibility: SessionVisibility;
	readonly place: SessionPlace;
	readonly source: SessionVisibilitySource;
	/**
	 * Why the viewer can't change it, when they can't: only the person a session acts for may, and a child session has
	 * its parent's. The dialog then shows the choice and the connections, read-only.
	 */
	readonly locked?: string | undefined;
	readonly onClose: () => void;
	/** After a change is stored. */
	readonly onChanged?: (visibility: SessionVisibility) => void;
}

/** Changes who can see a session, showing which connections it could use either way, and why others are refused. */
export function SessionVisibilityDialog({
	open,
	visibility,
	place,
	source,
	locked,
	onClose,
	onChanged,
}: SessionVisibilityDialogProps) {
	const [chosen, setChosen] = useState<SessionVisibility>(visibility);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const name = useId();
	const changing = chosen !== visibility;

	const close = () => {
		setChosen(visibility);
		setError(undefined);
		onClose();
	};

	const save = async () => {
		if (!changing) return close();
		setBusy(true);
		setError(undefined);
		try {
			await source.setVisibility(chosen);
			onChanged?.(chosen);
			onClose();
		} catch (caught) {
			setError(caught instanceof Error && caught.message !== "" ? caught.message : "Couldn't change it. Try again.");
		} finally {
			setBusy(false);
		}
	};

	const options: readonly SessionVisibility[] = ["private", "shared"];
	return (
		<Dialog
			open={open}
			title="Who can see this session"
			onClose={close}
			actions={
				locked === undefined ? (
					<>
						<Button onClick={close} disabled={busy}>
							Cancel
						</Button>
						<Button variant="primary" busy={busy} disabled={!changing} onClick={() => void save()}>
							{!changing ? "Save" : chosen === "private" ? "Make it private" : `Share with ${place.name}`}
						</Button>
					</>
				) : (
					<Button onClick={close}>Close</Button>
				)
			}
		>
			<div className="flex min-w-0 flex-col gap-4">
				<fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={locked !== undefined || busy}>
					<legend className="kt-sr-only">Who can see this session</legend>
					{options.map((option) => (
						<label
							key={option}
							className="flex min-w-0 cursor-pointer items-start gap-3 rounded-panel border border-border p-3 has-checked:border-border-strong has-checked:bg-active has-disabled:cursor-default"
						>
							<input
								type="radio"
								name={name}
								value={option}
								checked={chosen === option}
								disabled={locked !== undefined || busy}
								onChange={() => setChosen(option)}
								className="kt-focusable mt-0.5 size-3.5 accent-accent"
							/>
							<span className="mt-px flex shrink-0 text-muted" aria-hidden="true">
								{option === "private" ? <LockIcon size="sm" /> : <PeopleIcon size="sm" />}
							</span>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="text-sm font-medium text-fg">
									{option === "private" ? "Only you" : sharedAudience(place)}
								</span>
								<span className="text-xs leading-normal text-muted">{visibilityHint(option, place)}</span>
							</span>
						</label>
					))}
				</fieldset>
				{locked === undefined ? null : (
					<Notice level="info" announce={false}>
						{locked}
					</Notice>
				)}
				{visibility === "private" && chosen === "shared" ? (
					<Notice level="warning">
						Everything already in this session becomes visible to {sharedAudience(place).toLowerCase()}, including
						anything your personal connections returned. From now on they're refused here.
					</Notice>
				) : null}
				<SessionConnections key={chosen} visibility={chosen} source={source} />
				{error === undefined ? null : <Notice level="error">{error}</Notice>}
			</div>
		</Dialog>
	);
}

/** The connections the session could use with `visibility`: usable first, then each refused one with its reason. */
export function SessionConnections({
	visibility,
	source,
}: {
	visibility: SessionVisibility;
	source: Pick<SessionVisibilitySource, "connections">;
}) {
	const headingId = useId();
	const loaded = useLoad(() => source.connections(visibility), [visibility]);
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby={headingId}>
			<h3 id={headingId} className="m-0 text-xs font-medium text-muted">
				{visibility === "private" ? "Connections it can use when private" : "Connections it can use when shared"}
			</h3>
			{loaded.state.status === "loading" ? (
				<div className="flex flex-col gap-2" aria-busy="true">
					<Skeleton lines={1} />
					<Skeleton lines={1} />
				</div>
			) : loaded.state.status === "error" ? (
				<Notice level="error" action={<Button onClick={loaded.reload}>Try again</Button>}>
					Couldn't check its connections.
				</Notice>
			) : loaded.state.value.length === 0 ? (
				<p className="m-0 text-sm text-muted">There are no connections in this organisation yet.</p>
			) : (
				<ul className="m-0 flex list-none flex-col p-0">
					{[...loaded.state.value]
						.sort((a, b) => Number(b.usable) - Number(a.usable))
						.map((connection) => (
							<li
								key={connection.id}
								className="flex min-w-0 items-start gap-2.5 border-0 border-t border-solid border-border py-2 first:border-t-0 first:pt-0"
							>
								<span
									className={`mt-0.5 flex shrink-0 ${connection.usable ? "text-status-done" : "text-faint"}`}
									aria-hidden="true"
								>
									{connection.usable ? <CheckCircleIcon size="sm" /> : <MinusCircleIcon size="sm" />}
								</span>
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
										<span className={`text-sm ${connection.usable ? "text-fg" : "text-muted"}`}>{connection.name}</span>
										{connection.account === undefined ? null : (
											<span className="text-xs text-muted wrap-anywhere">{connection.account}</span>
										)}
										<span className="text-xs text-faint">
											{connection.ownerLabel}
											{connection.viaShare === true ? ", shared with this project" : ""}
										</span>
									</span>
									{connection.usable || connection.reason === undefined ? null : (
										<span className="text-xs text-muted wrap-anywhere">{connection.reason}</span>
									)}
								</span>
								<span className="kt-sr-only">{connection.usable ? "Can use" : "Refused"}</span>
							</li>
						))}
				</ul>
			)}
		</section>
	);
}
