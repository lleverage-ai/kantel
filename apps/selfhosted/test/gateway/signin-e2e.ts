// One pass over email one-time PIN sign-in on the gateway, shared by the in-process test (codes from a memory mailer)
// and the compose test (codes read from Mailpit): an invited admin and a stranger get the same answer to start, only
// the admin gets a code, a wrong code is refused, the right one starts a Harbour session that every mounted API
// accepts, the code works only once, sign-in is audited, and an ended session is refused.
import { ORGANISATION_HEADER } from "@harbour/contracts";
import type { E2eCheck, E2eTarget } from "./e2e.ts";

export interface SignInTarget extends E2eTarget {
	/** The deployment's organisation, which the admin is invited into. */
	readonly organisationId: string;
	/** An invited user's email (the gateway's HARBOUR_ADMIN_EMAIL). */
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
		"POST /auth/otp/verify starts a Harbour session in the deployment's organisation",
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

	const ended = await post("/auth/session/end", {}, { authorization: `Bearer ${token}` });
	check("POST /auth/session/end is 204", ended.status === 204, { status: ended.status });
	const afterEnd = await get(`/v1/sessions?projectId=${encodeURIComponent(target.projectId)}`);
	check("an ended session is 401", afterEnd.status === 401, { status: afterEnd.status });

	return checks;
}
