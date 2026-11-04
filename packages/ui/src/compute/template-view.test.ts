import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Template, TemplateChange, TemplatesSource } from "./compute-model.ts";
import { FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";
import { templateVariableDraft } from "./template-draft.ts";
import { createTemplateFixtures } from "./template-fixtures.ts";
import { NewTemplateView, TemplateView } from "./template-view.ts";

const POLL_MS = 2000;

/** A call that answers when told to. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/**
 * The sample templates, with node-web building v2 for as long as the test runs, a hold on reads of the template (each
 * held read waits to be answered or failed), a switch that refuses saves and a hold on saves (each held save waits to
 * be let through or failed). It keeps every change a save sent.
 */
function harness(templateId = "tpl_node") {
	const fixtures = createTemplateFixtures({ now: FIXTURE_NOW, buildMs: 3_600_000 });
	const held: ReturnType<typeof deferred<Template>>[] = [];
	const heldSaves: ReturnType<typeof deferred<void>>[] = [];
	const sent: TemplateChange[] = [];
	let hold = false;
	let holdSaves = false;
	let refuseSaves = false;
	let reads = 0;
	const source: TemplatesSource = {
		...fixtures,
		get: (id) => {
			reads += 1;
			if (!hold) return fixtures.get(id);
			const read = deferred<Template>();
			held.push(read);
			return read.promise;
		},
		update: (id, change) => {
			sent.push(change);
			if (refuseSaves) return Promise.reject(new Error("Kantel can't be reached."));
			if (!holdSaves) return fixtures.update(id, change);
			const save = deferred<void>();
			heldSaves.push(save);
			return save.promise.then(() => fixtures.update(id, change));
		},
	};
	const view = new TemplateView({ source, templateId, pollMs: POLL_MS });
	return {
		view,
		fixtures,
		sent,
		reads: () => reads,
		holdSaves: () => {
			holdSaves = true;
		},
		/** The oldest held save. */
		heldSave: () => {
			const save = heldSaves.shift();
			if (save === undefined) throw new Error("No save is held.");
			return save;
		},
		holdReads: () => {
			hold = true;
		},
		/** The oldest held read. */
		held: () => {
			const read = held.shift();
			if (read === undefined) throw new Error("No read is held.");
			return read;
		},
		releaseReads: () => {
			hold = false;
		},
		refuseSaves: (on: boolean) => {
			refuseSaves = on;
		},
	};
}

/** Opens node-web's editor while a read is on its way, and types a description and a multi-line variable. */
async function editDuringRead() {
	const test = harness();
	test.view.start();
	await vi.advanceTimersByTimeAsync(0);
	const first = test.view.state().read;
	if (first.status !== "ready") throw new Error("node-web wasn't read.");
	expect(first.value.template.build.state).toBe("building");
	test.holdReads();
	// The poll starts, and is still on its way when Edit opens.
	await vi.advanceTimersByTimeAsync(POLL_MS);
	expect(test.reads()).toBe(2);
	test.view.edit();
	test.view.change((draft) => ({
		...draft,
		description: "Typed while a read was on its way",
		variables: [...draft.variables, templateVariableDraft("NOTE", "two\nlines ")],
	}));
	const typed = test.view.state().editing;
	if (typed === undefined) throw new Error("The editor didn't open.");
	return { ...test, typed, first: first.value };
}

describe("a template's page while its editor is open", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps the editor and what's typed when a read that started before Edit answers, and reads no more", async () => {
		const { view, held, reads, typed, first, releaseReads } = await editDuringRead();
		// It answers with the template as it is now: built, under another description.
		held().resolve({ ...first.template, description: "Changed elsewhere", build: { state: "ready" } });
		await vi.advanceTimersByTimeAsync(0);
		expect(view.state().editing).toBe(typed);
		expect(view.state().editing?.draft.description).toBe("Typed while a read was on its way");
		expect(view.state().editing?.draft.variables.at(-1)).toMatchObject({ name: "NOTE", value: "two\nlines " });
		// No timer reads while it's open.
		releaseReads();
		await vi.advanceTimersByTimeAsync(POLL_MS * 10);
		expect(reads()).toBe(2);
	});

	it("keeps the editor and what's typed when that read fails, and reads again once Cancel closes it", async () => {
		const { view, held, reads, typed, releaseReads } = await editDuringRead();
		held().reject(new Error("Kantel can't be reached."));
		await vi.advanceTimersByTimeAsync(0);
		expect(view.state().editing).toBe(typed);
		// The page under it keeps its last answer, so Cancel goes back to it, not to the failure.
		expect(view.state().read.status).toBe("ready");
		releaseReads();
		await vi.advanceTimersByTimeAsync(POLL_MS * 10);
		expect(reads()).toBe(2);
		view.cancel();
		expect(view.state().editing).toBeUndefined();
		await vi.advanceTimersByTimeAsync(0);
		expect(reads()).toBe(3);
		expect(view.state().read.status).toBe("ready");
		// And node-web still builds, so it goes on reading.
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(reads()).toBe(4);
	});

	it("goes back to reading while the build runs after Cancel", async () => {
		const { view, held, reads, first, releaseReads } = await editDuringRead();
		held().resolve(first.template);
		await vi.advanceTimersByTimeAsync(0);
		releaseReads();
		view.cancel();
		expect(view.state().editing).toBeUndefined();
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(reads()).toBe(3);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(reads()).toBe(4);
	});

	it("leaves the editor open, as typed, when a save fails, and closes it and reads again when one succeeds", async () => {
		const { view, held, reads, typed, first, refuseSaves, releaseReads } = await editDuringRead();
		held().resolve(first.template);
		await vi.advanceTimersByTimeAsync(0);
		releaseReads();
		refuseSaves(true);
		await expect(view.save()).rejects.toThrow("Kantel can't be reached.");
		expect(view.state().editing).toBe(typed);
		expect(reads()).toBe(2);
		refuseSaves(false);
		const saved = await view.save();
		expect(saved.description).toBe("Typed while a read was on its way");
		expect(saved.spec.env).toEqual({ ...first.template.spec.env, NOTE: "two\nlines " });
		expect(view.state().editing).toBeUndefined();
		expect(reads()).toBe(3);
	});

	it("opens the editor on the first read when asked, and drops what a read answers after the page goes", async () => {
		const fixtures = createTemplateFixtures({ now: FIXTURE_NOW, buildMs: 3_600_000 });
		const later = deferred<Template>();
		let reads = 0;
		const source: TemplatesSource = {
			...fixtures,
			get: (id) => {
				reads += 1;
				return reads === 1 ? fixtures.get(id) : later.promise;
			},
		};
		const view = new TemplateView({ source, templateId: "tpl_node", pollMs: POLL_MS, editing: true });
		view.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(view.state().editing?.template.id).toBe("tpl_node");
		view.cancel();
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(reads).toBe(2);
		const before = view.state();
		view.stop();
		later.reject(new Error("too late"));
		await vi.advanceTimersByTimeAsync(POLL_MS * 5);
		expect(view.state()).toBe(before);
		expect(reads).toBe(2);
	});
});

describe("saving a template's editor", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	/** node-web's editor open, a description typed, and a save held on its way. */
	async function savePending() {
		const test = harness();
		test.view.start();
		await vi.advanceTimersByTimeAsync(0);
		test.view.edit();
		test.view.change((draft) => ({ ...draft, description: "Sent with the save" }));
		const typed = test.view.state().editing;
		if (typed === undefined) throw new Error("The editor didn't open.");
		test.holdSaves();
		const saving = test.view.save();
		return { ...test, typed, saving };
	}

	it("takes no typing and no Cancel while a save is on its way, then closes on what it saved", async () => {
		const { view, typed, saving, heldSave, reads } = await savePending();
		expect(view.state().editing).toMatchObject({ draft: typed.draft, saving: true });
		view.change((draft) => ({ ...draft, setup: "typed after Save" }));
		view.cancel();
		view.edit();
		expect(view.state().editing?.draft).toBe(typed.draft);
		await expect(view.save()).rejects.toThrow("already saving");
		const before = reads();
		heldSave().resolve();
		expect((await saving).description).toBe("Sent with the save");
		expect(view.state().editing).toBeUndefined();
		await vi.advanceTimersByTimeAsync(0);
		expect(reads()).toBe(before + 1);
	});

	it("gives the whole draft back for another try when a held save fails", async () => {
		const { view, typed, saving, heldSave } = await savePending();
		view.change((draft) => ({ ...draft, setup: "typed after Save" }));
		heldSave().reject(new Error("Kantel can't be reached."));
		await expect(saving).rejects.toThrow("Kantel can't be reached.");
		expect(view.state().editing).toBe(typed);
		view.change((draft) => ({ ...draft, setup: "typed after it failed" }));
		expect(view.state().editing?.draft).toMatchObject({
			description: "Sent with the save",
			setup: "typed after it failed",
		});
	});

	it("sends only a changed description, keeping a definition and name changed elsewhere since Edit opened", async () => {
		const { view, fixtures, sent } = harness("tpl_python");
		view.start();
		await vi.advanceTimersByTimeAsync(0);
		view.edit();
		const opened = view.state().editing?.template;
		if (opened === undefined) throw new Error("The editor didn't open.");
		// Another client publishes v4 and renames it while the editor is open.
		const newer = { ...opened.spec, setup: "uv pip install --system pandas polars duckdb jupyterlab ibis" };
		await fixtures.update("tpl_python", { name: "python-lab", spec: newer });
		view.change((draft) => ({ ...draft, description: "Only this changed" }));
		const saved = await view.save();
		expect(sent).toEqual([{ description: "Only this changed" }]);
		expect(saved).toMatchObject({ name: "python-lab", version: 4, description: "Only this changed", spec: newer });
		expect((await fixtures.versions("tpl_python"))[0]?.version).toBe(4);
	});

	it("still sends a definition that was changed, making a version, and an emptied description, clearing it", async () => {
		const { view, sent } = harness("tpl_python");
		view.start();
		await vi.advanceTimersByTimeAsync(0);
		view.edit();
		view.change((draft) => ({ ...draft, vcpus: "8", description: "" }));
		const saved = await view.save();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ description: "", spec: { vcpus: 8 } });
		expect(sent[0]?.name).toBeUndefined();
		expect(saved.version).toBe(4);
		expect(saved.spec.vcpus).toBe(8);
		expect(saved.description).toBeUndefined();
	});

	it("sends nothing to change when nothing was, and makes no version", async () => {
		const { view, sent } = harness("tpl_python");
		view.start();
		await vi.advanceTimersByTimeAsync(0);
		view.edit();
		const saved = await view.save();
		expect(sent).toEqual([{}]);
		expect(saved.version).toBe(3);
	});
});

describe("New template", () => {
	/** New template's form open with a name typed, and the create held on its way. */
	function createPending() {
		const fixtures = createTemplateFixtures({ now: FIXTURE_NOW, buildMs: 3_600_000, accountId: LLEVERAGE.id });
		const held: ReturnType<typeof deferred<void>>[] = [];
		const source: TemplatesSource = {
			...fixtures,
			create: (input) => {
				const make = deferred<void>();
				held.push(make);
				return make.promise.then(() => fixtures.create(input));
			},
		};
		const view = new NewTemplateView({ source, accountId: LLEVERAGE.id, open: true });
		view.change((draft) => ({ ...draft, name: "go-tools", setup: "go install golang.org/x/tools/gopls@latest" }));
		const typed = view.state();
		const saving = view.save();
		const make = held.shift();
		if (make === undefined) throw new Error("No create was sent.");
		return { view, fixtures, typed, saving, make };
	}

	it("takes no typing and no Cancel while the create is on its way, then closes once it's made", async () => {
		const { view, fixtures, typed, saving, make } = createPending();
		expect(view.state()).toEqual({ draft: typed.draft, saving: true });
		view.change((draft) => ({ ...draft, description: "typed after Create" }));
		view.cancel();
		view.open();
		expect(view.state().draft).toBe(typed.draft);
		make.resolve();
		const made = await saving;
		expect(made).toMatchObject({ name: "go-tools", spec: { setup: "go install golang.org/x/tools/gopls@latest" } });
		expect(made.description).toBeUndefined();
		expect(view.state().draft).toBeUndefined();
		expect((await fixtures.list(LLEVERAGE.id)).map((template) => template.name)).toContain("go-tools");
	});

	it("gives the whole draft back for another try when the create fails", async () => {
		const { view, typed, saving, make } = createPending();
		make.reject(new Error("There's already a template called go-tools."));
		await expect(saving).rejects.toThrow("already a template");
		expect(view.state()).toBe(typed);
		view.change((draft) => ({ ...draft, name: "go-tools-2" }));
		expect(view.state().draft?.name).toBe("go-tools-2");
		view.cancel();
		expect(view.state().draft).toBeUndefined();
	});
});
