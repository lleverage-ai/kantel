/**
 * The sharing API (`@kantel/sharing/http`) over the in-memory store: each route reaches its contract call, the store's
 * checks answer as statuses, and filters arrive as the contract's queries.
 */
import { type CallContext, createProjectAccess, KantelError, type ProjectAccess } from "@kantel/contracts";
import { createSharingApi } from "@kantel/sharing/http";
import { createMemorySharing } from "@kantel/sharing/memory";
import {
	actors,
	contextFor,
	createExpectAssertions,
	ManualClock,
	RecordingAuditSink,
	TenancyFixture,
} from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const a = createExpectAssertions(expect);
const ORG = "org-a";
const OWNER = "proj-owner";
const USER = "proj-user";
const callers: { readonly [name: string]: CallContext } = {
	ownerAdmin: contextFor(actors.human("owner-admin"), ORG, OWNER),
	userOperator: contextFor(actors.human("user-operator"), ORG, USER),
	userAdmin: contextFor(actors.human("user-admin"), ORG, USER),
};
const guideline = { kind: "brand.guideline", id: "guide-1" };

function setup() {
	const clock = new ManualClock();
	const audit = new RecordingAuditSink();
	const tenancy = new TenancyFixture(clock);
	tenancy.bind(actors.human("owner-admin"), ORG, "admin", OWNER);
	tenancy.bind(actors.human("user-operator"), ORG, "operator", USER);
	tenancy.bind(actors.human("user-admin"), ORG, "admin", USER);
	let access: ProjectAccess | undefined;
	const late = (): ProjectAccess => {
		if (access === undefined) throw new Error("not ready");
		return access;
	};
	const sharing = createMemorySharing({
		clock,
		audit,
		access: {
			require: (ctx, check) => late().require(ctx, check),
			allows: (ctx, check) => late().allows(ctx, check),
			resource: (ctx, check) => late().resource(ctx, check),
			allowsResource: (ctx, check) => late().allowsResource(ctx, check),
		},
	});
	access = createProjectAccess({ identity: tenancy.identity, sessions: tenancy.sessions, audit, clock, sharing });
	const api = createSharingApi({
		sharing,
		authenticate: async (request) => {
			const caller = callers[request.headers.get("x-caller") ?? ""];
			if (caller === undefined) throw new KantelError("forbidden", "Not signed in");
			return caller;
		},
	});
	const call = async (caller: string, method: string, path: string, body?: unknown) => {
		const response = await api.fetch(
			new Request(`https://kantel.test/v1${path}`, {
				method,
				headers: { "x-caller": caller, ...(body === undefined ? {} : { "content-type": "application/json" }) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		if (response === undefined) throw new Error(`${path} is not a sharing route`);
		const text = await response.text();
		return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
	};
	return { api, call };
}

describe("the sharing API", () => {
	it("registers, shares, lists, revokes and refuses through the store's checks", async () => {
		const { call } = setup();
		a.strictEqual(
			(
				await call("ownerAdmin", "POST", "/sharing/resources", {
					resource: guideline,
					owner: { kind: "project", organisationId: ORG, projectId: OWNER },
				})
			).status,
			200,
		);
		const grant = { resource: guideline, grantee: { kind: "project", projectId: USER }, permission: "use" };
		a.strictEqual((await call("userAdmin", "POST", "/sharing/shares", grant)).status, 403, "not the owner's admin");
		const created = await call("ownerAdmin", "POST", "/sharing/shares", grant);
		a.strictEqual(created.status, 201);
		a.partialDeepEqual(created.body, { resource: guideline, permission: "use", agentWrites: false });
		a.strictEqual(
			(await call("ownerAdmin", "POST", "/sharing/shares", { ...grant, agentWrites: true })).status,
			400,
			"a use share can't let agents write",
		);
		a.strictEqual(
			(await call("ownerAdmin", "POST", "/sharing/shares", { ...grant, permission: "edit", agentWrites: "yes" }))
				.status,
			400,
			"the schema wants a boolean",
		);
		const writes = await call("ownerAdmin", "POST", "/sharing/shares", {
			...grant,
			permission: "edit",
			agentWrites: true,
		});
		a.strictEqual(writes.status, 201);
		a.partialDeepEqual(writes.body, { permission: "edit", agentWrites: true });
		a.strictEqual((await call("ownerAdmin", "GET", `/sharing/shares/${writes.body.id}`)).body.agentWrites, true);
		await call("ownerAdmin", "POST", `/sharing/shares/${writes.body.id}/revoke`, {});

		const listed = await call(
			"userOperator",
			"GET",
			`/sharing/shares?resourceKind=${guideline.kind}&resourceId=${guideline.id}&granteeKind=project&granteeId=${USER}`,
		);
		a.strictEqual(listed.status, 200);
		a.deepEqual(
			listed.body.items.map((share: { id: string }) => share.id),
			[created.body.id],
		);
		a.strictEqual((await call("userOperator", "GET", "/sharing/shares?resourceKind=brand.guideline")).status, 400);
		a.strictEqual((await call("userOperator", "GET", `/sharing/shares/${created.body.id}`)).status, 200);

		const revoked = await call("userAdmin", "POST", `/sharing/shares/${created.body.id}/revoke`, { reason: "done" });
		a.strictEqual(revoked.status, 200, "the grantee's admin detaches it");
		a.strictEqual(revoked.body.revokeReason, "done");
		const ours = `/sharing/shares?granteeKind=project&granteeId=${USER}`;
		a.deepEqual((await call("userOperator", "GET", ours)).body.items, []);
		// Both revoked: the use share and the one that let agents write.
		a.strictEqual((await call("userOperator", "GET", `${ours}&includeInactive=true`)).body.items.length, 2);
	});

	it("requests access, lists the owner's inbox, and grants a narrower share", async () => {
		const { call } = setup();
		await call("ownerAdmin", "POST", "/sharing/resources", {
			resource: guideline,
			owner: { kind: "project", organisationId: ORG, projectId: OWNER },
		});
		const requested = await call("userOperator", "POST", "/sharing/requests", {
			resource: guideline,
			permission: "edit",
			reason: "Our brand work",
		});
		a.strictEqual(requested.status, 201);
		a.partialDeepEqual(requested.body, { status: "pending", grantee: { kind: "project", projectId: USER } });
		const inbox = await call("ownerAdmin", "GET", "/sharing/requests?decidable=true&status=pending");
		a.deepEqual(
			inbox.body.items.map((request: { id: string }) => request.id),
			[requested.body.id],
		);
		a.deepEqual((await call("userAdmin", "GET", "/sharing/requests?decidable=true")).body.items, []);
		a.strictEqual(
			(await call("userAdmin", "POST", `/sharing/requests/${requested.body.id}/decision`, { decision: "grant" }))
				.status,
			403,
			"not the requesting project's admin",
		);
		a.strictEqual(
			(
				await call("ownerAdmin", "POST", `/sharing/requests/${requested.body.id}/decision`, {
					decision: "grant",
					permission: "use",
					agentWrites: true,
				})
			).status,
			400,
			"a use grant can't let agents write",
		);
		const decided = await call("ownerAdmin", "POST", `/sharing/requests/${requested.body.id}/decision`, {
			decision: "grant",
			permission: "use",
		});
		a.strictEqual(decided.status, 200);
		a.partialDeepEqual(decided.body, {
			request: { status: "granted" },
			share: { permission: "use", agentWrites: false },
		});
		const again = await call("userOperator", "POST", "/sharing/requests", {
			resource: guideline,
			permission: "edit",
			reason: "Our agents keep it current",
		});
		const withWrites = await call("ownerAdmin", "POST", `/sharing/requests/${again.body.id}/decision`, {
			decision: "grant",
			agentWrites: true,
		});
		a.strictEqual(withWrites.status, 200);
		a.partialDeepEqual(withWrites.body, { share: { permission: "edit", agentWrites: true } });
		a.strictEqual(
			(await call("ownerAdmin", "POST", `/sharing/requests/${requested.body.id}/decision`, { decision: "reject" }))
				.status,
			409,
		);
		a.strictEqual((await call("userOperator", "POST", `/sharing/requests/${requested.body.id}/withdraw`)).status, 409);
	});

	it("keeps bindings and policy, and answers unknown routes and bodies", async () => {
		const { call } = setup();
		await call("ownerAdmin", "POST", "/sharing/resources", {
			resource: guideline,
			owner: { kind: "project", organisationId: ORG, projectId: OWNER },
		});
		const binding = { object: guideline, relation: "approver", subject: { kind: "user", userId: "user-operator" } };
		a.strictEqual((await call("ownerAdmin", "POST", "/sharing/bindings", binding)).status, 200);
		const bindings = await call(
			"ownerAdmin",
			"GET",
			`/sharing/bindings?objectKind=${guideline.kind}&objectId=${guideline.id}&relation=approver`,
		);
		a.strictEqual(bindings.body.items.length, 1);
		a.strictEqual((await call("ownerAdmin", "POST", "/sharing/bindings/remove", binding)).status, 204);

		const policy = { resource: guideline, policy: { twoPersonRule: true } };
		a.deepEqual((await call("ownerAdmin", "PUT", "/sharing/policies", policy)).body, { twoPersonRule: true });
		a.deepEqual((await call("ownerAdmin", "GET", `/sharing/policies?kind=${guideline.kind}&id=${guideline.id}`)).body, {
			twoPersonRule: true,
		});
		a.strictEqual((await call("userOperator", "GET", "/sharing/uses")).status, 400, "uses need a session");
		a.strictEqual((await call("ownerAdmin", "POST", "/sharing/shares", { resource: guideline })).status, 400);
		a.strictEqual((await call("ownerAdmin", "GET", "/sharing/nothing")).status, 404);
		a.strictEqual((await call("nobody", "GET", "/sharing/shares")).status, 403, "authenticate's refusal");
	});
});
