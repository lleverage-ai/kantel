// Whether a gateway's data outlives its process, in two halves around a restart or a replaced pod:
//
//   bun apps/selfhosted/test/gateway/kept.ts record --base-url <url> --state <file> [--exec "<command>"]
//   ... restart the gateway ...
//   bun apps/selfhosted/test/gateway/kept.ts check --base-url <url> --state <file> [--exec "<command>"]
//
// `record` makes a session with the bootstrap's key, prompts it, waits for the answer and writes the session, the
// submission and the answer to --state. `check` reads that same session back: it is listed, its submission still has
// the same answer, and its audit rows are still there. The bootstrap is read in the gateway's container, with
// `docker compose exec` or the command --exec names (as stack.ts does). Prints one line per check; exits 1 if any
// failed.
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		"base-url": { type: "string", default: "http://127.0.0.1:58090" },
		state: { type: "string" },
		compose: { type: "string", default: "deploy/compose/compose.yaml" },
		exec: { type: "string" },
	},
});
const mode = positionals[0];
const statePath = values.state;
if ((mode !== "record" && mode !== "check") || statePath === undefined) {
	console.error("usage: kept.ts record|check --base-url <url> --state <file> [--exec <command>]");
	process.exit(2);
}
const baseUrl = values["base-url"];

const [execFile = "docker", ...execArgs] = values.exec?.trim().split(/\s+/) ?? [
	"docker",
	"compose",
	"-f",
	values.compose,
	"exec",
	"-T",
	"gateway",
];
const read = spawnSync(execFile, [...execArgs, "cat", "/var/lib/harbour/bootstrap.json"], { encoding: "utf8" });
if (read.status !== 0) {
	console.error(`could not read the gateway's bootstrap: ${read.stderr.trim()}`);
	process.exit(2);
}
const { apiKey, projectId } = JSON.parse(read.stdout) as { apiKey: string; projectId: string };

interface Kept {
	readonly sessionId: string;
	readonly submissionId: string;
	readonly answer: string;
}

const call = async (path: string, init: RequestInit = {}) => {
	const response = await fetch(`${baseUrl}${path}`, {
		...init,
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
	});
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {}
	return { status: response.status, body };
};

const result = (kept: Pick<Kept, "sessionId" | "submissionId">, timeoutMs: number) =>
	call(
		`/v1/sessions/${encodeURIComponent(kept.sessionId)}/result?submission=${encodeURIComponent(kept.submissionId)}&timeoutMs=${timeoutMs}`,
	);

const checks: { name: string; ok: boolean; detail?: unknown }[] = [];

if (mode === "record") {
	const created = await call("/v1/sessions", {
		method: "POST",
		body: JSON.stringify({ projectId, agentId: "echo", title: "kept across a restart" }),
	});
	const sessionId = (created.body as { id?: string }).id ?? "";
	checks.push({ name: "POST /v1/sessions creates the session to keep", ok: created.status === 201, detail: created });
	const prompted = await call(`/v1/sessions/${encodeURIComponent(sessionId)}/prompt`, {
		method: "POST",
		body: JSON.stringify({ text: "remember this across a restart", requestId: "kept-1" }),
	});
	const submissionId = (prompted.body as { id?: string }).id ?? "";
	checks.push({ name: "POST …/prompt is accepted", ok: prompted.status === 202, detail: prompted });
	let answered = { status: 0, body: {} as unknown };
	for (let attempt = 0; attempt < 20 && answered.status !== 200; attempt++) {
		answered = await result({ sessionId, submissionId }, 5000);
	}
	const answer = (answered.body as { status?: string; answer?: string }).answer ?? "";
	checks.push({
		name: "the prompt is answered",
		ok: (answered.body as { status?: string }).status === "answered" && answer !== "",
		detail: answered,
	});
	await writeFile(statePath, JSON.stringify({ sessionId, submissionId, answer } satisfies Kept));
} else {
	const kept = JSON.parse(await readFile(statePath, "utf8")) as Kept;
	const listed = await call(`/v1/sessions?projectId=${encodeURIComponent(projectId)}`);
	checks.push({
		name: "GET /v1/sessions still lists the kept session",
		ok:
			listed.status === 200 &&
			((listed.body as { items?: { id: string }[] }).items ?? []).some((item) => item.id === kept.sessionId),
		detail: { status: listed.status },
	});
	const answered = await result(kept, 1000);
	const body = answered.body as { status?: string; answer?: string };
	checks.push({
		name: "GET …/result still has the kept submission's answer",
		ok: answered.status === 200 && body.status === "answered" && body.answer === kept.answer,
		detail: answered,
	});
	const audit = await call(`/v1/audit/events?sessionId=${encodeURIComponent(kept.sessionId)}`);
	const types = ((audit.body as { items?: { type: string }[] }).items ?? []).map((row) => row.type);
	checks.push({
		name: "GET /v1/audit/events still has the kept session's rows",
		ok: audit.status === 200 && types.includes("session.created") && types.includes("session.prompted"),
		detail: { status: audit.status, types },
	});
}

for (const check of checks) {
	console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}${check.ok ? "" : `: ${JSON.stringify(check.detail)}`}`);
}
process.exit(checks.every((check) => check.ok) ? 0 : 1);
