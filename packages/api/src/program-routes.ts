/**
 * The programs API's routes (docs/design/programs.md): saved, versioned code mode programs, run through the API with no
 * model in the loop. Experimental: a deployment serves them only with `KANTEL_PROGRAMS=on`, and answers 404 without it.
 */
import {
	CreateProgramBody,
	CreateProgramVersionBody,
	ListProgramsQuery,
	Program,
	ProgramList,
	ProgramPath,
	ProgramRun,
	ProgramRunList,
	ProgramRunPath,
	ProgramVersion,
	ProgramVersionList,
	ProgramVersionPath,
	RunProgramBody,
} from "./programs-schema.ts";
import { defineRoute } from "./route.ts";

const tag = "programs";
const EXPERIMENTAL = "Experimental: served only where the deployment sets `KANTEL_PROGRAMS=on`.";
const readErrors = ["invalid", "forbidden", "not_found"] as const;
const changeErrors = ["invalid", "forbidden", "not_found", "conflict"] as const;

export const listPrograms = defineRoute({
	operationId: "listPrograms",
	method: "GET",
	path: "/programs",
	tag,
	summary: "List programs",
	description: `The programs of the projects the caller may view, by name. ${EXPERIMENTAL}`,
	query: ListProgramsQuery,
	answer: { status: 200, description: "The programs.", schema: ProgramList },
	errors: ["invalid", "forbidden"],
});

export const createProgram = defineRoute({
	operationId: "createProgram",
	method: "POST",
	path: "/programs",
	tag,
	summary: "Save a new program",
	description: `Saves a program and its version 1; needs operator on the project. ${EXPERIMENTAL}`,
	body: CreateProgramBody,
	answer: { status: 201, description: "The program.", schema: Program },
	errors: changeErrors,
});

export const getProgram = defineRoute({
	operationId: "getProgram",
	method: "GET",
	path: "/programs/{programId}",
	tag,
	summary: "Get a program",
	description: EXPERIMENTAL,
	params: ProgramPath,
	answer: { status: 200, description: "The program.", schema: Program },
	errors: readErrors,
});

export const removeProgram = defineRoute({
	operationId: "removeProgram",
	method: "DELETE",
	path: "/programs/{programId}",
	tag,
	summary: "Delete a program",
	description: `Deletes the program and every version; its runs' sessions stay. ${EXPERIMENTAL}`,
	params: ProgramPath,
	answer: { status: 204, description: "Deleted." },
	errors: readErrors,
});

export const listProgramVersions = defineRoute({
	operationId: "listProgramVersions",
	method: "GET",
	path: "/programs/{programId}/versions",
	tag,
	summary: "List a program's versions",
	description: EXPERIMENTAL,
	params: ProgramPath,
	answer: { status: 200, description: "The versions, oldest first.", schema: ProgramVersionList },
	errors: readErrors,
});

export const createProgramVersion = defineRoute({
	operationId: "createProgramVersion",
	method: "POST",
	path: "/programs/{programId}/versions",
	tag,
	summary: "Save a program's next version",
	description: `Versions are immutable and numbered from 1; needs operator on the project. ${EXPERIMENTAL}`,
	params: ProgramPath,
	body: CreateProgramVersionBody,
	answer: { status: 201, description: "The new version.", schema: ProgramVersion },
	errors: changeErrors,
});

export const getProgramVersion = defineRoute({
	operationId: "getProgramVersion",
	method: "GET",
	path: "/programs/{programId}/versions/{version}",
	tag,
	summary: "Get a program version",
	description: EXPERIMENTAL,
	params: ProgramVersionPath,
	answer: { status: 200, description: "The version.", schema: ProgramVersion },
	errors: readErrors,
});

export const removeProgramVersion = defineRoute({
	operationId: "removeProgramVersion",
	method: "DELETE",
	path: "/programs/{programId}/versions/{version}",
	tag,
	summary: "Delete a program version",
	description: `A deleted version can't run; its number is never reused. ${EXPERIMENTAL}`,
	params: ProgramVersionPath,
	answer: { status: 204, description: "Deleted." },
	errors: readErrors,
});

export const runProgram = defineRoute({
	operationId: "runProgram",
	method: "POST",
	path: "/programs/{programId}/runs",
	tag,
	summary: "Run a program",
	description:
		"Runs a version (default the latest) with `input`, checked against its input schema, in a session of its own as the " +
		"caller, with no model: code mode runs the program, whose tool calls go through the same rules, approvals and " +
		`audit as any session's. Needs operator on the project. ${EXPERIMENTAL}`,
	params: ProgramPath,
	body: RunProgramBody,
	idempotent: true,
	answer: { status: 200, description: "The run, ended.", schema: ProgramRun },
	otherAnswers: [{ status: 202, description: "The run, still running.", schema: ProgramRun }],
	errors: changeErrors,
});

export const listProgramRuns = defineRoute({
	operationId: "listProgramRuns",
	method: "GET",
	path: "/programs/{programId}/runs",
	tag,
	summary: "List a program's runs",
	description: `The newest 100 runs, newest first. ${EXPERIMENTAL}`,
	params: ProgramPath,
	answer: { status: 200, description: "The runs.", schema: ProgramRunList },
	errors: readErrors,
});

export const getProgramRun = defineRoute({
	operationId: "getProgramRun",
	method: "GET",
	path: "/programs/{programId}/runs/{runId}",
	tag,
	summary: "Get a program run",
	description: `Its status, and its output or error once it has ended. ${EXPERIMENTAL}`,
	params: ProgramRunPath,
	answer: { status: 200, description: "The run.", schema: ProgramRun },
	errors: readErrors,
});

export const cancelProgramRun = defineRoute({
	operationId: "cancelProgramRun",
	method: "POST",
	path: "/programs/{programId}/runs/{runId}/cancel",
	tag,
	summary: "Cancel a program run",
	description: `Stops a running run (its session's run is aborted); an ended run is answered as it is. ${EXPERIMENTAL}`,
	params: ProgramRunPath,
	answer: { status: 200, description: "The run.", schema: ProgramRun },
	errors: readErrors,
});

export const programRoutes = {
	listPrograms,
	createProgram,
	getProgram,
	removeProgram,
	listProgramVersions,
	createProgramVersion,
	getProgramVersion,
	removeProgramVersion,
	runProgram,
	listProgramRuns,
	getProgramRun,
	cancelProgramRun,
} as const;
