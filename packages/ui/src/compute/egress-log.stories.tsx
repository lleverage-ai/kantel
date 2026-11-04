import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { EgressLog } from "./egress-log.tsx";
import type { LoggedEntry, ProtectedVariableRow } from "./egress-overview.ts";
import {
	DEV_STACK,
	EGRESS_LOG,
	ENVIRONMENTS,
	EVAL_EGRESS_LOG,
	EVAL_RUNNER,
	FIXTURE_NOW,
	SCRATCH,
	SCRATCH_EGRESS_LOG,
} from "./fixtures.ts";

export default { title: "Compute/Egress log" } satisfies StoryDefault;

const BACKEND = { id: "env_backend", name: "backend-dev" };
const EVALS = { id: "env_evals", name: "evals" };

const ENTRIES: readonly LoggedEntry[] = [
	...EGRESS_LOG.map((entry) => ({
		...entry,
		sandboxId: DEV_STACK.id,
		sandboxName: DEV_STACK.name,
		environment: BACKEND,
	})),
	...SCRATCH_EGRESS_LOG.map((entry) => ({ ...entry, sandboxId: SCRATCH.id, sandboxName: SCRATCH.name })),
	...EVAL_EGRESS_LOG.map((entry) => ({
		...entry,
		sandboxId: EVAL_RUNNER.id,
		sandboxName: EVAL_RUNNER.name,
		environment: EVALS,
	})),
].sort((a, b) => b.at - a.at);

const VARIABLES: readonly ProtectedVariableRow[] = ENVIRONMENTS.flatMap((env) =>
	env.variables
		.filter((variable) => variable.protected)
		.map((variable) => ({
			name: variable.name,
			bindings: variable.bindings,
			environment: { id: env.id, name: env.name },
		})),
);

const props = {
	entries: ENTRIES,
	variables: VARIABLES,
	now: FIXTURE_NOW,
	environmentHref: (id: string) => `#${id}`,
	onAllow: () => {},
};

/** Three sandboxes' requests: swaps, tunnels and denials. */
export const Default: Story = () => <EgressLog {...props} />;

/** A placeholder sent to a host it isn't bound to, opened: why, and the way to bind it. */
export const DenialOpen: Story = () => <EgressLog {...props} initialOpen={["egr_8", "egr_s2"]} />;

/** Only what was denied. */
export const Denied: Story = () => <EgressLog {...props} initialFilter="denied" />;

/** One sandbox's own, with no sandbox column: as a sandbox's page shows it. */
export const OneSandbox: Story = () => (
	<EgressLog {...props} entries={ENTRIES.filter((entry) => entry.sandboxId === DEV_STACK.id)} sandboxColumn={false} />
);

/** Nothing logged yet. */
export const Empty: Story = () => <EgressLog {...props} entries={[]} />;

/** On a phone: two lines a request. */
export const Phone: Story = () => <EgressLog {...props} narrow initialOpen={["egr_8"]} />;
Phone.meta = { width: 390 };
