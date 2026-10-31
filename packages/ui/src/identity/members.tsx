import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../primitives/button.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { EllipsisIcon, KeyRoundIcon } from "../primitives/lucide.tsx";
import { Menu } from "../primitives/menu.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	createMembersFlow,
	type MemberRow,
	type MembersApi,
	type MembersFlow,
	type MembersProblem,
	type MembersState,
	resetText,
} from "./members-model.ts";

// Styled with Tailwind utilities (src/tokens/tailwind.css). A heading, then the organisation's people, after Linear's and
// Vercel's members lists: one column at reading width, each row the person and a "…" menu holding Reset passkeys. The
// menu is always visible (not on hover), so it works the same with touch.

export interface MembersPageProps {
	/** `GET /v1/members` and `POST /v1/members/:userId/passkeys/reset`. */
	readonly api: MembersApi;
	/** The signed-in person's user ID, marked as you in the list. */
	readonly viewer?: string;
	/** Where the page starts, for stories; it loads the list either way. */
	readonly initial?: MembersState;
}

/** The sentence for a problem, by what was being done. */
function problemText(problem: MembersProblem, doing: "load" | "reset"): string {
	switch (problem.kind) {
		case "signed-out":
			return "You're signed out. Reload the page to sign in.";
		case "forbidden":
			return doing === "reset"
				? "You can't reset passkeys. It needs the admin role on this organisation."
				: "You can't list this organisation's members. Ask an admin of this organisation.";
		case "not-found":
			return "Harbour has no such member any more.";
		case "not-supported":
			return "This deployment has no passkeys to reset.";
		case "unavailable":
			return doing === "load"
				? "Harbour can't list its members right now. Try again in a moment."
				: "Harbour couldn't reset the passkeys. Try again in a moment.";
	}
}

/**
 * The organisation's members, for an admin, with a way to reset a person's passkeys when they've lost them. A reset
 * removes every passkey the person has, so they can set up a new one after signing in; Harbour audits it. Reset asks
 * first.
 */
export function MembersPage({ api, viewer, initial }: MembersPageProps) {
	const latest = useRef(api);
	latest.current = api;
	const [flow] = useState<MembersFlow>(() =>
		createMembersFlow({
			api: {
				list: () => latest.current.list(),
				resetPasskeys: (userId) => latest.current.resetPasskeys(userId),
			},
			...(initial === undefined ? {} : { initial }),
		}),
	);
	const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
	useEffect(() => {
		void flow.load();
	}, [flow]);
	const members = state.members ?? [];

	return (
		<div className="flex w-full max-w-content min-w-0 flex-col gap-6 text-sm leading-normal text-fg [&_p]:m-0">
			<PageHeader title="Members" />

			<section className="flex min-w-0 flex-col gap-2" aria-label="Members">
				{state.loadProblem === undefined ? null : (
					<Notice
						level={state.loadProblem.kind === "forbidden" ? "warning" : "error"}
						action={
							state.loadProblem.kind === "unavailable" ? (
								<Button size="xs" busy={state.loading} onClick={() => void flow.load()}>
									Try again
								</Button>
							) : undefined
						}
					>
						{problemText(state.loadProblem, "load")}
					</Notice>
				)}
				{state.members === undefined ? (
					state.loadProblem === undefined ? (
						<div className="flex flex-col gap-4">
							<span className="hb-sr-only">Loading members</span>
							<Skeleton lines={1} />
							<Skeleton lines={1} />
						</div>
					) : null
				) : members.length === 0 ? (
					<EmptyState title="No members">Nobody holds a role in this organisation yet.</EmptyState>
				) : (
					<ul className="m-0 flex list-none flex-col divide-y divide-border rounded-panel border border-border bg-panel p-0">
						{members.map((member) => (
							<MemberItem
								key={member.userId}
								member={member}
								you={member.userId === viewer}
								flow={flow}
								state={state}
							/>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}

function MemberItem({
	member,
	you,
	flow,
	state,
}: {
	member: MemberRow;
	you: boolean;
	flow: MembersFlow;
	state: MembersState;
}) {
	const confirming = state.confirming === member.userId;
	const resetting = state.resetting === member.userId;
	const problem = state.resetProblem?.userId === member.userId ? state.resetProblem.problem : undefined;
	const done = state.done?.userId === member.userId ? state.done : undefined;
	/** Holds the row's menu, whose trigger takes focus back when the confirmation closes. */
	const menuSlot = useRef<HTMLSpanElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const wasConfirming = useRef(false);
	// Into the confirmation when it opens, and back to the row's menu when it closes.
	useEffect(() => {
		if (confirming) cancelButton.current?.focus();
		else if (wasConfirming.current) menuSlot.current?.querySelector<HTMLButtonElement>("button")?.focus();
		wasConfirming.current = confirming;
	}, [confirming]);

	return (
		<li className="flex min-w-0 flex-col gap-2 px-3 py-2">
			<div className="flex min-w-0 items-center justify-between gap-2">
				<p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<span className="font-medium wrap-anywhere">{member.name}</span>
					{you ? <Badge>You</Badge> : null}
				</p>
				<span ref={menuSlot} className="flex flex-none">
					<Menu
						label={`Actions for ${member.name}`}
						icon={<EllipsisIcon />}
						align="end"
						entries={[
							{
								kind: "item",
								id: "reset-passkeys",
								label: "Reset passkeys",
								icon: <KeyRoundIcon />,
								disabled: confirming || resetting,
								onSelect: () => flow.askReset(member.userId),
							},
						]}
					/>
				</span>
			</div>
			{confirming ? (
				// biome-ignore lint/a11y/useSemanticElements: a confirmation inside a list row, not a form or a fieldset.
				<div
					className="flex flex-col gap-2 rounded-control border border-status-error-line bg-status-error-soft px-3 py-2.5"
					role="group"
					aria-label={`Reset passkeys for ${member.name}`}
				>
					<p className="wrap-anywhere">
						{you
							? "Reset your own passkeys? Harbour removes every passkey you have, and you can set up a new one on the connection request page."
							: `Reset ${member.name}'s passkeys? Harbour removes every passkey they have, and they can set up a new one on the connection request page. Do this only once you know it's them asking.`}
					</p>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="xs" variant="danger" busy={resetting} onClick={() => void flow.reset()}>
							Reset passkeys
						</Button>
						<Button
							ref={cancelButton}
							size="xs"
							variant="ghost"
							disabled={resetting}
							onClick={() => flow.cancelReset()}
						>
							Cancel
						</Button>
					</div>
				</div>
			) : null}
			{problem === undefined ? null : (
				<p className="text-xs text-status-error" role="alert">
					{problemText(problem, "reset")}
				</p>
			)}
			{done === undefined ? null : (
				<p className="text-xs text-muted" role="status">
					{resetText(member.name, done.removed)}
				</p>
			)}
		</li>
	);
}
