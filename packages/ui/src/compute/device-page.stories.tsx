import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { ComputeAccount, DeviceLoginsSource } from "./compute-model.ts";
import { DeviceLoginPage } from "./device-page.tsx";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_DEVICE_CODE, FIXTURE_NOW } from "./fixtures.ts";

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

/** Opened by `kantel login`: the code is in the address, so the person checks it and approves. */
export const Default: Story = () => <Scenario code={FIXTURE_DEVICE_CODE} />;

/** Opened by hand: the person types the code their terminal shows. */
export const TypeTheCode: Story = () => <Scenario />;

/** A code no sign-in has. */
export const UnknownCode: Story = () => <Scenario code="ZZZZ-ZZZZ" />;

/** In an organisation where the person is a member, who can't give a device a key there. */
export const NotAnAdmin: Story = () => <Scenario code={FIXTURE_DEVICE_CODE} account={MEMBER_OF} />;

/** While it looks the code up. */
export const Loading: Story = () => <Scenario code={FIXTURE_DEVICE_CODE} options={{ hang: true }} />;

/** On a phone. */
export const Mobile: Story = () => <Scenario code={FIXTURE_DEVICE_CODE} />;
Mobile.meta = { width: 420 };
