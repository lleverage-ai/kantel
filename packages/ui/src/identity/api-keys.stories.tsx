import { type ApiKey, KantelError, type HeldRole, type IssuedApiKey } from "@kantel/contracts";
import { useState } from "react";
import { DAY, MINUTE } from "../primitives/format.ts";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { ApiKeysPage } from "./api-keys.tsx";
import type { ApiKeysApi, ApiKeysState, KeyProject } from "./api-keys-model.ts";
import { ApiKeysLive } from "./stories-live-keys.tsx";
import { pageFrame } from "./story-frames.ts";

export default { title: "Identity/API keys" } satisfies StoryDefault;

/** A fixed time, so the ages read the same in every screenshot. */
const NOW = Date.UTC(2026, 9, 28, 14, 0, 0);
const HOUR = 60 * MINUTE;

const PROJECTS: readonly KeyProject[] = [
	{ id: "prj_harbour", name: "Kantel" },
	{ id: "prj_sal", name: "Sal" },
	{ id: "prj_brwsr", name: "brwsr" },
];

const ADMIN: readonly HeldRole[] = [{ role: "admin" }];
const OPERATOR: readonly HeldRole[] = [{ role: "operator" }];

/** Each key's first 12 characters, as a real secret's would read. */
const PREFIXES: Readonly<Record<string, string>> = {
	key_supervisor: "hbr_Xk3p9QaZ",
	key_ci_runner: "hbr_m7RtV2cL",
	key_nightly: "hbr_0dHs5WyN",
	key_old_bot: "hbr_Fa8jT4bE",
	key_trial: "hbr_pL6nK1uG",
	key_github_app: "hbr_q7Vb2xN0",
	key_lleverage: "hbr_Rz5yH8mQ",
};

const key = (id: string, rest: Partial<ApiKey> & Pick<ApiKey, "name" | "createdAt">): ApiKey => ({
	id,
	serviceId: `svc_${id}`,
	organisationId: "org_harbour",
	projectIds: ["prj_harbour"],
	role: "operator",
	prefix: PREFIXES[id] ?? "hbr_Q1w2E3r4",
	...rest,
});

const KEYS: readonly ApiKey[] = [
	key("key_supervisor", {
		name: "Sal's supervisor",
		projectIds: ["prj_sal", "prj_harbour"],
		createdAt: NOW - 12 * DAY,
		lastUsedAt: NOW - 4 * MINUTE,
	}),
	key("key_ci_runner", {
		name: "CI runner",
		role: "viewer",
		createdAt: NOW - 3 * DAY,
		lastUsedAt: NOW - 2 * HOUR,
		expiresAt: NOW + 87 * DAY,
	}),
	key("key_nightly", { name: "Nightly evals", projectIds: ["prj_brwsr"], createdAt: NOW - 20 * MINUTE }),
	key("key_lleverage", {
		name: "Lleverage",
		scope: "organisation",
		projectIds: [],
		permissions: ["create_projects"],
		createdAt: NOW - 2 * DAY,
		lastUsedAt: NOW - 30 * MINUTE,
	}),
	key("key_old_bot", {
		name: "Old deploy bot",
		role: "admin",
		createdAt: NOW - 60 * DAY,
		lastUsedAt: NOW - 9 * DAY,
		revokedAt: NOW - 8 * DAY,
	}),
	key("key_trial", { name: "Trial integration", createdAt: NOW - 45 * DAY, expiresAt: NOW - 15 * DAY }),
];

const ISSUED: IssuedApiKey = {
	key: key("key_github_app", { name: "GitHub app", createdAt: NOW, expiresAt: NOW + 90 * DAY }),
	secret: "hbr_q7Vb2xN0dLk4sR9mTzE1aYpW6cJhU3fG8oKiB5nXeM",
};

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

/** A stand-in for the key routes over a list in memory; `fail` makes a call reject as the server would. */
function storyApi(
	start: readonly ApiKey[],
	fail: { list?: KantelError; create?: KantelError; revoke?: KantelError } = {},
): ApiKeysApi {
	let keys = [...start];
	let made = 0;
	return {
		list: () =>
			pause(() => {
				if (fail.list) throw fail.list;
				return keys;
			}, 300),
		create: (input) =>
			pause(() => {
				if (fail.create) throw fail.create;
				made += 1;
				const issued: IssuedApiKey = {
					key: key(`key_story_${made}`, {
						name: input.name,
						...(input.scope === undefined ? {} : { scope: input.scope }),
						projectIds: input.projectIds ?? [],
						role: input.role,
						...(input.permissions === undefined ? {} : { permissions: input.permissions }),
						createdAt: NOW,
						...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
					}),
					secret: ISSUED.secret,
				};
				keys = [...keys, issued.key];
				return issued;
			}),
		revoke: (keyId) =>
			pause(() => {
				if (fail.revoke) throw fail.revoke;
				keys = keys.map((k) => (k.id === keyId ? { ...k, revokedAt: NOW } : k));
			}),
	};
}

function Page({
	api,
	roles = ADMIN,
	projects = PROJECTS,
	initial,
}: {
	api: () => ApiKeysApi;
	roles?: readonly HeldRole[];
	projects?: readonly KeyProject[];
	initial?: () => ApiKeysState;
}) {
	const [made] = useState(api);
	const [start] = useState(initial ?? (() => undefined));
	return (
		<div className={pageFrame}>
			<ApiKeysPage
				api={made}
				projects={projects}
				roles={roles}
				now={() => NOW}
				{...(start === undefined ? {} : { initial: start })}
			/>
		</div>
	);
}

const listed = (rest: Partial<ApiKeysState> = {}): ApiKeysState => ({ keys: KEYS, loading: false, ...rest });

export const Empty: Story = () => <Page api={() => storyApi([])} />;

export const List: Story = () => <Page api={() => storyApi(KEYS)} initial={() => listed()} />;

export const Loading: Story = () => (
	<Page api={() => ({ ...storyApi(KEYS), list: () => new Promise<never>(() => undefined) })} />
);

export const NewKey: Story = () => (
	<Page
		api={() => storyApi(KEYS)}
		initial={() =>
			listed({
				draft: {
					name: "GitHub app",
					scope: "projects",
					projectId: "prj_harbour",
					role: "operator",
					expiry: "90d",
					createProjects: false,
					busy: false,
				},
			})
		}
	/>
);
NewKey.storyName = "New key";

/** An organisation admin's key for a host app that makes a project per customer: every project, at most operator. */
export const NewOrganisationKey: Story = () => (
	<Page
		api={() => storyApi(KEYS)}
		initial={() =>
			listed({
				draft: {
					name: "Lleverage",
					scope: "organisation",
					projectId: "prj_harbour",
					role: "operator",
					expiry: "never",
					createProjects: true,
					busy: false,
				},
			})
		}
	/>
);
NewOrganisationKey.storyName = "New organisation key";

/** A project admin is offered project keys only: an organisation key needs an organisation-wide admin. */
export const ProjectAdmin: Story = () => (
	<Page roles={[{ projectId: "prj_harbour", role: "admin" }]} api={() => storyApi(KEYS.slice(0, 2))} />
);
ProjectAdmin.storyName = "Project admin";

export const SecretShownOnce: Story = () => (
	<Page
		api={() => storyApi([...KEYS, ISSUED.key])}
		initial={() => listed({ keys: [...KEYS, ISSUED.key], issued: ISSUED })}
	/>
);
SecretShownOnce.storyName = "Secret shown once";

export const RevokeConfirm: Story = () => (
	<Page api={() => storyApi(KEYS)} initial={() => listed({ confirming: "key_ci_runner" })} />
);
RevokeConfirm.storyName = "Revoke confirm";

/** An operator who administers no project: the routes let them in, but no key is theirs to see or change. */
export const NotAdmin: Story = () => <Page api={() => storyApi([])} roles={OPERATOR} />;
NotAdmin.storyName = "Operator, not admin";

export const NoProjects: Story = () => <Page api={() => storyApi([])} projects={[]} />;
NoProjects.storyName = "No projects";

export const LoadFailed: Story = () => (
	<Page api={() => storyApi(KEYS, { list: new KantelError("unavailable", "Kantel is restarting") })} />
);
LoadFailed.storyName = "Error: list failed";

export const Viewer: Story = () => (
	<Page
		roles={[{ role: "viewer" }]}
		api={() => storyApi([], { list: new KantelError("forbidden", "API keys need the operator role or stronger") })}
	/>
);
Viewer.storyName = "Error: viewer";

export const CreateRefused: Story = () => (
	<Page
		roles={[{ projectId: "prj_harbour", role: "admin" }]}
		api={() => storyApi(KEYS, { create: new KantelError("forbidden", "needs admin on the organisation") })}
		initial={() =>
			listed({
				draft: {
					name: "GitHub app",
					scope: "projects",
					projectId: "prj_harbour",
					role: "operator",
					expiry: "never",
					createProjects: false,
					busy: false,
					problem: { kind: "forbidden" },
				},
			})
		}
	/>
);
CreateRefused.storyName = "Error: create refused";

export const CreateInvalid: Story = () => (
	<Page
		api={() => storyApi(KEYS)}
		initial={() =>
			listed({
				draft: {
					name: "",
					scope: "projects",
					projectId: "prj_harbour",
					role: "operator",
					expiry: "never",
					createProjects: false,
					busy: false,
					nameError: "Name the key after what will use it.",
				},
			})
		}
	/>
);
CreateInvalid.storyName = "Error: no name";

export const RevokeFailed: Story = () => (
	<Page
		api={() => storyApi(KEYS, { revoke: new KantelError("forbidden", "needs admin on the project") })}
		initial={() => listed({ revokeProblem: { keyId: "key_supervisor", problem: { kind: "forbidden" } } })}
	/>
);
RevokeFailed.storyName = "Error: revoke refused";

/** The page on the real handler and an in-memory directory: issue a key, then call with it, revoke it and call again. */
export const Live: Story = () => <ApiKeysLive />;
