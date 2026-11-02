// The Environments page's model (sandbox tier 3, experimental): the calls the page makes, and the words it shows. The
// records are @kantel/contracts' (`Environment`, `EnvironmentDetail`, `EnvironmentLease`); the console binds
// `EnvironmentsSource` to `/v1/environments`, stories and the recorded console to fixtures.
//
// An environment is a long-lived machine owned by a project, by default by one person in it. Sessions attach through
// grants and hold leases while they run commands there; the machine starts on first use and stops when it has been
// idle for its timeout. The page never shows a provider's machine ID, an address or a port URL's token.

import {
	type Environment,
	type EnvironmentDetail,
	type EnvironmentEvent,
	type EnvironmentFilter,
	type EnvironmentId,
	type EnvironmentLease,
	type EnvironmentProviderKind,
	type EnvironmentSize,
	type EnvironmentState,
	environmentUp,
} from "@kantel/contracts";
import { compactAge } from "../primitives/format.ts";
import type { Status } from "../tokens/tokens.ts";

/** The calls the page makes, bound to the viewer by the host. */
export interface EnvironmentsSource {
	/** The environments the viewer may see, by name; with a project, that project's. */
	list(filter?: EnvironmentFilter): Promise<readonly Environment[]>;
	/** One environment with its leases, grants and recent history. */
	get(id: EnvironmentId): Promise<EnvironmentDetail>;
	/** Starts a stopped environment. Resolves as soon as the start is under way. */
	start(id: EnvironmentId): Promise<Environment>;
	/** Stops a running or idle environment; its sessions' leases end. Resolves as soon as the stop is under way. */
	stop(id: EnvironmentId): Promise<Environment>;
}

/** Names for what the page shows by ID: projects, people and sessions. */
export interface EnvironmentsDirectory {
	project(projectId: string): string | undefined;
	person(userId: string): string | undefined;
	/** A session's title, when the host knows it. */
	session(sessionId: string): string | undefined;
}

export interface EnvironmentLinks {
	/** Where a session in the environment's project opens. */
	session(sessionId: string, projectId: string): string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Words

export const STATE_LABELS: Readonly<Record<EnvironmentState, string>> = {
	creating: "Creating",
	stopped: "Stopped",
	starting: "Starting",
	running: "Running",
	idle: "Idle",
	stopping: "Stopping",
	error: "Failed",
	destroyed: "Destroyed",
};

/** The status colour for each state: up and in use is done, idle and counting down is worth a look. */
export const STATE_STATUS: Readonly<Record<EnvironmentState, Status>> = {
	creating: "working",
	stopped: "idle",
	starting: "working",
	running: "done",
	idle: "approval",
	stopping: "working",
	error: "error",
	destroyed: "idle",
};

/** Whether the state is on its way somewhere, so the page reads it again shortly. */
export function environmentMoving(state: EnvironmentState): boolean {
	return state === "creating" || state === "starting" || state === "stopping";
}

/** "Running", "Idle, stops in 9m", "Stopped 2h ago", "Failed". */
export function environmentStatusText(environment: Environment, now: number): string {
	const label = STATE_LABELS[environment.state];
	if (environment.state === "idle" && environment.idleStopAt !== undefined) {
		const left = environment.idleStopAt - now;
		return left <= 60_000 ? `${label}, stops in under a minute` : `${label}, stops in ${Math.ceil(left / 60_000)}m`;
	}
	if (environment.state === "stopped" && environment.lastStoppedAt !== undefined) {
		const age = compactAge(environment.lastStoppedAt, now);
		return age === "now" ? `${label} just now` : `${label} ${age} ago`;
	}
	return label;
}

export const PROVIDER_LABELS: Readonly<Record<EnvironmentProviderKind, string>> = {
	boat: "boat.dev",
	firecracker: "Kantel host",
	byo: "Your own VM",
	fake: "Test provider",
};

/** "4 vCPU, 8 GB memory, 51 GB disk". */
export function sizeText(size: EnvironmentSize): string {
	return `${size.vcpus} vCPU, ${size.memoryGb} GB memory, ${size.diskGb} GB disk`;
}

/** "Lleverage project, Tom's", or "Lleverage project, everyone's" for a project-wide one. */
export function ownerText(environment: Pick<Environment, "owner">, directory: EnvironmentsDirectory): string {
	const project = directory.project(environment.owner.projectId) ?? environment.owner.projectId;
	if (environment.owner.userId === undefined) return `${project} project, every member's sessions`;
	const person = directory.person(environment.owner.userId) ?? environment.owner.userId;
	return `${project} project, ${person}'s sessions`;
}

/** "No sessions", "1 session", "3 sessions". */
export function leaseCountText(count: number): string {
	if (count === 0) return "No sessions";
	return count === 1 ? "1 session" : `${count} sessions`;
}

/** "1.2 s", "850 ms", "1m 5s". */
export function latencyText(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** "Wakes in 3.4 s (median of 12)", or undefined before its first start. */
export function resumeText(environment: Pick<Environment, "resume">): string | undefined {
	const resume = environment.resume;
	if (resume === undefined) return undefined;
	if (resume.samples <= 1) return `Wakes in ${latencyText(resume.lastMs)}`;
	return `Wakes in ${latencyText(resume.p50Ms)} (median of ${resume.samples}), last ${latencyText(resume.lastMs)}`;
}

/** "6.2 h this month", "40 min this month", "Not run this month". */
export function runningText(ms: number): string {
	if (ms < 60_000) return "Not run this month";
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min this month`;
	return `${(ms / 3_600_000).toFixed(1)} h this month`;
}

/** "15 minutes idle", "1 hour idle". */
export function idleText(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `Stops after ${hours === 1 ? "1 hour" : `${hours} hours`} idle`;
	}
	return `Stops after ${minutes === 1 ? "1 minute" : `${minutes} minutes`} idle`;
}

/** What the start or stop button does from here, or nothing while it's on its way or gone. */
export function powerAction(state: EnvironmentState): "start" | "stop" | undefined {
	if (environmentUp(state)) return "stop";
	if (state === "stopped" || state === "error") return "start";
	return undefined;
}

/** A lease's live time: "Attached 12m ago". */
export function leaseSinceText(lease: EnvironmentLease, now: number): string {
	const age = compactAge(lease.acquiredAt, now);
	return age === "now" ? "Attached just now" : `Attached ${age} ago`;
}

/** "3 commands", "1 command". */
export function commandCountText(count: number): string {
	return count === 1 ? "1 command" : `${count} commands`;
}

/** Live leases first, newest first. */
export function sortLeases(leases: readonly EnvironmentLease[]): readonly EnvironmentLease[] {
	return [...leases].filter((lease) => lease.endedAt === undefined).sort((a, b) => b.acquiredAt - a.acquiredAt);
}

/** One history row's words: "Started in 3.1 s", "Stopped after 15 minutes idle", "Fix the flaky test attached". */
export function eventText(event: EnvironmentEvent, directory: EnvironmentsDirectory): string {
	const session = event.sessionId === undefined ? "A session" : (directory.session(event.sessionId) ?? "A session");
	switch (event.kind) {
		case "created":
			return "Created";
		case "starting":
			return "Starting";
		case "started":
			return event.durationMs === undefined ? "Started" : `Started in ${latencyText(event.durationMs)}`;
		case "stopping":
			return "Stopping";
		case "stopped":
			return event.reason === "idle" ? "Stopped when idle" : "Stopped";
		case "failed":
			return event.message === undefined ? "Failed" : `Failed: ${event.message}`;
		case "destroyed":
			return "Destroyed";
		case "lease.acquired":
			return `${session} attached`;
		case "lease.ended":
			return `${session} let go`;
		case "granted":
			return `${session} was granted it`;
		case "revoked":
			return `${session}'s grant was revoked`;
	}
}
