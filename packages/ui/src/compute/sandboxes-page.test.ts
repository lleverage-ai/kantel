import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Sandbox, SandboxState } from "./compute-model.ts";
import { outputUnavailable, sandboxTimeline } from "./sandbox-logs.tsx";
import { filesShown, type SandboxTab, sandboxViewShown } from "./sandbox-page.tsx";
import { QUICK_SANDBOX, sandboxesShown, screenLink, showsCpu } from "./sandboxes-page.tsx";
import { SettingsFrame } from "./settings-nav.tsx";

const box = (name: string, state: SandboxState): Sandbox => ({
	id: `sbx_${name}`,
	name,
	hostname: "",
	accountId: "org_test",
	kind: "microvm",
	size: "medium",
	state,
	createdAt: 0,
	createdBy: "",
	usage: [],
});

describe("a sandbox's logs", () => {
	it("puts its commands, its making and its snapshots in one timeline, newest first", () => {
		const sandbox = {
			...box("api", "running"),
			createdAt: 100,
			createdBy: "Ada",
			environment: { id: "e", name: "dev" },
		};
		const timeline = sandboxTimeline(
			sandbox,
			[
				{ id: "cmd_a", command: "ls", startedAt: 300, by: "Ada" },
				{ id: "cmd_b", command: "make", startedAt: 500, exitCode: 2, by: "", output: "error" },
			],
			[
				{ id: "snap_1", sandboxId: sandbox.id, takenAt: 200, reason: "periodic", sizeBytes: 0, expiresAt: 0 },
				{ id: "snap_2", sandboxId: sandbox.id, takenAt: 400, reason: "stop", sizeBytes: 0, expiresAt: 0 },
			],
		);
		expect(timeline.map((entry) => (entry.kind === "command" ? entry.command.command : entry.text))).toEqual([
			"make",
			"Stopped, snapshot taken",
			"ls",
			"Snapshot taken",
			"Started from dev",
		]);
	});

	it("names the sandbox a fork came from, even with the environment it inherited", () => {
		const made = (sandbox: Pick<Sandbox, "environment" | "forkedFrom">) => {
			const [entry] = sandboxTimeline({ ...box("api", "running"), ...sandbox }, [], []);
			return entry?.kind === "event" ? entry.text : undefined;
		};
		const dev = { id: "e", name: "dev" };
		expect(made({ environment: dev, forkedFrom: "sbx_parent" })).toBe("Forked from sbx_parent");
		expect(made({ forkedFrom: "sbx_parent" })).toBe("Forked from sbx_parent");
		expect(made({ environment: dev })).toBe("Started from dev");
		expect(made({})).toBe("Created");
	});

	it("says a failed command's output isn't available only for an end-to-end sandbox's failure with none", () => {
		const failedBare = { id: "c1", command: "make", startedAt: 1, exitCode: 2, by: "" };
		const entries = (command: typeof failedBare & { output?: string }) =>
			sandboxTimeline(box("api", "running"), [command], []);
		expect(outputUnavailable(entries(failedBare), true)).toBe(true);
		// The hosted console reads output, and says nothing.
		expect(outputUnavailable(entries(failedBare), false)).toBe(false);
		expect(outputUnavailable(entries({ ...failedBare, output: "error" }), true)).toBe(false);
		expect(outputUnavailable(entries({ ...failedBare, exitCode: 0 }), true)).toBe(false);
	});
});

describe("a sandbox's page", () => {
	const tabs: readonly SandboxTab[] = ["overview", "logs", "snapshots", "files"];

	it("shows Browser and Desktop in the console, and on Overview where they open in a tab of their own", () => {
		const running = { inTab: false, windows: true, known: true, tabs };
		for (const screen of ["desktop", "watch", "browser"] as const) {
			expect(sandboxViewShown(screen, running)).toBe(screen);
			// kantel console can't frame them: an address for one shows Overview, and they open in a tab.
			expect(sandboxViewShown(screen, { ...running, inTab: true })).toBe("overview");
			// Nothing to show once it's known to have none.
			expect(sandboxViewShown(screen, { ...running, windows: false })).toBe("overview");
			expect(sandboxViewShown(screen, { ...running, windows: false, known: false })).toBe(screen);
		}
		expect(sandboxViewShown("logs", running)).toBe("logs");
		expect(sandboxViewShown("egress", running)).toBe("overview");
	});

	it("opens a row's Browser and Desktop in a tab where the console can't frame them, and on its page elsewhere", () => {
		const click = (button = 0) => {
			const event = {
				button,
				metaKey: false,
				ctrlKey: false,
				shiftKey: false,
				prevented: false,
				preventDefault() {
					event.prevented = true;
				},
				currentTarget: { getAttribute: () => "/sandboxes/sbx_a/desktop" },
			};
			return event;
		};
		const went: string[] = [];
		const tabs: string[] = [];
		const navigate = (path: string) => went.push(path);
		const openTab = (view: string) => tabs.push(view);

		const local = click();
		screenLink("tab", navigate, openTab)("desktop")(local);
		expect([local.prevented, tabs, went]).toEqual([true, ["desktop"], []]);
		// Not a primary click: left to the browser.
		const middle = click(1);
		screenLink("tab", navigate, openTab)("browser")(middle);
		expect([middle.prevented, tabs]).toEqual([false, ["desktop"]]);

		for (const screens of ["console", undefined] as const) {
			const hosted = click();
			screenLink(screens, navigate, openTab)("desktop")(hosted);
			expect(hosted.prevented).toBe(true);
		}
		expect([went, tabs]).toEqual([["/sandboxes/sbx_a/desktop", "/sandboxes/sbx_a/desktop"], ["desktop"]]);
	});

	it("reads a running sandbox's files (over E2E where it is), and no snapshot of an end-to-end one", () => {
		const source = {
			files: {
				list: async () => ({ entries: [], more: false }),
				read: async () => ({ bytes: new Uint8Array(), size: 0 }),
			},
		};
		const running = { state: "running" as const };
		const snapshot = { id: "snap_1", takenAt: 0 };
		const yes = { status: "ready", value: true } as const;
		const no = { status: "ready", value: false } as const;
		const stopped = { ...running, state: "stopped" as const, snapshot };
		// Running, its files from the host; the source reads them over the space's E2E session where it has one.
		expect(filesShown(running, source, no)).toBe("live");
		expect(filesShown(running, source, yes)).toBe("live");
		expect(filesShown(running, source, { status: "loading" })).toBe("live");
		// Stopped, its latest snapshot, but only once it's known it isn't end to end: the host serves those to no one.
		expect(filesShown(stopped, source, no)).toBe("snapshot");
		expect(filesShown(stopped, source, { status: "loading" })).toBe("checking");
		expect(filesShown(stopped, source, { status: "error", error: new Error("no chain") })).toBe("unchecked");
		expect(filesShown(stopped, source, yes)).toBe("sealed");
		expect(filesShown({ ...running, state: "stopped" }, source, no)).toBe("none");
		expect(filesShown(running, {}, no)).toBe("none");
	});
});

describe("the sandboxes list", () => {
	const samples = [0.1, 0.4, 0.2];

	it("draws CPU only while a sandbox runs or has just failed, never a flat line for a stopped one", () => {
		expect(showsCpu({ state: "running", usage: samples })).toBe(true);
		expect(showsCpu({ state: "stopping", usage: samples })).toBe(true);
		expect(showsCpu({ state: "error", usage: samples })).toBe(true);
		for (const state of ["stopped", "paused", "starting"] as const)
			expect(showsCpu({ state, usage: samples })).toBe(false);
		// Nothing to draw yet.
		expect(showsCpu({ state: "running", usage: [] })).toBe(false);
		expect(showsCpu({ state: "running", usage: [0.3] })).toBe(false);
	});

	it("makes New's sandbox with New sandbox's defaults: a medium microVM that stops after an hour", () => {
		expect(QUICK_SANDBOX).toEqual({ kind: "microvm", size: "medium", autoStopMinutes: 60 });
	});

	it("filters by state and by a trimmed, case-blind search, and shows everything with no search", () => {
		const all = [
			box("api-server", "running"),
			box("API-worker", "paused"),
			box("eval", "error"),
			box("web", "stopped"),
		];
		const names = (list: readonly Sandbox[]) => list.map((each) => each.name);
		expect(names(sandboxesShown(all, "all", ""))).toEqual(["api-server", "API-worker", "eval", "web"]);
		expect(names(sandboxesShown(all, "all", "  api "))).toEqual(["api-server", "API-worker"]);
		// Paused counts as stopped; a failed one only under Error.
		expect(names(sandboxesShown(all, "stopped", ""))).toEqual(["API-worker", "web"]);
		expect(names(sandboxesShown(all, "error", ""))).toEqual(["eval"]);
		expect(names(sandboxesShown(all, "running", "api"))).toEqual(["api-server"]);
	});
});

describe("Settings' navigation", () => {
	// Crossing the phone breakpoint must not remount the settings page (losing a draft or a new key's secret), so the
	// page sits in the same elements in both layouts and only their classes change.
	it("keeps the page in the same elements on a phone and a wide screen", () => {
		const items = [{ id: "keys", label: "API keys", href: "#keys", selected: true }];
		const skeleton = (narrow: boolean) =>
			renderToStaticMarkup(
				// It has no hooks, so it can be called as it is.
				SettingsFrame({ items, narrow, children: createElement("form", { id: "page" }, "The page") }),
			).replace(/ class="[^"]*"/g, "");
		expect(skeleton(true)).toBe(skeleton(false));
		expect(skeleton(true)).toContain('<form id="page">');
	});
});
