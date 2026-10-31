// One pass over email one-time PIN sign-in on the gateway, shared by the in-process test (codes from a memory mailer)
// and the compose test (codes read from Mailpit): an invited admin and a stranger get the same answer to start, only
// the admin gets a code, a wrong code is refused, the right one starts a Kantel session that every mounted API
// accepts, the code works only once, sign-in is audited, the person can see who they are and issue, use and revoke an
// API key, and an ended session is refused.
import { normaliseEmail, ORGANISATION_HEADER } from "@kantel/contracts";
import type { E2eCheck, E2eTarget } from "./e2e.ts";

export interface SignInTarget extends E2eTarget {
	/** An invited user's email (the gateway's KANTEL_ADMIN_EMAIL). */
	readonly adminEmail: string;
	/** The newest code sent to `email` since `since` (ms), waiting up to `timeoutMs`; undefined if none came. */
	readonly readCode: (email: string, since: number, timeoutMs: number) => Promise<string | undefined>;
}

async function body(response: Response): Promise<unknown> {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

export async function runSignInE2e(target: SignInTarget): Promise<E2eCheck[]> {
	const checks: E2eCheck[] = [];
	const check = (name: string, ok: boolean, detail?: unknown) => {
		checks.push({ name, ok, ...(detail === undefined ? {} : { detail: JSON.stringify(detail).slice(0, 500) }) });
	};
	const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
		fetch(`${target.baseUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(payload),
		});
	const stranger = `stranger-${crypto.randomUUID()}@harbour.localhost`;
	const since = Date.now();

	const anonymous = await fetch(`${target.baseUrl}/v1/me`);
	const challenge = (await body(anonymous)) as { error?: { signIn?: string[] } };
	check(
		"GET /v1/me without credentials is 401 and names email sign-in",
		anonymous.status === 401 && JSON.stringify(challenge.error?.signIn) === JSON.stringify(["email_otp"]),
		{ status: anonymous.status, body: challenge },
	);

	const startAdmin = await post("/auth/otp/start", { email: target.adminEmail });
	const adminBody = await body(startAdmin);
	const startStranger = await post("/auth/otp/start", { email: stranger });
	const strangerBody = await body(startStranger);
	check(
		"POST /auth/otp/start answers 202 alike for an invited user and a stranger",
		startAdmin.status === 202 &&
			startStranger.status === 202 &&
			JSON.stringify(adminBody) === JSON.stringify(strangerBody),
		{ admin: [startAdmin.status, adminBody], stranger: [startStranger.status, strangerBody] },
	);

	const code = await target.readCode(target.adminEmail, since, 10_000);
	check("the invited user's code arrives", code !== undefined && /^\d{6}$/.test(code));
	const strangerCode = await target.readCode(stranger, since, 1_500);
	check("a stranger gets no code", strangerCode === undefined);

	const wrong = code === "000000" ? "000001" : "000000";
	const refused = await post("/auth/otp/verify", { email: target.adminEmail, code: wrong });
	check("a wrong code is 401", refused.status === 401, await body(refused));

	const verified = await post("/auth/otp/verify", { email: target.adminEmail, code: code ?? "" });
	const session = (await body(verified)) as { token?: string; organisationIds?: string[]; user?: { email?: string } };
	const token = session.token ?? "";
	check(
		"POST /auth/otp/verify starts a Kantel session in the deployment's organisation",
		verified.status === 200 &&
			token.startsWith("hbs_") &&
			(session.organisationIds ?? []).includes(target.organisationId),
		{ status: verified.status, organisationIds: session.organisationIds, user: session.user?.email },
	);

	const again = await post("/auth/otp/verify", { email: target.adminEmail, code: code ?? "" });
	check("the code works only once", again.status === 401, { status: again.status });

	const asPerson = {
		authorization: `Bearer ${token}`,
		[ORGANISATION_HEADER]: target.organisationId,
	};
	const get = (path: string) => fetch(`${target.baseUrl}${path}`, { headers: asPerson });
	for (const path of [
		`/v1/sessions?projectId=${encodeURIComponent(target.projectId)}`,
		`/v1/workspaces/${target.workspaceId}/files`,
		"/v1/deployment",
	]) {
		const response = await get(path);
		check(`the session reads GET ${path.replace(/\?.*$/, "")}`, response.ok, {
			status: response.status,
			body: response.ok ? undefined : await body(response),
		});
	}
	const audited = await get("/v1/audit/events?type=identity.session.started");
	const rows = (await body(audited)) as { items?: { type: string; actor?: { kind?: string } }[] };
	check(
		"sign-in is audited as identity.session.started",
		audited.ok && (rows.items ?? []).some((row) => row.type === "identity.session.started"),
		audited.ok ? { count: rows.items?.length } : rows,
	);

	const me = await get("/v1/me");
	const meBody = (await body(me)) as {
		actor?: { kind?: string };
		email?: string;
		method?: string;
		roles?: { projectId?: string; role: string }[];
	};
	check(
		"GET /v1/me names the person, signed in by session, as an organisation admin",
		me.ok &&
			meBody.actor?.kind === "human" &&
			// The bootstrap stores the invited address normalised, whatever case KANTEL_ADMIN_EMAIL was given in.
			meBody.email === normaliseEmail(target.adminEmail) &&
			(meBody.roles ?? []).some((held) => held.projectId === undefined && held.role === "admin"),
		meBody,
	);
	const projects = await get("/v1/projects");
	const projectsBody = (await body(projects)) as { items?: { id: string }[] };
	check(
		"GET /v1/projects lists the deployment's project",
		projects.ok && (projectsBody.items ?? []).some((project) => project.id === target.projectId),
		projectsBody,
	);

	// Loading skills and memory, as a host adapter does, is the organisation admin's (#12): a skill imported for the
	// project is listed and read back; a project space takes a snapshot and recalls from it.
	const owner = { kind: "project", organisationId: target.organisationId, projectId: target.projectId };
	const skillMd = "---\nname: e2e-signin\ndescription: Checks sign-in end to end\n---\n\n# e2e-signin\n";
	const imported = await post(
		"/v1/skills/import",
		{
			owner,
			name: "e2e-signin",
			description: "Checks sign-in end to end",
			files: [{ path: "SKILL.md", content: skillMd }],
			source: { sourceId: "e2e", ref: "1" },
		},
		asPerson,
	);
	const revision = (await body(imported)) as { skillId?: string; revision?: number };
	check("POST /v1/skills/import publishes the admin's skill", imported.ok && typeof revision.skillId === "string", {
		status: imported.status,
		body: revision,
	});
	const file = await get(
		`/v1/skills/${encodeURIComponent(revision.skillId ?? "")}/revisions/${revision.revision ?? 0}/file?path=SKILL.md`,
	);
	const fileBody = (await body(file)) as { content?: string };
	check("GET /v1/skills/:id/revisions/:n/file reads its SKILL.md", file.ok && fileBody.content === skillMd, {
		status: file.status,
	});
	const created = await post("/v1/memory/spaces", { owner, name: `e2e ${crypto.randomUUID().slice(0, 8)}` }, asPerson);
	const space = (await body(created)) as { id?: string };
	check("POST /v1/memory/spaces creates the admin's space", created.status === 201 && typeof space.id === "string", {
		status: created.status,
		body: space,
	});
	const snapshot = await post(
		`/v1/memory/spaces/${encodeURIComponent(space.id ?? "")}/snapshot`,
		{
			sourceId: "e2e",
			ref: "1",
			concepts: [
				{
					id: "e2e/harbour-port",
					title: "Kantel's port",
					description: "Where the gateway listens",
					statement: "The self-hosted gateway listens on port 8080 in its container.",
					scope: { kind: "global" },
					sources: ["e2e:1"],
					setBy: "owner",
					status: "active",
					updatedAt: 1,
				},
			],
		},
		asPerson,
	);
	check("POST /v1/memory/spaces/:id/snapshot loads the admin's snapshot", snapshot.ok, {
		status: snapshot.status,
		body: snapshot.ok ? undefined : await body(snapshot),
	});
	const recalled = await post("/v1/memory/recall", { spaceIds: [space.id ?? ""], query: "gateway port" }, asPerson);
	const recall = (await body(recalled)) as { concepts?: { id: string }[] };
	check(
		"POST /v1/memory/recall recalls the concept",
		recalled.ok && (recall.concepts ?? []).some((concept) => concept.id === "e2e/harbour-port"),
		recall,
	);

	// A host app's key, from issue to revocation: the secret is shown once, the key works, then it doesn't.
	const issued = await post(
		"/v1/keys",
		{ name: `e2e ${crypto.randomUUID().slice(0, 8)}`, projectIds: [target.projectId], role: "operator" },
		asPerson,
	);
	const issuedBody = (await body(issued)) as { key?: { id?: string }; secret?: string };
	const keyId = issuedBody.key?.id ?? "";
	const secret = issuedBody.secret ?? "";
	check("POST /v1/keys issues a key and shows its secret", issued.status === 201 && keyId !== "" && secret !== "", {
		status: issued.status,
		key: issuedBody.key,
	});
	const listed = await get("/v1/keys");
	const listedText = await listed.text();
	check(
		"GET /v1/keys lists the key, without its secret",
		listed.ok && listedText.includes(keyId) && secret !== "" && !listedText.includes(secret),
		{ status: listed.status },
	);
	const asKey = (path: string) => fetch(`${target.baseUrl}${path}`, { headers: { authorization: `Bearer ${secret}` } });
	const sessionsPath = `/v1/sessions?projectId=${encodeURIComponent(target.projectId)}`;
	const used = await asKey(sessionsPath);
	check("the new key reads GET /v1/sessions", used.ok, { status: used.status });
	const revoked = await post(`/v1/keys/${encodeURIComponent(keyId)}/revoke`, {}, asPerson);
	check("POST /v1/keys/:id/revoke is 204", revoked.status === 204, { status: revoked.status });
	const afterRevoke = await asKey(sessionsPath);
	check("a revoked key is 401", afterRevoke.status === 401, { status: afterRevoke.status });

	const ended = await post("/auth/session/end", {}, { authorization: `Bearer ${token}` });
	check("POST /auth/session/end is 204", ended.status === 204, { status: ended.status });
	const afterEnd = await get(`/v1/sessions?projectId=${encodeURIComponent(target.projectId)}`);
	check("an ended session is 401", afterEnd.status === 401, { status: afterEnd.status });

	return checks;
}
