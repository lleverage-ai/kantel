import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Sandbox, SandboxState, Template } from "./compute-model.ts";
import { createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";
import { outputUnavailable, sandboxTimeline } from "./sandbox-logs.tsx";
import { filesShown, type SandboxTab, sandboxViewShown } from "./sandbox-page.tsx";
import {
	newSandboxInput,
	newSandboxType,
	QUICK_SANDBOX,
	requestedTemplate,
	SandboxesPage,
	sandboxesShown,
	screenLink,
	showsCpu,
} from "./sandboxes-page.tsx";
import { SettingsFrame } from "./settings-nav.tsx";
import { sampleTemplates } from "./template-fixtures.ts";

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
	it("draws CPU while a sandbox runs or has just failed, isolates and new ones too, never for a stopped one", () => {
		expect(showsCpu({ state: "running" })).toBe(true);
		expect(showsCpu({ state: "stopping" })).toBe(true);
		expect(showsCpu({ state: "error" })).toBe(true);
		for (const state of ["stopped", "paused", "starting"] as const) expect(showsCpu({ state })).toBe(false);
	});

	it("makes New's sandbox with New sandbox's defaults: a medium microVM that stops after an hour", () => {
		expect(QUICK_SANDBOX).toEqual({ kind: "microvm", autoStopMinutes: 60 });
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

describe("New sandbox", () => {
	const python = sampleTemplates(FIXTURE_NOW).find((template) => template.id === "tpl_python") as Template;
	const form = {
		accountId: LLEVERAGE.id,
		name: "",
		kind: "microvm" as const,
		shape: { vcpus: 2, memoryMb: 4096 },
		shapeChosen: false,
		from: "",
		environment: "",
		autoStop: "60",
	};

	it("names no shape for a template's sandbox unless a slider moved, so the template's own applies", () => {
		const own = newSandboxInput({ ...form, template: python });
		expect(own).toEqual({ accountId: LLEVERAGE.id, kind: "microvm", templateId: "tpl_python", autoStopMinutes: 60 });
		expect("shape" in own).toBe(false);
		const moved = { vcpus: 4, memoryMb: 8192 };
		expect(newSandboxInput({ ...form, template: python, shape: moved, shapeChosen: true }).shape).toEqual(moved);
		// Without a template, and for an isolate, the shape the sliders show.
		expect(newSandboxInput(form).shape).toEqual({ vcpus: 2, memoryMb: 4096 });
		expect(newSandboxInput({ ...form, kind: "isolate", shape: { vcpus: 0, memoryMb: 256 }, template: python })).toEqual(
			{
				accountId: LLEVERAGE.id,
				kind: "isolate",
				shape: { vcpus: 0, memoryMb: 256 },
				autoStopMinutes: 60,
			},
		);
	});

	it("keeps a requested template until the list is read, and says so when it can't be had", () => {
		const microvm = newSandboxType(undefined, true);
		expect(requestedTemplate("tpl_python", { status: "loading" }, microvm)).toEqual({ pending: true });
		expect(requestedTemplate("tpl_python", { status: "ready", value: [python] }, microvm)).toEqual({
			template: python,
			pending: false,
		});
		expect(requestedTemplate("tpl_python", { status: "failed" }, microvm).problem).toMatch(
			/couldn't read the templates/,
		);
		expect(requestedTemplate("tpl_gone", { status: "ready", value: [python] }, microvm).problem).toMatch(
			/isn't in this account/,
		);
		expect(requestedTemplate("", { status: "loading" }, microvm)).toEqual({ pending: false });
	});

	it("keeps a requested template, refused, when the hosts' answer says none runs microVMs", () => {
		const list = { status: "ready", value: [python] } as const;
		// Before the hosts answer, a microVM from the template, waiting for its list.
		const before = newSandboxType(undefined, true);
		expect(before).toEqual({ kind: "microvm", chosen: false });
		expect(requestedTemplate("tpl_python", { status: "loading" }, before)).toEqual({ pending: true });
		// The answer lands with no microVM host: an isolate is picked, but the template isn't dropped for it.
		const after = newSandboxType(undefined, false);
		expect(after).toEqual({ kind: "isolate", chosen: false });
		for (const read of [{ status: "loading" } as const, list]) {
			const requested = requestedTemplate("tpl_python", read, after);
			expect(requested.pending).toBe(false);
			expect(requested.template).toBeUndefined();
			expect(requested.problem).toMatch(/none of this organisation's hosts run them\. Pick None or choose Isolate/);
		}
		// A clean isolate takes the user's own choice: None, or Isolate chosen.
		expect(requestedTemplate("", list, after)).toEqual({ pending: false });
		expect(requestedTemplate("tpl_python", list, newSandboxType("isolate", false))).toEqual({ pending: false });
		expect(requestedTemplate("tpl_python", list, newSandboxType("isolate", true))).toEqual({ pending: false });
		// A microVM chosen before the answer can't be made once it says there are none.
		expect(newSandboxType("microvm", false)).toEqual({ kind: "isolate", chosen: false });
	});

	it("opens from a template's page with it picked, and waits for the list rather than dropping it", () => {
		const markup = renderToStaticMarkup(
			createElement(SandboxesPage, {
				source: createComputeFixtures().sandboxes,
				account: LLEVERAGE,
				hosting: "self-hosted",
				templates: () => new Promise<readonly Template[]>(() => {}),
				template: "tpl_python",
				creating: true,
				now: FIXTURE_NOW,
			}),
		);
		expect(markup).toMatch(/<option value="tpl_python" selected="">tpl_python<\/option>/);
		expect(markup).toContain("Reading the templates.");
		expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*aria-busy="true"/);
	});
});
