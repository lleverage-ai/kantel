import { describe, expect, it } from "vitest";
import { environmentNamesText } from "./compute-model.ts";
import {
	bindingText,
	hostProblem,
	inspectedHosts,
	pathProblem,
	repoUrlProblem,
	variableNameProblem,
} from "./egress-rules.ts";
import { API_SERVER, createComputeFixtures, DEV_STACK, LLEVERAGE, RENDER } from "./fixtures.ts";
import { shadowedLines } from "./sandbox-environments.tsx";

describe("what a binding, a grant and a repository may be", () => {
	it("takes a host alone, with a wildcard only for subdomains", () => {
		expect(hostProblem("api.github.com")).toBeUndefined();
		expect(hostProblem("*.example.com")).toBeUndefined();
		expect(hostProblem("https://api.github.com")).toMatch(/without https/);
		expect(hostProblem("api.github.com/user")).toMatch(/no path/);
		expect(hostProblem("api.github.com:443")).toMatch(/no port/);
		expect(hostProblem("*")).toMatch(/subdomains/);
		expect(hostProblem("*example.com")).toMatch(/subdomains/);
	});

	it("takes a path starting / with no query", () => {
		expect(pathProblem("/repos/")).toBeUndefined();
		expect(pathProblem("repos")).toBeDefined();
		expect(pathProblem("/user?x=1")).toBeDefined();
	});

	it("keeps Kantel's own variable names for itself", () => {
		expect(variableNameProblem("GH_TOKEN")).toBeUndefined();
		expect(variableNameProblem("1TOKEN")).toBeDefined();
		expect(variableNameProblem("HTTPS_PROXY")).toMatch(/Kantel sets/);
		expect(variableNameProblem("KANTEL_SANDBOX")).toMatch(/Kantel sets/);
	});

	it("refuses a repository the environment already has, however its address is written", () => {
		const taken = ["https://github.com/lleverage-ai/kantel"];
		expect(repoUrlProblem("https://github.com/lleverage-ai/evals", taken)).toBeUndefined();
		expect(repoUrlProblem("https://github.com/lleverage-ai/kantel", taken)).toMatch(/already/);
		expect(repoUrlProblem("https://github.com/Lleverage-AI/kantel.git", taken)).toMatch(/already/);
		expect(repoUrlProblem("git@github.com:lleverage-ai/kantel", taken)).toMatch(/https/);
		// Another Git server may keep two repositories apart by case alone.
		const own = ["https://git.example.com/team/Service.git"];
		expect(repoUrlProblem("https://git.example.com/team/service.git", own)).toBeUndefined();
		expect(repoUrlProblem("https://GIT.example.com/team/Service/", own)).toMatch(/already/);
	});

	it("says which hosts the proxy looks inside", () => {
		const github = { host: "api.github.com", pathPrefixes: [], methods: [] };
		const npm = { id: "g", action: "allow" as const, host: "registry.npmjs.org", methods: [], paths: [] };
		const deleteRepos = {
			id: "d",
			action: "deny" as const,
			host: "example.com",
			methods: ["DELETE" as const],
			paths: [],
		};
		expect(inspectedHosts([github], [npm, deleteRepos])).toEqual(["api.github.com", "example.com"]);
		expect(bindingText({ host: "api.openai.com", pathPrefixes: ["/v1/"], methods: ["POST"] })).toBe(
			"POST api.openai.com /v1/",
		);
	});
});

describe("the sample environments", () => {
	it("never read back a protected value, and need a binding to protect one", async () => {
		const source = createComputeFixtures();
		const env = await source.environments.get("env_backend");
		const token = env.variables.find((variable) => variable.name === "GH_TOKEN");
		expect(token?.protected).toBe(true);
		expect(token?.value).toBeUndefined();
		await expect(
			source.environments.setVariable(env.id, { name: "X_TOKEN", protected: true, value: "secret", bindings: [] }),
		).rejects.toThrow(/host/);
		const saved = await source.environments.setVariable(env.id, {
			name: "X_TOKEN",
			protected: true,
			value: "secret",
			bindings: [{ host: "api.example.com", pathPrefixes: [], methods: [] }],
		});
		expect(JSON.stringify(saved)).not.toContain("secret");
	});

	it("keep a sandbox's placeholder when a value is rotated", async () => {
		const source = createComputeFixtures();
		const before = await source.egress.get(DEV_STACK.id);
		const token = (await source.environments.get("env_backend")).variables.find((each) => each.name === "GH_TOKEN");
		if (token === undefined) throw new Error("no GH_TOKEN");
		await source.environments.setVariable("env_backend", { ...token, value: "rotated" });
		const after = await source.egress.get(DEV_STACK.id);
		expect(after.protectedVariables).toEqual(before.protectedVariables);
		expect(before.protectedVariables[0]?.placeholderPrefix).toMatch(/^kph_/);
	});

	it("refuse a repository list with one address twice, and leave the list as it was", async () => {
		const source = createComputeFixtures();
		const env = await source.environments.get("env_backend");
		const first = env.repos[0];
		if (first === undefined) throw new Error("no repository");
		await expect(source.environments.setRepos(env.id, [...env.repos, { url: first.url, ref: "dev" }])).rejects.toThrow(
			/twice/,
		);
		expect((await source.environments.get(env.id)).repos).toEqual(env.repos);
		const fewer = await source.environments.setRepos(env.id, env.repos.slice(1));
		expect(fewer.repos).toEqual(env.repos.slice(1));
	});

	it("list an account's environments by name", async () => {
		const source = createComputeFixtures();
		const names = (await source.environments.list(LLEVERAGE.id)).map((env) => env.name);
		expect(names).toEqual(["backend-dev", "evals", "lleverage-github"]);
	});
});

describe("a sample sandbox's environments", () => {
	it("say what each loses to a later one, and which come when it next starts", async () => {
		const source = createComputeFixtures();
		const environments = source.sandboxes.environments;
		if (environments === undefined) throw new Error("No sandbox environments.");
		const [backend, github] = await environments.list(API_SERVER.id);
		expect(backend?.shadowed).toEqual({ variables: ["GH_TOKEN"], files: [], repos: ["~/kantel"] });
		expect(github?.shadowed).toEqual({ variables: [], files: [], repos: [] });
		expect(shadowedLines(backend?.shadowed ?? { variables: [], files: [], repos: [] })).toEqual([
			{ label: "Variables set later", items: ["GH_TOKEN"] },
			{ label: "Repositories cloned by a later one", items: ["~/kantel"] },
		]);
		expect((await environments.list(RENDER.id)).map((env) => env.pending)).toEqual([true]);
	});

	it("attach last (pending on a stopped one), move one attached again, and detach", async () => {
		const source = createComputeFixtures();
		const environments = source.sandboxes.environments;
		if (environments === undefined) throw new Error("No sandbox environments.");
		const attached = await environments.attach(RENDER.id, "env_evals");
		expect(attached.map((env) => [env.name, env.pending])).toEqual([
			["lleverage-github", true],
			["evals", true],
		]);
		const moved = await environments.attach(RENDER.id, "env_evals", 0);
		expect(moved.map((env) => env.name)).toEqual(["evals", "lleverage-github"]);
		expect((await source.sandboxes.get(RENDER.id)).environments?.map((env) => env.id)).toEqual([
			"env_evals",
			"env_github",
		]);
		const detached = await environments.detach(RENDER.id, "env_evals");
		expect(detached.map((env) => env.name)).toEqual(["lleverage-github"]);
		// Deleting an environment takes it off every sandbox.
		await source.environments.remove("env_github");
		expect(await environments.list(RENDER.id)).toEqual([]);
		expect((await source.sandboxes.get(API_SERVER.id)).environments?.map((env) => env.name)).toEqual(["backend-dev"]);
	});

	it("give the egress each protected variable from the environment that wins it, and every grant", async () => {
		const egress = await createComputeFixtures().egress.get(API_SERVER.id);
		expect(egress.environments.map((env) => env.name)).toEqual(["backend-dev", "lleverage-github"]);
		expect(egress.protectedVariables.find((variable) => variable.name === "GH_TOKEN")?.environmentId).toBe(
			"env_github",
		);
		expect(egress.environmentGrants.map((grant) => grant.id)).toContain("grt_gh_org");
	});

	it("names them in a line", () => {
		expect(environmentNamesText(undefined)).toBeUndefined();
		expect(environmentNamesText([{ id: "a", name: "a" }])).toBe("a");
		expect(
			environmentNamesText([
				{ id: "a", name: "a" },
				{ id: "b", name: "b" },
				{ id: "c", name: "c" },
			]),
		).toBe("a, b and c");
	});
});
