import { KantelError } from "@kantel/contracts";
import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { MembersPage } from "./members.tsx";
import type { InviteRow, MemberRow, MembersApi, MembersState } from "./members-model.ts";
import { pageFrame } from "./story-frames.ts";

export default { title: "Identity/Members" } satisfies StoryDefault;

const MEMBERS: readonly MemberRow[] = [
	{ userId: "usr_ada", name: "Ada Lovelace" },
	{ userId: "usr_grace", name: "Grace Hopper" },
	{ userId: "usr_lin", name: "Lin Pemberton-Okonkwo-Vasquez, platform on-call this week" },
	{ userId: "usr_tom", name: "Tom" },
];

const INVITES: readonly InviteRow[] = [
	{ id: "inv_linus", email: "linus@example.com", role: "operator", expiresAt: Date.UTC(2026, 10, 14) },
	{ id: "inv_margaret", email: "margaret.hamilton@example.com", role: "viewer", expiresAt: Date.UTC(2026, 10, 14) },
];

const pause = <T,>(value: () => T, ms = 600): Promise<T> =>
	new Promise((resolve, reject) =>
		setTimeout(() => {
			try {
				resolve(value());
			} catch (error) {
				reject(error);
			}
		}, ms),
	);

/** A stand-in for the members and reset routes; `fail` makes a call reject as the server would. */
function storyApi(
	members: readonly MemberRow[],
	fail: { list?: KantelError; reset?: KantelError; invite?: KantelError } = {},
	invites: readonly InviteRow[] = [],
	emailed = false,
): MembersApi {
	return {
		listInvites: () => pause(() => invites, 300),
		invite: ({ email, role }) =>
			pause(() => {
				if (fail.invite) throw fail.invite;
				return {
					invite: { id: `inv_${email}`, email, role, expiresAt: Date.UTC(2026, 10, 14) },
					link: "https://harbour.example.com/",
					emailed,
				};
			}),
		revokeInvite: () => pause(() => undefined),
		list: () =>
			pause(() => {
				if (fail.list) throw fail.list;
				return members;
			}, 300),
		resetPasskeys: () =>
			pause(() => {
				if (fail.reset) throw fail.reset;
				return { removed: 2 };
			}),
	};
}

function Page({ api, initial }: { api: () => MembersApi; initial?: () => MembersState }) {
	const [made] = useState(api);
	const [start] = useState(initial ?? (() => undefined));
	return (
		<div className={pageFrame}>
			<MembersPage api={made} viewer="usr_tom" {...(start === undefined ? {} : { initial: start })} />
		</div>
	);
}

const listed = (rest: Partial<MembersState> = {}): MembersState => ({
	members: MEMBERS,
	invites: [],
	loading: false,
	...rest,
});

const YOU: readonly MemberRow[] = [{ userId: "usr_tom", name: "Tom" }];

export const List: Story = () => <Page api={() => storyApi(MEMBERS)} initial={() => listed()} />;

export const PendingInvites: Story = () => (
	<Page api={() => storyApi(MEMBERS, {}, INVITES)} initial={() => listed({ invites: INVITES })} />
);
PendingInvites.storyName = "Pending invites";

export const OnlyYou: Story = () => <Page api={() => storyApi(YOU)} initial={() => listed({ members: YOU })} />;
OnlyYou.storyName = "Only you";

export const InviteDialog: Story = () => (
	<Page api={() => storyApi(MEMBERS)} initial={() => listed({ inviting: { sending: false } })} />
);
InviteDialog.storyName = "Invite dialog";

export const InviteLink: Story = () => (
	<Page
		api={() => storyApi(MEMBERS, {}, INVITES.slice(0, 1))}
		initial={() =>
			listed({
				invites: INVITES.slice(0, 1),
				inviting: {
					sending: false,
					sent: { invite: INVITES[0] as InviteRow, link: "https://harbour.example.com/", emailed: false },
				},
			})
		}
	/>
);
InviteLink.storyName = "Invite link to share";

export const InviteRefused: Story = () => (
	<Page
		api={() => storyApi(MEMBERS, {}, INVITES)}
		initial={() => listed({ invites: INVITES, inviting: { sending: false, problem: { kind: "conflict" } } })}
	/>
);
InviteRefused.storyName = "Error: invite refused";

export const Loading: Story = () => (
	<Page api={() => ({ ...storyApi(MEMBERS), list: () => new Promise<never>(() => undefined) })} />
);

export const Empty: Story = () => <Page api={() => storyApi([])} />;

export const ResetConfirm: Story = () => (
	<Page api={() => storyApi(MEMBERS)} initial={() => listed({ confirming: "usr_grace" })} />
);
ResetConfirm.storyName = "Reset confirm";

export const ResetOwn: Story = () => (
	<Page api={() => storyApi(MEMBERS)} initial={() => listed({ confirming: "usr_tom" })} />
);
ResetOwn.storyName = "Reset your own";

export const ResetDone: Story = () => (
	<Page api={() => storyApi(MEMBERS)} initial={() => listed({ done: { userId: "usr_grace", removed: 2 } })} />
);
ResetDone.storyName = "Reset done";

export const LoadFailed: Story = () => (
	<Page api={() => storyApi(MEMBERS, { list: new KantelError("unavailable", "Kantel is restarting") })} />
);
LoadFailed.storyName = "Error: list failed";

export const ResetRefused: Story = () => (
	<Page
		api={() => storyApi(MEMBERS, { reset: new KantelError("forbidden", "needs admin on the organisation") })}
		initial={() => listed({ resetProblem: { userId: "usr_ada", problem: { kind: "forbidden" } } })}
	/>
);
ResetRefused.storyName = "Error: reset refused";
