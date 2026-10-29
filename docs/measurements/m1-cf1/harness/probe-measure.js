// One probe: a warm `tools` call on a session that doesn't exist, to see which gateway validation answers.
const r = await fetch("/v1/measurements/isolate-ready", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ sessionId: "00000000-0000-0000-0000-000000000000", tools: true }),
});
return { summary: { status: r.status, body: await r.text(), at: new Date().toISOString() } };
