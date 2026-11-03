// One end-to-end pass over the gateway's HTTP surface, shared by the in-process test (gateway.test.ts) and the
// compose test (stack.ts): every mounted API refuses a call without credentials, the identity routes say who the key
// is and which projects it has (and keep its keys from an operator who administers nothing), the compute plane
// answers its super-admin's key, the agent plane's routes are gone, and the console's page is served.

export interface E2eTarget {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly organisationId: string;
	readonly projectId: string;
	/** The bootstrap's named projects (KANTEL_PROJECTS), by name, all on the key. */
	readonly projects?: { readonly [name: string]: string };
	/** The compute plane's super-admin key (`ksk_…`), from the bootstrap file. */
	readonly computeKey?: string;
}

export interface E2eCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}

async function body(response: Response): Promise<unknown> {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** The agent plane's routes, which an older version served: each is 404 now, whoever asks. */
export const REMOVED_ROUTES: readonly string[] = [
	"/v1/sessions",
	"/v1/workspaces/w_any/files",
	"/v1/skills",
	"/v1/memory/spaces",
	"/v1/connections",
	"/v1/model-providers",
	"/v1/vault/items",
	"/v1/approvals",
];

export async function runGatewayE2e(target: E2eTarget, options: { readonly console?: boolean } = {}) {
	const checks: E2eCheck[] = [];
	const check = (name: string, ok: boolean, detail?: unknown) => {
		checks.push({ name, ok, ...(detail === undefined ? {} : { detail: JSON.stringify(detail).slice(0, 500) }) });
	};
	const url = (path: string) => `${target.baseUrl}${path}`;
	const authorised = { authorization: `Bearer ${target.apiKey}` };
	const call = (path: string, init: RequestInit = {}) =>
		fetch(url(path), {
			...init,
			headers: { ...authorised, "content-type": "application/json", ...(init.headers ?? {}) },
		});

	const health = await fetch(url("/healthz"));
	check("healthz answers without credentials", health.ok, await body(health));

	for (const path of [
		"/v1/audit/events",
		"/v1/deployment",
		"/v1/me",
		"/v1/projects",
		"/v1/keys",
		"/v1/whoami",
		"/v1/sandboxes",
	]) {
		const refused = await fetch(url(path));
		check(`${path} without credentials is 401`, refused.status === 401, { status: refused.status });
		const wrong = await fetch(url(path), { headers: { authorization: "Bearer ktk_not-a-key" } });
		check(`${path} with an unknown key is 401`, wrong.status === 401, { status: wrong.status });
	}

	const deployment = await call("/v1/deployment");
	check("deployment lists its bindings", deployment.ok, await body(deployment));

	// The identity routes, as the bootstrap's key: a service with operator on the deployment's projects and nothing else.
	const named = Object.entries(target.projects ?? {});
	const keyProjects = [...new Set([target.projectId, ...named.map(([, id]) => id)])].sort();
	const me = await call("/v1/me");
	const meBody = (await body(me)) as { actor?: { kind?: string }; roles?: { projectId?: string; role: string }[] };
	const roles = meBody.roles ?? [];
	check(
		"GET /v1/me names the key's service and its operator role on each of the deployment's projects",
		me.ok &&
			meBody.actor?.kind === "service" &&
			roles.every((role) => role.role === "operator") &&
			JSON.stringify(roles.map((role) => role.projectId).sort()) === JSON.stringify(keyProjects),
		meBody,
	);
	const projects = await call("/v1/projects");
	const projectsBody = (await body(projects)) as { items?: { id: string; name: string }[] };
	const listedProjects = projectsBody.items ?? [];
	check(
		"GET /v1/projects lists the key's project and the bootstrap's named projects, by name",
		projects.ok &&
			listedProjects.some((project) => project.id === target.projectId) &&
			named.every(([name, id]) => listedProjects.some((project) => project.id === id && project.name === name)),
		projectsBody,
	);
	const keys = await call("/v1/keys");
	const keysBody = (await body(keys)) as { items?: unknown[] };
	check("GET /v1/keys lists no keys to an operator who administers nothing", keys.ok && keysBody.items?.length === 0, {
		status: keys.status,
		body: keysBody,
	});
	const issued = await call("/v1/keys", {
		method: "POST",
		body: JSON.stringify({ name: "e2e", projectIds: [target.projectId], role: "viewer" }),
	});
	check("POST /v1/keys is 403 for an operator who administers nothing", issued.status === 403, {
		status: issued.status,
	});

	const audit = await call("/v1/audit/events");
	check("GET /v1/audit/events answers the key", audit.ok, { status: audit.status });

	// The compute plane, as its super-admin.
	if (target.computeKey !== undefined) {
		const asCompute = { headers: { authorization: `Bearer ${target.computeKey}` } };
		const whoami = await fetch(url("/v1/whoami"), asCompute);
		check("GET /v1/whoami answers the compute plane's super-admin key", whoami.ok, await body(whoami));
		const sandboxes = await fetch(url("/v1/sandboxes"), asCompute);
		const sandboxesBody = (await body(sandboxes)) as { items?: unknown[] } | unknown[];
		check(
			"GET /v1/sandboxes lists the super-admin's sandboxes",
			sandboxes.ok && (Array.isArray(sandboxesBody) || Array.isArray(sandboxesBody.items)),
			sandboxesBody,
		);
	}

	// The agent plane is gone: its routes are 404 to the deployment's own key, not served or refused.
	for (const path of REMOVED_ROUTES) {
		const gone = await call(path);
		check(`${path} is 404: the agent plane was removed`, gone.status === 404, { status: gone.status });
	}

	if (options.console !== false) {
		for (const path of ["/", "/sandboxes", "/compute/sandboxes"]) {
			const page = await fetch(url(path));
			const html = await page.text();
			check(
				`GET ${path} serves the console`,
				page.ok && (page.headers.get("content-type") ?? "").startsWith("text/html") && html.includes("<div"),
				{ status: page.status },
			);
		}
	}
	return checks;
}
