import type { CallContext } from "@harbour/contracts";
import { isHarbourError } from "@harbour/contracts";
import { createMemorySkills } from "@harbour/skills/memory";
import { createSkillsMountSource, pinsVersion } from "@harbour/skills/mount";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";
import { describe, expect, it } from "vitest";

const service: CallContext = { actor: { kind: "service", serviceId: "sal" }, organisationId: "org-a" };
const owner = { kind: "organisation", organisationId: "org-a" } as const;
const source = { sourceId: "toolkit", ref: "c1" };

async function setup() {
	const skills = createMemorySkills();
	await skills.importRevision(service, {
		owner,
		name: "pr-review",
		description: "Review a PR",
		files: [
			{ path: "SKILL.md", content: "---\nname: pr-review\ndescription: Review a PR\n---\n" },
			{ path: "scripts/check.sh", content: "echo ok\n" },
			{ path: "scripts/lib/util.sh", content: "true\n" },
		],
		source,
	});
	await skills.importRevision(service, {
		owner,
		name: "docs",
		description: "Docs",
		files: [{ path: "SKILL.md", content: "# Docs\n" }],
		source,
	});
	const mount = createSkillsMountSource(skills, { visibility: () => ({}) });
	return { skills, mount };
}

describe("createSkillsMountSource", () => {
	it("serves a session's pinned revisions by name, and only those", async () => {
		const { skills, mount } = await setup();
		const version = await mount.latestVersion(service, "session-1");
		expect(version).toBe(await pinsVersion(await skills.pinForSession(service, "session-1", {})));
		expect((await mount.list(service, "session-1", version, "")).map((entry) => [entry.path, entry.kind])).toEqual([
			["docs", "directory"],
			["pr-review", "directory"],
		]);
		expect(
			(await mount.list(service, "session-1", version, "pr-review")).map((entry) => [
				entry.path,
				entry.kind,
				entry.size,
			]),
		).toEqual([
			["pr-review/SKILL.md", "file", 49],
			["pr-review/scripts", "directory", 0],
		]);
		expect((await mount.list(service, "session-1", version, "pr-review/scripts")).map((entry) => entry.path)).toEqual([
			"pr-review/scripts/check.sh",
			"pr-review/scripts/lib",
		]);
		expect(
			new TextDecoder().decode(await mount.read(service, "session-1", version, "pr-review/scripts/check.sh")),
		).toBe("echo ok\n");

		// A later revision does not reach a session already pinned; a new session gets it.
		await skills.importRevision(service, {
			owner,
			name: "pr-review",
			description: "Review a PR well",
			files: [{ path: "SKILL.md", content: "v2" }],
			source: { sourceId: "toolkit", ref: "c2" },
		});
		expect(await mount.latestVersion(service, "session-1")).toBe(version);
		expect(new TextDecoder().decode(await mount.read(service, "session-1", version, "pr-review/SKILL.md"))).toContain(
			"Review a PR",
		);
		const other = await mount.latestVersion(service, "session-2");
		expect(other).not.toBe(version);
		expect(new TextDecoder().decode(await mount.read(service, "session-2", other, "pr-review/SKILL.md"))).toBe("v2");
		// Session 1's version does not name session 2's pins.
		await expect(mount.read(service, "session-2", version, "pr-review/SKILL.md")).rejects.toSatisfy((error) =>
			isHarbourError(error, "not_found"),
		);
	});

	it("refuses paths outside the mount and names what is missing", async () => {
		const { mount } = await setup();
		const version = await mount.latestVersion(service, "session-1");
		for (const path of ["../x", "/pr-review/SKILL.md", "pr-review//SKILL.md"]) {
			await expect(mount.read(service, "session-1", version, path)).rejects.toSatisfy((error) =>
				isHarbourError(error, "invalid"),
			);
		}
		for (const path of ["unknown/SKILL.md", "pr-review/missing.md", "pr-review/scripts"]) {
			await expect(mount.read(service, "session-1", version, path)).rejects.toSatisfy((error) =>
				isHarbourError(error, "not_found"),
			);
		}
		await expect(mount.list(service, "session-1", version, "pr-review/nothing")).rejects.toSatisfy((error) =>
			isHarbourError(error, "not_found"),
		);
	});

	it("mounts read-only at /skills in a workspace, pinned to the session's revisions", async () => {
		const { mount } = await setup();
		const workspaces = createMemoryWorkspaces({ sources: [mount] });
		const record = await workspaces.create(service, {
			owner,
			sessionId: "session-1",
			mounts: [{ path: "/skills", source: "skills", ref: "session-1" }],
		});
		expect(record.mounts).toMatchObject([{ path: "/skills", source: "skills", ref: "session-1", readOnly: true }]);
		const file = await workspaces.read(service, record.id, "/skills/docs/SKILL.md");
		expect(new TextDecoder().decode(file.content)).toBe("# Docs\n");
		const listed = await workspaces.list(service, record.id, { path: "/skills", recursive: true });
		expect(listed.items.map((entry) => entry.path)).toContain("/skills/pr-review/scripts/lib/util.sh");
	});
});
