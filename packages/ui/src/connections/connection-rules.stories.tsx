import type { ConnectionCeiling, ConnectionDecision } from "@harbour/contracts";
import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { ConnectionRulesSection } from "./connection-rules.tsx";
import type { ConnectionRulesSource } from "./connections-model.ts";
import { ConnectionsPage, fakeWindow } from "./connections-page.tsx";
import {
	CONNECTIONS,
	createConnectionsScenario,
	createRulesScenario,
	FIXTURE_NOW,
	FIXTURE_RULES,
	MEMBER_VIEWER,
	PEOPLE,
	REDIRECT_URI,
	VIEWER,
} from "./fixtures.ts";

export default { title: "Connections/Rules" } satisfies StoryDefault;

const github = CONNECTIONS.find((c) => c.id === "conn_github_tom") ?? CONNECTIONS[0]!;
const linear = CONNECTIONS.find((c) => c.id === "conn_linear_support") ?? CONNECTIONS[0]!;
const slack = CONNECTIONS.find((c) => c.id === "conn_slack_org") ?? CONNECTIONS[0]!;

const CEILING: ConnectionCeiling = {
	set: true,
	routes: [
		{ host: "api.github.com", methods: ["GET", "HEAD", "POST", "PATCH"], pathPrefix: "/repos/acme" },
		{ host: "api.github.com", methods: ["GET"], pathPrefix: "/user" },
	],
};

function Section({
	connectionId = github.id,
	admin = true,
	ceiling,
	hang,
	fail,
	decision,
}: {
	connectionId?: string;
	admin?: boolean;
	ceiling?: ConnectionCeiling;
	hang?: boolean;
	fail?: boolean;
	decision?: ConnectionDecision;
}) {
	const connection = CONNECTIONS.find((c) => c.id === connectionId) ?? github;
	const viewer = admin ? VIEWER : MEMBER_VIEWER;
	const [source] = useState<ConnectionRulesSource>(() =>
		createRulesScenario({
			connections: () => CONNECTIONS,
			viewer,
			wait: (value) =>
				hang === true
					? new Promise(() => {})
					: new Promise((resolve, reject) =>
							setTimeout(() => {
								try {
									if (fail === true) throw new Error("Couldn't reach Harbour");
									resolve(value());
								} catch (error) {
									reject(error);
								}
							}, 150),
						),
			...(ceiling === undefined ? {} : { ceiling }),
		}),
	);
	return (
		<div className="flex w-full max-w-[var(--hb-content-width)] min-w-0 flex-col p-1">
			<ConnectionRulesSection
				connection={connection}
				source={source}
				viewer={viewer}
				canManage={admin || connection.owner.kind === "user"}
				now={FIXTURE_NOW}
				{...(decision === undefined ? {} : { initialDecision: decision })}
			/>
		</div>
	);
}

/** A GitHub connection's rules: the template's defaults, a person's own, one from an approval and one running out. */
export const Default: Story = () => <Section />;

/** While the rules load. */
export const Loading: Story = () => <Section hang />;

/** The rules couldn't be read. */
export const LoadError: Story = () => <Section fail />;

/** A connection made before rules: none yet, everything goes through, and the template's defaults one click away. */
export const Empty: Story = () => <Section connectionId={slack.id} />;

/** An MCP server's rules name its tools. */
export const McpTools: Story = () => <Section connectionId={linear.id} />;

/** Someone who can't manage the connection sees its rules and can try a request, but not change them. */
export const ReadOnly: Story = () => <Section admin={false} connectionId="conn_github_bot" />;

/** The organisation's ceiling, said above the rules. */
export const WithCeiling: Story = () => <Section ceiling={CEILING} />;

const deleteRule = FIXTURE_RULES.conn_github_tom?.rules.find((rule) => rule.id === "cr_gh_delete");

/** "Try a request" answered by a rule: the path the decision took, and the deciding rule lit in the list. */
export const TriedDenied: Story = () => (
	<Section
		decision={{
			action: "deny",
			by: { kind: "rule", ruleId: "cr_gh_delete" },
			...(deleteRule === undefined ? {} : { rule: deleteRule }),
			reason: "Any agent: DELETE /repos/** is blocked",
			rulesVersion: 6,
		}}
	/>
);

/** "Try a request" stopped by the ceiling before any rule was looked at. */
export const TriedCeiling: Story = () => (
	<Section
		ceiling={CEILING}
		decision={{
			action: "deny",
			by: { kind: "ceiling" },
			reason: "The organisation's ceiling doesn't allow DELETE api.github.com/orgs/acme, whatever a rule says",
			rulesVersion: 6,
		}}
	/>
);

/** "Try a request" with no rule matching: the connection's answer for those. */
export const TriedUnmatched: Story = () => (
	<Section
		decision={{
			action: "ask",
			by: { kind: "unmatched" },
			reason: "No rule covers it, so it needs approval",
			rulesVersion: 6,
		}}
	/>
);

/** Many rules, long paths and notes. */
export const LongContent: Story = () => {
	const many = {
		...FIXTURE_RULES,
		conn_github_tom: {
			...FIXTURE_RULES.conn_github_tom!,
			rules: [
				...FIXTURE_RULES.conn_github_tom!.rules,
				...Array.from({ length: 8 }, (_, index) => ({
					...FIXTURE_RULES.conn_github_tom!.rules[2]!,
					id: `cr_long_${index}`,
					what: {
						kind: "endpoint" as const,
						method: "PATCH" as const,
						path: `/repos/acme/a-very-long-repository-name-number-${index}/pulls/*/requested_reviewers`,
					},
					note: "Lets the release agent ask for reviews on its own pull requests, across every repository it maintains",
				})),
			],
		},
	};
	const [source] = useState(() =>
		createRulesScenario({ connections: () => CONNECTIONS, viewer: VIEWER, wait: async (v) => v(), initial: many }),
	);
	return (
		<div className="flex w-full max-w-[var(--hb-content-width)] min-w-0 flex-col p-1">
			<ConnectionRulesSection connection={github} source={source} viewer={VIEWER} canManage now={FIXTURE_NOW} />
		</div>
	);
};

/** On a phone. */
export const Mobile: Story = () => <Section />;
Mobile.meta = { width: 420 };

/** The whole connection page, with the rules under its details. */
export const OnConnectionPage: Story = () => {
	const [source] = useState(() => createConnectionsScenario({}, VIEWER));
	return (
		<ConnectionsPage
			source={source}
			viewer={VIEWER}
			people={(userId) => PEOPLE[userId]}
			redirectUri={REDIRECT_URI}
			now={FIXTURE_NOW}
			openWindow={fakeWindow()}
			initialView={{ name: "connection", connectionId: github.id }}
		/>
	);
};
