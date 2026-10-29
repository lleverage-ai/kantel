// Counts the sessions in the default project through the session API, following every cursor; with args.before
// (ISO times), also how many existed at each of those times (by createdAt).
const befores = args.before ?? [];
const at = Object.fromEntries(befores.map((b) => [b, 0]));
const projects = await (await fetch("/v1/projects")).json();
const projectId = (projects.items ?? projects)[0].id;
let cursor;
let total = 0;
let open = 0;
const t0 = performance.now();
do {
	const url = new URL("/v1/sessions", location.href);
	url.searchParams.set("projectId", projectId);
	url.searchParams.set("limit", "100");
	if (cursor) url.searchParams.set("cursor", cursor);
	const page = await (await fetch(url)).json();
	total += page.items.length;
	open += page.items.filter((s) => s.status !== "done").length;
	for (const s of page.items) for (const b of befores) if (new Date(s.createdAt) < new Date(b)) at[b]++;
	cursor = page.nextCursor ?? page.cursor;
} while (cursor);
return { summary: { projectId, total, open, at, ms: Math.round(performance.now() - t0) } };
