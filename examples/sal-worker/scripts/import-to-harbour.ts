/**
 * Loads a Sal worker's skills and memory into a deployed Harbour through its public API, so the console has them to
 * show. It reads what `harbour-sal.ts` reads (the same config: the sal-memory clone at a commit and the skill sources
 * in Pi's order, at pinned refs, with Sal's worker exclusions), then:
 *
 * - imports each skill with `POST /v1/skills/import`, owned by the caller's organisation, with its source and ref and
 *   the `sal` extension, so a second run at the same refs publishes nothing new;
 * - creates the memory space (`POST /v1/memory/spaces`) unless one of that name exists, and loads the bundle into it
 *   with `POST /v1/memory/spaces/{spaceId}/snapshot`.
 *
 * Both need a person with the organisation's admin role on Cloudflare. Run with Node 24:
 *
 *   node examples/sal-worker/scripts/import-to-harbour.ts --config sal.json --url https://harbour.example \
 *     --header "Cf-Access-Jwt-Assertion: <token>"
 *
 * `--out <file>` writes the requests as JSON instead of sending them (`{ organisation, skills, space, snapshot }`, with
 * `<organisation>` standing in for the owner's organisation), to send from somewhere already signed in. `--space`
 * names the memory space (default "Sal memory"). Nothing it reads is written anywhere else: the content is the
 * owner's, so keep it out of the repository.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHarbourClient, type ImportSkillBody } from "@harbour/api/sdk";
import type { MemorySnapshot, MeResponse, OwnerRef } from "@harbour/contracts";
import { type DiscoveryMode, directorySkillSource, gitSkillSource } from "../src/skill-sources.ts";
import { prepareSalWorker } from "../src/worker.ts";

interface ImportConfig {
	readonly memory: { readonly repo: string; readonly ref: string; readonly bundleDir?: string };
	readonly skills: readonly (
		| {
				readonly id: string;
				readonly git: string;
				readonly paths: readonly string[];
				readonly ref?: string;
				readonly mode?: DiscoveryMode;
		  }
		| { readonly id: string; readonly dir: string; readonly ref?: string; readonly mode?: DiscoveryMode }
	)[];
	readonly exclude?: readonly string[];
}

const ORGANISATION = "<organisation>";

const { values } = parseArgs({
	options: {
		config: { type: "string" },
		url: { type: "string" },
		header: { type: "string", multiple: true },
		token: { type: "string" },
		space: { type: "string" },
		out: { type: "string" },
	},
});
if (values.config === undefined) throw new Error("--config is required");
if (values.url === undefined && values.out === undefined) throw new Error("--url or --out is required");
const configPath = resolve(values.config);
const base = dirname(configPath);
const config = JSON.parse(readFileSync(configPath, "utf8")) as ImportConfig;
const spaceName = values.space ?? "Sal memory";

const host = await prepareSalWorker({
	organisationId: ORGANISATION,
	memory: { ...config.memory, repo: resolve(base, config.memory.repo) },
	skills: config.skills.map((entry) => {
		const source =
			"git" in entry
				? gitSkillSource({ id: entry.id, repo: resolve(base, entry.git), paths: entry.paths, mode: entry.mode ?? "pi" })
				: directorySkillSource({ id: entry.id, root: resolve(base, entry.dir), mode: entry.mode ?? "pi" });
		return entry.ref === undefined ? { source } : { source, ref: entry.ref };
	}),
	...(config.exclude === undefined ? {} : { exclude: config.exclude }),
});

/** Every skill as published locally, ready to import under `owner`. */
async function skillBodies(owner: OwnerRef): Promise<ImportSkillBody[]> {
	const bodies: ImportSkillBody[] = [];
	let cursor: string | undefined;
	do {
		const page = await host.skills.list(host.ctx, {}, cursor === undefined ? { limit: 100 } : { limit: 100, cursor });
		for (const listing of page.items) {
			const revision = await host.skills.getRevision(host.ctx, listing.skillId, listing.revision);
			if (revision.source === undefined) throw new Error(`${listing.name} has no source`);
			const files = await Promise.all(
				revision.files.map(async ({ path }) => ({
					path,
					content: await host.skills.readFile(host.ctx, listing.skillId, listing.revision, path),
				})),
			);
			bodies.push({
				owner,
				name: revision.name,
				description: revision.description,
				files,
				source: revision.source,
				...(revision.extensions === undefined ? {} : { extensions: revision.extensions }),
			});
		}
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return bodies;
}

const snapshot: MemorySnapshot = host.bundle.snapshot;
const summary = {
	skills: 0,
	concepts: snapshot.concepts.length,
	memoryRef: snapshot.ref,
	refused: host.bundle.refused.length,
};

if (values.out !== undefined) {
	const skills = await skillBodies({ kind: "organisation", organisationId: ORGANISATION });
	writeFileSync(values.out, JSON.stringify({ organisation: ORGANISATION, skills, space: spaceName, snapshot }));
	console.log(JSON.stringify({ ...summary, skills: skills.length, out: values.out }));
} else {
	const url = (values.url ?? "").replace(/\/+$/, "");
	const headers: Record<string, string> = {};
	for (const header of values.header ?? []) {
		const at = header.indexOf(":");
		if (at < 1) throw new Error(`--header ${JSON.stringify(header)} is not "Name: value"`);
		headers[header.slice(0, at).trim()] = header.slice(at + 1).trim();
	}
	if (values.token !== undefined) headers.authorization = `Bearer ${values.token}`;
	const meResponse = await fetch(`${url}/v1/me`, { headers });
	if (!meResponse.ok) throw new Error(`GET /v1/me answered ${meResponse.status}`);
	const me = (await meResponse.json()) as MeResponse;
	const harbour = createHarbourClient({ baseUrl: `${url}/v1`, headers: () => headers });
	const owner: OwnerRef = { kind: "organisation", organisationId: me.organisationId };

	let published = 0;
	for (const body of await skillBodies(owner)) {
		const revision = await harbour.importSkill(body);
		published += 1;
		console.error(`skill ${body.name}: revision ${revision.revision}`);
	}

	const spaces = await harbour.listMemorySpaces({ limit: 100 });
	const space =
		spaces.items.find((item) => item.name === spaceName && item.owner.kind === "organisation") ??
		(await harbour.createMemorySpace({ owner, name: spaceName }));
	const loaded = await harbour.importMemorySnapshot(space.id, snapshot);
	console.log(JSON.stringify({ ...summary, skills: published, spaceId: loaded.id, snapshot: loaded.snapshot }));
}
