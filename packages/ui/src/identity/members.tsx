import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../primitives/button.tsx";
import { KeyIcon } from "../primitives/icons.tsx";
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
import "./members.css";

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
		<div className="hb-members">
			<header className="hb-members-head">
				<h1 className="hb-members-title">Members</h1>
				<p className="hb-members-lede">
					The people with a role in this organisation. If someone loses their passkeys, reset them here so they can set
					up a new one.
				</p>
			</header>

			<section className="hb-members-list" aria-label="Members">
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
						<div className="hb-members-loading">
							<span className="hb-sr-only">Loading members</span>
							<Skeleton lines={1} />
							<Skeleton lines={1} />
						</div>
					) : null
				) : members.length === 0 ? (
					<EmptyState title="No members">Nobody holds a role in this organisation yet.</EmptyState>
				) : (
					<ul className="hb-members-rows">
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
	const resetButton = useRef<HTMLButtonElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const wasConfirming = useRef(false);
	// Into the confirmation when it opens, and back to Reset when it closes.
	useEffect(() => {
		if (confirming) cancelButton.current?.focus();
		else if (wasConfirming.current) resetButton.current?.focus();
		wasConfirming.current = confirming;
	}, [confirming]);

	return (
		<li className="hb-member-row">
			<div className="hb-member-row-main">
				<p className="hb-member-row-title">
					<span className="hb-member-row-name">{member.name}</span>
					{you ? <Badge>You</Badge> : null}
				</p>
				{confirming ? null : (
					<Button
						ref={resetButton}
						size="xs"
						variant="secondary"
						icon={<KeyIcon size="sm" />}
						aria-label={`Reset passkeys for ${member.name}`}
						onClick={() => flow.askReset(member.userId)}
					>
						Reset passkeys
					</Button>
				)}
			</div>
			{confirming ? (
				// biome-ignore lint/a11y/useSemanticElements: a confirmation inside a list row, not a form or a fieldset.
				<div className="hb-member-confirm" role="group" aria-label={`Reset passkeys for ${member.name}`}>
					<p className="hb-member-confirm-text">
						{you
							? "Reset your own passkeys? Harbour removes every passkey you have, and you can set up a new one on the vault page."
							: `Reset ${member.name}'s passkeys? Harbour removes every passkey they have, and they can set up a new one on the vault page. Do this only once you know it's them asking.`}
					</p>
					<div className="hb-members-actions">
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
				<p className="hb-member-row-error" role="alert">
					{problemText(problem, "reset")}
				</p>
			)}
			{done === undefined ? null : (
				<p className="hb-member-row-done" role="status">
					{resetText(member.name, done.removed)}
				</p>
			)}
		</li>
	);
}
