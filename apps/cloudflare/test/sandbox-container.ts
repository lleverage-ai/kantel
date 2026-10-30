// A stand-in for one session's `HarbourSandbox` (src/sandbox-object.ts) and its container's agent
// (images/sandbox/agent/agent.ts), in memory: the same versions, syncs, `behind` answers, fences and ownership, with
// commands run by a function the test gives instead of a shell. `stop()` is an eviction: the working copy goes.
import type {
	Behind,
	ContainerCall,
	ContainerChanges,
	ContainerCommand,
	ContainerRan,
	ContainerStage,
	ContainerStaged,
	ContainerSync,
	ContainerWarmed,
	SandboxContainer,
	SandboxContainers,
} from "../src/container-backend.ts";

/** A working copy's file: base64 content and mode, as the sync carries them. */
interface File {
	readonly content: string;
	readonly mode: number;
}

/** What a command sees and changes: the working copy as text, by path. */
export type FakeRun = (
	command: string,
	files: Map<string, string>,
) => { readonly exitCode: number; readonly stdout?: string; readonly stderr?: string };

const decode = (content: string) => new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0)));
const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

export class FakeSandboxContainer implements SandboxContainer {
	running = false;
	used = false;
	/** The session closed (`closeSession`): nothing starts the container again. */
	closed = false;
	starts = 0;
	/** Containers `closeSession` stopped (destroyed) while running. */
	destroys = 0;
	/** Files received in syncs, staged batches included. */
	putsReceived = 0;
	stages = 0;
	execs: string[] = [];
	#version: number | null = null;
	/** The working copy as synced (what `#version` has), and as commands left it. */
	#base = new Map<string, File>();
	#files = new Map<string, File>();
	#owner: { leaseId: string; workspaceId: string } | undefined;
	readonly #fences = new Map<string, "closing" | "ended">();
	readonly #run: FakeRun;

	constructor(run: FakeRun) {
		this.#run = run;
	}

	get version(): number | null {
		return this.#version;
	}

	/** A file in the working copy, as text. */
	file(path: string): string | undefined {
		const file = this.#files.get(path);
		return file === undefined ? undefined : decode(file.content);
	}

	/** The container stops (inactivity, an eviction): what it held is gone. */
	stop(): void {
		this.running = false;
		this.#reset();
	}

	async exec(call: ContainerCall & { readonly request: ContainerCommand }): Promise<ContainerRan> {
		this.#checkClosed();
		this.#checkFence(call.leaseId);
		const timings = this.#claim(call.leaseId, call.workspaceId);
		this.used = true;
		if (!this.#apply(call.sync)) return this.#behind();
		const command = typeof call.request.command === "string" ? call.request.command : call.request.command.join(" ");
		this.execs.push(command);
		const text = new Map([...this.#files].map(([path, file]) => [path, decode(file.content)]));
		const result = this.#run(command, text);
		for (const path of this.#files.keys()) if (!text.has(path)) this.#files.delete(path);
		for (const [path, content] of text) {
			const before = this.#files.get(path);
			if (before === undefined || decode(before.content) !== content) {
				this.#files.set(path, { content: encode(content), mode: before?.mode ?? 0o644 });
			}
		}
		return {
			kind: "ran",
			exitCode: result.exitCode,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			timings,
		};
	}

	async changes(call: ContainerCall & { readonly final?: boolean }): Promise<ContainerChanges> {
		if (call.final === true && !this.#fences.has(call.leaseId)) this.#fences.set(call.leaseId, "closing");
		if (this.#owner?.leaseId !== call.leaseId || !this.running) {
			return { kind: "changes", put: [], remove: [], stamp: 0 };
		}
		if (!this.#apply(call.sync)) return this.#behind();
		const put = [...this.#files]
			.filter(([path]) => this.#dirty(path))
			.map(([path, file]) => ({ path, mode: file.mode, content: file.content }));
		const remove = [...this.#base.keys()].filter((path) => !this.#files.has(path));
		return { kind: "changes", put, remove, stamp: 1 };
	}

	async ack(args: { readonly leaseId: string; readonly version: number; readonly stamp: number }): Promise<void> {
		if (this.#owner?.leaseId !== args.leaseId || !this.running) return;
		this.#base = new Map(this.#files);
		this.#version = args.version;
	}

	async ended(args: { readonly leaseId: string; readonly discard: boolean }): Promise<void> {
		this.#fences.set(args.leaseId, "ended");
		if (this.#owner?.leaseId !== args.leaseId) return;
		// An expired lease's container stops, as the object destroys it.
		if (args.discard && this.running) this.stop();
		this.#owner = { ...this.#owner, leaseId: "" };
	}

	async warm(args: {
		readonly sessionId: string;
		readonly workspaceId: string;
		readonly head: number;
		readonly sync?: ContainerSync;
		readonly force?: boolean;
	}): Promise<ContainerWarmed> {
		if (this.closed || (args.force !== true && !this.used)) return { kind: "warmed", state: "skipped", timings: {} };
		const wasRunning = this.running;
		const timings = this.#claim(this.#owner?.leaseId ?? "", args.workspaceId);
		const state = wasRunning ? "running" : "started";
		if (args.sync === undefined) {
			if (this.#version === args.head) return { kind: "warmed", state, timings };
			return { kind: "behind", have: this.#version, started: !wasRunning, timings };
		}
		if (!this.#apply(args.sync)) return this.#behind();
		return { kind: "warmed", state, timings };
	}

	async stage(call: ContainerStage): Promise<ContainerStaged> {
		if (call.start) {
			this.#checkClosed();
			if (call.leaseId !== undefined) this.#checkFence(call.leaseId);
			this.#claim(call.leaseId ?? this.#owner?.leaseId ?? "", call.workspaceId);
		} else if (!this.running || this.#owner?.leaseId !== call.leaseId) {
			return { kind: "staged" };
		}
		this.stages += 1;
		if (!this.#apply({ ...call.sync, partial: true })) return this.#behind();
		return { kind: "staged" };
	}

	async closeSession(): Promise<{ readonly stopped: boolean }> {
		const running = this.running;
		if (!running && !this.used) return { stopped: false };
		this.closed = true;
		if (this.#owner !== undefined && this.#owner.leaseId !== "") {
			this.#fences.set(this.#owner.leaseId, "ended");
			this.#owner = { ...this.#owner, leaseId: "" };
		}
		if (running) {
			this.destroys += 1;
			this.stop();
		}
		return { stopped: running };
	}

	#checkClosed(): void {
		if (this.closed) throw new Error("the session has closed");
	}

	#checkFence(leaseId: string): void {
		const fence = this.#fences.get(leaseId);
		if (fence !== undefined)
			throw new Error(`lease ${leaseId} ${fence === "closing" ? "is being released" : "has ended"}`);
	}

	#claim(leaseId: string, workspaceId: string): Record<string, number> {
		if (!this.running) {
			this.running = true;
			this.starts += 1;
			this.#reset();
			this.#owner = { leaseId, workspaceId };
			return { "container.start": 1 };
		}
		if (this.#owner === undefined || this.#owner.workspaceId !== workspaceId) this.#reset();
		this.#owner = { leaseId, workspaceId };
		return {};
	}

	#reset(): void {
		this.#version = null;
		this.#base.clear();
		this.#files.clear();
	}

	#dirty(path: string): boolean {
		const base = this.#base.get(path);
		const file = this.#files.get(path);
		return base?.content !== file?.content || base?.mode !== file?.mode;
	}

	#apply(sync: ContainerSync & { readonly partial?: boolean }): boolean {
		if (sync.from !== this.#version) return false;
		for (const path of sync.remove) {
			if (this.#dirty(path)) continue;
			this.#base.delete(path);
			this.#files.delete(path);
		}
		for (const file of sync.put) {
			this.putsReceived += 1;
			if (this.#dirty(file.path)) continue;
			this.#base.set(file.path, { content: file.content, mode: file.mode });
			this.#files.set(file.path, { content: file.content, mode: file.mode });
		}
		if (sync.partial !== true) this.#version = sync.to;
		return true;
	}

	#behind(): Behind {
		return { kind: "behind", have: this.#version };
	}
}

/** One fake container per session, made on first use. */
export function fakeSandboxContainers(run: FakeRun): {
	readonly containers: SandboxContainers;
	readonly of: (sessionId: string) => FakeSandboxContainer;
} {
	const all = new Map<string, FakeSandboxContainer>();
	const of = (sessionId: string) => {
		let found = all.get(sessionId);
		if (found === undefined) {
			found = new FakeSandboxContainer(run);
			all.set(sessionId, found);
		}
		return found;
	};
	return { containers: of, of };
}

/**
 * A few programs for the tests: `make` writes `build/out.txt` from `src/in.txt`, `uname` prints `Linux`, `cat` prints
 * a file, and anything else is `command not found`. Commands split on `&&`.
 */
export const fakePrograms: FakeRun = (command, files) => {
	let stdout = "";
	for (const part of command.split("&&").map((each) => each.trim())) {
		const [program, ...args] = part.split(/\s+/);
		if (program === "make") files.set("build/out.txt", `built: ${files.get("src/in.txt") ?? ""}`);
		else if (program === "uname") stdout += "Linux\n";
		else if (program === "cat") {
			const content = files.get(args[0] ?? "");
			if (content === undefined) return { exitCode: 1, stdout, stderr: `cat: ${args[0]}: No such file\n` };
			stdout += content;
		} else return { exitCode: 127, stdout, stderr: `${program}: command not found\n` };
	}
	return { exitCode: 0, stdout };
};
