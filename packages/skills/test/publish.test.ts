import { type CallContext, KantelError, isKantelError, type SkillFile, type SkillSource } from "@kantel/contracts";
import { createMemorySkills } from "@kantel/skills/memory";
import { withSourcePublishing } from "@kantel/skills/publish";
import { RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

type Exported = Parameters<NonNullable<SkillSource["publish"]>>[0];

const human: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-a" };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: "org-a",
};
const owner = { kind: "organisation", organisationId: "org-a" } as const;

function skillMd(name: string, body: string): SkillFile {
	return { path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n` };
}

async function rejectedCode(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return isKantelError(error) ? error.code : String(error);
	}
	return undefined;
}

/** Lets queued promise callbacks and timers run until `predicate` holds. */
async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !predicate(); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(predicate()).toBe(true);
}

/** A writable source that records what it was given; `fail` makes it throw, `gate` holds `deploy`'s exports. */
function fakeSource(id = "sal-git") {
	const calls: Exported[] = [];
	const state: { fail?: unknown; gate?: Promise<void>; active: number; maxActive: number } = {
		active: 0,
		maxActive: 0,
	};
	const source: SkillSource = {
		id,
		fetch: async () => [],
		async publish(skill) {
			calls.push(structuredClone(skill));
			const n = calls.length;
			state.active += 1;
			state.maxActive = Math.max(state.maxActive, state.active);
			try {
				if (state.gate !== undefined && skill.name === "deploy") await state.gate;
				if (state.fail !== undefined) throw state.fail;
				return { ref: `commit-${n}` };
			} finally {
				state.active -= 1;
			}
		},
	};
	return { source, calls, state };
}

function setup(sourceFor?: (name: string) => SkillSource | undefined) {
	const audit = new RecordingAuditSink();
	const fake = fakeSource();
	const inner = createMemorySkills();
	const skills = withSourcePublishing({
		skills: inner,
		sourceFor: (pkg) => (sourceFor === undefined ? fake.source : sourceFor(pkg.name)),
		audit,
	});
	return { audit, fake, inner, skills };
}

describe("withSourcePublishing", () => {
	it("writes a native publish's whole package back to its source and audits where it landed", async () => {
		const { audit, fake, skills } = setup();
		const pkg = await skills.create(human, { owner, name: "deploy", description: "Deploy" });
		const { digest } = await skills.saveDraft(human, pkg.id, {
			files: [{ path: "scripts/run.sh", content: "echo run\n" }, skillMd("deploy", "Ship it.")],
		});
		const revision = await skills.publish(human, pkg.id, { expectedDigest: digest });
		expect(revision).toMatchObject({ revision: 1, digest });
		expect(fake.calls).toEqual([
			{
				name: "deploy",
				description: "deploy skill",
				files: [skillMd("deploy", "Ship it."), { path: "scripts/run.sh", content: "echo run\n" }],
				revision: { skillId: pkg.id, revision: 1, digest },
			},
		]);
		expect(audit.ofType("skills.revision.exported")).toMatchObject([
			{
				actor: human.actor,
				organisationId: "org-a",
				subject: { kind: "skills.skill", id: pkg.id },
				data: { sourceId: "sal-git", ref: "commit-1", revision: 1, digest },
			},
		]);
	});

	it("exports nothing for a package without a writable source", async () => {
		const readOnly: SkillSource = { id: "read-only", fetch: async () => [] };
		const { audit, fake, skills } = setup((name) => (name === "notes" ? readOnly : undefined));
		for (const name of ["deploy", "notes"]) {
			const pkg = await skills.create(human, { owner, name, description: name });
			const { digest } = await skills.saveDraft(human, pkg.id, { files: [skillMd(name, "Body.")] });
			expect((await skills.publish(human, pkg.id, { expectedDigest: digest })).revision).toBe(1);
		}
		expect(fake.calls).toEqual([]);
		expect(audit.events.filter((event) => event.type.startsWith("skills.revision.export"))).toEqual([]);
	});

	it("skips a revision that came from the source and a publish that created nothing", async () => {
		const { fake, skills } = setup();
		const imported = await skills.importRevision(human, {
			owner,
			name: "deploy",
			description: "Deploy",
			files: [skillMd("deploy", "From commit abc.")],
			source: { sourceId: "sal-git", ref: "abc" },
		});
		expect(fake.calls).toEqual([]);
		// A draft identical to the imported revision publishes nothing new, so that revision (and its source) comes back.
		const same = await skills.saveDraft(human, imported.skillId, { files: [skillMd("deploy", "From commit abc.")] });
		const back = await skills.publish(human, imported.skillId, { expectedDigest: same.digest });
		expect(back).toEqual(imported);
		expect(fake.calls).toEqual([]);

		const changed = await skills.saveDraft(human, imported.skillId, { files: [skillMd("deploy", "Edited.")] });
		const native = await skills.publish(human, imported.skillId, { expectedDigest: changed.digest });
		expect(native.revision).toBe(2);
		expect(fake.calls.map((call) => call.revision.revision)).toEqual([2]);
		// An unchanged draft, and a retry after success, return revision 2 again without exporting it again.
		const unchanged = await skills.saveDraft(human, imported.skillId, { files: [skillMd("deploy", "Edited.")] });
		expect(await skills.publish(human, imported.skillId, { expectedDigest: unchanged.digest })).toEqual(native);
		expect(await skills.publish(human, imported.skillId, { expectedDigest: changed.digest })).toEqual(native);
		expect(fake.calls.map((call) => call.revision.revision)).toEqual([2]);
	});

	it("audits a failing source by its error code only, and the publish still stands", async () => {
		const { audit, fake, inner, skills } = setup();
		const pkg = await skills.create(human, { owner, name: "deploy", description: "Deploy" });
		fake.state.fail = new KantelError("unavailable", "https://token@git.example/secret.git refused the push");
		const first = await skills.saveDraft(human, pkg.id, { files: [skillMd("deploy", "One.")] });
		const revision = await skills.publish(human, pkg.id, { expectedDigest: first.digest });
		expect(revision.revision).toBe(1);
		expect((await inner.get(human, pkg.id)).latestRevision).toBe(1);
		fake.state.fail = new Error("socket hang up");
		const second = await skills.saveDraft(human, pkg.id, { files: [skillMd("deploy", "Two.")] });
		expect((await skills.publish(human, pkg.id, { expectedDigest: second.digest })).revision).toBe(2);
		const failed = audit.ofType("skills.revision.export_failed");
		expect(failed).toMatchObject([
			{ subject: { id: pkg.id }, data: { sourceId: "sal-git", revision: 1, error: "unavailable" } },
			{ subject: { id: pkg.id }, data: { sourceId: "sal-git", revision: 2, error: "error" } },
		]);
		expect(JSON.stringify(failed)).not.toContain("secret");
		expect(JSON.stringify(failed)).not.toContain("socket");
		expect(audit.ofType("skills.revision.exported")).toEqual([]);
	});

	it("runs one export at a time per skill, in order, without holding up other skills", async () => {
		const { fake, skills } = setup();
		const deploy = await skills.create(human, { owner, name: "deploy", description: "Deploy" });
		const notes = await skills.create(human, { owner, name: "notes", description: "Notes" });
		let open = () => {};
		fake.state.gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const first = await skills.saveDraft(human, deploy.id, { files: [skillMd("deploy", "One.")] });
		const publishing = skills.publish(human, deploy.id, { expectedDigest: first.digest });
		await until(() => fake.calls.length === 1);
		const second = await skills.saveDraft(human, deploy.id, { files: [skillMd("deploy", "Two.")] });
		let secondDone = false;
		const next = skills.publish(human, deploy.id, { expectedDigest: second.digest }).then((revision) => {
			secondDone = true;
			return revision;
		});
		// Another skill's export does not wait behind this one.
		const other = await skills.saveDraft(human, notes.id, { files: [skillMd("notes", "Notes.")] });
		expect((await skills.publish(human, notes.id, { expectedDigest: other.digest })).revision).toBe(1);
		expect(fake.calls.map((call) => call.name)).toEqual(["deploy", "notes"]);
		expect(secondDone).toBe(false);
		open();
		const [one, two] = await Promise.all([publishing, next]);
		expect([one.revision, two.revision]).toEqual([1, 2]);
		expect(fake.calls.filter((call) => call.name === "deploy").map((call) => call.revision.revision)).toEqual([1, 2]);
		expect(fake.state.maxActive).toBe(2);
	});

	it("retries an export with exportRevision, which only a caller who may read the skill may make", async () => {
		const { audit, fake, skills } = setup();
		const pkg = await skills.create(human, { owner, name: "deploy", description: "Deploy" });
		fake.state.fail = new KantelError("unavailable", "The remote is down");
		const { digest } = await skills.saveDraft(human, pkg.id, { files: [skillMd("deploy", "One.")] });
		await skills.publish(human, pkg.id, { expectedDigest: digest });
		expect(await rejectedCode(skills.exportRevision(human, pkg.id, 1))).toBe("unavailable");
		expect(audit.ofType("skills.revision.export_failed")).toHaveLength(2);

		fake.state.fail = undefined;
		expect(await skills.exportRevision(human, pkg.id, 1)).toEqual({ sourceId: "sal-git", ref: "commit-3" });
		expect(fake.calls.at(-1)?.revision).toEqual({ skillId: pkg.id, revision: 1, digest });
		expect(audit.ofType("skills.revision.exported")).toMatchObject([{ data: { ref: "commit-3", revision: 1 } }]);

		expect(await rejectedCode(skills.exportRevision(agent, pkg.id, 1))).toBe("forbidden");
		const outsider: CallContext = { actor: { kind: "human", userId: "x" }, organisationId: "org-b" };
		expect(await rejectedCode(skills.exportRevision(outsider, pkg.id, 1))).toBe("not_found");
		expect(await rejectedCode(skills.exportRevision(human, pkg.id, 9))).toBe("not_found");
		expect(audit.ofType("skills.revision.export_failed")).toHaveLength(2);
		expect(fake.calls).toHaveLength(3);
	});

	it("never takes the source back to an older revision, and tells a failed export's caller only the error code", async () => {
		const { audit, fake, skills } = setup();
		const pkg = await skills.create(human, { owner, name: "deploy", description: "Deploy" });
		fake.state.fail = new KantelError("unavailable", "https://token@git.example/secret.git refused the push", {
			remote: "https://token@git.example/secret.git",
		});
		const one = await skills.saveDraft(human, pkg.id, { files: [skillMd("deploy", "One.")] });
		await skills.publish(human, pkg.id, { expectedDigest: one.digest });
		let thrown: unknown;
		await skills.exportRevision(human, pkg.id, 1).catch((error: unknown) => {
			thrown = error;
		});
		expect(isKantelError(thrown, "unavailable")).toBe(true);
		expect(
			JSON.stringify({ message: (thrown as Error).message, details: (thrown as KantelError).details }),
		).not.toContain("secret");

		fake.state.fail = undefined;
		const two = await skills.saveDraft(human, pkg.id, { files: [skillMd("deploy", "Two.")] });
		await skills.publish(human, pkg.id, { expectedDigest: two.digest });
		const calls = fake.calls.length;
		expect(await rejectedCode(skills.exportRevision(human, pkg.id, 1))).toBe("conflict");
		expect(fake.calls).toHaveLength(calls);
		expect(fake.calls.at(-1)?.revision.revision).toBe(2);
		expect(audit.ofType("skills.revision.export_failed")).toHaveLength(2);
	});

	it("keeps a publish that succeeded even when looking up its source or auditing the failure throws", async () => {
		const audit = new RecordingAuditSink();
		const failingAudit = {
			append: async (...args: Parameters<RecordingAuditSink["append"]>) => {
				if (args[1].some((event) => event.type === "skills.revision.export_failed")) throw new Error("audit down");
				return audit.append(...args);
			},
		} as unknown as RecordingAuditSink;
		const inner = createMemorySkills();
		const skills = withSourcePublishing({
			skills: inner,
			sourceFor: () => {
				throw new Error("no source registry");
			},
			audit: failingAudit,
		});
		const pkg = await skills.create(human, { owner, name: "deploy", description: "Deploy" });
		const { digest } = await skills.saveDraft(human, pkg.id, { files: [skillMd("deploy", "One.")] });
		expect((await skills.publish(human, pkg.id, { expectedDigest: digest })).revision).toBe(1);
		expect((await inner.get(human, pkg.id)).latestRevision).toBe(1);
	});

	it("refuses exportRevision as not_supported when the package has no writable source", async () => {
		const readOnly: SkillSource = { id: "read-only", fetch: async () => [] };
		const { skills } = setup((name) => (name === "notes" ? readOnly : undefined));
		for (const name of ["deploy", "notes"]) {
			const pkg = await skills.create(human, { owner, name, description: name });
			const { digest } = await skills.saveDraft(human, pkg.id, { files: [skillMd(name, "Body.")] });
			await skills.publish(human, pkg.id, { expectedDigest: digest });
			expect(await rejectedCode(skills.exportRevision(human, pkg.id, 1)), name).toBe("not_supported");
		}
	});

	it("passes an agent's publish to the store, which refuses it", async () => {
		const { fake, skills } = setup();
		const pkg = await skills.create(human, { owner, name: "deploy", description: "Deploy" });
		const { digest } = await skills.saveDraft(agent, pkg.id, { files: [skillMd("deploy", "Proposed.")] });
		expect(await rejectedCode(skills.publish(agent, pkg.id, { expectedDigest: digest }))).toBe("forbidden");
		expect(fake.calls).toEqual([]);
	});
});
