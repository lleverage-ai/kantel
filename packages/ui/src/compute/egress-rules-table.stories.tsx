import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { type EgressOverview, protectedVariablesOf, rulesOf } from "./egress-overview.ts";
import { AddRuleDialog, EgressRulesTable, ProtectedVariablesTable } from "./egress-rules-table.tsx";
import { DEV_STACK, ENVIRONMENTS, PROXY } from "./fixtures.ts";

export default { title: "Compute/Egress rules" } satisfies StoryDefault;

const OVERVIEW: EgressOverview = {
	proxy: PROXY,
	environments: ENVIRONMENTS,
	sandboxes: [
		{
			sandboxId: DEV_STACK.id,
			sandboxName: DEV_STACK.name,
			accountId: DEV_STACK.accountId,
			protectedVariables: [],
			environmentGrants: [],
			grants: [{ id: "grt_dev_pypi", action: "allow", host: "pypi.org", methods: [], paths: [] }],
			entries: [],
		},
	],
	unread: [],
	unreadIds: [],
};

const RULES = rulesOf(OVERVIEW);
const VARIABLES = protectedVariablesOf(OVERVIEW);

/** The account's, its environments' and a sandbox's rules in one table, each with what it applies to. */
export const Default: Story = () => {
	const [rules, setRules] = useState(RULES);
	return (
		<EgressRulesTable
			rules={rules}
			scopeHref={(scope) => (scope.kind === "account" ? undefined : `#${scope.id}`)}
			onRemove={(rule) => setRules((current) => current.filter((each) => each.key !== rule.key))}
		/>
	);
};

/** No rules anywhere. */
export const Empty: Story = () => <EgressRulesTable rules={[]} />;

/** The protected variables and where each is swapped in. */
export const ProtectedVariables: Story = () => (
	<ProtectedVariablesTable variables={VARIABLES} environmentHref={(id) => `#${id}`} />
);

/** On a phone: two lines a rule, and a variable. */
export const Phone: Story = () => (
	<div className="flex flex-col gap-6">
		<EgressRulesTable rules={RULES} narrow onRemove={() => {}} />
		<ProtectedVariablesTable variables={VARIABLES} narrow />
	</div>
);
Phone.meta = { width: 390 };

const SCOPES = [
	{ kind: "account" as const },
	...ENVIRONMENTS.map((env) => ({ kind: "environment" as const, id: env.id, name: env.name })),
	{ kind: "sandbox" as const, id: DEV_STACK.id, name: DEV_STACK.name },
];

/** Add rule, for every sandbox: whole hosts only. */
export const AddRule: Story = () => <AddRuleDialog scopes={SCOPES} onClose={() => {}} onAdd={async () => {}} />;

/** Add rule for an environment: methods and paths too. */
export const AddRuleForEnvironment: Story = () => (
	<AddRuleDialog
		scopes={SCOPES}
		initial={{ scope: { kind: "environment", id: "env_backend", name: "backend-dev" } }}
		onClose={() => {}}
		onAdd={async () => {}}
	/>
);

/** Allowed hosts chosen with no host allowed for every sandbox: the first is asked for, and sent with the policy. */
export const FirstHost: Story = () => (
	<AddRuleDialog scopes={SCOPES} firstHost onClose={() => {}} onAdd={async () => {}} />
);

/** While sandboxes may reach nothing, a rule allowing a host for every sandbox makes it Allowed hosts. */
export const AddRuleWhileClosed: Story = () => (
	<AddRuleDialog scopes={SCOPES} closed onClose={() => {}} onAdd={async () => {}} />
);

/** Allowing a denied request's host, from the log: for the sandbox that asked. */
export const AllowFromLog: Story = () => (
	<AddRuleDialog
		scopes={SCOPES}
		initial={{ action: "allow", host: "example-tracker.io", scope: SCOPES[3] }}
		onClose={() => {}}
		onAdd={async () => {}}
	/>
);
