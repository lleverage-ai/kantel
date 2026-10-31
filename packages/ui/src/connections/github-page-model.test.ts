import { describe, expect, it } from "vitest";
import type { Connection } from "./connections-model.ts";
import {
	CATALOGUE,
	CLIENTS,
	CONNECTIONS,
	FIXTURE_REACH,
	FIXTURE_REACH_MANY,
	GITHUB_APP_MADE,
	GITHUB_OWN_APP,
	VIEWER,
} from "./fixtures.ts";
import {
	appPermissions,
	gitHubAppOf,
	gitHubPageState,
	leadConnection,
	ownerCounts,
	repositoryCount,
	tryProject,
	tryPrompts,
} from "./github-page-model.ts";

const github = CONNECTIONS.filter((c) => c.templateId === "github");
const tom = github.find((c) => c.id === "conn_github_tom") as Connection;
const bot = github.find((c) => c.id === "conn_github_bot") as Connection;
const githubClient = CLIENTS[1];
const billing = { kind: "project", organisationId: "org_acme", projectId: "proj_billing" } as const;

describe("GitHub's page state (#461)", () => {
	it("is not set up with no app to sign in through, app made once there is one, and connected once connected", () => {
		expect(gitHubPageState(GITHUB_OWN_APP, [])).toBe("not_set_up");
		expect(gitHubPageState(GITHUB_APP_MADE, [])).toBe("app_made");
		expect(gitHubPageState(GITHUB_APP_MADE, github)).toBe("connected");
		// A connection leads even where the app has since gone.
		expect(gitHubPageState(GITHUB_OWN_APP, github)).toBe("connected");
		// A connection to another service doesn't count.
		expect(
			gitHubPageState(
				GITHUB_APP_MADE,
				CONNECTIONS.filter((c) => c.templateId !== "github"),
			),
		).toBe("app_made");
	});

	it("is app made straight back from GitHub's manifest flow, before the catalogue says so", () => {
		if (githubClient === undefined) throw new Error("No GitHub client fixture");
		const app = {
			slug: "kantel-agent",
			installUrl: "https://github.com/apps/kantel-agent/installations/new",
			appUrl: "https://github.com/apps/kantel-agent",
		};
		const made = {
			status: "created",
			client: { ...githubClient, githubApp: app },
			installUrl: app.installUrl,
			appUrl: app.appUrl,
		} as const;
		expect(gitHubPageState(GITHUB_OWN_APP, [], made)).toBe("app_made");
		expect(gitHubAppOf(GITHUB_OWN_APP, made)).toEqual(app);
		expect(gitHubPageState(GITHUB_OWN_APP, [], { status: "failed", message: "No" })).toBe("not_set_up");
	});

	it("names the GitHub App the catalogue resolves to, and none for another client", () => {
		expect(gitHubAppOf(GITHUB_APP_MADE)?.slug).toBe("kantel-agent");
		expect(gitHubAppOf(CATALOGUE[0] ?? GITHUB_OWN_APP)).toBeUndefined();
	});
});

describe("the connection GitHub's page leads with", () => {
	it("is the viewer's own, else their open project's, else the organisation's", () => {
		expect(leadConnection(github, VIEWER)?.id).toBe("conn_github_tom");
		expect(leadConnection([bot, tom], VIEWER)?.id).toBe("conn_github_tom");
		expect(leadConnection([bot], VIEWER)?.id).toBe("conn_github_bot");
		const project = { ...bot, id: "conn_project", owner: billing };
		expect(leadConnection([bot, project], { ...VIEWER, projectId: "proj_billing" })?.id).toBe("conn_project");
		expect(leadConnection([], VIEWER)).toBeUndefined();
	});
});

describe("Try it", () => {
	it("starts in the connection's project, a project a person's is shared with, or the one open", () => {
		expect(tryProject({ ...bot, owner: billing }, VIEWER)).toBe("proj_billing");
		// Tom's is shared with Support.
		expect(tryProject(tom, { ...VIEWER, projectId: "proj_billing" })).toBe("proj_support");
		expect(tryProject({ ...tom, shares: [] }, { ...VIEWER, projectId: "proj_billing" })).toBe("proj_billing");
		expect(tryProject({ ...tom, shares: [] }, VIEWER)).toBe("proj_support");
		expect(tryProject(bot, { ...VIEWER, projectId: "proj_billing" })).toBe("proj_billing");
		expect(tryProject({ ...bot, onlyProjects: ["proj_support"] }, { ...VIEWER, projectId: "proj_billing" })).toBe(
			"proj_support",
		);
		expect(tryProject({ ...tom, shares: [] }, { ...VIEWER, projects: [] })).toBeUndefined();
	});

	it("suggests prompts that name a repository it reaches, when one is known", () => {
		expect(tryPrompts()).toContain("Why did the last Actions run fail?");
		expect(tryPrompts(FIXTURE_REACH)).toContain("Why did the last Actions run on web fail?");
		expect(tryPrompts(FIXTURE_REACH)).toHaveLength(3);
	});
});

describe("what GitHub's page says", () => {
	it("lists the app's permissions read only, writes first", () => {
		expect(appPermissions().map((p) => `${p.label}: ${p.access}`)).toEqual([
			"Code and branches: write",
			"Issues: write",
			"Pull requests: write",
			"Actions runs: read",
			"Repository details: read",
			"Organisation members: read",
		]);
	});

	it("counts repositories by everything GitHub has, and by whose they are", () => {
		expect(repositoryCount(FIXTURE_REACH)).toBe("12 repositories");
		expect(ownerCounts(FIXTURE_REACH)).toBe("8 acme, 4 tvdavies");
		expect(repositoryCount(FIXTURE_REACH_MANY)).toBe("340 repositories");
		expect(repositoryCount({ ...FIXTURE_REACH, total: 1 })).toBe("12 repositories");
		expect(
			repositoryCount({ repositories: [{ fullName: "a/b", private: false }], total: 1, truncated: false, owners: [] }),
		).toBe("1 repository");
		expect(ownerCounts({ ...FIXTURE_REACH, owners: [] })).toBe("");
	});
});
