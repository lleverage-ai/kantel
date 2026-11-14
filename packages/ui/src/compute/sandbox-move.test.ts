import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	canMove,
	movePhaseText,
	SANDBOX_STATE_LABELS,
	type Sandbox,
	sandboxActions,
	sandboxesPollMs,
} from "./compute-model.ts";
import { RENDER } from "./fixtures.ts";
import { stateBucket } from "./sandbox-filters.ts";
import { MoveDialog, moveProgressText } from "./sandbox-move.tsx";

const moving = (phase: string): Sandbox => ({
	...RENDER,
	state: "moving",
	move: { phase, hostId: "hst_hetzner_1", hostName: "hetzner-fsn1-01", keepMemory: false, startedAt: 0 },
});

const render = (sandbox: Sandbox) =>
	renderToStaticMarkup(
		createElement(MoveDialog, {
			sandbox,
			targets: async () => [],
			onClose: () => {},
			onMove: async () => {},
		}),
	);

describe("a move's phase", () => {
	it("words the phases Kantel has, and any later one as it names it", () => {
		expect(movePhaseText("copying")).toBe("Copying its disk");
		expect(movePhaseText("starting")).toBe("Starting it");
		expect(movePhaseText("stopping")).toBe("Stopping it for the last copy");
		expect(movePhaseText("final-copy")).toBe("Copying its last changes");
		expect(movePhaseText("verifying_checksums")).toBe("Verifying checksums");
		expect(movePhaseText("constructor")).toBe("Constructor");
		expect(movePhaseText("")).toBe("Moving");
	});

	it("says where to, where the host is known", () => {
		expect(moveProgressText("copying", "edge-2")).toBe("Copying its disk to edge-2");
		expect(moveProgressText("starting", "edge-2")).toBe("Starting it on edge-2");
		expect(moveProgressText("stopping", "edge-2")).toBe("Stopping it for the last copy");
		expect(moveProgressText("copying", undefined)).toBe("Copying its disk");
	});

	it("shows in the dialog of a moving sandbox, with Close, not Move", () => {
		const html = render(moving("final-copy"));
		expect(html).toContain("Copying its last changes");
		expect(html).toContain("hetzner-fsn1-01");
		expect(html).toContain('data-move-phase="final-copy"');
		expect(html).toContain("It keeps going if you close this.");
		expect(html).toContain(">Close<");
		expect(html).not.toContain(">Move<");
		expect(render(moving("rebalancing"))).toContain("Rebalancing");
	});
});

describe("moving", () => {
	it("is offered for a stopped or paused microVM on a host the viewer knows, connected", () => {
		expect(canMove(RENDER)).toBe(true);
		expect(canMove({ ...RENDER, state: "paused" })).toBe(true);
		expect(canMove({ ...RENDER, state: "running" })).toBe(false);
		expect(canMove(moving("copying"))).toBe(false);
		expect(canMove({ ...RENDER, kind: "isolate" })).toBe(false);
		expect(canMove({ ...RENDER, hostUnreachable: true })).toBe(false);
		const { hostId: _, ...unseen } = RENDER;
		expect(canMove(unseen)).toBe(false);
	});

	it("is a state of its own: between states, read again soon, under running, with nothing else to do meanwhile", () => {
		expect(SANDBOX_STATE_LABELS.moving).toBe("Moving");
		expect(sandboxesPollMs([moving("copying")], 1_000)).toBe(1_000);
		expect(stateBucket("moving")).toBe("running");
		expect(sandboxActions("moving")).toEqual({
			connect: false,
			stop: false,
			resume: false,
			fork: false,
			recover: false,
		});
	});
});
