// One pass over email one-time PIN sign-in on the gateway, shared by the in-process test (codes from a memory mailer)
// and the compose test (codes read from Mailpit): an invited admin and a stranger get the same answer to start, only
// the admin gets a code, a wrong code is refused, the right one starts a Kantel session that the compute plane and the
// gateway's own APIs accept, the code works only once, sign-in is audited, the person can see who they are and issue,
// use and revoke an API key, and an ended session is refused.
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
	const stranger = `stranger-${crypto.randomUUID()}@kantel.localhost`;
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
			token.startsWith("kts_") &&
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
	for (const path of ["/v1/whoami", "/v1/sandboxes", "/v1/deployment"]) {
		const response = await get(path);
		check(`the session reads GET ${path}`, response.ok, {
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
	const used = await asKey("/v1/me");
	check("the new key reads GET /v1/me", used.ok, { status: used.status });
	const revoked = await post(`/v1/keys/${encodeURIComponent(keyId)}/revoke`, {}, asPerson);
	check("POST /v1/keys/:id/revoke is 204", revoked.status === 204, { status: revoked.status });
	const afterRevoke = await asKey("/v1/me");
	check("a revoked key is 401", afterRevoke.status === 401, { status: afterRevoke.status });

	const ended = await post("/auth/session/end", {}, { authorization: `Bearer ${token}` });
	check("POST /auth/session/end is 204", ended.status === 204, { status: ended.status });
	const afterEnd = await get("/v1/whoami");
	check("an ended session is 401", afterEnd.status === 401, { status: afterEnd.status });

	return checks;
}
