/**
 * The environments API's routes (docs/site/src/content/docs/api/environments.md): sandbox tier 3, long-lived machines
 * a project's sessions attach to. Experimental: a deployment serves them only with `KANTEL_ENVIRONMENTS=experimental`,
 * and answers 404 without it.
 *
 * A provider's signed webhook (`POST /v1/environment-webhooks/boat`) is not a JSON route of the API: the host serves it
 * itself, checked by its signature rather than a caller's sign-in.
 */
import {
	CreateEnvironmentBody,
	Environment,
	EnvironmentDetail,
	EnvironmentGrant,
	EnvironmentGrantPath,
	EnvironmentList,
	EnvironmentPath,
	GrantEnvironmentBody,
	ListEnvironmentsQuery,
	UpdateEnvironmentBody,
} from "./environments-schema.ts";
import { defineRoute } from "./route.ts";

const tag = "environments";
const EXPERIMENTAL = "Experimental: served only where the deployment sets `KANTEL_ENVIRONMENTS=experimental`.";
const readErrors = ["invalid", "forbidden", "not_found"] as const;
const changeErrors = ["invalid", "forbidden", "not_found", "conflict", "unavailable"] as const;

export const listEnvironments = defineRoute({
	operationId: "listEnvironments",
	method: "GET",
	path: "/environments",
	tag,
	summary: "List environments",
	description: `The environments of the projects the caller may view, by name; destroyed ones are left out. ${EXPERIMENTAL}`,
	query: ListEnvironmentsQuery,
	answer: { status: 200, description: "The environments.", schema: EnvironmentList },
	errors: ["invalid", "forbidden"],
});

export const createEnvironment = defineRoute({
	operationId: "createEnvironment",
	method: "POST",
	path: "/environments",
	tag,
	summary: "Create an environment",
	description:
		"Creates an environment and its machine; needs operator on the project. It belongs to the caller unless " +
		"`projectWide`, and idles until a session uses it. The name is unique in the project (`conflict` otherwise). " +
		EXPERIMENTAL,
	body: CreateEnvironmentBody,
	answer: { status: 201, description: "The environment.", schema: Environment },
	errors: changeErrors,
});

export const getEnvironment = defineRoute({
	operationId: "getEnvironment",
	method: "GET",
	path: "/environments/{environmentId}",
	tag,
	summary: "Get an environment",
	description: `The environment, the sessions holding it, its grants and its recent history. ${EXPERIMENTAL}`,
	params: EnvironmentPath,
	answer: { status: 200, description: "The environment.", schema: EnvironmentDetail },
	errors: readErrors,
});

export const updateEnvironment = defineRoute({
	operationId: "updateEnvironment",
	method: "PATCH",
	path: "/environments/{environmentId}",
	tag,
	summary: "Change an environment",
	description: `Changes its description, idle timeout or size; a new size applies at the next start. ${EXPERIMENTAL}`,
	params: EnvironmentPath,
	body: UpdateEnvironmentBody,
	answer: { status: 200, description: "The environment.", schema: Environment },
	errors: changeErrors,
});

export const startEnvironment = defineRoute({
	operationId: "startEnvironment",
	method: "POST",
	path: "/environments/{environmentId}/start",
	tag,
	summary: "Start an environment",
	description: `Starts a stopped environment; answers as soon as the start is under way. ${EXPERIMENTAL}`,
	params: EnvironmentPath,
	answer: { status: 200, description: "The environment, starting.", schema: Environment },
	errors: [...changeErrors, "exhausted", "refused"],
});

export const stopEnvironment = defineRoute({
	operationId: "stopEnvironment",
	method: "POST",
	path: "/environments/{environmentId}/stop",
	tag,
	summary: "Stop an environment",
	description: `Stops it, keeping its disk; the sessions holding it let go. ${EXPERIMENTAL}`,
	params: EnvironmentPath,
	answer: { status: 200, description: "The environment, stopping.", schema: Environment },
	errors: changeErrors,
});

export const destroyEnvironment = defineRoute({
	operationId: "destroyEnvironment",
	method: "DELETE",
	path: "/environments/{environmentId}",
	tag,
	summary: "Destroy an environment",
	description: `Removes its machine and disk, and revokes its grants; needs admin on the project. ${EXPERIMENTAL}`,
	params: EnvironmentPath,
	answer: { status: 200, description: "The environment, destroyed.", schema: Environment },
	errors: changeErrors,
});

export const grantEnvironment = defineRoute({
	operationId: "grantEnvironment",
	method: "POST",
	path: "/environments/{environmentId}/grants",
	tag,
	summary: "Grant a session an environment",
	description:
		"Lets a session in the environment's project use it as `bash`'s `env`, by its alias; needs operator on the " +
		`project. A session already granted it is answered with its grant. ${EXPERIMENTAL}`,
	params: EnvironmentPath,
	body: GrantEnvironmentBody,
	answer: { status: 201, description: "The grant.", schema: EnvironmentGrant },
	errors: changeErrors,
});

export const revokeEnvironmentGrant = defineRoute({
	operationId: "revokeEnvironmentGrant",
	method: "DELETE",
	path: "/environments/{environmentId}/grants/{grantId}",
	tag,
	summary: "Revoke a session's grant",
	description: `Ends the session's use of the environment, and its lease. ${EXPERIMENTAL}`,
	params: EnvironmentGrantPath,
	answer: { status: 204, description: "Revoked." },
	errors: readErrors,
});

export const environmentRoutes = {
	listEnvironments,
	createEnvironment,
	getEnvironment,
	updateEnvironment,
	startEnvironment,
	stopEnvironment,
	destroyEnvironment,
	grantEnvironment,
	revokeEnvironmentGrant,
} as const;
