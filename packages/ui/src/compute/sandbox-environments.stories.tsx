import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { Environment, SandboxEnvironment, SandboxEnvironmentsSource, SandboxState } from "./compute-model.ts";
import { API_SERVER, createComputeFixtures, DEV_STACK, ENVIRONMENTS, LLEVERAGE, RENDER, SCRATCH } from "./fixtures.ts";
import type { SandboxNotice } from "./sandbox-actions.tsx";
import { SandboxEnvironments } from "./sandbox-environments.tsx";

export default { title: "Compute/Sandbox environments" } satisfies StoryDefault;

const never = <T,>(): Promise<T> => new Promise<T>(() => {});

/** The section as a sandbox's Overview has it, on the sample data unless `source` stands in, with its notices. */
function Scenario({
	sandboxId = API_SERVER.id,
	state = "running",
	source: given,
	available: givenAvailable,
	attachOpen = false,
	narrow = false,
}: {
	sandboxId?: string;
	state?: SandboxState;
	source?: SandboxEnvironmentsSource;
	available?: () => Promise<readonly Environment[]>;
	attachOpen?: boolean;
	narrow?: boolean;
}) {
	const [fixtures] = useState(() => createComputeFixtures({ settleMs: 600 }));
	const [notice, setNotice] = useState<SandboxNotice>();
	const source = given ?? fixtures.sandboxes.environments;
	if (source === undefined) return null;
	return (
		<div className={`flex flex-col gap-3 p-6 ${narrow ? "" : "max-w-(--kt-content-width)"}`}>
			<SandboxEnvironments
				source={source}
				sandboxId={sandboxId}
				state={state}
				available={givenAvailable ?? (() => fixtures.environments.list(LLEVERAGE.id))}
				environmentHref={(id) => `#environments/${id}`}
				onNotice={setNotice}
				attachOpen={attachOpen}
			/>
			{notice === undefined ? null : (
				<p className={`m-0 text-sm ${notice.level === "error" ? "text-status-error" : "text-muted"}`}>{notice.text}</p>
			)}
		</div>
	);
}

/** A source with these environments that answers at once, for a state the sample doesn't have. */
const fixed = (environments: readonly SandboxEnvironment[]): SandboxEnvironmentsSource => ({
	list: async () => environments,
	attach: async () => environments,
	detach: async () => environments,
});

const shadowedNone = { variables: [], files: [], repos: [] };

/**
 * Two, in order: lleverage-github is later, so its GH_TOKEN and its clone of kantel win over backend-dev's, which
 * says so quietly. Attach and Detach work on the sample.
 */
export const Default: Story = () => <Scenario />;

/** Several, each losing something to a later one, and the last losing a variable to the sandbox's own env. */
export const Shadowed: Story = () => (
	<Scenario
		source={fixed([
			{
				id: "env_backend",
				name: "backend-dev",
				shadowed: {
					variables: ["GH_TOKEN", "NODE_ENV", "DATABASE_URL"],
					files: ["/home/user/.npmrc"],
					repos: ["~/kantel"],
				},
				pending: false,
			},
			{
				id: "env_evals",
				name: "evals",
				shadowed: { variables: ["EVAL_SUITE"], files: [], repos: [] },
				pending: false,
			},
			{
				id: "env_github",
				name: "lleverage-github",
				shadowed: { variables: ["GIT_AUTHOR_NAME"], files: [], repos: [] },
				pending: false,
			},
		])}
	/>
);

/** Attached while it was stopped: its files and repositories come when the sandbox next starts. */
export const Pending: Story = () => <Scenario sandboxId={RENDER.id} state="stopped" />;

/** Running, with one being set up in the background: Setting up, and the section reads again until it's done. */
export const SettingUp: Story = () => (
	<Scenario
		source={fixed([
			{ id: "env_backend", name: "backend-dev", shadowed: shadowedNone, pending: false },
			{ id: "env_npm", name: "npm", shadowed: shadowedNone, pending: true },
		])}
	/>
);

/** One environment: no word on order. */
export const One: Story = () => <Scenario sandboxId={DEV_STACK.id} />;

/** None yet: Attach gives it one. */
export const Empty: Story = () => <Scenario sandboxId={SCRATCH.id} />;

/** Reading them. */
export const Loading: Story = () => <Scenario source={{ ...fixed([]), list: never }} />;

/** Kantel couldn't read them. */
export const Failed: Story = () => (
	<Scenario source={{ ...fixed([]), list: () => Promise.reject(new Error("The gateway didn't answer.")) }} />
);

/** Attach open, on the sample: the account's environments the sandbox doesn't have. */
export const Attach: Story = () => <Scenario sandboxId={DEV_STACK.id} attachOpen />;

/** Attach on a stopped sandbox: its files and repositories come when it next starts. */
export const AttachStopped: Story = () => <Scenario sandboxId={RENDER.id} state="stopped" attachOpen />;

/** Attaching: the call doesn't answer, so Attach stays busy (pick one and press Attach). */
export const Attaching: Story = () => (
	<Scenario
		sandboxId={DEV_STACK.id}
		attachOpen
		source={{
			...fixed([{ id: "env_backend", name: "backend-dev", shadowed: shadowedNone, pending: false }]),
			attach: never,
		}}
	/>
);

/** An attach Kantel refuses: the dialog says why and stays open (pick one and press Attach). */
export const AttachFailed: Story = () => (
	<Scenario
		sandboxId={DEV_STACK.id}
		attachOpen
		source={{
			...fixed([{ id: "env_backend", name: "backend-dev", shadowed: shadowedNone, pending: false }]),
			attach: () =>
				Promise.reject(new Error("ANTHROPIC_API_KEY is a protected variable of evals; leave it out of env")),
		}}
	/>
);

/** Attach with nothing left to attach: it has every environment in the account. */
export const AttachNothingLeft: Story = () => (
	<Scenario attachOpen available={async () => ENVIRONMENTS.filter((env) => env.id !== "env_evals")} />
);

const LONG = "backend-dev-with-github-npm-openai-and-the-staging-database-for-the-nightly-migrations";

/** Long names and many shadowed values wrap rather than push the row wide. */
export const LongContent: Story = () => (
	<Scenario
		source={fixed([
			{
				id: "env_long",
				name: LONG,
				shadowed: {
					variables: Array.from({ length: 14 }, (_, at) => `SERVICE_${at + 1}_INTERNAL_API_BASE_URL`),
					files: ["/home/user/.config/some-tool-with-a-long-name/credentials-for-the-staging-cluster.json"],
					repos: ["/home/user/src/github.com/lleverage-ai/a-repository-with-a-rather-long-name"],
				},
				pending: true,
			},
			{ id: "env_github", name: "lleverage-github", shadowed: shadowedNone, pending: false },
		])}
	/>
);

/** At 420px: the same rows, wrapping. */
export const Mobile: Story = () => <Scenario narrow />;
Mobile.meta = { width: 420 };

/** At 420px, long content. */
export const MobileLongContent: Story = () => (
	<Scenario
		narrow
		source={fixed([
			{
				id: "env_long",
				name: LONG,
				shadowed: { variables: ["GH_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY"], files: [], repos: ["~/kantel"] },
				pending: true,
			},
			{ id: "env_github", name: "lleverage-github", shadowed: shadowedNone, pending: false },
		])}
	/>
);
MobileLongContent.meta = { width: 420 };
