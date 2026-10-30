/**
 * Renders the TypeScript SDK for a set of routes: the types of every named schema, the SDK's runtime
 * (`sdk-runtime.ts`), and `createHarbourClient`, with one method per route. The SDK is one file with no imports, so a
 * host app can copy it or import `@harbour/api/sdk`. Generated into `generated/sdk.ts`.
 */
import type { TSchema } from "typebox";
import type { JsonSchema } from "./openapi.ts";
import { pathParameters, type RouteDefinition } from "./route.ts";

const plain = (schema: TSchema): JsonSchema => JSON.parse(JSON.stringify(schema)) as JsonSchema;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

/** A JSDoc comment for a description, indented. */
const doc = (description: unknown, indent = ""): string =>
	typeof description === "string" && description !== ""
		? `${indent}/** ${description.replaceAll("*/", "*\\/").replaceAll("\n", `\n${indent} * `)} */\n`
		: "";

class TypeWriter {
	/** Every named type the SDK declares, by name. */
	readonly named = new Map<string, string>();

	/** The TypeScript type of a schema; a named schema inside it is declared once and referred to by name. */
	type(node: JsonSchema, inline = false): string {
		const title = typeof node.title === "string" ? node.title : undefined;
		if (title !== undefined && !inline) {
			if (!this.named.has(title)) {
				this.named.set(title, "");
				this.named.set(title, this.declaration(title, node));
			}
			return title;
		}
		if ("const" in node) return JSON.stringify(node.const);
		if (Array.isArray(node.enum)) return node.enum.map((value) => JSON.stringify(value)).join(" | ");
		if (Array.isArray(node.anyOf)) return (node.anyOf as JsonSchema[]).map((child) => this.type(child)).join(" | ");
		switch (node.type) {
			case "string":
				return "string";
			case "integer":
			case "number":
				return "number";
			case "boolean":
				return "boolean";
			case "null":
				return "null";
			case "array":
				return `readonly (${this.type((node.items as JsonSchema | undefined) ?? {})})[]`;
			case "object":
				return this.object(node);
			default:
				return "unknown";
		}
	}

	private object(node: JsonSchema): string {
		const properties = (node.properties as { [name: string]: JsonSchema } | undefined) ?? {};
		const required = new Set((node.required as string[] | undefined) ?? []);
		const members = Object.entries(properties).map(
			([name, child]) =>
				`${doc(child.description, "\t")}\treadonly ${key(name)}${required.has(name) ? "" : "?"}: ${this.type(child)};`,
		);
		const pattern = node.patternProperties as { [pattern: string]: JsonSchema } | undefined;
		const extra =
			pattern !== undefined
				? Object.values(pattern)[0]
				: typeof node.additionalProperties === "object"
					? (node.additionalProperties as JsonSchema)
					: undefined;
		if (extra !== undefined) members.push(`\treadonly [key: string]: ${this.type(extra)};`);
		return members.length === 0 ? "{}" : `{\n${members.join("\n")}\n}`;
	}

	private declaration(name: string, node: JsonSchema): string {
		const body = this.type(node, true);
		const isObject = node.type === "object" && body.startsWith("{");
		return `${doc(node.description)}${isObject ? `export interface ${name} ${body}` : `export type ${name} = ${body};`}`;
	}
}

const isOptional = (schema: TSchema | undefined): boolean =>
	schema === undefined || ((plain(schema).required as string[] | undefined) ?? []).length === 0;

function method(route: RouteDefinition, types: TypeWriter): { signature: string; implementation: string } {
	const names = pathParameters(route.path);
	const args: string[] = names.map((name) => `${name}: string`);
	const params = names.map((name) => name);
	let body: string | undefined;
	let query: string | undefined;
	// A stream's handlers come straight after its path parameters, ahead of its optional query.
	const frame = route.stream === undefined ? undefined : types.type(plain(route.stream.frame));
	if (frame !== undefined) {
		args.push(`handlers: StreamHandlers<${frame}>`);
		params.push("handlers");
	}
	if (route.body !== undefined) {
		const type = types.type(plain(route.body));
		const optional = isOptional(route.body);
		args.push(`body${optional ? "?" : ""}: ${type}`);
		params.push(optional ? "body = {}" : "body");
		body = "body";
	}
	if (route.query !== undefined) {
		const type = types.type(plain(route.query));
		const optional = isOptional(route.query);
		args.push(`query${optional ? "?" : ""}: ${type}`);
		params.push("query");
		query = "query";
	}
	args.push("options?: CallOptions");
	params.push("callOptions");
	const answers = [route.answer, ...(route.otherAnswers ?? [])].map((answer) =>
		answer.schema === undefined ? "void" : types.type(plain(answer.schema)),
	);
	const output = frame !== undefined ? "StreamHandle" : `Promise<${[...new Set(answers)].join(" | ")}>`;
	const path = route.path.replace(
		/\{([A-Za-z][A-Za-z0-9]*)\}/g,
		(_, name: string) => `\${encodeURIComponent(${name})}`,
	);
	const call = [
		`method: ${JSON.stringify(route.method)}`,
		`path: ${names.length === 0 ? JSON.stringify(route.path) : `\`${path}\``}`,
		...(query === undefined ? [] : [query]),
		...(body === undefined ? [] : [body]),
	].join(", ");
	const summary = [
		route.summary,
		route.description,
		route.idempotent === true ? "Idempotent with `options.idempotencyKey`" : undefined,
	]
		.filter((part) => part !== undefined)
		.map((part) => part.replace(/\.$/, ""))
		.join(". ");
	return {
		signature: `${doc(`${summary.replace(/\.?$/, ".")} \`${route.method} ${route.path}\``, "\t")}\t${route.operationId}(${args.join(", ")}): ${output};`,
		implementation:
			frame !== undefined
				? `\t\t${route.operationId}: (${params.join(", ")}) => openStream(options, { ${call} }, handlers, callOptions),`
				: `\t\t${route.operationId}: (${params.join(", ")}) => send(options, { ${call} }, callOptions),`,
	};
}

export interface SdkSource {
	/** The text of `sdk-runtime.ts`. */
	readonly runtime: string;
	/** Who generated it from what, for the header comment. */
	readonly header: string;
}

/** The SDK's source for `routes`. */
export function renderSdk(routes: { readonly [id: string]: RouteDefinition }, source: SdkSource): string {
	const types = new TypeWriter();
	const methods = Object.values(routes).map((route) => method(route, types));
	const declarations = [...types.named].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text);
	return [
		source.header,
		"",
		"// Types",
		"",
		declarations.join("\n\n"),
		"",
		"// Runtime",
		"",
		source.runtime.trim(),
		"",
		"// Client",
		"",
		"/** Harbour's public API, one method per route. */",
		"export interface HarbourClient {",
		methods.map((entry) => entry.signature).join("\n"),
		"}",
		"",
		"/** A client for Harbour's public API over `fetch`. */",
		"export function createHarbourClient(options: HarbourClientOptions): HarbourClient {",
		"\treturn {",
		methods.map((entry) => entry.implementation).join("\n"),
		"\t};",
		"}",
		"",
	].join("\n");
}
