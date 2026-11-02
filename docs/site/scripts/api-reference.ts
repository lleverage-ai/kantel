// Writes the docs site's API reference pages from the public API's OpenAPI document
// (packages/api/generated/openapi.json, itself generated from packages/api/src/routes.ts), so the reference can't drift
// from the routes: one page per tag under src/content/docs/api/reference/, plus types.md with every named schema.
// `--check` writes nothing and fails if any page differs from what it would write, or if a generated page is left over
// from a tag that no longer exists: CI runs it beside `pnpm --filter @kantel/api generate:check`.
//
// Node built-ins only, so it runs without an install: `node docs/site/scripts/api-reference.ts`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

interface Schema {
	readonly $ref?: string;
	readonly type?: string;
	/** `binary` for bytes, such as an image's. */
	readonly format?: string;
	readonly const?: unknown;
	readonly title?: string;
	readonly description?: string;
	readonly properties?: { readonly [name: string]: Schema };
	readonly patternProperties?: { readonly [pattern: string]: Schema };
	readonly required?: readonly string[];
	readonly items?: Schema;
	readonly anyOf?: readonly Schema[];
	readonly oneOf?: readonly Schema[];
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly maxItems?: number;
}

interface Parameter {
	readonly name: string;
	readonly in: "path" | "query" | "header";
	readonly required?: boolean;
	readonly description?: string;
	readonly schema: Schema;
}

interface Operation {
	readonly operationId: string;
	readonly summary?: string;
	readonly description?: string;
	readonly tags?: readonly string[];
	readonly parameters?: readonly Parameter[];
	readonly requestBody?: { readonly content: { readonly [type: string]: { readonly schema: Schema } } };
	readonly responses: {
		readonly [status: string]: {
			readonly description?: string;
			readonly content?: { readonly [type: string]: { readonly schema: Schema } };
		};
	};
}

interface Document {
	readonly info: { readonly title: string; readonly version: string };
	readonly servers?: readonly { readonly url: string }[];
	readonly paths: { readonly [path: string]: { readonly [method: string]: Operation } };
	readonly components: { readonly schemas: { readonly [name: string]: Schema } };
}

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, "..", "..", "..");
const source = join(repository, "packages", "api", "generated", "openapi.json");
const outDir = join(here, "..", "src", "content", "docs", "api", "reference");
const check = process.argv.includes("--check");

/** Pages in the reference directory written by hand, never by this script. */
const HAND_WRITTEN = new Set(["index.md", "unlisted.md"]);

/**
 * Each tag's page: its title, its place in the sidebar and a line about it. A note, when set, says something the
 * OpenAPI document can't, such as routes defined but not yet served; keep it short and remove it once it's untrue.
 */
const TAGS: {
	readonly [tag: string]: {
		readonly title: string;
		readonly order: number;
		readonly about: string;
		readonly note?: string;
	};
} = {
	sessions: { title: "Sessions", order: 1, about: "Create, list, read, close, abort, fork and warm sessions." },
	messages: {
		title: "Messages and results",
		order: 2,
		about: "Send messages to a session, wait for a run's result and choose models.",
	},
	stream: { title: "Stream and history", order: 3, about: "A session's live stream and its history in pages." },
	skills: { title: "Skills", order: 4, about: "Published skills, their revisions and files, and imports from a host." },
	rules: {
		title: "Prompt rules",
		order: 5,
		about: "Prompt rules for the platform, an organisation, a project or a user.",
	},
	memory: { title: "Memory", order: 6, about: "Memory spaces and concepts, search, recall and snapshot imports." },
	schedules: { title: "Schedules", order: 7, about: "Schedules, their next due times and their runs." },
	browsers: { title: "Browsers", order: 8, about: "Live and replay links to a session's browsers for an outside app." },
	shares: { title: "File shares", order: 9, about: "Sharing a workspace file by link or with named people." },
	sharing: {
		title: "Resource sharing",
		order: 10,
		about: "Shares, access requests, bindings and policies on resources, and what a session used through them.",
	},
	connections: {
		title: "Connections",
		order: 11,
		about: "Connectors to outside services: the catalogue, OAuth and key connections, OAuth clients and uses.",
	},
	projects: {
		title: "Projects",
		order: 12,
		about: "Creating a project in the caller's organisation, as an admin or with an organisation API key.",
	},
	"tool-servers": {
		title: "Tool servers",
		order: 13,
		about: "MCP servers Kantel calls for tools: the registry, tunnel tokens and each server's tools.",
		note: "Experimental: served only where the deployment sets `KANTEL_TOOL_SERVERS=experimental`.",
	},
	environments: {
		title: "Environments",
		order: 14,
		about: "Long-lived machines a project's sessions attach to: create, start, stop, grant and destroy.",
		note: "Experimental: served only where the deployment sets `KANTEL_ENVIRONMENTS=experimental`.",
	},
};

const document = JSON.parse(readFileSync(source, "utf8")) as Document;
const schemas = document.components.schemas;
const base = document.servers?.[0]?.url ?? "/v1";

const anchor = (name: string) => name.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "");
const refName = (ref: string) => ref.replace("#/components/schemas/", "");
const typeLink = (name: string) => `[${name}](/api/reference/types/#${anchor(name)})`;
/** Text for a Markdown table cell: one line, pipes escaped. */
const cell = (text: string) => text.replaceAll("\n", " ").replaceAll("|", "\\|");

/** A schema as a short type expression, linking named schemas to the types page. */
function typeOf(schema: Schema | undefined): string {
	if (schema === undefined) return "any";
	if (schema.$ref !== undefined) return typeLink(refName(schema.$ref));
	if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``;
	const union = schema.anyOf ?? schema.oneOf;
	if (union !== undefined) return union.map(typeOf).join(" or ");
	if (schema.type === "array") return `${typeOf(schema.items)}[]`;
	if (schema.type === "object" && schema.properties === undefined && schema.patternProperties !== undefined) {
		const values = Object.values(schema.patternProperties)[0];
		// Entities, not angle brackets, so a Markdown or MDX renderer never reads it as a tag.
		return `Record&lt;string, ${values === undefined || Object.keys(values).length === 0 ? "any" : typeOf(values)}&gt;`;
	}
	if (schema.type === "object" && schema.properties !== undefined) return "object";
	return schema.type ?? "any";
}

/** Limits worth stating beside a description, such as a length or a minimum. */
function limits(schema: Schema): string {
	const parts: string[] = [];
	if (schema.minLength !== undefined && schema.minLength > 1) parts.push(`at least ${schema.minLength} characters`);
	if (schema.maxLength !== undefined) parts.push(`at most ${schema.maxLength} characters`);
	if (schema.minimum !== undefined) parts.push(`minimum ${schema.minimum}`);
	if (schema.maximum !== undefined) parts.push(`maximum ${schema.maximum}`);
	if (schema.maxItems !== undefined) parts.push(`at most ${schema.maxItems} items`);
	return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/** An object schema's properties as a table, or nothing when it has none. */
function propertyTable(schema: Schema): string[] {
	const properties = Object.entries(schema.properties ?? {});
	if (properties.length === 0) return [];
	const required = new Set(schema.required ?? []);
	return [
		"| Field | Type | Required | Description |",
		"| --- | --- | --- | --- |",
		...properties.map(
			([name, property]) =>
				`| \`${name}\` | ${cell(typeOf(property))} | ${required.has(name) ? "yes" : "no"} | ${cell(
					`${property.description ?? ""}${limits(property)}`,
				)} |`,
		),
	];
}

/** The discriminating constant of an object variant, such as `type: "hello"`, if it has one. */
function discriminator(schema: Schema): string | undefined {
	for (const [name, property] of Object.entries(schema.properties ?? {})) {
		if (property.const !== undefined) return `${name}: ${JSON.stringify(property.const)}`;
	}
	return undefined;
}

/** One named schema's section on the types page. */
function typeSection(name: string, schema: Schema): string[] {
	const lines = [`### ${name}`, ""];
	if (schema.description !== undefined) lines.push(schema.description, "");
	const union = schema.anyOf ?? schema.oneOf;
	if (union?.some((each) => each.properties !== undefined)) {
		lines.push("One of:", "");
		union.forEach((variant, index) => {
			if (variant.properties === undefined) {
				lines.push(`- ${typeOf(variant)}`, "");
				return;
			}
			const label = discriminator(variant) ?? `variant ${index + 1}`;
			lines.push(`**\`${label}\`**${variant.description === undefined ? "" : `: ${variant.description}`}`, "");
			lines.push(...propertyTable(variant), "");
		});
		return lines;
	}
	if (union !== undefined) {
		lines.push(`One of: ${typeOf(schema)}.`, "");
		return lines;
	}
	const table = propertyTable(schema);
	if (table.length > 0) lines.push(...table, "");
	else lines.push(`Type: ${typeOf(schema)}.`, "");
	return lines;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** One operation's section on its tag's page. */
function operationSection(path: string, method: string, operation: Operation): string[] {
	const lines = [`## ${operation.summary ?? operation.operationId}`, ""];
	lines.push(`\`${method.toUpperCase()} ${base}${path}\` (SDK method \`${operation.operationId}\`)`, "");
	if (operation.description !== undefined) lines.push(operation.description, "");

	const parameters = operation.parameters ?? [];
	for (const place of ["path", "query", "header"] as const) {
		const here = parameters.filter((parameter) => parameter.in === place);
		if (here.length === 0) continue;
		lines.push(`**${place === "path" ? "Path" : place === "query" ? "Query" : "Header"} parameters**`, "");
		lines.push("| Name | Type | Required | Description |", "| --- | --- | --- | --- |");
		for (const parameter of here) {
			lines.push(
				`| \`${parameter.name}\` | ${cell(typeOf(parameter.schema))} | ${parameter.required === true ? "yes" : "no"} | ${cell(
					`${parameter.description ?? parameter.schema.description ?? ""}${limits(parameter.schema)}`,
				)} |`,
			);
		}
		lines.push("");
	}

	const body = operation.requestBody?.content["application/json"]?.schema;
	if (body !== undefined) lines.push(`**Body**: ${typeOf(body)}`, "");

	const answers = Object.entries(operation.responses).filter(([status]) => Number(status) < 400);
	if (answers.length > 0) {
		lines.push("**Answers**", "");
		for (const [status, answer] of answers) {
			const content = Object.entries(answer.content ?? {});
			// A binary answer, such as an image, is its bytes in one of its types.
			const binary = content.length > 0 && content.every(([, each]) => each.schema.format === "binary");
			const shape =
				content.length === 0
					? "no body"
					: binary
						? `bytes, as ${content.map(([type]) => `\`${type}\``).join(", ")}`
						: content.map(([type, each]) => `${typeOf(each.schema)} (\`${type}\`)`).join(", ");
			lines.push(`- \`${status}\`: ${shape}. ${answer.description ?? ""}`.trimEnd());
		}
		lines.push("");
	}

	const errors = Object.entries(operation.responses).filter(([status]) => Number(status) >= 400);
	if (errors.length > 0) {
		lines.push(
			`**Errors**: ${errors
				.map(([status, answer]) => {
					const code = /`([a-z_]+)`/.exec(answer.description ?? "")?.[1];
					return `\`${status}\`${code === undefined ? "" : ` ${code}`}`;
				})
				.join(", ")}. Each is an ${typeLink("ErrorBody")}.`,
			"",
		);
	}
	return lines;
}

const frontmatter = (title: string, description: string, order: number) => [
	"---",
	`title: ${JSON.stringify(title)}`,
	`description: ${JSON.stringify(description)}`,
	"sidebar:",
	`  order: ${order}`,
	"---",
	"",
	`<!-- Generated by docs/site/scripts/api-reference.ts from packages/api/generated/openapi.json. Don't edit: run \`node docs/site/scripts/api-reference.ts\`. -->`,
	"",
];

const pages = new Map<string, string>();

// One page per tag, its operations in the document's order.
const byTag = new Map<string, string[]>();
for (const [path, item] of Object.entries(document.paths)) {
	for (const method of METHODS) {
		const operation = item[method];
		if (operation === undefined) continue;
		const tag = operation.tags?.[0] ?? "other";
		const lines = byTag.get(tag) ?? [];
		lines.push(...operationSection(path, method, operation));
		byTag.set(tag, lines);
	}
}
let fallbackOrder = 50;
for (const [tag, sections] of byTag) {
	const known = TAGS[tag];
	const title = known?.title ?? tag;
	const lines = [...frontmatter(title, known?.about ?? `The ${tag} routes.`, known?.order ?? fallbackOrder++)];
	if (known?.about !== undefined) lines.push(known.about, "");
	if (known?.note !== undefined) lines.push(":::caution", known.note, ":::", "");
	lines.push(...sections);
	pages.set(`${tag}.md`, `${lines.join("\n").trimEnd()}\n`);
}

// Every named schema, alphabetically.
const types = [
	...frontmatter("Types", "Every named type in the public API, as the OpenAPI document defines it.", 98),
	"Every named schema in the OpenAPI document, alphabetically. Field types link to their own entries.",
	"",
];
for (const name of Object.keys(schemas).sort((a, b) => a.localeCompare(b))) {
	const schema = schemas[name];
	if (schema !== undefined) types.push(...typeSection(name, schema));
}
pages.set("types.md", `${types.join("\n").trimEnd()}\n`);

let stale = 0;
for (const [file, text] of pages) {
	const path = join(outDir, file);
	const name = relative(repository, path);
	if (check) {
		let current: string | undefined;
		try {
			current = readFileSync(path, "utf8");
		} catch {
			current = undefined;
		}
		if (current !== text) {
			stale += 1;
			console.error(`${name} is stale. Run \`node docs/site/scripts/api-reference.ts\` and commit the result.`);
		}
	} else {
		writeFileSync(path, text);
		console.log(`Wrote ${name}`);
	}
}
for (const file of readdirSync(outDir)) {
	if (file.endsWith(".md") && !HAND_WRITTEN.has(file) && !pages.has(file)) {
		stale += 1;
		console.error(`${relative(repository, join(outDir, file))} is no longer generated: delete it.`);
	}
}
if (stale > 0) process.exit(1);
if (check) console.log("The API reference pages are current.");
