import { HarbourError } from "@harbour/contracts";
import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { MembersPage } from "./members.tsx";
import type { MemberRow, MembersApi, MembersState } from "./members-model.ts";
import "./stories.css";

export default { title: "Identity/Members" } satisfies StoryDefault;

const MEMBERS: readonly MemberRow[] = [
	{ userId: "usr_ada", name: "Ada Lovelace" },
	{ userId: "usr_grace", name: "Grace Hopper" },
	{ userId: "usr_lin", name: "Lin Pemberton-Okonkwo-Vasquez, platform on-call this week" },
	{ userId: "usr_tom", name: "Tom" },
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
function storyApi(members: readonly MemberRow[], fail: { list?: HarbourError; reset?: HarbourError } = {}): MembersApi {
	return {
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
		<div className="hb-story-keys">
			<MembersPage api={made} viewer="usr_tom" {...(start === undefined ? {} : { initial: start })} />
		</div>
	);
}

const listed = (rest: Partial<MembersState> = {}): MembersState => ({ members: MEMBERS, loading: false, ...rest });

export const List: Story = () => <Page api={() => storyApi(MEMBERS)} initial={() => listed()} />;

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
	<Page api={() => storyApi(MEMBERS, { list: new HarbourError("unavailable", "Harbour is restarting") })} />
);
LoadFailed.storyName = "Error: list failed";

export const ResetRefused: Story = () => (
	<Page
		api={() => storyApi(MEMBERS, { reset: new HarbourError("forbidden", "needs admin on the organisation") })}
		initial={() => listed({ resetProblem: { userId: "usr_ada", problem: { kind: "forbidden" } } })}
	/>
);
ResetRefused.storyName = "Error: reset refused";
