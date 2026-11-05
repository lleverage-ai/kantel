import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DAY, HOUR, MINUTE } from "../primitives/format.ts";
import { idleStopText, type Sandbox, type SandboxState, stoppedByText, type Template } from "./compute-model.ts";
import { createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";
import { IDLE_STOP_CHOICES, idleStopChoices } from "./sandbox-actions.tsx";
import { filterCounts, NO_FILTERS, type SandboxFilters, TYPE_FILTERS } from "./sandbox-filters.ts";
import { outputUnavailable, sandboxTimeline } from "./sandbox-logs.tsx";
import { filesShown, type SandboxTab, sandboxViewShown } from "./sandbox-page.tsx";
import {
	countdownText,
	newSandboxInput,
	newSandboxType,
	QUICK_SANDBOX,
	requestedTemplate,
	SandboxesPage,
	sandboxesShown,
	screenLink,
	shortId,
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

	it("says when its idle stop comes while it runs, and that it stopped it once it has", () => {
		const running = { state: "running" as const, idleStopMinutes: 30, idleStopsAt: FIXTURE_NOW + 24 * MINUTE };
		expect(idleStopText(running, FIXTURE_NOW)).toBe("Idle stop in 24m");
		expect(idleStopText(running, FIXTURE_NOW + HOUR)).toBe("Idle stop now");
		expect(idleStopText({ state: "running" }, FIXTURE_NOW)).toBeUndefined();
		expect(idleStopText({ ...running, state: "stopped" }, FIXTURE_NOW)).toBeUndefined();
		expect(stoppedByText({ state: "stopped", stopReason: "idle-stop", idleStopMinutes: 30 })).toBe(
			"Stopped after 30m unused",
		);
		expect(stoppedByText({ state: "stopped", stopReason: "auto-stop" })).toBe("Stopped by its auto-stop");
		// Someone stopped it: nothing to say.
		expect(stoppedByText({ state: "stopped" })).toBeUndefined();
		expect(stoppedByText({ state: "running", stopReason: "idle-stop" })).toBeUndefined();
	});

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

	it("opens a row's Desktop in a tab where the console can't frame it, and leaves its link's new tab elsewhere", () => {
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
		const tabs: string[] = [];
		const openTab = (view: string) => tabs.push(view);

		const local = click();
		screenLink("tab", openTab)("desktop")(local);
		expect([local.prevented, tabs]).toEqual([true, ["desktop"]]);
		// Not a primary click: left to the browser.
		const middle = click(1);
		screenLink("tab", openTab)("browser")(middle);
		expect([middle.prevented, tabs]).toEqual([false, ["desktop"]]);

		// The console's screen page, in the new tab its link opens: the click is the browser's.
		for (const screens of ["console", undefined] as const) {
			const hosted = click();
			screenLink(screens, openTab)("desktop")(hosted);
			expect(hosted.prevented).toBe(false);
		}
		expect(tabs).toEqual(["desktop"]);
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
	it("reads usage live while a sandbox runs or has just failed, isolates and new ones too, never for a stopped one", () => {
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
		const shown = (state: SandboxFilters["state"], search: string) =>
			names(sandboxesShown(all, { ...NO_FILTERS, state, search }, 0));
		expect(shown("all", "")).toEqual(["api-server", "API-worker", "eval", "web"]);
		expect(shown("all", "  api ")).toEqual(["api-server", "API-worker"]);
		// Paused counts as stopped; a failed one only under Error.
		expect(shown("stopped", "")).toEqual(["API-worker", "web"]);
		expect(shown("error", "")).toEqual(["eval"]);
		expect(shown("running", "api")).toEqual(["api-server"]);
	});

	it("searches a sandbox's address and ID as well as its name", () => {
		const all = [
			{ ...box("api", "running"), id: "sbx_9f2k7d1q", hostname: "api.acme.kantel.dev" },
			{ ...box("web", "running"), id: "sbx_33aa", hostname: "web.acme.kantel.dev" },
		];
		const names = (search: string) => sandboxesShown(all, { ...NO_FILTERS, search }, 0).map((each) => each.name);
		expect(names("9F2K")).toEqual(["api"]);
		expect(names("acme.kantel")).toEqual(["api", "web"]);
		expect(names("web.acme")).toEqual(["web"]);
	});

	it("filters by the latest snapshot's age and by type, and counts each option with the others as they are", () => {
		const now = 10 * DAY;
		const all: Sandbox[] = [
			{ ...box("fresh", "running"), snapshot: { id: "snp_1", takenAt: now - HOUR } },
			{ ...box("old", "stopped"), snapshot: { id: "snp_2", takenAt: now - 3 * DAY } },
			{ ...box("never", "running"), kind: "isolate" },
		];
		const names = (filters: Partial<SandboxFilters>) =>
			sandboxesShown(all, { ...NO_FILTERS, ...filters }, now).map((each) => each.name);
		expect(names({ snapshot: "day" })).toEqual(["fresh"]);
		expect(names({ snapshot: "older" })).toEqual(["old"]);
		expect(names({ snapshot: "none" })).toEqual(["never"]);
		expect(names({ type: "isolate" })).toEqual(["never"]);
		expect(names({ type: "microvm", state: "running" })).toEqual(["fresh"]);
		// A snapshot whose time the source doesn't say is in no age's filter, only Any's.
		const unknown = [...all, { ...box("undated", "stopped"), snapshot: { id: "snp_3" } }];
		const shown = (filters: Partial<SandboxFilters>) =>
			sandboxesShown(unknown, { ...NO_FILTERS, ...filters }, now).map((each) => each.name);
		expect(shown({ snapshot: "day" })).toEqual(["fresh"]);
		expect(shown({ snapshot: "older" })).toEqual(["old"]);
		expect(shown({ snapshot: "none" })).toEqual(["never"]);
		expect(shown({})).toContain("undated");
		const counts = filterCounts(all, { ...NO_FILTERS, state: "running" }, "type", TYPE_FILTERS, now);
		expect([...counts]).toEqual([
			["all", 2],
			["microvm", 1],
			["isolate", 1],
		]);
	});

	it("counts down to auto-stop in minutes, and in minutes and seconds for its last 10", () => {
		const running = { state: "running" as const };
		expect(countdownText({ ...running, stopsAt: 52 * MINUTE }, 0)).toBe("52m");
		expect(countdownText({ ...running, stopsAt: 4 * MINUTE + 7_000 }, 0)).toBe("4:07");
		expect(countdownText({ ...running, stopsAt: 59_500 }, 0)).toBe("1:00");
		expect(countdownText(running, 0)).toBe("Always on");
		expect(countdownText({ state: "stopped", stopsAt: 5 * MINUTE }, 0)).toBe("–");
	});

	it("shortens a long ID to its start and end, and leaves a short one whole", () => {
		expect(shortId("sbx_9f2k7d1qzz4m")).toBe("sbx_9f2k…zz4m");
		expect(shortId("sbx_33aa")).toBe("sbx_33aa");
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

	it("keeps a sandbox's own idle stop in its dialog when no preset matches it, so an untouched Save keeps it", () => {
		// Below, between and above the presets, as the CLI or API may set them.
		for (const [minutes, label] of [
			[1, "1 minute"],
			[45, "45 minutes"],
			[120, "2 hours"],
			[1440, "1 day"],
			[43_200, "30 days"],
		] as const) {
			const { options, choice } = idleStopChoices(minutes);
			// Saving the first choice sends its own minutes, unchanged.
			expect(Number(choice)).toBe(minutes);
			expect(options).toContainEqual({ value: String(minutes), label });
			// The presets and Never are still there to pick, in order, Never first.
			for (const preset of IDLE_STOP_CHOICES) expect(options).toContainEqual(preset);
			expect(options[0]?.value).toBe("never");
			const values = options.slice(1).map((option) => Number(option.value));
			expect(values).toEqual([...values].sort((a, b) => a - b));
		}
		// A preset or none: the presets alone.
		expect(idleStopChoices(30)).toEqual({ options: IDLE_STOP_CHOICES, choice: "30" });
		expect(idleStopChoices(undefined)).toEqual({ options: IDLE_STOP_CHOICES, choice: "never" });
	});

	it("sends an idle stop only when one is chosen", () => {
		expect(newSandboxInput({ ...form, idleStop: "30" }).idleStopMinutes).toBe(30);
		expect("idleStopMinutes" in newSandboxInput({ ...form, idleStop: "never" })).toBe(false);
		expect("idleStopMinutes" in newSandboxInput(form)).toBe(false);
		// Beside auto-stop, which stays as chosen.
		expect(newSandboxInput({ ...form, autoStop: "never", idleStop: "15" })).toMatchObject({ idleStopMinutes: 15 });
		expect("autoStopMinutes" in newSandboxInput({ ...form, autoStop: "never", idleStop: "15" })).toBe(false);
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
