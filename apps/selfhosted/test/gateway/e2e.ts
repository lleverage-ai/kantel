// One end-to-end pass over the gateway's HTTP surface, shared by the in-process test (gateway.test.ts) and the
// compose test (gateway.stack.test.ts): every mounted API refuses a call without credentials, then a session runs a
// prompt to its answer and streams its events, the workspace read API lists and reads the bootstrap README, the
// audit query API returns the session's rows, the identity routes say who the key is and which projects it has (and
// keep its keys from an operator who administers nothing), the skills and memory routes answer reads and refuse the
// operator's imports, and the console's page is served.

export interface E2eTarget {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly organisationId: string;
	readonly projectId: string;
	readonly workspaceId: string;
	/** The bootstrap's named projects (KANTEL_PROJECTS), by name, all on the key. */
	readonly projects?: { readonly [name: string]: string };
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

/** Reads server-sent events until `stop` says so or `timeoutMs` passes; returns the event names seen. */
async function readEvents(response: Response, stop: (names: readonly string[]) => boolean, timeoutMs: number) {
	const names: string[] = [];
	if (response.body === null) return names;
	const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
	const deadline = Date.now() + timeoutMs;
	let buffer = "";
	try {
		while (!stop(names) && Date.now() < deadline) {
			const next = await Promise.race([
				reader.read(),
				new Promise<{ done: true; value: undefined }>((resolve) =>
					setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
				),
			]);
			if (next.done) break;
			buffer += next.value;
			for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
				const event = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const name = /^event: (.+)$/m.exec(event)?.[1];
				if (name !== undefined) names.push(name);
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return names;
}

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
		"/v1/sessions",
		`/v1/workspaces/${target.workspaceId}/files`,
		"/v1/audit/events",
		"/v1/deployment",
		"/v1/me",
		"/v1/projects",
		"/v1/keys",
		"/v1/skills",
		"/v1/memory/spaces",
	]) {
		const refused = await fetch(url(path));
		check(`${path} without credentials is 401`, refused.status === 401, { status: refused.status });
		const wrong = await fetch(url(path), { headers: { authorization: "Bearer hbr_not-a-key" } });
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

	// The skills and memory routes (#12): reads answer the key; loading them is the organisation admin's.
	const skills = await call(`/v1/skills?projectId=${encodeURIComponent(target.projectId)}`);
	const skillsBody = (await body(skills)) as { items?: unknown[] };
	check("GET /v1/skills lists the skills the key sees", skills.ok && Array.isArray(skillsBody.items), skillsBody);
	const skillImport = await call("/v1/skills/import", {
		method: "POST",
		body: JSON.stringify({
			owner: { kind: "project", organisationId: target.organisationId, projectId: target.projectId },
			name: "e2e-skill",
			description: "An end-to-end skill",
			files: [{ path: "SKILL.md", content: "---\nname: e2e-skill\ndescription: An end-to-end skill\n---\n" }],
			source: { sourceId: "e2e", ref: "1" },
		}),
	});
	check("POST /v1/skills/import is 403 for an operator who administers nothing", skillImport.status === 403, {
		status: skillImport.status,
		body: await body(skillImport),
	});
	const spaces = await call("/v1/memory/spaces");
	const spacesBody = (await body(spaces)) as { items?: unknown[] };
	check(
		"GET /v1/memory/spaces lists the spaces the key reads",
		spaces.ok && Array.isArray(spacesBody.items),
		spacesBody,
	);
	const space = await call("/v1/memory/spaces", {
		method: "POST",
		body: JSON.stringify({
			owner: { kind: "project", organisationId: target.organisationId, projectId: target.projectId },
			name: "e2e",
		}),
	});
	check("POST /v1/memory/spaces is 403 for an operator who administers nothing", space.status === 403, {
		status: space.status,
		body: await body(space),
	});

	// The session API: create, prompt, wait for the answer, then watch the events.
	const created = await call("/v1/sessions", {
		method: "POST",
		body: JSON.stringify({ projectId: target.projectId, agentId: "echo", title: "gateway e2e" }),
	});
	const session = (await body(created)) as { id?: string; status?: string };
	check("POST /v1/sessions creates a session", created.status === 201 && typeof session.id === "string", session);
	if (typeof session.id !== "string") return checks;
	const sessionId = session.id;

	const prompted = await call(`/v1/sessions/${sessionId}/prompt`, {
		method: "POST",
		body: JSON.stringify({ text: "hello from the e2e test", requestId: "e2e-1" }),
	});
	const submission = (await body(prompted)) as { id?: string };
	check("POST …/prompt is accepted", prompted.status === 202 && typeof submission.id === "string", submission);
	if (typeof submission.id !== "string") return checks;

	let result: { status?: string; answer?: string } = {};
	for (let attempt = 0; attempt < 20; attempt++) {
		const waited = await call(
			`/v1/sessions/${sessionId}/result?submission=${encodeURIComponent(submission.id)}&timeoutMs=5000`,
		);
		result = (await body(waited)) as typeof result;
		if (waited.status === 200) break;
	}
	check(
		"GET …/result answers with the echo model's reply",
		result.status === "answered" && result.answer === "Echo: hello from the e2e test",
		result,
	);

	const listed = await call(`/v1/sessions?projectId=${encodeURIComponent(target.projectId)}`);
	const page = (await body(listed)) as { items?: { id: string }[] };
	check(
		"GET /v1/sessions lists the session",
		listed.ok && (page.items ?? []).some((item) => item.id === sessionId),
		listed.ok ? { count: page.items?.length } : page,
	);

	const events = await call(`/v1/sessions/${sessionId}/events`, { headers: { accept: "text/event-stream" } });
	const names = await readEvents(events, (seen) => seen.includes("ready"), 10_000);
	check(
		"GET …/events streams hello, a snapshot and ready",
		events.ok && names[0] === "hello" && names.includes("snapshot") && names.includes("ready"),
		{ status: events.status, names },
	);

	// The workspace read API over the bootstrap workspace.
	const files = await call(`/v1/workspaces/${target.workspaceId}/files`);
	const listing = (await body(files)) as { items?: { path: string }[] };
	check(
		"GET /v1/workspaces/:id/files lists README.md",
		files.ok && (listing.items ?? []).some((entry) => entry.path.endsWith("README.md")),
		listing,
	);
	const content = await call(`/v1/workspaces/${target.workspaceId}/content?path=README.md`);
	const text = await content.text();
	check("GET /v1/workspaces/:id/content reads README.md", content.ok && text.startsWith("# Kantel self-hosted"), {
		status: content.status,
		version: content.headers.get("harbour-version"),
	});

	// The audit query API: the session's own rows, newest first.
	const audit = await call(`/v1/audit/events?sessionId=${encodeURIComponent(sessionId)}`);
	const rows = (await body(audit)) as { items?: { type: string }[] };
	const types = (rows.items ?? []).map((row) => row.type);
	check(
		"GET /v1/audit/events returns session.created and session.prompted",
		audit.ok && types.includes("session.created") && types.includes("session.prompted"),
		audit.ok ? { types } : rows,
	);

	if (options.console !== false) {
		for (const path of ["/", `/projects/${target.projectId}`]) {
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
