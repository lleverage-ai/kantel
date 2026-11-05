import { describe, expect, it } from "vitest";
import { computePath, parseComputePath, pathAfterAccountSwitch } from "./compute-console.tsx";
import { startingSnapshot, type Template } from "./compute-model.ts";
import { createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";
import {
	DEFAULT_TEMPLATE_BASE,
	type TemplateDraft,
	templateBaseChoices,
	templateBasePicked,
	templateDraft,
	templateDraftProblems,
	templateEditorChange,
	templateEditorInput,
	templateEnv,
	templateVariableDraft,
	templateVariableProblems,
} from "./template-draft.ts";
import { BASE_STABLE, createTemplateFixtures, sampleTemplateBases, sampleTemplates } from "./template-fixtures.ts";
import { buildPollMs } from "./template-view.ts";
import {
	baseText,
	behindText,
	builtFromText,
	freshnessText,
	imageText,
	rebuildText,
	resourcesText,
	shortFreshnessText,
	templatePickHint,
	waitsForImage,
} from "./templates-page.tsx";

const MINUTE = 60_000;
const byName = (name: string): Template => {
	const found = sampleTemplates(FIXTURE_NOW).find((template) => template.name === name);
	if (found === undefined) throw new Error(`no sample ${name}`);
	return found;
};

describe("what the console says about a template", () => {
	it("says what its image and base are", () => {
		expect(imageText(byName("python-data").spec)).toBe("Kantel base (kantel/sandbox)");
		expect(baseText(byName("python-data").spec)).toBe("kantel/sandbox:stable");
		expect(baseText(byName("media-tools").spec)).toMatch(/^kantel\/sandbox@[0-9a-f]{12}$/);
		expect(resourcesText({ vcpus: 4, memoryMb: 8192 })).toBe("4 vCPU, 8 GB");
		expect(resourcesText({ vcpus: 1, memoryMb: 1536 })).toBe("1 vCPU, 1536 MB");
	});

	it("says what new sandboxes start from: its current version's snapshot, or a fresh boot", () => {
		expect(freshnessText(byName("python-data"), FIXTURE_NOW)).toBe("Snapshot built 2h ago");
		// v1's snapshot is kept, but only v2's restores.
		expect(freshnessText(byName("node-web"), FIXTURE_NOW)).toBe("Building v2; new sandboxes boot the image fresh");
		expect(freshnessText(byName("rust-ci"), FIXTURE_NOW)).toBe("Build failed; new sandboxes boot the image fresh");
		expect(freshnessText({ version: 1, build: { state: "none" } }, FIXTURE_NOW)).toMatch(/boot the image fresh/);
	});

	it("says the same in a few words for the list", () => {
		expect(shortFreshnessText(byName("python-data"), FIXTURE_NOW)).toBe("Built 2h ago");
		expect(shortFreshnessText(byName("node-web"), FIXTURE_NOW)).toBe("Boots fresh until built");
		expect(shortFreshnessText(byName("rust-ci"), FIXTURE_NOW)).toBe("Boots fresh");
		expect(shortFreshnessText({ version: 1, build: { state: "none" } }, FIXTURE_NOW)).toBe("Boots fresh until built");
	});

	it("says how far a pinned base is behind, and nothing for one that follows its channel", () => {
		expect(behindText(byName("media-tools"))).toBe("Base 3 releases behind");
		expect(behindText(byName("python-data"))).toBeUndefined();
	});

	it("starts new sandboxes only from a snapshot of the template's current version, stale or not", () => {
		const python = byName("python-data");
		const ready = python.build.ready;
		if (ready === undefined) throw new Error("python-data has no snapshot");
		expect(startingSnapshot(python)).toBe(ready);
		// A new base digest on its channel: the same version's snapshot goes stale and still serves until it's replaced.
		const stale = { ...ready, state: "stale" as const };
		expect(startingSnapshot({ version: 3, build: { state: "building", ready: stale } })).toBe(stale);
		expect(freshnessText({ version: 3, build: { state: "stale", ready: stale } }, FIXTURE_NOW)).toBe(
			"Out of date, rebuilding soon; new sandboxes start from its snapshot, built 2h ago",
		);
		// An older version's, ready or stale, stays in the cache and starts nothing.
		expect(startingSnapshot({ version: 4, build: { state: "building", ready } })).toBeUndefined();
		expect(startingSnapshot({ version: 4, build: { state: "stale", ready: stale } })).toBeUndefined();
		expect(freshnessText({ version: 4, build: { state: "failed", ready: stale } }, FIXTURE_NOW)).toBe(
			"Build failed; new sandboxes boot the image fresh",
		);
		expect(startingSnapshot(byName("node-web"))).toBeUndefined();
	});

	it("tells New sandbox how a picked template will start", () => {
		expect(templatePickHint(byName("python-data"), FIXTURE_NOW)).toBe("Starts from its snapshot, built 2h ago.");
		expect(templatePickHint(byName("node-web"), FIXTURE_NOW)).toBe(
			"v2 isn't built yet: it boots the image and runs the setup itself, which takes longer.",
		);
		expect(templatePickHint(byName("rust-ci"), FIXTURE_NOW)).toMatch(/^Nothing built yet/);
	});

	it("tells New sandbox a picked template boots fresh at another shape than its own, and restores again at its own", () => {
		const python = byName("python-data");
		const own = { vcpus: python.spec.vcpus, memoryMb: python.spec.memoryMb };
		const fresh = `rather than its own ${resourcesText(python.spec)}, it boots the image and runs the setup itself, which takes longer.`;
		expect(templatePickHint(python, FIXTURE_NOW, { ...own, vcpus: own.vcpus * 2 })).toBe(
			`At ${resourcesText({ ...own, vcpus: own.vcpus * 2 })} ${fresh}`,
		);
		expect(templatePickHint(python, FIXTURE_NOW, { ...own, memoryMb: own.memoryMb * 2 })).toBe(
			`At ${resourcesText({ ...own, memoryMb: own.memoryMb * 2 })} ${fresh}`,
		);
		// Sliders moved back to the template's own vCPUs and memory: its snapshot serves again.
		expect(templatePickHint(python, FIXTURE_NOW, own)).toBe("Starts from its snapshot, built 2h ago.");
		// One with nothing built says why it boots fresh at another shape too.
		const rust = byName("rust-ci");
		expect(templatePickHint(rust, FIXTURE_NOW, { vcpus: 2, memoryMb: rust.spec.memoryMb })).toMatch(
			/^At 2 vCPU, .* rather than its own/,
		);
	});
});

describe("a custom image's availability", () => {
	const python = byName("python-data");
	const ready = python.build.ready;
	if (ready === undefined) throw new Error("python-data has no snapshot");
	const dockerfile = { ...python.spec, image: { kind: "dockerfile" as const, dockerfile: "FROM alpine\n" } };
	const unbuilt = { ...python, spec: dockerfile, version: 4, build: { state: "building" as const, ready } };

	it("never promises a fresh boot before its current version's image is built", () => {
		expect(waitsForImage(unbuilt)).toBe(true);
		expect(waitsForImage(python)).toBe(false);
		const said = [
			freshnessText(unbuilt, FIXTURE_NOW),
			freshnessText({ ...unbuilt, build: { state: "none" } }, FIXTURE_NOW),
			freshnessText({ ...unbuilt, build: { state: "failed", ready } }, FIXTURE_NOW),
			shortFreshnessText(unbuilt, FIXTURE_NOW),
			shortFreshnessText({ ...unbuilt, build: { state: "failed" } }, FIXTURE_NOW),
			rebuildText(unbuilt),
			templatePickHint(unbuilt, FIXTURE_NOW),
			templatePickHint(unbuilt, FIXTURE_NOW, { vcpus: 8, memoryMb: 16384 }),
		];
		for (const text of said) expect(text).not.toMatch(/fresh|boots the image/i);
		expect(freshnessText(unbuilt, FIXTURE_NOW)).toBe("Building v4; new sandboxes wait for its image to build");
		expect(shortFreshnessText(unbuilt, FIXTURE_NOW)).toBe("Waits for its image");
		expect(rebuildText(unbuilt)).toBe("Rebuilding. New sandboxes can't start from it until its image is built.");
		expect(templatePickHint(unbuilt, FIXTURE_NOW)).toMatch(/^v4's image isn't built yet/);
	});

	it("still serves a built image: its snapshot, a stale one during a rebuild, and a fresh boot at another shape", () => {
		const built = { ...python, spec: dockerfile };
		expect(freshnessText(built, FIXTURE_NOW)).toBe("Snapshot built 2h ago");
		const stale = { ...ready, state: "stale" as const };
		const rebuilding = { ...built, build: { state: "building" as const, ready: stale } };
		expect(shortFreshnessText(rebuilding, FIXTURE_NOW)).toBe(`v${ready.version} serves while it rebuilds`);
		expect(rebuildText(rebuilding)).toMatch(/current snapshot until the new one is ready/);
		expect(templatePickHint(built, FIXTURE_NOW, { vcpus: 8, memoryMb: 16384 })).toMatch(
			/boots the built image and runs the setup itself/,
		);
		// A Kantel base with nothing built still boots fresh.
		expect(freshnessText({ ...python, version: 4, build: { state: "none" } }, FIXTURE_NOW)).toMatch(
			/boot the image fresh/,
		);
	});
});

describe("the template editor's variables", () => {
	/** Every kind of value the API may hold, which the editor must send back as it was. */
	const awkward = {
		NOTE: "hello\n#keep this\nB=value",
		TRAILING: "x  \n",
		EMPTY: "",
		EQUALS: "a=b==c=",
		QUOTED: "\"quoted\" 'and' \\escaped",
		SPACED: "  both ends  ",
		TAB: "\tafter a tab",
		HASH: "#not a comment",
	};
	const withEnv = (env: Record<string, string>): Template => {
		const python = byName("python-data");
		return { ...python, spec: { ...python.spec, env } };
	};
	const sent = (draft: TemplateDraft, template: Template) => templateEditorInput(draft, template.spec.grants).spec.env;

	it("saves a template's variables exactly as they were when only its name or setup changes", () => {
		const template = withEnv(awkward);
		const draft = templateDraft(template);
		expect(draft.variables.map(({ name, value }) => [name, value])).toEqual(Object.entries(awkward));
		expect(templateDraftProblems(draft).ready).toBe(true);
		expect(sent(draft, template)).toEqual(awkward);
		expect(sent({ ...draft, description: "Another description", setup: "echo hi\n" }, template)).toEqual(awkward);
	});

	it("keeps every other value, line breaks and all, when one variable is edited, added or removed", () => {
		const template = withEnv(awkward);
		const draft = templateDraft(template);
		const edited: TemplateDraft = {
			...draft,
			variables: [
				...draft.variables
					.filter((variable) => variable.name !== "HASH")
					.map((variable) => (variable.name === "EQUALS" ? { ...variable, value: "k=v\nsecond line " } : variable)),
				templateVariableDraft("NEW", " y"),
			],
		};
		const { HASH: _removed, ...rest } = awkward;
		expect(sent(edited, template)).toEqual({ ...rest, EQUALS: "k=v\nsecond line ", NEW: " y" });
	});

	it("starts New template with one empty row, which saves nothing", () => {
		const draft = templateDraft();
		expect(draft.variables.map(({ name, value }) => ({ name, value }))).toEqual([{ name: "", value: "" }]);
		expect(templateEnv(draft.variables)).toEqual({});
		expect(templateVariableProblems(draft.variables)).toEqual([undefined]);
	});

	it("checks each name as the API does, and says which repeat an earlier row", () => {
		const rows = [
			templateVariableDraft("GOOD", "1"),
			templateVariableDraft("1BAD", "x"),
			templateVariableDraft("", "a value with no name"),
			templateVariableDraft("KANTEL_SANDBOX", "x"),
			templateVariableDraft("https_proxy", "x"),
			templateVariableDraft("GOOD", "2"),
			templateVariableDraft("", ""),
			templateVariableDraft(`A${"B".repeat(255)}`, ""),
		];
		expect(templateVariableProblems(rows)).toEqual([
			undefined,
			"Use letters, digits and underscores, not starting with a digit.",
			"Give the variable a name.",
			"Kantel sets this one itself. Choose another name.",
			"Kantel sets this one itself. Choose another name.",
			"There's already a GOOD.",
			undefined,
			"Keep the name to 255 characters.",
		]);
		const draft = { ...templateDraft(), name: "fine", variables: rows };
		expect(templateDraftProblems(draft).ready).toBe(false);
		expect(templateDraftProblems({ ...draft, variables: rows.slice(0, 1) }).ready).toBe(true);
	});
});

describe("a template's build, as its views follow it", () => {
	const at = (state: Template["build"]["state"]) => ({ build: { state } });

	it("reads again soon while a build runs, now and then while one waits to rebuild, and not once all are settled", () => {
		expect(buildPollMs([at("ready"), at("building")], 2000)).toBe(2000);
		expect(buildPollMs([at("ready")], 2000, [{ state: "queued" }])).toBe(2000);
		expect(buildPollMs([at("ready")], 2000, [{ state: "building" }])).toBe(2000);
		expect(buildPollMs([at("stale")], 2000)).toBe(30_000);
		expect(buildPollMs([at("ready"), at("failed"), at("none")], 2000, [{ state: "ready" }, { state: "failed" }])).toBe(
			undefined,
		);
		expect(buildPollMs([], 2000)).toBeUndefined();
	});
});

describe("the template editor's base", () => {
	const bases = sampleTemplateBases(FIXTURE_NOW);
	const [stable, beta] = bases;
	if (stable === undefined || beta === undefined) throw new Error("no sample bases");
	const oldest = stable.history.at(-1)?.digest ?? "";

	it("starts New template following the default base's stable channel, and saves Kantel's base image", () => {
		const draft = { ...templateDraft(), name: "fresh" };
		expect(templateDraftProblems(draft).ready).toBe(true);
		expect(templateEditorInput(draft, []).spec).toMatchObject({
			image: { kind: "kantel-base" },
			base: DEFAULT_TEMPLATE_BASE,
		});
	});

	it("offers only the published images and channels, and the default's stable before it publishes", () => {
		const draft = templateDraft();
		expect(templateBaseChoices(draft, bases)).toMatchObject({
			images: ["kantel/sandbox"],
			channels: ["stable", "beta"],
			channel: "stable",
			current: BASE_STABLE,
		});
		expect(templateBaseChoices(draft, [])).toEqual({
			images: ["kantel/sandbox"],
			channels: ["stable"],
			channel: "stable",
			current: "",
			digests: [],
		});
	});

	it("pins a digest from the channel's history, the current one first, and shows the channel a pinned one came from", () => {
		const pinned = templateBasePicked({ ...templateDraft(), name: "held" }, { mode: "digest" }, bases);
		expect(pinned).toMatchObject({ baseMode: "digest", channel: "stable", digest: BASE_STABLE });
		expect(templateBaseChoices(pinned, bases).digests.map((release) => release.digest)).toEqual(
			stable.history.map((release) => release.digest),
		);
		expect(templateEditorInput(pinned, []).spec.base).toEqual({ image: "kantel/sandbox", digest: BASE_STABLE });

		const onBeta = templateBasePicked(pinned, { channel: "beta" }, bases);
		expect(onBeta).toMatchObject({ channel: "beta", digest: beta.digest });

		// media-tools pins the oldest stable digest: beta never published it, so its fields show stable's history.
		const media = templateDraft(byName("media-tools"));
		expect(templateBaseChoices({ ...media, channel: "beta" }, bases)).toMatchObject({ channel: "stable" });
		expect(templateBasePicked(media, { mode: "channel" }, bases)).toMatchObject({
			baseMode: "channel",
			channel: "stable",
		});
		expect(templateBasePicked(media, { mode: "channel" }, bases).digest).toBe(oldest);
	});

	it("keeps a template's own base on offer when the deployment no longer publishes it", () => {
		const unpublished = `sha256:${"a".repeat(64)}`;
		const draft = {
			...templateDraft(),
			baseImage: "kantel/sandbox-gpu",
			channel: "nightly",
			baseMode: "digest" as const,
			digest: unpublished,
		};
		expect(templateBaseChoices(draft, bases)).toEqual({
			images: ["kantel/sandbox-gpu", "kantel/sandbox"],
			channels: ["nightly"],
			channel: "nightly",
			current: "",
			digests: [{ digest: unpublished }],
		});
	});

	it("can't pin a channel that hasn't published a digest", () => {
		const pinned = templateBasePicked({ ...templateDraft(), name: "held" }, { mode: "digest" }, []);
		expect(pinned.digest).toBe("");
		expect(templateDraftProblems(pinned).ready).toBe(false);
	});
});

describe("the sample templates' setup scripts", () => {
	it("allow every host their scripts and Dockerfiles fetch from", () => {
		const kinds = new Set<string>();
		for (const template of sampleTemplates(FIXTURE_NOW)) {
			const { image, setup = "", grants } = template.spec;
			kinds.add(image.kind);
			// A Dockerfile's RUN steps fetch behind the same grants, in the build microVM.
			const fetches = `${setup}\n${image.kind === "dockerfile" ? image.dockerfile : ""}`;
			const hosts = grants.map((grant) => grant.host);
			for (const [, host] of fetches.matchAll(/https:\/\/([^/\s]+)/g)) expect(hosts, template.name).toContain(host);
			if (/\bapt-get\b/.test(fetches)) expect(hosts, template.name).toContain("snapshot.ubuntu.com");
		}
		expect([...kinds].sort()).toEqual(["dockerfile", "image", "kantel-base"]);
	});
});

describe("a template's custom image", () => {
	it("is read into the draft and saved back as the kind picked, the others' text kept but not sent", () => {
		const ci = byName("ci-tools");
		const draft = templateDraft(ci);
		expect(draft).toMatchObject({ imageKind: "dockerfile", imageRef: "" });
		expect(draft.dockerfile).toContain("FROM $KANTEL_BASE");
		expect(templateEditorChange(ci, draft)).toEqual({});
		const ref = { ...draft, imageKind: "image" as const, imageRef: " ghcr.io/acme/ci:1.8 " };
		expect(templateEditorChange(ci, ref).spec?.image).toEqual({ kind: "image", ref: "ghcr.io/acme/ci:1.8" });
		// Back to the Dockerfile: it is as it was, and nothing changed.
		expect(templateEditorChange(ci, { ...ref, imageKind: "dockerfile" })).toEqual({});
		const base = templateEditorChange(ci, { ...draft, imageKind: "kantel-base" });
		expect(base.spec?.image).toEqual({ kind: "kantel-base" });
		expect(templateDraft(byName("python-slim"))).toMatchObject({ imageKind: "image", imageRef: "python:3.13-slim" });
	});

	it("can't be saved blank, too long, or as a reference that isn't one", () => {
		const draft = { ...templateDraft(), name: "custom" };
		expect(templateDraftProblems({ ...draft, imageKind: "dockerfile", dockerfile: "  \n" }).ready).toBe(false);
		const long = templateDraftProblems({ ...draft, imageKind: "dockerfile", dockerfile: "#".repeat(65_537) });
		expect(long.ready).toBe(false);
		expect(long.dockerfile).toContain("65,536");
		expect(templateDraftProblems({ ...draft, imageKind: "dockerfile", dockerfile: "FROM alpine\n" }).ready).toBe(true);
		expect(templateDraftProblems({ ...draft, imageKind: "image", imageRef: "" }).ready).toBe(false);
		for (const bad of ["Python:3", "python:3 ; curl 169.254.169.254", "-v/:/host", `python@sha256:${"z".repeat(64)}`]) {
			const problems = templateDraftProblems({ ...draft, imageKind: "image", imageRef: bad });
			expect(problems.ready, bad).toBe(false);
			expect(problems.imageRef, bad).toBeDefined();
		}
		for (const good of [
			"python:3.13-slim",
			"ghcr.io/acme/ci:1.8",
			`registry.example.com:5000/a/b@sha256:${"0".repeat(64)}`,
		]) {
			expect(templateDraftProblems({ ...draft, imageKind: "image", imageRef: good }).ready, good).toBe(true);
		}
	});

	it("saves as an image reference whatever its hidden base fields hold, which switching back still has", () => {
		// A digest to pin picked on a deployment that published none: the base fields can't be saved as they are.
		const halfway = { ...templateDraft(), name: "py", baseMode: "digest" as const, digest: "" };
		expect(templateDraftProblems(halfway).ready).toBe(false);
		const ref = { ...halfway, imageKind: "image" as const, imageRef: "python:3.13-slim" };
		expect(templateDraftProblems(ref).ready).toBe(true);
		expect(templateEditorInput(ref, []).spec.base).toEqual(DEFAULT_TEMPLATE_BASE);
		// Back to a Dockerfile or the base: the half-picked base is as it was, and must be finished first.
		for (const imageKind of ["dockerfile", "kantel-base"] as const) {
			const back = { ...ref, imageKind, dockerfile: "FROM alpine\n" };
			expect(back).toMatchObject({ baseMode: "digest", digest: "" });
			expect(templateDraftProblems(back).ready, imageKind).toBe(false);
		}
		// A whole base picked is saved as picked, and an image-reference template read back saves nothing new.
		const pinned = { ...ref, digest: BASE_STABLE };
		expect(templateEditorInput(pinned, []).spec.base).toEqual({ image: "kantel/sandbox", digest: BASE_STABLE });
		const slim = byName("python-slim");
		expect(templateEditorChange(slim, templateDraft(slim))).toEqual({});
	});

	it("says what it is and what a snapshot was built from", () => {
		const ci = byName("ci-tools");
		const slim = byName("python-slim");
		expect(imageText(ci.spec)).toBe("Dockerfile on kantel/sandbox");
		expect(imageText(slim.spec)).toBe("Image python:3.13-slim");
		const ciReady = ci.build.ready as NonNullable<typeof ci.build.ready>;
		expect(builtFromText(ciReady)).toMatch(/^Dockerfile [0-9a-f]{12}, built [0-9a-f]{12}$/);
		expect(builtFromText(slim.build.ready as NonNullable<typeof slim.build.ready>)).toMatch(
			/^python:3\.13-slim@[0-9a-f]{12}$/,
		);
		expect(ciReady.key.imageDigest).toBe(ciReady.builtFrom.imageDigest);
		expect(builtFromText(byName("python-data").build.ready as NonNullable<Template["build"]["ready"]>)).toMatch(
			/^kantel\/sandbox:stable@[0-9a-f]{12}$/,
		);
	});
});

describe("the Templates page's address", () => {
	it("routes the list and one template, and an account switch goes back to the list", () => {
		expect(parseComputePath("/compute/templates")).toEqual({ page: "templates" });
		expect(parseComputePath("/compute/templates/tpl_python")).toEqual({ page: "templates", templateId: "tpl_python" });
		expect(computePath("templates", "/compute", "tpl_python")).toBe("/compute/templates/tpl_python");
		expect(pathAfterAccountSwitch("/compute/templates/tpl_python")).toBe("/compute/templates");
	});
});

describe("the sample templates source", () => {
	it("is there only when the deployment has templates on", () => {
		expect(createComputeFixtures().templates).toBeUndefined();
		expect(createComputeFixtures({ templates: true }).templates).toBeDefined();
	});

	it("builds a new version in the background, the last one's snapshot kept, stale, but booting fresh", async () => {
		let now = FIXTURE_NOW;
		const source = createTemplateFixtures({ now, clock: () => now, buildMs: 5, accountId: LLEVERAGE.id });
		const before = await source.get("tpl_python");
		const changed = await source.update("tpl_python", { spec: { ...before.spec, vcpus: 8 } });
		expect(changed.version).toBe(before.version + 1);
		expect(changed.build.state).toBe("building");
		expect(changed.build.ready?.state).toBe("stale");
		expect(changed.build.ready?.version).toBe(before.version);
		expect(startingSnapshot(changed)).toBeUndefined();
		expect(freshnessText(changed, now)).toBe("Building v4; new sandboxes boot the image fresh");
		expect((await source.snapshots("tpl_python")).find((entry) => entry.id === before.build.ready?.id)?.state).toBe(
			"stale",
		);
		now += MINUTE;
		await new Promise((resolve) => setTimeout(resolve, 20));
		const built = await source.get("tpl_python");
		expect(built.build.state).toBe("ready");
		expect(built.build.ready?.version).toBe(changed.version);
		const cache = await source.snapshots("tpl_python");
		expect(cache.filter((entry) => entry.state === "stale")).toEqual([]);
		expect((await source.versions("tpl_python"))[0]?.version).toBe(changed.version);
	});

	it("keeps the version when only the name or description changes", async () => {
		const source = createTemplateFixtures({ now: FIXTURE_NOW, buildMs: 5 });
		const renamed = await source.update("tpl_python", { description: "Just the description" });
		expect(renamed.version).toBe(3);
		expect(renamed.build.state).toBe("ready");
	});

	it("keeps the ready snapshot serving, stale, on a rebuild until the rebuild's replaces it", async () => {
		const source = createTemplateFixtures({ now: FIXTURE_NOW, buildMs: 5 });
		const before = await source.get("tpl_python");
		const rebuilt = await source.rebuild("tpl_python");
		expect(rebuilt.build.state).toBe("building");
		expect(rebuilt.build.ready).toMatchObject({ id: before.build.ready?.id, state: "stale" });
		expect(freshnessText(rebuilt, FIXTURE_NOW)).toBe(
			"Building v3; new sandboxes start from its snapshot, built 2h ago",
		);
		expect(rebuildText(rebuilt)).toBe(
			"Rebuilding. New sandboxes start from v3's current snapshot until the new one is ready, and still do if the rebuild fails.",
		);
		expect(shortFreshnessText(rebuilt, FIXTURE_NOW)).toBe("v3 serves while it rebuilds");
		await new Promise((resolve) => setTimeout(resolve, 20));
		const built = await source.get("tpl_python");
		expect(built.build.state).toBe("ready");
		expect(built.build.ready?.id).not.toBe(before.build.ready?.id);
		const cache = await source.snapshots("tpl_python");
		expect(cache.find((entry) => entry.id === before.build.ready?.id)?.state).toBe("discarded");
	});

	it("throws a failed build away on a rebuild, and boots fresh until it's ready when nothing was built", async () => {
		const source = createTemplateFixtures({ now: FIXTURE_NOW, buildMs: 5 });
		const rebuilt = await source.rebuild("tpl_rust");
		expect(rebuilt.build.state).toBe("building");
		expect(rebuilt.build.ready).toBeUndefined();
		expect(freshnessText(rebuilt, FIXTURE_NOW)).toMatch(/boot the image fresh/);
		expect(rebuildText(rebuilt)).toBe("Rebuilding. New sandboxes boot the image fresh until it's ready.");
		expect((await source.snapshots("tpl_rust")).find((entry) => entry.id === "tsn_rust_1")?.state).toBe("discarded");
	});

	it("boots fresh on a rebuild whose only snapshot is an older version's, which it keeps", async () => {
		const source = createTemplateFixtures({ now: FIXTURE_NOW, buildMs: 5 });
		const rebuilt = await source.rebuild("tpl_node");
		expect(rebuilt.build.ready).toMatchObject({ id: "tsn_node_1", version: 1, state: "stale" });
		expect(rebuildText(rebuilt)).toBe("Rebuilding. New sandboxes boot the image fresh until it's ready.");
		expect((await source.snapshots("tpl_node")).find((entry) => entry.id === "tsn_node_1")?.state).toBe("stale");
	});

	it("records which template a sandbox was made from, and whether it started from the snapshot", async () => {
		const source = createComputeFixtures({ templates: true, settleMs: 1 });
		// The template's own 4 vCPUs and 8 GB, asked for or not: restored from its snapshot.
		const made = await source.sandboxes.create({
			accountId: LLEVERAGE.id,
			kind: "microvm",
			shape: { vcpus: 4, memoryMb: 8192 },
			templateId: "tpl_python",
		});
		expect(made.template).toEqual({ id: "tpl_python", name: "python-data", version: 3, start: "snapshot" });
		const own = await source.sandboxes.create({ accountId: LLEVERAGE.id, kind: "microvm", templateId: "tpl_python" });
		expect(own.size).toBe("medium");
		expect(own.template?.start).toBe("snapshot");
		// Another shape: no snapshot was built as it, so it boots fresh.
		const other = await source.sandboxes.create({
			accountId: LLEVERAGE.id,
			kind: "microvm",
			shape: { vcpus: 8, memoryMb: 16_384 },
			templateId: "tpl_python",
		});
		expect(other.template?.start).toBe("boot");
		const fresh = await source.sandboxes.create({
			accountId: LLEVERAGE.id,
			kind: "microvm",
			shape: { vcpus: 8, memoryMb: 16_384 },
			templateId: "tpl_rust",
		});
		expect(fresh.template?.start).toBe("boot");
		// node-web's only snapshot is v1's: v2's sandboxes boot fresh, at its own shape too.
		const node = await source.sandboxes.create({ accountId: LLEVERAGE.id, kind: "microvm", templateId: "tpl_node" });
		expect(node.template).toMatchObject({ id: "tpl_node", version: 2, start: "boot" });
	});
});
