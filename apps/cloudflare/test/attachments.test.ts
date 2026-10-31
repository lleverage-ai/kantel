// Prompt attachments on the stack: the console uploads a file to its project (`POST /v1/attachments`), the prompt names
// it, and the model reads it as content: a text file's text, a PDF's text (pdf.js, through unpdf) and an image as an
// image. What the model can't read is refused at upload, with a reason the composer shows on the file's card.
import { createMockAccess } from "@kantel/identity/testing";
import { createMemoryObjectBucket } from "@kantel/skills/sql";
import { afterEach, describe, expect, it } from "vitest";
import { createAttachmentStore, formatOf, MAX_IMAGE_BYTES, MESSAGE_BUDGET, storedType } from "../src/attachments.ts";
import { gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { ATTACHMENTS_PATH, MAX_ATTACHMENT_BYTES, routeRequest, STACK_NAME } from "../src/route.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";
const BASE = "https://harbour.test";

const encoder = new TextEncoder();

/** A one-page PDF whose page says `text`, with a correct cross-reference table. */
function pdfSaying(text: string): Uint8Array<ArrayBuffer> {
	const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((object, index) => {
		offsets.push(body.length);
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return encoder.encode(body);
}

/** The smallest PNG: one transparent pixel. */
const PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
	(char) => char.charCodeAt(0),
);

const session = (projectId: string) =>
	({ id: "s1", organisationId: "org", projectId }) as unknown as Parameters<
		ReturnType<typeof createAttachmentStore>["reader"]["read"]
	>[1];
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: "org" } as const;

describe("the attachment store", () => {
	it("types a file from its name when the browser gives none, and knows what the model can read", () => {
		expect(storedType("notes.md", "")).toBe("text/plain");
		expect(storedType("report.PDF", "application/octet-stream")).toBe("application/pdf");
		expect(storedType("cat.png", "image/png")).toBe("image/png");
		expect(storedType("a.txt", "text/plain;charset=utf-8")).toBe("text/plain");
		expect(formatOf("a.json", "application/json")).toBe("text");
		expect(formatOf("cat.png", "image/png")).toBe("image");
		expect(formatOf("x.pdf", "application/pdf")).toBe("pdf");
		expect(formatOf("photo.heic", "image/heic")).toBeUndefined();
		expect(formatOf("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe(
			undefined,
		);
	});

	it("reads text, a PDF's text and an image for the model, framed by name, from the session's project only", async () => {
		const store = createAttachmentStore({ objects: createMemoryObjectBucket() });
		const scope = { organisationId: "org", projectId: "proj" };
		const notes = await store.put(scope, {
			name: "notes.md",
			type: "text/markdown",
			bytes: encoder.encode("# Plan\nShip it"),
		});
		const report = await store.put(scope, {
			name: "report.pdf",
			type: "application/pdf",
			bytes: pdfSaying("The harbour opens at dawn"),
		});
		const photo = await store.put(scope, { name: "dot.png", type: "image/png", bytes: PNG });
		expect(notes).toMatchObject({ name: "notes.md", type: "text/markdown", kind: "file", size: 14 });
		expect(photo).toMatchObject({ kind: "image", type: "image/png" });

		const read = await store.reader.read(ctx, session("proj"), [notes, report, photo]);
		expect(read.attachments).toEqual([notes, report, photo]);
		expect(read.blocks).toEqual([
			{ type: "text", text: '<file name="notes.md" type="text/markdown">\n# Plan\nShip it\n</file>' },
			{ type: "text", text: expect.stringContaining("The harbour opens at dawn") },
			{ type: "text", text: '<file name="dot.png" type="image/png">' },
			{ type: "image", data: btoa(String.fromCharCode(...PNG)), mimeType: "image/png" },
			{ type: "text", text: "</file>" },
		]);
		expect(read.blocks[1]).toMatchObject({
			text: expect.stringMatching(/^<file name="report.pdf" type="application\/pdf">/),
		});
		// The files as uploaded, for the session's files: the PDF itself, not its text.
		expect(read.files).toEqual([
			{ attachment: notes, bytes: encoder.encode("# Plan\nShip it") },
			{ attachment: report, bytes: pdfSaying("The harbour opens at dawn") },
			{ attachment: photo, bytes: PNG },
		]);

		// Another project's session can't read them, and an ID is never a path.
		await expect(store.reader.read(ctx, session("other"), [notes])).rejects.toThrow("No attachment");
		await expect(store.reader.read(ctx, session("proj"), [{ ...notes, id: "../x" }])).rejects.toThrow("No attachment");
	});

	it("refuses what the model can't read, with a reason a person can act on", async () => {
		const store = createAttachmentStore({ objects: createMemoryObjectBucket() });
		const scope = { organisationId: "org", projectId: "proj" };
		const put = (name: string, type: string, bytes: Uint8Array) => store.put(scope, { name, type, bytes });
		await expect(put("a.heic", "image/heic", PNG)).rejects.toThrow("isn't a type the model can read");
		await expect(put("empty.txt", "text/plain", new Uint8Array())).rejects.toThrow("is empty");
		await expect(put("big.png", "image/png", new Uint8Array(MAX_IMAGE_BYTES + 1))).rejects.toThrow("Scale it down");
		await expect(put("bin.txt", "text/plain", Uint8Array.of(1, 0, 2))).rejects.toThrow("isn't a text file");
		await expect(put("broken.pdf", "application/pdf", encoder.encode("not a pdf"))).rejects.toThrow(
			"couldn't be read as a PDF",
		);
		await expect(put("scan.pdf", "application/pdf", pdfSaying(""))).rejects.toThrow("has no text to read");
	});

	it("cuts a long text where the message's budget runs out, and says so", async () => {
		const store = createAttachmentStore({ objects: createMemoryObjectBucket() });
		const long = await store.put(
			{ organisationId: "org", projectId: "proj" },
			{ name: "log.txt", type: "text/plain", bytes: encoder.encode("x".repeat(MESSAGE_BUDGET + 10)) },
		);
		const read = await store.reader.read(ctx, session("proj"), [long]);
		const text = (read.blocks[0] as { text: string }).text;
		expect(text.length).toBeLessThan(MESSAGE_BUDGET);
		expect(text).toContain(`[Cut short: the first`);
	});
});

describe("attachments through the gateway", () => {
	const opened: Stack[] = [];
	afterEach(async () => {
		for (const stack of opened.splice(0)) await stack.close();
	});

	async function setup() {
		const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
		const config = gatewayConfig({
			KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
			KANTEL_ACCESS_AUD: AUD,
			KANTEL_ADMIN_EMAIL: ADMIN,
		});
		const stack = await createStack({ config, accessFetch: mock.fetch });
		opened.push(stack);
		const gateway = createGateway(stack);
		const headers = { "cf-access-jwt-assertion": await mock.sign({ sub: "access-subject-1", email: ADMIN }) };
		const call = (path: string, init: RequestInit = {}) =>
			gateway.fetch(new Request(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }));
		return { stack, call };
	}

	const upload = (
		call: (path: string, init?: RequestInit) => Promise<Response>,
		projectId: string,
		name: string,
		type: string,
		body: Uint8Array<ArrayBuffer>,
	) =>
		call(`${ATTACHMENTS_PATH}?${new URLSearchParams({ projectId, name })}`, {
			method: "POST",
			headers: { "content-type": type },
			body,
		});

	it("uploads a text file and a PDF, and the next prompt's model reads them before the words", async () => {
		const { stack, call } = await setup();
		const projectId = stack.project.id;
		const notes = await upload(call, projectId, "notes.txt", "text/plain", encoder.encode("The code word is heron."));
		expect(notes.status).toBe(201);
		const report = await upload(call, projectId, "report.pdf", "application/pdf", pdfSaying("Tide at noon"));
		expect(report.status).toBe(201);
		const attachments = [await notes.json(), await report.json()];

		const created = await call("/v1/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ projectId, agentId: DEFAULT_AGENT_ID }),
		});
		const { id } = (await created.json()) as { id: string };
		const prompted = await call(`/v1/sessions/${id}/prompt`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "What do they say?", attachments }),
		});
		expect(prompted.status).toBe(202);
		const submission = (await prompted.json()) as { id: string };
		const result = await call(
			`/v1/sessions/${id}/result?submission=${encodeURIComponent(submission.id)}&timeoutMs=5000`,
		);
		const answer = ((await result.json()) as { answer: string }).answer;
		// The echo model repeats the user message's text: the files' first, then the words.
		expect(answer).toContain("The code word is heron.");
		expect(answer).toContain("Tide at noon");
		expect(answer.indexOf("heron")).toBeLessThan(answer.indexOf("What do they say?"));
		// Each file is saved in the session's files too, and the model is told where, so its tools can use it.
		expect(answer).toContain("uploads/notes.txt (attached as notes.txt)");
		expect(answer).toContain("uploads/report.pdf (attached as report.pdf)");

		// The transcript shows the words, with the files named beside them.
		const snapshot = (await (await call(`/v1/sessions/${id}/snapshot`)).json()) as {
			items: { kind: string; text?: string; attachments?: { name: string }[] }[];
		};
		const user = snapshot.items.find((item) => item.kind === "user");
		expect(user?.text).toBe("What do they say?");
		expect(user?.attachments?.map((attachment) => attachment.name)).toEqual(["notes.txt", "report.pdf"]);
	});

	it("serves a stored file back to the project's viewers, never as HTML", async () => {
		const { stack, call } = await setup();
		const projectId = stack.project.id;
		const image = (await (await upload(call, projectId, "cat.png", "image/png", PNG)).json()) as { id: string };
		const page = (await (
			await upload(call, projectId, "page.html", "text/html", encoder.encode("<script>alert(1)</script>"))
		).json()) as { id: string };

		const read = await call(`${ATTACHMENTS_PATH}/${image.id}?projectId=${encodeURIComponent(projectId)}`);
		expect(read.status).toBe(200);
		expect(read.headers.get("content-type")).toBe("image/png");
		expect(read.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG);

		const html = await call(`${ATTACHMENTS_PATH}/${page.id}?projectId=${encodeURIComponent(projectId)}`);
		expect(html.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(html.headers.get("content-security-policy")).toContain("sandbox");
		expect(await html.text()).toBe("<script>alert(1)</script>");

		// Another project's ID, a made-up one and a path are all refused.
		const elsewhere = await call(`${ATTACHMENTS_PATH}/${image.id}?projectId=another-project`);
		expect(elsewhere.ok).toBe(false);
		const missing = await call(`${ATTACHMENTS_PATH}/no-such-file?projectId=${encodeURIComponent(projectId)}`);
		expect(missing.status).toBe(404);
		const traversal = await call(`${ATTACHMENTS_PATH}/..%2F..%2Fx?projectId=${encodeURIComponent(projectId)}`);
		expect(traversal.status).toBe(404);

		const anonymous = await createGateway(stack).fetch(
			new Request(`${BASE}${ATTACHMENTS_PATH}/${image.id}?projectId=${encodeURIComponent(projectId)}`),
		);
		expect(anonymous.status).toBe(401);
	});

	it("refuses a type the model can't read, and a caller who isn't signed in", async () => {
		const { stack, call } = await setup();
		const refused = await upload(call, stack.project.id, "deck.pptx", "application/vnd.ms-powerpoint", PNG);
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
			"isn't a type the model can read",
		);
		const gateway = createGateway(stack);
		const anonymous = await gateway.fetch(
			new Request(`${BASE}${ATTACHMENTS_PATH}?projectId=${stack.project.id}&name=a.txt`, {
				method: "POST",
				body: "hello",
			}),
		);
		expect(anonymous.status).toBe(401);
	});

	it("refuses a body over 20 MB at the Worker, before the stack reads it", async () => {
		const forwarded: Request[] = [];
		const stub = {
			fetch: async (request: Request) => {
				forwarded.push(request);
				return new Response("ok");
			},
		};
		const env = {
			STACK: { idFromName: (name: string) => name, get: () => stub },
			VAULTS: { idFromName: (name: string) => name, get: () => stub },
			ASSETS: stub,
		};
		const big = await routeRequest(
			new Request(`${BASE}${ATTACHMENTS_PATH}?projectId=p&name=a.txt`, {
				method: "POST",
				body: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
			}),
			env,
		);
		expect(big.status).toBe(413);
		const small = await routeRequest(
			new Request(`${BASE}${ATTACHMENTS_PATH}?projectId=p&name=a.txt`, { method: "POST", body: "hello" }),
			env,
		);
		expect(small.status).toBe(200);
		expect(forwarded).toHaveLength(1);
		expect(STACK_NAME).toBe("m1");
	});
});
