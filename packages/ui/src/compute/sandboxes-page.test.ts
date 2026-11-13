import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DAY, HOUR, MINUTE } from "../primitives/format.ts";
import {
	HOST_CHECK_POLL_MS,
	HOST_UNREACHABLE_LABEL,
	type HostChoice,
	idleStopText,
	type Pool,
	type Sandbox,
	type SandboxState,
	sandboxActions,
	sandboxesPollMs,
	sandboxMachineText,
	stoppedByText,
	type Template,
} from "./compute-model.ts";
import { API_SERVER, createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";
import { SandboxStateLabel } from "./parts.tsx";
import { canRestartOnLatest, canSaveSnapshot, IDLE_STOP_CHOICES, idleStopChoices } from "./sandbox-actions.tsx";
import {
	creatorFilters,
	creatorText,
	filterCounts,
	filtered,
	NO_FILTERS,
	type SandboxFilters,
	TYPE_FILTERS,
} from "./sandbox-filters.ts";
import { sandboxTimeline } from "./sandbox-logs.tsx";
import { filesShown, type SandboxTab, sandboxViewShown } from "./sandbox-page.tsx";
import {
	countdownText,
	hostOptions,
	hostProblem,
	hostsInPool,
	newSandboxInput,
	newSandboxType,
	poolChoices,
	poolSent,
	QUICK_SANDBOX,
	requestedTemplate,
	SandboxesPage,
	sandboxesShown,
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
			environments: [{ id: "e", name: "dev" }],
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
			"Created",
		]);
	});

	it("names the sandbox a fork came from, and not its environments, which change after it's made", () => {
		const made = (sandbox: Pick<Sandbox, "environments" | "forkedFrom">) => {
			const [entry] = sandboxTimeline({ ...box("api", "running"), ...sandbox }, [], []);
			return entry?.kind === "event" ? entry.text : undefined;
		};
		const dev = [{ id: "e", name: "dev" }];
		expect(made({ environments: dev, forkedFrom: "sbx_parent" })).toBe("Forked from sbx_parent");
		expect(made({ forkedFrom: "sbx_parent" })).toBe("Forked from sbx_parent");
		expect(made({ environments: dev })).toBe("Created");
		expect(made({})).toBe("Created");
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

	it("shows Browser and Desktop in the console, and Overview where it has none to show", () => {
		const running = { windows: true, known: true, tabs };
		for (const screen of ["desktop", "watch", "browser"] as const) {
			expect(sandboxViewShown(screen, running)).toBe(screen);
			// Nothing to show once it's known to have none.
			expect(sandboxViewShown(screen, { ...running, windows: false })).toBe("overview");
			expect(sandboxViewShown(screen, { ...running, windows: false, known: false })).toBe(screen);
		}
		expect(sandboxViewShown("logs", running)).toBe("logs");
		expect(sandboxViewShown("egress", running)).toBe("overview");
	});

	it("reads a running sandbox's files from its host, and a stopped one's from its latest snapshot", () => {
		const source = {
			files: {
				list: async () => ({ entries: [], more: false }),
				read: async () => ({ bytes: new Uint8Array(), size: 0 }),
			},
		};
		const running = { state: "running" as const };
		const snapshot = { id: "snap_1", takenAt: 0 };
		const stopped = { ...running, state: "stopped" as const, snapshot };
		expect(filesShown(running, source)).toBe("live");
		expect(filesShown(stopped, source)).toBe("snapshot");
		expect(filesShown({ ...running, state: "stopped" }, source)).toBe("none");
		expect(filesShown(running, {})).toBe("none");
		// One whose guest agent doesn't answer shows its snapshot's, as a stopped one does.
		expect(filesShown({ ...stopped, state: "running", unresponsive: "It is out of memory" }, source)).toBe("snapshot");
		// So does one whose host isn't connected.
		expect(filesShown({ ...stopped, state: "running", hostUnreachable: true }, source)).toBe("snapshot");
	});
});

describe("a sandbox whose host isn't connected", () => {
	const label = (sandbox: Pick<Sandbox, "state" | "unresponsive" | "hostUnreachable">) =>
		renderToStaticMarkup(createElement(SandboxStateLabel, { sandbox })).replace(/<[^>]+>/g, "");

	it("shows Host unreachable in place of a state its host could have changed, and keeps stopped and error", () => {
		for (const state of ["starting", "running", "stopping", "paused"] as const) {
			expect(label({ state, hostUnreachable: true })).toBe(HOST_UNREACHABLE_LABEL);
		}
		expect(label({ state: "stopped", hostUnreachable: true })).toBe("Stopped");
		expect(label({ state: "error", hostUnreachable: true })).toBe("Error");
		// Its host being away says more than its guest agent not answering, which can't be known now.
		expect(label({ state: "running", hostUnreachable: true, unresponsive: "It is out of memory" })).toBe(
			HOST_UNREACHABLE_LABEL,
		);
		expect(label({ state: "running" })).toBe("Running");
	});

	it("offers only Stop: connecting, forking, resuming and recovering all need its host", () => {
		expect(sandboxActions("running", false, true)).toEqual({
			connect: false,
			stop: true,
			resume: false,
			fork: false,
			recover: false,
		});
		expect(sandboxActions("paused", false, true)).toMatchObject({ stop: true, resume: false });
		expect(sandboxActions("stopped", false, true)).toMatchObject({ stop: false, resume: false, fork: false });
		expect(sandboxActions("error", false, true)).toMatchObject({ resume: false, recover: false });
		expect(sandboxActions("running")).toMatchObject({ connect: true, fork: true });
	});

	it("offers no Save snapshot or Restart on latest base, which need the host that holds its disk", () => {
		// On a base six days behind.
		const { base } = API_SERVER;
		const snapshot = { id: "snap_1", takenAt: 0 };
		expect(canSaveSnapshot({ snapshot })).toBe(true);
		expect(canSaveSnapshot({ snapshot, hostUnreachable: true })).toBe(false);
		expect(canRestartOnLatest({ state: "running", base })).toBe(true);
		expect(canRestartOnLatest({ state: "running", base, hostUnreachable: true })).toBe(false);
		expect(canRestartOnLatest({ state: "stopped", base, hostUnreachable: true })).toBe(false);
	});

	it("is read again every 15 seconds, as is any running one, so a missed word of its host is put right", () => {
		expect(sandboxesPollMs([{ state: "running" }], 1_000)).toBe(HOST_CHECK_POLL_MS);
		expect(sandboxesPollMs([{ state: "stopped", hostUnreachable: true }], 1_000)).toBe(HOST_CHECK_POLL_MS);
		expect(sandboxesPollMs([{ state: "stopped" }, { state: "error" }], 1_000)).toBeUndefined();
		// Anything between states is read sooner, frozen or not.
		expect(sandboxesPollMs([{ state: "running" }, { state: "starting" }], 1_000)).toBe(1_000);
		expect(sandboxesPollMs([{ state: "starting" }], 1_000, true)).toBe(1_000);
		// A story's page, frozen at one time, isn't read again for its host.
		expect(sandboxesPollMs([{ state: "running", hostUnreachable: true }], 1_000, true)).toBeUndefined();
		expect(HOST_CHECK_POLL_MS).toBe(15_000);
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

	it("filters by who made it, offering You first, and says You for the viewer's and names an API key", () => {
		const made = (name: string, kind: "user" | "api_key", id: string, by: string): Sandbox => ({
			...box(name, "running"),
			createdBy: by,
			creator: { kind, id },
		});
		const all = [
			made("mine", "user", "usr_me", "Tom Davies"),
			made("theirs", "user", "usr_ada", "Ada Lovelace"),
			made("ci", "api_key", "key_ci", "ci-runner"),
			made("also-mine", "user", "usr_me", "Tom Davies"),
		];
		const names = (creator: string) => sandboxesShown(all, { ...NO_FILTERS, creator }, 0).map((each) => each.name);
		expect(names("all")).toEqual(["mine", "theirs", "ci", "also-mine"]);
		expect(names("usr_me")).toEqual(["mine", "also-mine"]);
		expect(names("key_ci")).toEqual(["ci"]);
		expect(filtered({ ...NO_FILTERS, creator: "usr_me" })).toBe(true);
		// A story's filters from before Created by leave it out: anyone.
		const { creator: _, ...older } = NO_FILTERS;
		expect(filtered(older)).toBe(false);
		expect(sandboxesShown(all, older, 0)).toHaveLength(4);

		expect(creatorText(all[0] as Sandbox, "usr_me")).toBe("You");
		expect(creatorText(all[1] as Sandbox, "usr_me")).toBe("Ada Lovelace");
		expect(creatorText(all[2] as Sandbox, "usr_me")).toBe("ci-runner (API key)");
		// Without the viewer, a person's own are named like anyone's.
		expect(creatorText(all[0] as Sandbox, undefined)).toBe("Tom Davies");

		const options = creatorFilters(all, "usr_me");
		expect(options).toEqual([
			{ value: "all", label: "Anyone" },
			{ value: "usr_me", label: "You" },
			{ value: "usr_ada", label: "Ada Lovelace" },
			{ value: "key_ci", label: "ci-runner (API key)" },
		]);
		expect([...filterCounts(all, NO_FILTERS, "creator", options, 0)]).toEqual([
			["all", 4],
			["usr_me", 2],
			["usr_ada", 1],
			["key_ci", 1],
		]);
		// You stays an option where the viewer made none, so it can say none are theirs.
		expect(creatorFilters([all[1] as Sandbox], "usr_me").map((option) => option.label)).toEqual([
			"Anyone",
			"You",
			"Ada Lovelace",
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

	it("lists a starting sandbox as the machine it asked for, never the sample small's 2 vCPU and 4 GB", () => {
		const { size: _, ...unnamed } = box("dev", "starting");
		// A custom 4 vCPU, 16 GB microVM while it starts: no size names it, and its host hasn't said.
		const custom: Sandbox = { ...unnamed, shape: { vcpus: 4, memoryGb: 16 } };
		expect(sandboxMachineText(custom)).toBe("MicroVM, 4 vCPU, 16 GB");
		// A fork of it while it starts: its source's machine, recorded from the moment it was made.
		const fork: Sandbox = {
			...custom,
			id: "sbx_fork",
			forkedFrom: custom.id,
			resources: { vcpus: 4, memoryGb: 16, diskGb: 50 },
		};
		expect(sandboxMachineText(fork)).toBe("MicroVM, 4 vCPU, 16 GB");
		// Nothing known yet (a named size its host hasn't placed): unknown, not a size's sample figures.
		expect(sandboxMachineText(box("named", "starting"))).toBe("MicroVM, –");
		for (const each of [custom, fork, box("named", "starting"), unnamed]) {
			expect(sandboxMachineText(each)).not.toContain("2 vCPU, 4 GB");
		}
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
		environments: [],
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

	it("sends the environments picked, in the order picked, and none without any", () => {
		expect(newSandboxInput({ ...form, environments: ["env_b", "env_a"] }).environmentIds).toEqual(["env_b", "env_a"]);
		expect("environmentIds" in newSandboxInput(form)).toBe(false);
	});

	it("puts it on the host picked, and leaves Kantel to pick without one", () => {
		expect(newSandboxInput({ ...form, host: "hst_home" }).hostId).toBe("hst_home");
		expect("hostId" in newSandboxInput({ ...form, host: "" })).toBe(false);
		expect("hostId" in newSandboxInput(form)).toBe(false);
	});

	describe("in a pool", () => {
		const pool = (id: string, name: string, isDefault = false): Pool => ({
			id,
			name,
			default: isDefault,
			hosts: 1,
			createdAt: FIXTURE_NOW,
		});
		const pools = [pool("pool_default", "default", true), pool("pool_ci", "ci")];

		it("offers a picker only once the pools are read and there's more than one, so one pool changes nothing", () => {
			expect(poolChoices({ status: "ready", pools })).toEqual(pools);
			expect(poolChoices({ status: "ready", pools: [pools[0] as Pool] })).toBeUndefined();
			expect(poolChoices({ status: "ready", pools: [] })).toBeUndefined();
			expect(poolChoices({ status: "loading" })).toBeUndefined();
			expect(poolChoices({ status: "failed" })).toBeUndefined();
		});

		it("sends the pool picked, and none for the default, so a sandbox may still go on shared hosts", () => {
			expect(newSandboxInput({ ...form, pool: poolSent(pools, "pool_ci") }).poolId).toBe("pool_ci");
			expect("poolId" in newSandboxInput({ ...form, pool: poolSent(pools, "pool_default") })).toBe(false);
			expect("poolId" in newSandboxInput({ ...form, pool: poolSent(pools, "") })).toBe(false);
			// One the account no longer has, or with no picker (one pool, or pools not read): the default.
			expect(poolSent(pools, "pool_gone")).toBe("");
			expect(poolSent(undefined, "pool_ci")).toBe("");
			expect("poolId" in newSandboxInput(form)).toBe(false);
		});

		it("offers only the pool's hosts once one is picked, and every host for the default", () => {
			const hosts: HostChoice[] = [
				{ id: "hst_a", name: "box-a", state: "online", kinds: ["microvm"], shared: false, poolId: "pool_ci" },
				{ id: "hst_b", name: "box-b", state: "online", kinds: ["microvm"], shared: false, poolId: "pool_default" },
				{ id: "hst_c", name: "box-c", state: "online", kinds: ["microvm"], shared: true, poolId: "pool_shared" },
			];
			expect(hostsInPool(hosts, "pool_ci").map((host) => host.id)).toEqual(["hst_a"]);
			expect(hostsInPool(hosts, "")).toEqual(hosts);
			expect(hostsInPool(hosts, "pool_empty")).toEqual([]);
		});

		it("is placed in the pool picked, and refused naming it when none of its hosts can take it", async () => {
			const source = createComputeFixtures({ hostsAway: ["hst_hetzner_1"] });
			const made = await source.sandboxes.create({ accountId: LLEVERAGE.id, kind: "isolate", poolId: "pool_default" });
			expect(made.hostId).toBe("hst_home");
			await expect(
				source.sandboxes.create({ accountId: LLEVERAGE.id, kind: "microvm", poolId: "pool_ci" }),
			).rejects.toThrow("No host in pool ci can run a microvm sandbox now");
			// And its shapes say so: no microVMs in ci while its hosts are away.
			expect((await source.sandboxes.shapes?.(LLEVERAGE.id, undefined, "pool_ci"))?.microvm.available).toBe(false);
			expect((await source.sandboxes.shapes?.(LLEVERAGE.id))?.microvm.available).not.toBe(false);
		});
	});

	it("offers the hosts that can take the type now, and keeps a picked one that can't with why", () => {
		const hosts: HostChoice[] = [
			{ id: "hst_a", name: "box-a", state: "online", kinds: ["microvm", "isolate"], shared: false },
			{ id: "hst_b", name: "box-b", state: "draining", kinds: ["microvm", "isolate"], shared: false },
			{ id: "hst_c", name: "box-c", state: "online", kinds: ["isolate"], shared: true },
		];
		expect(hostOptions(hosts, "microvm", "")).toEqual([
			{ value: "", label: "Any host" },
			{ value: "hst_a", label: "box-a" },
		]);
		expect(hostOptions(hosts, "isolate", "").map((option) => option.label)).toEqual([
			"Any host",
			"box-a",
			"box-c (shared)",
		]);
		// Picked for an isolate, then the type changed: it stays, with why, and the create waits for another.
		expect(hostOptions(hosts, "microvm", "hst_c").at(-1)).toEqual({
			value: "hst_c",
			label: "box-c (shared): no microvms",
		});
		expect(hostProblem(hosts, "microvm", "hst_c")).toBe("box-c doesn't run microvms.");
		expect(hostProblem(hosts, "microvm", "hst_b")).toBe("box-b is draining, so it takes no new sandboxes.");
		expect(hostProblem(hosts, "microvm", "hst_gone")).toBe("That host is gone. Pick another.");
		expect(hostProblem(hosts, "microvm", "hst_a")).toBeUndefined();
		expect(hostProblem(hosts, "microvm", "")).toBeUndefined();
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

	it("names no shape from a saved snapshot that holds memory, which restores only into its own machine", () => {
		const fromMemory = newSandboxInput({ ...form, from: "ssn_dev_stack_warm", fromMemory: true });
		expect(fromMemory).toEqual({
			accountId: LLEVERAGE.id,
			kind: "microvm",
			fromSnapshot: "ssn_dev_stack_warm",
			autoStopMinutes: 60,
		});
		// A snapshot of the disk alone boots, so it takes the sliders' shape.
		expect(newSandboxInput({ ...form, from: "ssn_node22_base", fromMemory: false })).toMatchObject({
			fromSnapshot: "ssn_node22_base",
			shape: { vcpus: 2, memoryMb: 4096 },
		});
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
