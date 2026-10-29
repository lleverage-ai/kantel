// Smoke test of the coding tools through the model on the deployed stack: a session on the measurement workspace is
// asked to read a file, then run a command; the transcript and the session's audit events show which tools ran and
// when its lease was acquired. args: { workspaceFrom } (a measurement session whose workspace to use)
const json = { "content-type": "application/json" };
const projects = await (await fetch("/v1/projects")).json();
const projectId = (projects.items ?? projects)[0].id;
const from = await (await fetch(`/v1/sessions/${args.workspaceFrom}`)).json();
const workspaceId = from.workspaceId;
const created = await fetch("/v1/sessions", {
	method: "POST",
	headers: json,
	body: JSON.stringify({ projectId, agentId: "assistant", title: "Coding tools smoke test", workspaceId, labels: { measurement: "tools-smoke" } }),
});
const session = await created.json();
const audit = async () =>
	(await (await fetch(`/v1/audit/events?sessionId=${session.id}&limit=50`)).json()).items?.map((e) => ({ at: e.at, type: e.type, actor: e.actor?.kind })) ?? [];
const afterCreate = await audit();
const prompt = await fetch(`/v1/sessions/${session.id}/prompt`, {
	method: "POST",
	headers: json,
	body: JSON.stringify({
		text: "First use the read tool to read src/file-00.txt. Then use the bash tool to run: ls src | wc -l. Reply with the file's text and the number.",
		requestId: crypto.randomUUID(),
	}),
});
let status;
const t0 = performance.now();
for (let i = 0; i < 120; i++) {
	await new Promise((r) => setTimeout(r, 1000));
	status = (await (await fetch(`/v1/sessions/${session.id}`)).json()).status;
	if (status !== "running") break;
}
const elapsed = Math.round(performance.now() - t0);
const history = await (await fetch(`/v1/sessions/${session.id}/history?limit=50`)).json();
const afterRun = await audit();
const close = await fetch(`/v1/sessions/${session.id}/close`, { method: "POST", headers: json, body: "{}" });
const afterClose = await audit();
return {
	sessionId: session.id,
	workspaceId,
	createStatus: created.status,
	promptStatus: prompt.status,
	history,
	afterCreate,
	afterRun,
	afterClose,
	summary: {
		sessionId: session.id,
		status,
		elapsed,
		closeStatus: close.status,
		leasesAfterCreate: afterCreate.filter((e) => e.type.startsWith("sandbox.lease")).length,
		afterRun: afterRun.map((e) => `${e.type}/${e.actor}`),
		afterClose: afterClose.map((e) => `${e.type}/${e.actor}`),
	},
};
