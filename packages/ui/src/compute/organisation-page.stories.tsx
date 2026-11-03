import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { CreateOrganisationDialog, JoinOrganisationDialog } from "./account-switcher.tsx";
import type { ComputeAccount, OrganisationInvite } from "./compute-model.ts";
import {
	type ComputeFixtureOptions,
	createComputeFixtures,
	FIXTURE_NOW,
	LLEVERAGE,
	PERSONAL,
	VIEWER,
} from "./fixtures.ts";
import { OrganisationPage } from "./organisation-page.tsx";

export default { title: "Compute/Organisation page" } satisfies StoryDefault;

// Each story keeps its own source, so inviting, revoking and removing change its organisation; leaving it goes back to
// the personal account, and creating or joining one from there opens it.
function Scenario({
	account = LLEVERAGE,
	options,
	invited,
}: {
	account?: ComputeAccount;
	options?: ComputeFixtureOptions;
	invited?: OrganisationInvite;
}) {
	const [source] = useState(() => createComputeFixtures(options));
	const [current, setCurrent] = useState(account);
	const [dialog, setDialog] = useState<"create" | "join">();
	return (
		<>
			<OrganisationPage
				key={current.id}
				source={source.accounts}
				account={current}
				viewerId={VIEWER.id}
				now={FIXTURE_NOW}
				onCreate={() => setDialog("create")}
				onJoin={() => setDialog("join")}
				onLeft={() => setCurrent(PERSONAL)}
				{...(invited === undefined ? {} : { invited })}
			/>
			<CreateOrganisationDialog
				open={dialog === "create"}
				onClose={() => setDialog(undefined)}
				onCreate={async (input) => setCurrent(await source.accounts.createOrganisation(input))}
			/>
			<JoinOrganisationDialog
				open={dialog === "join"}
				onClose={() => setDialog(undefined)}
				onJoin={async (code) => setCurrent(await source.accounts.join(code))}
			/>
		</>
	);
}

/** Lleverage, seen by Tom, an admin: he can invite, revoke and remove anyone but himself and the owner. */
export const Organisation: Story = () => <Scenario />;

/** An invite just made: its join code shows once, since Kantel sends no email. */
export const OrganisationInvited: Story = () => (
	<Scenario
		invited={{
			id: "inv_new",
			email: "sam@example.com",
			role: "member",
			sentAt: FIXTURE_NOW,
			code: "kji_q8w2mr5tz4kd9xv3bn7c",
		}}
	/>
);

/** A personal account: what organisations are for, and making or joining one. */
export const OrganisationPersonal: Story = () => <Scenario account={PERSONAL} />;

/** The members while they load. */
export const OrganisationLoading: Story = () => <Scenario options={{ hang: true }} />;

/** The members when Kantel can't be reached. */
export const OrganisationFailed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: the tables scroll sideways. */
export const OrganisationMobile: Story = () => <Scenario />;
OrganisationMobile.meta = { width: 420 };
