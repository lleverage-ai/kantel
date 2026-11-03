import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { ComputeAccount } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE, PERSONAL } from "./fixtures.ts";
import { TelemetryPage } from "./telemetry-page.tsx";

export default { title: "Compute/Telemetry page" } satisfies StoryDefault;

// Each story keeps its own source, so Save, the switch and Send test change its settings.
function Scenario({
	options,
	account = LLEVERAGE,
	httpOnly = false,
}: {
	options?: ComputeFixtureOptions;
	account?: ComputeAccount;
	httpOnly?: boolean;
}) {
	const [source] = useState(() => createComputeFixtures(options));
	const telemetry = httpOnly
		? { ...source.telemetry, protocols: ["http/protobuf" as const], attributes: false }
		: source.telemetry;
	return <TelemetryPage source={telemetry} account={account} now={FIXTURE_NOW} />;
}

/** An organisation exporting to Grafana Cloud, with its key set and two resource attributes. */
export const Default: Story = () => <Scenario />;

/** A personal account with nothing set up: no endpoint, so the switch waits for one. */
export const Unconfigured: Story = () => <Scenario account={PERSONAL} />;

/**
 * The fixtures' empty mode. Telemetry is a settings form, not a list, so empty is an account with nothing set: the
 * same as Unconfigured.
 */
export const Empty: Story = () => <Scenario options={{ empty: true }} account={PERSONAL} />;

/** Kantel's compute API today: OTLP/HTTP only and no resource attributes, so neither choice shows. */
export const HttpOnly: Story = () => <Scenario account={PERSONAL} httpOnly />;

/** The settings while they load. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** The settings when Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: fields stack, header rows wrap. */
export const Mobile: Story = () => <Scenario />;
Mobile.meta = { width: 420 };
