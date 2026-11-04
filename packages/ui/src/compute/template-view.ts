// A template's page as one store: its three reads (the template, its snapshot cache and its versions) made together
// and made again while a build runs, and the editor's draft. The editor holds the template as it was when Edit opened
// and what's typed since, apart from the reads: once it's open no read, the one in flight when it opened included,
// changes it or closes it, whether that read answers or fails. Reading again on a timer stops while it's open and
// starts again when it closes (at once, if a read failed meanwhile). A save sends only what was changed from the
// template as Edit read it; while it's on its way the draft can't be changed or closed, so the answer closes just what
// it saved, and a save that fails leaves it open, as typed, for another try. A save that succeeds puts the template it
// answered with on the page before the editor closes, so Edit can't open again on the template from before it while
// the reads that follow are on their way. New template's form is a smaller store of the same kind.

import type { Loaded } from "../primitives/load.ts";
import type { Template, TemplateSnapshot, TemplatesSource, TemplateVersion } from "./compute-model.ts";
import { type TemplateDraft, templateDraft, templateEditorChange, templateEditorInput } from "./template-draft.ts";

/** How often a view of templates reads them again while a build runs. */
export const TEMPLATE_POLL_MS = 2000;
/** And while one is out of date, waiting for Kantel to start its rebuild. */
const STALE_POLL_MS = 30_000;

/**
 * When a view of templates reads them again: soon while a build runs (a template building, or a snapshot queued or
 * building), now and then while one is out of date and waits to rebuild, and not at all once every build has settled.
 */
export function buildPollMs(
	templates: readonly Pick<Template, "build">[],
	pollMs: number,
	snapshots: readonly Pick<TemplateSnapshot, "state">[] = [],
): number | undefined {
	if (
		templates.some((template) => template.build.state === "building") ||
		snapshots.some((entry) => entry.state === "queued" || entry.state === "building")
	)
		return pollMs;
	return templates.some((template) => template.build.state === "stale") ? STALE_POLL_MS : undefined;
}

/** What a template's page reads. */
export interface TemplateRead {
	readonly template: Template;
	readonly snapshots: readonly TemplateSnapshot[];
	readonly versions: readonly TemplateVersion[];
}

/** The open editor: the template as it was when Edit opened, and the draft typed since. */
export interface TemplateEditing {
	readonly template: Template;
	readonly draft: TemplateDraft;
	/** A save is on its way: until it answers the draft can't be changed and the editor can't be closed. */
	readonly saving?: boolean;
}

export interface TemplateViewState {
	readonly read: Loaded<TemplateRead>;
	readonly editing?: TemplateEditing;
}

export interface TemplateViewOptions {
	readonly source: TemplatesSource;
	readonly templateId: string;
	/** How often it reads again while a build runs. */
	readonly pollMs: number;
	/** Open the editor once the template is first read, for a story. */
	readonly editing?: boolean;
}

export class TemplateView {
	readonly #options: TemplateViewOptions;
	#state: TemplateViewState = { read: { status: "loading" } };
	readonly #listeners = new Set<() => void>();
	/** The newest read's number: an answer to an older one is dropped. */
	#reading = 0;
	#inFlight = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#live = false;
	#editOnRead: boolean;
	/** A read failed while the editor was open: it's made again when the editor closes. */
	#missed = false;

	constructor(options: TemplateViewOptions) {
		this.#options = options;
		this.#editOnRead = options.editing ?? false;
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	readonly state = (): TemplateViewState => this.#state;

	/** Reads, and keeps reading while a build runs, until `stop`. */
	start(): void {
		if (this.#live) return;
		this.#live = true;
		this.reload();
	}

	/** No more reads, and the answer to one on its way is dropped: the page went, or shows another template. */
	stop(): void {
		this.#live = false;
		this.#reading += 1;
		this.#inFlight = false;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** Reads the three again now, keeping the last answer on screen meanwhile. */
	readonly reload = (): void => {
		if (!this.#live) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#reading += 1;
		const reading = this.#reading;
		this.#inFlight = true;
		const { source, templateId } = this.#options;
		Promise.all([source.get(templateId), source.snapshots(templateId), source.versions(templateId)]).then(
			([template, snapshots, versions]) =>
				this.#settle(reading, { status: "ready", value: { template, snapshots, versions } }),
			(error: unknown) => this.#settle(reading, { status: "error", error }),
		);
	};

	/** Opens the editor on the template as last read. */
	readonly edit = (): void => {
		const { read, editing } = this.#state;
		if (read.status !== "ready" || editing !== undefined) return;
		this.#open(read.value.template);
	};

	/** Changes the open editor's draft, unless a save is on its way. */
	readonly change = (update: (draft: TemplateDraft) => TemplateDraft): void => {
		const { editing } = this.#state;
		if (editing === undefined || editing.saving === true) return;
		this.#set({ ...this.#state, editing: { template: editing.template, draft: update(editing.draft) } });
	};

	/** Closes the editor, dropping the draft, and goes back to reading while a build runs; not while a save is on its way. */
	readonly cancel = (): void => {
		const { editing } = this.#state;
		if (editing === undefined || editing.saving === true) return;
		this.#set({ read: this.#state.read });
		if (this.#missed) this.reload();
		else this.#schedule();
	};

	/**
	 * Saves what the draft changed. Saved, the page shows the template the save answered with, the editor closes and the
	 * page reads again (dropping any read from before the save); refused, it stays as it was before the save.
	 */
	readonly save = async (): Promise<Template> => {
		const editing = this.#state.editing;
		if (editing === undefined) throw new Error("The editor isn't open.");
		if (editing.saving === true) throw new Error("The template is already saving.");
		this.#set({ ...this.#state, editing: { ...editing, saving: true } });
		let saved: Template;
		try {
			saved = await this.#options.source.update(
				editing.template.id,
				templateEditorChange(editing.template, editing.draft),
			);
		} catch (error) {
			this.#set({ ...this.#state, editing });
			throw error;
		}
		const { read } = this.#state;
		this.#set({
			read: read.status === "ready" ? { status: "ready", value: { ...read.value, template: saved } } : read,
		});
		this.reload();
		return saved;
	};

	#open(template: Template): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#missed = false;
		this.#set({ ...this.#state, editing: { template, draft: templateDraft(template) } });
	}

	#settle(reading: number, read: Loaded<TemplateRead>): void {
		if (!this.#live || reading !== this.#reading) return;
		this.#inFlight = false;
		const { editing } = this.#state;
		// While the editor is open an answer is kept for when it closes, and a failure is read again then, so the page
		// it closes to shows what's there now; the editor sees neither.
		if (editing !== undefined && read.status === "error") this.#missed = true;
		else {
			this.#missed = false;
			this.#set({ ...this.#state, read });
		}
		if (this.#editOnRead && read.status === "ready") {
			this.#editOnRead = false;
			this.#open(read.value.template);
		}
		this.#schedule();
	}

	/** Sets the next read's timer: while a build runs, no read is on its way and the editor is closed. */
	#schedule(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const { read, editing } = this.#state;
		if (!this.#live || this.#inFlight || editing !== undefined || read.status !== "ready") return;
		const wait = buildPollMs([read.value.template], this.#options.pollMs, read.value.snapshots);
		if (wait !== undefined) this.#timer = setTimeout(this.reload, wait);
	}

	#set(state: TemplateViewState): void {
		this.#state = state;
		for (const listener of this.#listeners) listener();
	}
}

export interface NewTemplateState {
	/** New template's draft while its form is open. */
	readonly draft?: TemplateDraft;
	/** A create is on its way: until it answers the draft can't be changed and the form can't be closed. */
	readonly saving?: boolean;
}

/** New template's form: its draft, and a create that closes it only once it's made. */
export class NewTemplateView {
	readonly #source: TemplatesSource;
	readonly #accountId: string;
	#state: NewTemplateState;
	readonly #listeners = new Set<() => void>();

	constructor(options: { readonly source: TemplatesSource; readonly accountId: string; readonly open?: boolean }) {
		this.#source = options.source;
		this.#accountId = options.accountId;
		this.#state = options.open === true ? { draft: templateDraft() } : {};
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	readonly state = (): NewTemplateState => this.#state;

	/** Opens the form on an empty draft. */
	readonly open = (): void => {
		if (this.#state.draft === undefined) this.#set({ draft: templateDraft() });
	};

	/** Changes the draft, unless a create is on its way. */
	readonly change = (update: (draft: TemplateDraft) => TemplateDraft): void => {
		const { draft, saving } = this.#state;
		if (draft === undefined || saving === true) return;
		this.#set({ draft: update(draft) });
	};

	/** Closes the form, dropping the draft; not while a create is on its way. */
	readonly cancel = (): void => {
		if (this.#state.saving !== true) this.#set({});
	};

	/** Makes the template. Made, the form closes; refused, it stays as it was before the create. */
	readonly save = async (): Promise<Template> => {
		const before = this.#state;
		const { draft } = before;
		if (draft === undefined) throw new Error("New template isn't open.");
		if (before.saving === true) throw new Error("The template is already being made.");
		this.#set({ draft, saving: true });
		let made: Template;
		try {
			made = await this.#source.create({ accountId: this.#accountId, ...templateEditorInput(draft, []) });
		} catch (error) {
			this.#set(before);
			throw error;
		}
		this.#set({});
		return made;
	};

	#set(state: NewTemplateState): void {
		this.#state = state;
		for (const listener of this.#listeners) listener();
	}
}
