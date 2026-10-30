/**
 * The OpenAPI 3.1 document for a set of routes. Every schema with a `title` becomes a component and is referenced by
 * `$ref` wherever it appears; the rest stay inline. The document is generated into `generated/openapi.json`.
 */
import type { ErrorCode } from "@harbour/contracts";
import type { TSchema } from "typebox";
import {
	IDEMPOTENCY_KEY_HEADER,
	MAX_IDEMPOTENCY_KEY_LENGTH,
	pathParameters,
	type RouteDefinition,
	STATUS_BY_CODE,
	UNAUTHENTICATED_STATUS,
} from "./route.ts";
import { ErrorBody } from "./schema.ts";

export type JsonSchema = { [key: string]: unknown };

export interface OpenApiInfo {
	readonly title: string;
	readonly version: string;
	readonly description: string;
	/** The server URL the paths are relative to, such as `/v1`. */
	readonly basePath: string;
}

/** Plain JSON: TypeBox keeps some markers (such as optional) under symbols, which JSON never sees. */
const plain = (schema: TSchema): JsonSchema => JSON.parse(JSON.stringify(schema)) as JsonSchema;

/** Collects named schemas as components, replacing each with a `$ref` where it's used. */
export class SchemaRegistry {
	readonly components = new Map<string, JsonSchema>();

	/** The schema with every named schema inside it (and itself, unless `inline`) as a reference. */
	use(schema: TSchema | JsonSchema, inline = false): JsonSchema {
		return this.walk(plain(schema as TSchema), inline);
	}

	private walk(node: JsonSchema, inline: boolean): JsonSchema {
		const title = typeof node.title === "string" ? node.title : undefined;
		if (title !== undefined && !inline) {
			if (!this.components.has(title)) {
				this.components.set(title, {});
				this.components.set(title, this.walk(node, true));
			}
			return { $ref: `#/components/schemas/${title}` };
		}
		const out: JsonSchema = {};
		for (const [key, value] of Object.entries(node)) {
			if (key === "properties" || key === "patternProperties") {
				out[key] = Object.fromEntries(
					Object.entries(value as { [name: string]: JsonSchema }).map(([name, child]) => [
						name,
						this.walk(child, false),
					]),
				);
			} else if (key === "items" || (key === "additionalProperties" && typeof value === "object")) {
				out[key] = this.walk(value as JsonSchema, false);
			} else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
				out[key] = (value as JsonSchema[]).map((child) => this.walk(child, false));
			} else {
				out[key] = value;
			}
		}
		return out;
	}
}

const statusFor = (code: ErrorCode) => STATUS_BY_CODE[code];

function parameters(route: RouteDefinition, registry: SchemaRegistry): JsonSchema[] {
	const out: JsonSchema[] = [];
	const params = route.params === undefined ? undefined : plain(route.params);
	for (const name of pathParameters(route.path)) {
		const schema = (params?.properties as { [name: string]: JsonSchema } | undefined)?.[name] ?? { type: "string" };
		const { description, ...rest } = schema;
		out.push({
			name,
			in: "path",
			required: true,
			...(typeof description === "string" ? { description } : {}),
			schema: registry.use(rest),
		});
	}
	if (route.query !== undefined) {
		const query = plain(route.query);
		const required = new Set((query.required as string[] | undefined) ?? []);
		for (const [name, schema] of Object.entries(query.properties as { [name: string]: JsonSchema })) {
			const { description, ...rest } = schema;
			out.push({
				name,
				in: "query",
				required: required.has(name),
				...(typeof description === "string" ? { description } : {}),
				schema: registry.use(rest),
			});
		}
	}
	if (route.idempotent === true) {
		out.push({
			name: IDEMPOTENCY_KEY_HEADER,
			in: "header",
			required: false,
			description:
				"A key of your choosing, unique per call, such as a UUID. A retry with the same key gets the first call's answer " +
				"and does nothing again.",
			schema: { type: "string", minLength: 1, maxLength: MAX_IDEMPOTENCY_KEY_LENGTH },
		});
	}
	return out;
}

function operation(route: RouteDefinition, registry: SchemaRegistry): JsonSchema {
	const error = registry.use(ErrorBody);
	const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: error } } });
	const frame = route.stream === undefined ? undefined : registry.use(route.stream.frame);
	const success =
		frame !== undefined
			? {
					"101": {
						description:
							"Upgraded to a WebSocket (send `Upgrade: websocket`). Each message is a JSON array of frames; an empty " +
							"array is a keep-alive. The server negotiates `permessage-deflate` where the platform can. The client " +
							"sends nothing; to resume, reconnect with `?after=` and the last cursor it holds.",
						content: { "application/json": { schema: { type: "array", items: frame } } },
					},
					[String(route.answer.status)]: {
						description:
							`${route.answer.description} Without an upgrade: server-sent events, each named after its frame's ` +
							"type with the frame as its JSON data, then one `ready` event once the client has caught up. " +
							"Snapshot and delta events carry their cursor as the event ID, so `Last-Event-ID` resumes too.",
						content: { "text/event-stream": { schema: frame } },
					},
				}
			: Object.fromEntries(
					[route.answer, ...(route.otherAnswers ?? [])].map((answer) => [
						String(answer.status),
						answer.schema === undefined
							? { description: answer.description }
							: {
									description: answer.description,
									content: { "application/json": { schema: registry.use(answer.schema) } },
								},
					]),
				);
	const responses: { [status: string]: unknown } = {
		...success,
		[String(UNAUTHENTICATED_STATUS)]: errorResponse("The request needs a valid credential (`unauthenticated`)."),
	};
	const byStatus = new Map<number, ErrorCode[]>();
	for (const code of route.errors) byStatus.set(statusFor(code), [...(byStatus.get(statusFor(code)) ?? []), code]);
	for (const [status, codes] of [...byStatus].sort(([a], [b]) => a - b)) {
		responses[String(status)] = errorResponse(codes.map((code) => `\`${code}\``).join(" or "));
	}
	const query = route.query === undefined ? undefined : plain(route.query);
	const description = [route.description, typeof query?.description === "string" ? query.description : undefined]
		.filter((part) => part !== undefined)
		.join("\n\n");
	const params = parameters(route, registry);
	return {
		operationId: route.operationId,
		summary: route.summary,
		...(description === "" ? {} : { description }),
		tags: [route.tag],
		...(params.length === 0 ? {} : { parameters: params }),
		...(route.body === undefined
			? {}
			: {
					requestBody: {
						required: ((plain(route.body).required as string[] | undefined) ?? []).length > 0,
						content: { "application/json": { schema: registry.use(route.body) } },
					},
				}),
		responses,
	};
}

/** The OpenAPI 3.1 document for `routes`. */
export function openApiDocument(routes: { readonly [id: string]: RouteDefinition }, info: OpenApiInfo): JsonSchema {
	const registry = new SchemaRegistry();
	const paths: { [path: string]: { [method: string]: JsonSchema } } = {};
	for (const route of Object.values(routes)) {
		paths[route.path] ??= {};
		(paths[route.path] as { [method: string]: JsonSchema })[route.method.toLowerCase()] = operation(route, registry);
	}
	const schemas = Object.fromEntries([...registry.components].sort(([a], [b]) => a.localeCompare(b)));
	return {
		openapi: "3.1.0",
		info: { title: info.title, version: info.version, description: info.description },
		servers: [{ url: info.basePath }],
		security: [{ bearer: [] }],
		paths,
		components: {
			securitySchemes: {
				bearer: {
					type: "http",
					scheme: "bearer",
					description:
						"A host app's API key (`hbr_…`), from the API keys page or `POST /v1/keys`. It acts as a `service` actor, " +
						"limited to the key's projects and role. Behind Cloudflare Access a person's browser is signed in by Access " +
						"instead, with no header.",
				},
			},
			schemas,
		},
	};
}
