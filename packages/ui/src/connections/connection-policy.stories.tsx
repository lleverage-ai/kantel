import type { ConnectionRules } from "@kantel/contracts";
import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { PolicyGridView, policyOptions } from "./connection-policy.tsx";
import { choiceOf, policyExceptions, readPolicyGrid } from "./connection-policy-model.ts";
import { ConnectionRulesSection } from "./connection-rules.tsx";
import type { ConnectionRulesSource } from "./connections-model.ts";
import {
	CONNECTIONS,
	createRulesScenario,
	FIXTURE_NOW,
	FIXTURE_RULES,
	MEMBER_VIEWER,
	MIGRATED_RULES,
	POLICY_RULES,
	policyFixture,
	VIEWER,
} from "./fixtures.ts";

export default { title: "Connections/What agents may do" } satisfies StoryDefault;

const github = CONNECTIONS.find((c) => c.id === "conn_github_tom") ?? CONNECTIONS[0]!;
const options = policyOptions(github, FIXTURE_NOW);
const grid = readPolicyGrid(POLICY_RULES, options);

const WRITES_ALLOWED = policyFixture(POLICY_RULES, choiceOf(grid, { cell: { key: "repo:write", action: "allow" } }));
const REPOSITORIES = policyFixture(
	POLICY_RULES,
	choiceOf(grid, { repositories: ["tvdavies/harbour", "tvdavies/sal", "tvdavies/brwsr"] }),
);
/** A person's rule letting every PATCH through: writes are allowed for some requests and ask for the rest. */
const MIXED: ConnectionRules = {
	...POLICY_RULES,
	rules: [
		...POLICY_RULES.rules,
		{
			id: "cr_tom_patch",
			connectionId: "conn_github_tom",
			who: { kind: "any" },
			what: { kind: "endpoint", method: "PATCH", path: "/**" },
			action: "allow",
			uses: 0,
			source: "person",
			note: "Edits go through",
			createdBy: { kind: "human", userId: "usr_tom" },
			createdAt: FIXTURE_NOW - 3 * 86_400_000,
			updatedAt: FIXTURE_NOW - 3 * 86_400_000,
		},
	],
};

function Section({
	rules,
	connectionId = github.id,
	admin = true,
}: {
	rules: ConnectionRules;
	connectionId?: string;
	admin?: boolean;
}) {
	const connection = CONNECTIONS.find((c) => c.id === connectionId) ?? github;
	const viewer = admin ? VIEWER : MEMBER_VIEWER;
	const [source] = useState<ConnectionRulesSource>(() =>
		createRulesScenario({
			connections: () => CONNECTIONS,
			viewer,
			wait: (value) => new Promise((resolve) => setTimeout(() => resolve(value()), 150)),
			initial: { ...FIXTURE_RULES, [connectionId]: { ...rules, connectionId } },
		}),
	);
	return (
		<div className="flex w-full max-w-content min-w-0 flex-col p-1">
			<ConnectionRulesSection
				connection={connection}
				source={source}
				viewer={viewer}
				canManage={admin || connection.owner.kind === "user"}
				now={FIXTURE_NOW}
			/>
		</div>
	);
}

/**
 * Tom's GitHub connection with GitHub's defaults: reads allowed, writes ask, deletes blocked. An approval's rule, a
 * person's and one for a single session show as exceptions, each saying where it came from. Change a cell: the grid
 * dims while its rules save, and the rule list under Advanced shows them.
 */
export const Defaults: Story = () => <Section rules={POLICY_RULES} />;

/** Writes to repositories, issues and pull requests set to Allow: Actions workflows keep asking. */
export const WritesAllowed: Story = () => <Section rules={WRITES_ALLOWED} />;

/** Only three repositories: every other one is blocked, by a rule the grid made. */
export const RepositoryList: Story = () => <Section rules={REPOSITORIES} />;

/** A person's rule lets every PATCH through, so writes vary by request: the cells say so, with nothing lit. */
export const MixedCell: Story = () => <Section rules={MIXED} />;

/** The release bot's defaults, without the note that the migration gave them. */
const { defaults: _migrated, ...BOT_RULES } = MIGRATED_RULES;

/** Someone who can't manage the organisation's connection sees each answer, and no controls. */
export const ReadOnly: Story = () => (
	<Section
		connectionId="conn_github_bot"
		admin={false}
		rules={policyFixture(
			BOT_RULES,
			choiceOf(readPolicyGrid(BOT_RULES, options), { repositories: ["acme/web", "acme/api"] }),
		)}
	/>
);

function View({ saving, error }: { saving?: boolean; error?: string }) {
	return (
		<div className="flex w-full max-w-content min-w-0 flex-col p-1">
			<PolicyGridView
				grid={{ ...grid, cells: { ...grid.cells, "repo:write": "allow" } }}
				exceptions={policyExceptions(POLICY_RULES)}
				viewer={VIEWER}
				canManage
				saving={saving === true}
				{...(error === undefined ? {} : { error })}
				onCell={() => {}}
				onRepositories={() => {}}
			/>
		</div>
	);
}

/** While a change saves: the new answer shows, and the controls take nothing until the rules read back. */
export const Saving: Story = () => <View saving />;

/** A change the API refused: the grid reads the rules again and says why. */
export const SaveError: Story = () => (
	<View error="The organisation's ceiling doesn't allow POST api.github.com/repos, so this rule can't be saved" />
);

/** On a phone, each group's columns stack, each saying which it is. */
export const Mobile: Story = () => <Section rules={REPOSITORIES} />;
Mobile.meta = { width: 420 };
