import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { ComputeAccount, DeviceLoginsSource } from "./compute-model.ts";
import { DeviceLoginPage } from "./device-page.tsx";
import {
	type ComputeFixtureOptions,
	createComputeFixtures,
	FIXTURE_DEVICE_CODE,
	FIXTURE_NOW,
	FIXTURE_PERSONAL_DEVICE_CODE,
} from "./fixtures.ts";

export default { title: "Compute/Device sign-in page" } satisfies StoryDefault;

const PERSONAL: ComputeAccount = { id: "acc_tom", kind: "personal", name: "Tom Davies", role: "owner", members: 1 };
const MEMBER_OF: ComputeAccount = { id: "acc_acme", kind: "organisation", name: "Acme", role: "member", members: 6 };

// Each story keeps its own source, so Approve and Deny change its sign-in.
function Scenario({
	code,
	account = PERSONAL,
	options,
}: {
	code?: string;
	account?: ComputeAccount;
	options?: ComputeFixtureOptions;
}) {
	const [source] = useState(() => createComputeFixtures(options).devices as DeviceLoginsSource);
	return (
		<DeviceLoginPage source={source} account={account} now={FIXTURE_NOW} {...(code === undefined ? {} : { code })} />
	);
}

/** Opened by `kantel login`: it asks for a personal token, for all the person's accounts or only the open one. */
export const Default: Story = () => <Scenario code={FIXTURE_PERSONAL_DEVICE_CODE} />;

/** A personal token from an organisation where the person is a member: any member may approve one. */
export const PersonalAsAMember: Story = () => <Scenario code={FIXTURE_PERSONAL_DEVICE_CODE} account={MEMBER_OF} />;

/** An older kantel's sign-in, which gets an API key in the open account. */
export const AccountKey: Story = () => <Scenario code={FIXTURE_DEVICE_CODE} />;

/** Opened by hand: the person types the code their terminal shows. */
export const TypeTheCode: Story = () => <Scenario />;

/** A code no sign-in has. */
export const UnknownCode: Story = () => <Scenario code="ZZZZ-ZZZZ" />;

/** An older kantel's sign-in in an organisation where the person is a member, who can't give a device a key there. */
export const NotAnAdmin: Story = () => <Scenario code={FIXTURE_DEVICE_CODE} account={MEMBER_OF} />;

/** While it looks the code up. */
export const Loading: Story = () => <Scenario code={FIXTURE_DEVICE_CODE} options={{ hang: true }} />;

/** On a phone. */
export const Mobile: Story = () => <Scenario code={FIXTURE_PERSONAL_DEVICE_CODE} />;
Mobile.meta = { width: 420 };
