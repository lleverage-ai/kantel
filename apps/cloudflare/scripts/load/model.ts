/**
 * The load test's scripted model (`scripts/load/README.md`): a CPA stand-in for `wrangler dev --env dev` with
 * `KANTEL_DEV_MODELS_URL` pointing here. Every call is answered from the conversation in its request, so any number of
 * sessions run side by side with no queue and no model spend, through the same model gateway, tools and transcript as
 * a real model's calls.
 *
 * A user message `load steps=<n> out=<bytes> write=<bytes> container=<bytes> text=<bytes>` runs `n` tool calls, in
 * turn: a `bash` command printing `out` bytes in the isolate, a `write` of a `write`-byte file, a `read` of it, and a
 * `bash` command in the container writing a `container`-byte file (staged back to the workspace by its checkpoint)
 * and printing `out` bytes. Then it answers with `text` bytes. Anything else is answered with a short text.
 *
 *   node scripts/load/model.ts [port]   (default 8798)
 */
import { createServer } from "node:http";
import { createFakeModelUpstream, type FakeUpstreamScript } from "@kantel/testing/models";

const port = Number(process.argv[2] ?? 8798);
const MODELS = [{ id: "claude-sonnet-5-5" }, { id: "claude-haiku-5" }];
/** CPA renames Kantel's tools for Claude; the gateway takes the prefix off again. */
const NS = "mcp__harbour__";

interface Block {
	readonly type: string;
	readonly text?: string;
	readonly name?: string;
}
interface Message {
	readonly role: string;
	readonly content: string | readonly Block[];
}

const filler = (bytes: number, salt: string) => {
	const line = `${salt} the quick brown fox jumps over the lazy dog 0123456789\n`;
	return line.repeat(Math.max(1, Math.ceil(bytes / line.length))).slice(0, bytes);
};

/** The next answer for an Anthropic Messages body. */
export function scriptFor(body: { messages?: readonly Message[] }): FakeUpstreamScript {
	const messages = body.messages ?? [];
	let start = messages.length - 1;
	const said = (message: Message | undefined) =>
		message === undefined
			? ""
			: typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text ?? "")
						.join("\n");
	while (start >= 0 && !(messages[start]?.role === "user" && said(messages[start]).trim() !== "")) start -= 1;
	const prompt = said(messages[start]).trim();
	const directive = /^load\b(.*)$/is.exec(prompt);
	if (directive === null) return { thinking: "", text: `Echo: ${prompt.slice(0, 200)}` };
	const arg = (name: string, fallback: number) =>
		Number(new RegExp(`${name}=(\\d+)`).exec(directive[1] ?? "")?.[1] ?? fallback);
	const steps = arg("steps", 8);
	const out = arg("out", 200_000);
	const write = arg("write", 100_000);
	const container = arg("container", 0);
	const text = arg("text", 4_000);
	const done = messages
		.slice(start + 1)
		.filter((message) => message.role === "assistant")
		.flatMap((message) => (typeof message.content === "string" ? [] : message.content))
		.filter((block) => block.type === "tool_use").length;
	const usage = { input: 2_000 + done * 500, output: 300, cacheRead: 20_000, cacheWrite: 0, reasoning: 0 };
	if (done >= steps) {
		return { thinking: "Done.", text: filler(text, `answer-${done}`), usage };
	}
	const id = `toolu_load_${done}_${Math.random().toString(36).slice(2, 10)}`;
	const lines = Math.max(1, Math.floor(out / 7));
	const kinds = container > 0 ? ["bash", "write", "read", "container"] : ["bash", "write", "read"];
	const kind = kinds[done % kinds.length];
	const file = `out/f${Math.floor(done / kinds.length)}.txt`;
	const call =
		kind === "bash"
			? { name: `${NS}bash`, arguments: { command: `seq 100000 ${100000 + lines}` } }
			: kind === "write"
				? { name: `${NS}write`, arguments: { path: file, content: filler(write, `step-${done}`) } }
				: kind === "read"
					? { name: `${NS}read`, arguments: { path: file } }
					: {
							name: `${NS}bash`,
							arguments: {
								command: `python3 -c "import os; os.makedirs('stage', exist_ok=True); open('stage/c${done}.bin','wb').write(os.urandom(${container})); print('x' * ${out})"`,
							},
						};
	return { thinking: `Step ${done + 1} of ${steps}.`, text: "", toolCall: { id, ...call }, usage };
}

const server = createServer(async (request, response) => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const raw = Buffer.concat(chunks);
	let script: FakeUpstreamScript | undefined;
	if (request.method === "POST" && raw.length > 0) {
		try {
			script = scriptFor(JSON.parse(raw.toString("utf8")));
		} catch {
			script = undefined;
		}
	}
	// One fake per call: it records what it is sent, and these bodies grow with every turn.
	const fake = createFakeModelUpstream({ models: MODELS, ...(script === undefined ? {} : { script }) });
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
	const answer = await fake.fetch(`http://cpa.local${request.url}`, {
		method: request.method,
		headers,
		...(raw.length > 0 && request.method !== "GET" ? { body: raw } : {}),
	});
	response.writeHead(answer.status, Object.fromEntries(answer.headers));
	if (answer.body === null) return void response.end();
	for await (const chunk of answer.body) response.write(chunk);
	response.end();
});
server.listen(port, "127.0.0.1", () => console.log(`load model on http://127.0.0.1:${port}`));
