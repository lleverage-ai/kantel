/**
 * Loads a Sal worker's skills and memory into a deployed Kantel through its public API, so the console has them to
 * show. It reads what `kantel-sal.ts` reads (the same config: the sal-memory clone at a commit and the skill sources
 * in Pi's order, at pinned refs, with Sal's worker exclusions), then:
 *
 * - imports each skill with `POST /v1/skills/import`, owned by the caller's organisation, with its source and ref and
 *   the `sal` extension, so a second run at the same refs publishes nothing new;
 * - creates the memory space (`POST /v1/memory/spaces`) unless one of that name exists, and loads the bundle into it
 *   with `POST /v1/memory/spaces/{spaceId}/snapshot`.
 *
 * With `--profile <agent ID>` it then names them on that agent's profile (`PUT /v1/profiles/{agentId}`), so its new
 * sessions list the skills and recall from the space: the skills a Sal worker's prompt lists (those whose
 * `disable-model-invocation` is not set, as Pi leaves those out), and the space beside the profile's other memory scopes.
 *
 * The Kantel and the credentials come from the environment, never the command line or the repository:
 *
 * - `KANTEL_URL`: the Kantel's base URL, such as `https://harbour.example` (or `--url`);
 * - `KANTEL_API_KEY`: an `hbr_` key, sent as `Authorization: Bearer`; the normal path;
 * - `KANTEL_ACCESS_TOKEN`: a signed-in person's Cloudflare Access token, sent as `Cf-Access-Jwt-Assertion`.
 *
 * Importing skills and snapshots is the organisation admin's, or a key's that carries the `import` permission (minted by
 * an organisation admin: `POST /v1/keys` with `"permissions": ["import"]`, see the README). That permission covers the
 * two imports only, so the memory space must exist first: an admin makes it once, or a signed-in admin's first run
 * does. An `operator` key on the project also sets the profile. Run with Node 24:
 *
 *   KANTEL_URL=https://harbour.example KANTEL_API_KEY=<key> \
 *     node examples/sal-worker/scripts/import-to-kantel.ts --config sal.json --profile assistant
 *
 * `--out <file>` writes the requests as JSON instead of sending them (`{ organisation, skills, space, snapshot }`, with
 * `<organisation>` standing in for the owner's organisation), to send from somewhere already signed in. `--space`
 * names the memory space (default "Sal memory"). `--header "Name: value"` adds a header to every request. Nothing it
 * reads is written anywhere else: the content is the owner's, so keep it out of the repository.
 */
// First: HARBOUR_URL and the other HARBOUR_* names from before the rename still count (TASK-4231).
import "@kantel/contracts/legacy-env";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createKantelClient, type ImportSkillBody, KantelApiError } from "@kantel/api/sdk";
import type { AgentProfile, MemorySnapshot, MeResponse, OwnerRef } from "@kantel/contracts";
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
		space: { type: "string" },
		profile: { type: "string" },
		out: { type: "string" },
	},
});
if (values.config === undefined) throw new Error("--config is required");
const kantelUrl = values.url ?? process.env.KANTEL_URL;
if (kantelUrl === undefined && values.out === undefined) throw new Error("set KANTEL_URL (or --url), or --out");
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

/** Whether Pi lists a skill in the prompt: not when its frontmatter sets `disable-model-invocation`. */
function listedByPi(extensions: ImportSkillBody["extensions"]): boolean {
	const sal = extensions?.sal as { readonly disableModelInvocation?: boolean } | undefined;
	return sal?.disableModelInvocation !== true;
}

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
	const url = (kantelUrl ?? "").replace(/\/+$/, "");
	const headers: Record<string, string> = {};
	for (const header of values.header ?? []) {
		const at = header.indexOf(":");
		if (at < 1) throw new Error(`--header ${JSON.stringify(header)} is not "Name: value"`);
		headers[header.slice(0, at).trim()] = header.slice(at + 1).trim();
	}
	const apiKey = process.env.KANTEL_API_KEY;
	if (apiKey !== undefined && apiKey !== "") headers.authorization = `Bearer ${apiKey}`;
	const accessToken = process.env.KANTEL_ACCESS_TOKEN;
	if (accessToken !== undefined && accessToken !== "") headers["cf-access-jwt-assertion"] = accessToken;
	const meResponse = await fetch(`${url}/v1/me`, { headers });
	if (!meResponse.ok) throw new Error(`GET /v1/me answered ${meResponse.status}`);
	const me = (await meResponse.json()) as MeResponse;
	const harbour = createKantelClient({ baseUrl: `${url}/v1`, headers: () => headers });
	const owner: OwnerRef = { kind: "organisation", organisationId: me.organisationId };

	let published = 0;
	const listed: string[] = [];
	for (const body of await skillBodies(owner)) {
		const revision = await harbour.importSkill(body);
		published += 1;
		if (listedByPi(body.extensions)) listed.push(body.name);
		console.error(`skill ${body.name}: revision ${revision.revision}`);
	}

	const spaces = await harbour.listMemorySpaces({ limit: 100 });
	const space =
		spaces.items.find((item) => item.name === spaceName && item.owner.kind === "organisation") ??
		(await harbour.createMemorySpace({ owner, name: spaceName }).catch((error: unknown) => {
			if (!(error instanceof KantelApiError) || error.status !== 403) throw error;
			throw new Error(
				`There is no memory space "${spaceName}", and this caller may not make one: an organisation admin makes it once (see the README)`,
				{ cause: error },
			);
		}));
	const loaded = await harbour.importMemorySnapshot(space.id, snapshot);

	let profile: { readonly agentId: string; readonly skills: number; readonly memoryScopes: number } | undefined;
	if (values.profile !== undefined) {
		const path = `${url}/v1/profiles/${encodeURIComponent(values.profile)}`;
		const got = await fetch(path, { headers });
		if (!got.ok) throw new Error(`GET /v1/profiles/${values.profile} answered ${got.status}`);
		const current = (await got.json()) as AgentProfile;
		const next: AgentProfile = {
			...current,
			skills: listed.sort(),
			memoryScopes: [...new Set([...current.memoryScopes, loaded.id])],
		};
		const put = await fetch(path, {
			method: "PUT",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify(next),
		});
		if (!put.ok) throw new Error(`PUT /v1/profiles/${values.profile} answered ${put.status}: ${await put.text()}`);
		profile = { agentId: next.id, skills: next.skills.length, memoryScopes: next.memoryScopes.length };
	}
	console.log(
		JSON.stringify({
			...summary,
			skills: published,
			spaceId: loaded.id,
			snapshot: loaded.snapshot,
			...(profile === undefined ? {} : { profile }),
		}),
	);
}
