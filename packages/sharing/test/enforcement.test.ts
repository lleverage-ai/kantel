/**
 * Enforcement of shares in the components: skills, memory, the vault and
 * workspaces check another project's resources through `ProjectAccess.resource`, over the sharing store's lookup.
 */
import { type CallContext, createProjectAccess, type OwnerRef, type ProjectAccess } from "@kantel/contracts";
import { createMemoryMemory } from "@kantel/memory/memory";
import { createMemorySharing } from "@kantel/sharing/memory";
import { componentResolvers } from "@kantel/sharing/resolvers";
import { createMemorySkills } from "@kantel/skills/memory";
import {
	actors,
	contextFor,
	createExpectAssertions,
	ManualClock,
	RecordingAuditSink,
	TenancyFixture,
	WORKER,
} from "@kantel/testing/harness";
import { createMemoryVault } from "@kantel/vault/memory";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@kantel/workspace/stored";
import { describe, expect, it } from "vitest";

const a = createExpectAssertions(expect);
const ORG = "org-a";
const OWNER = "proj-owner";
const USER = "proj-user";
const ownerAdmin = contextFor(actors.human("owner-admin"), ORG, OWNER);
const author = contextFor(actors.human("author"), ORG, OWNER);
const reviewer = contextFor(actors.human("reviewer"), ORG, OWNER);
const userOperator = contextFor(actors.human("user-operator"), ORG, USER);
const agent = contextFor(actors.agent("agent-user", "sess-user"), ORG, USER);
const later = contextFor(actors.agent("agent-user", "sess-later"), ORG, USER);
const owned: OwnerRef = { kind: "project", organisationId: ORG, projectId: OWNER };

function setup() {
	const clock = new ManualClock();
	const audit = new RecordingAuditSink();
	const tenancy = new TenancyFixture(clock);
	tenancy.bind(ownerAdmin.actor, ORG, "admin", OWNER);
	tenancy.bind(author.actor, ORG, "operator", OWNER);
	tenancy.bind(reviewer.actor, ORG, "operator", OWNER);
	tenancy.bind(userOperator.actor, ORG, "operator", USER);
	tenancy.session({ id: "sess-user", organisationId: ORG, projectId: USER, agentId: "agent-user" });
	tenancy.session({ id: "sess-later", organisationId: ORG, projectId: USER, agentId: "agent-user" });
	let access: ProjectAccess | undefined;
	const late = (): ProjectAccess => {
		if (access === undefined) throw new Error("not ready");
		return access;
	};
	const deferred: ProjectAccess = {
		require: (ctx, check) => late().require(ctx, check),
		allows: (ctx, check) => late().allows(ctx, check),
		resource: (ctx, check) => late().resource(ctx, check),
		allowsResource: (ctx, check) => late().allowsResource(ctx, check),
	};
	const skills = createMemorySkills({ clock, audit, access: deferred });
	const memory = createMemoryMemory({ clock, audit, access: deferred });
	const vault = createMemoryVault({ clock, audit, access: deferred });
	const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore(), audit, access: deferred, clock });
	// Not a check this suite makes: `deferred` covers every component.
	const sharing = createMemorySharing({
		clock,
		audit,
		access: deferred,
		resolvers: componentResolvers(() => ({ skills, memory, vault, workspaces })),
	});
	access = createProjectAccess({ identity: tenancy.identity, sessions: tenancy.sessions, audit, clock, sharing });
	return { clock, audit, tenancy, skills, memory, vault, workspaces, sharing, access };
}

async function publishedSkill(env: ReturnType<typeof setup>, revisions: number) {
	const pkg = await env.skills.create(ownerAdmin, { owner: owned, name: "review-checklist", description: "Checks" });
	for (let revision = 1; revision <= revisions; revision += 1) {
		const files = [
			{ path: "SKILL.md", content: `---\nname: review-checklist\ndescription: Checks\n---\nv${revision}` },
		];
		const { digest } = await env.skills.saveDraft(ownerAdmin, pkg.id, { files });
		await env.skills.publish(ownerAdmin, pkg.id, { expectedDigest: digest });
	}
	return pkg;
}

const concept = (id: string) => ({
	id: `support/${id}`,
	title: id,
	statement: `The ${id} rule.`,
	scope: { kind: "global" } as const,
	sources: ["https://example.com/source"],
});

describe("skills", () => {
	it("pins another project's skill only while shared, at the share's revision, and records the share", async () => {
		const env = setup();
		const pkg = await publishedSkill(env, 2);
		const visibility = { projectId: USER, shared: [pkg.id] };
		a.deepEqual(await env.skills.pinForSession(agent, "sess-user", visibility), [], "not shared: left out");
		a.strictEqual(
			env.audit.ofType("access.denied").filter((event) => event.subject?.id === pkg.id).length,
			1,
			"the refusal is audited",
		);
		await a.rejectsWithCode(env.skills.getRevision(agent, pkg.id, 2), "forbidden");

		const share = await env.sharing.createShare(ownerAdmin, {
			resource: { kind: "skills.skill", id: pkg.id, revision: 1 },
			grantee: { kind: "project", projectId: USER },
			permission: "use",
		});
		const pins = await env.skills.pinForSession(later, "sess-later", visibility);
		a.deepEqual(
			pins.map((pin) => [pin.skillId, pin.revision]),
			[[pkg.id, 1]],
		);
		a.strictEqual((await env.skills.getRevision(later, pkg.id, 1)).revision, 1);
		await a.rejectsWithCode(env.skills.getRevision(later, pkg.id, 2), "forbidden", "not the pinned revision");
		a.deepEqual(
			(await env.sharing.listUses(userOperator, { sessionId: "sess-later" })).map((use) => [
				use.resource.revision,
				use.shareId,
			]),
			[[1, share.id]],
		);
		const listed = await env.skills.list(userOperator, visibility);
		a.deepEqual(
			listed.items.map((item) => item.skillId),
			[pkg.id],
		);

		await env.sharing.revokeShare(ownerAdmin, share.id);
		await a.rejectsWithCode(env.skills.readFile(later, pkg.id, 1, "SKILL.md"), "forbidden", "revoked: no more reads");
	});

	it("separates use from change: agents draft, edit shares save, approvers publish, two people with the rule", async () => {
		const env = setup();
		const pkg = await publishedSkill(env, 1);
		const files = [{ path: "SKILL.md", content: "---\nname: review-checklist\ndescription: Better\n---\nv2" }];
		await env.sharing.createShare(ownerAdmin, {
			resource: { kind: "skills.skill", id: pkg.id },
			grantee: { kind: "project", projectId: USER },
			permission: "use",
		});
		await a.rejectsWithCode(env.skills.saveDraft(agent, pkg.id, { files }), "forbidden", "use alone changes nothing");
		await a.rejectsWithCode(env.skills.saveDraft(userOperator, pkg.id, { files }), "forbidden");
		await env.sharing.createShare(ownerAdmin, {
			resource: { kind: "skills.skill", id: pkg.id },
			grantee: { kind: "project", projectId: USER },
			permission: "edit",
		});
		await env.skills.saveDraft(agent, pkg.id, { files });
		const { digest } = await env.skills.saveDraft(userOperator, pkg.id, { files });
		await a.rejectsWithCode(env.skills.publish(userOperator, pkg.id, { expectedDigest: digest }), "forbidden");

		await env.sharing.setPolicy(ownerAdmin, { kind: "skills.skill", id: pkg.id }, { twoPersonRule: true });
		await env.skills.saveDraft(author, pkg.id, { files });
		await a.rejectsWithCode(
			env.skills.publish(author, pkg.id, { expectedDigest: digest }),
			"forbidden",
			"an author doesn't publish",
		);
		const published = await env.skills.publish(reviewer, pkg.id, { expectedDigest: digest });
		a.strictEqual(published.revision, 2);
	});
});

describe("memory", () => {
	it("recalls another project's space only while shared, and applies a proposal by a second person", async () => {
		const env = setup();
		const space = await env.memory.createSpace(ownerAdmin, { owner: owned, name: "Support" });
		await env.memory.importSnapshot(ownerAdmin, space.id, {
			sourceId: "fixture",
			ref: "one",
			concepts: [],
		});
		await a.rejectsWithCode(env.memory.recall(agent, { spaceIds: [space.id], query: "rule" }), "forbidden");
		await a.rejectsWithCode(
			env.memory.propose(agent, space.id, { op: "remember", concept: concept("tone") }),
			"forbidden",
		);
		await env.sharing.createShare(ownerAdmin, {
			resource: { kind: "memory.space", id: space.id },
			grantee: { kind: "project", projectId: USER },
			permission: "propose",
		});
		await env.memory.recall(agent, { spaceIds: [space.id], query: "rule" });
		const proposal = await env.memory.propose(agent, space.id, { op: "remember", concept: concept("tone") });
		await a.rejectsWithCode(env.memory.decide(userOperator, proposal.id, { outcome: "apply" }), "forbidden");

		await env.sharing.setPolicy(ownerAdmin, { kind: "memory.space", id: space.id }, { twoPersonRule: true });
		const own = await env.memory.propose(author, space.id, { op: "remember", concept: concept("voice") });
		await a.rejectsWithCode(env.memory.decide(author, own.id, { outcome: "apply" }), "forbidden");
		a.strictEqual((await env.memory.decide(reviewer, own.id, { outcome: "apply" })).status, "applied");
		a.strictEqual((await env.memory.decide(author, proposal.id, { outcome: "apply" })).status, "applied");
	});
});

describe("vault", () => {
	it("lets a session propose on another project's item only while shared, and stops its grant when unshared", async () => {
		const env = setup();
		const item = await env.vault.putItem(ownerAdmin, {
			owner: owned,
			name: "GitHub",
			hosts: ["api.github.com"],
			injection: { header: "Authorization", template: "Bearer {key}" },
			value: "secret-value",
		});
		const terms = {
			itemId: item.id,
			route: { host: "api.github.com", methods: ["GET"] as const, pathPrefix: "/" },
			lifetime: {},
			reason: "read the repository",
		};
		await a.rejectsWithCode(
			env.vault.propose(agent, { ...terms, route: { ...terms.route, methods: ["GET"] } }),
			"forbidden",
		);
		const share = await env.sharing.createShare(ownerAdmin, {
			resource: { kind: "vault.item", id: item.id },
			grantee: { kind: "project", projectId: USER },
			permission: "use",
		});
		const proposal = await env.vault.propose(agent, { ...terms, route: { ...terms.route, methods: ["GET"] } });
		a.strictEqual(proposal.projectId, USER, "decided in the requesting project");
		await a.rejectsWithCode(
			env.vault.decide(ownerAdmin, {
				proposalId: proposal.id,
				outcome: "approve",
				termsHash: proposal.termsHash,
				pickedCode: proposal.bindingCode,
			}),
			"forbidden",
			"not by the owner's admin",
		);
		await env.vault.decide(userOperator, {
			proposalId: proposal.id,
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
		});
		const request = {
			organisationId: ORG,
			projectId: USER,
			agentId: "agent-user",
			sessionId: "sess-user",
			method: "GET" as const,
			url: "https://api.github.com/repos/harbour",
		};
		a.strictEqual((await env.vault.decideEgress(WORKER, request)).allow, true);
		await env.sharing.revokeShare(ownerAdmin, share.id);
		a.strictEqual((await env.vault.decideEgress(WORKER, request)).allow, false, "unshared: the grant stops");
	});
});

describe("workspaces", () => {
	it("reads another project's workspace through a use share and writes it only with edit", async () => {
		const env = setup();
		const workspace = await env.workspaces.create(ownerAdmin, { owner: owned });
		const reader: CallContext = userOperator;
		await a.rejectsWithCode(env.workspaces.get(reader, workspace.id), "forbidden");
		await env.sharing.createShare(ownerAdmin, {
			resource: { kind: "workspace", id: workspace.id },
			grantee: { kind: "project", projectId: USER },
			permission: "use",
		});
		a.strictEqual((await env.workspaces.get(reader, workspace.id)).id, workspace.id);
		const write = () =>
			env.workspaces.commit(reader, workspace.id, {
				baseVersion: 0,
				changes: [{ op: "put", path: "notes.md", content: "hello" }],
			});
		await a.rejectsWithCode(write(), "forbidden", "use doesn't write");
		await env.sharing.createShare(ownerAdmin, {
			resource: { kind: "workspace", id: workspace.id },
			grantee: { kind: "project", projectId: USER },
			permission: "edit",
		});
		a.strictEqual((await write()).version, 1);
	});

	it("lets an agent write another project's workspace only through an edit share that lets agents write", async () => {
		const env = setup();
		const workspace = await env.workspaces.create(ownerAdmin, { owner: owned });
		const resource = { kind: "workspace", id: workspace.id } as const;
		let version = 0;
		const write = async (ctx: CallContext) => {
			const committed = await env.workspaces.commit(ctx, workspace.id, {
				baseVersion: version,
				changes: [{ op: "put", path: "notes.md", content: `v${version + 1}` }],
			});
			version = committed.version;
			return committed;
		};
		const plain = await env.sharing.createShare(ownerAdmin, {
			resource,
			grantee: { kind: "project", projectId: USER },
			permission: "edit",
		});
		a.strictEqual((await env.workspaces.get(agent, workspace.id)).id, workspace.id, "an edit share reads");
		await a.rejectsWithCode(write(agent), "forbidden", "but its agents don't write without the flag");
		a.strictEqual((await write(userOperator)).version, 1, "its people do");
		const writes = await env.sharing.createShare(ownerAdmin, {
			resource,
			grantee: { kind: "project", projectId: USER },
			permission: "edit",
			agentWrites: true,
		});
		a.strictEqual((await write(agent)).version, 2);
		a.strictEqual((await write(later)).version, 3, "every session of the grantee project");
		await env.sharing.revokeShare(ownerAdmin, writes.id);
		await a.rejectsWithCode(write(agent), "forbidden", "revoking it stops the writes");
		a.strictEqual((await write(userOperator)).version, 4, "the plain edit share still holds for people");
		a.ok(plain.id !== writes.id);
	});
});
