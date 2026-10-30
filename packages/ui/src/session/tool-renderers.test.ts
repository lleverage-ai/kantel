import type { PresentedFile, ToolItem, TranscriptItem } from "@harbour/protocol";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { assistant, tool, user } from "./fixtures.ts";
import { ToolCallChip } from "./tool-call.tsx";
import { type ToolRenderer, ToolRenderersContext, toolRenderers } from "./tool-renderer-model.ts";
import { DEFAULT_TOOL_RENDERERS, defaultToolRenderers } from "./tool-renderers.tsx";
import { Transcript, type TranscriptProps } from "./transcript.tsx";
import { groupTranscript } from "./transcript-model.ts";

// The registry decides how a call shows; these render the transcript as a page gets it and count what is in it.

// The virtualiser renders no rows on a server; here every row renders, in order.
vi.mock("virtua", () => ({
	VList: ({ data, children }: { data: readonly unknown[]; children: (entry: unknown, index: number) => ReactNode }) =>
		createElement("div", null, ...data.map((entry, index) => children(entry, index))),
}));

const poster = (slug: string): PresentedFile => ({
	workspaceId: "ws-1",
	path: `images/${slug}.png`,
	name: `${slug}.png`,
	mimeType: "image/png",
	size: 1_800_000,
});
const posters = ["navy-isometric", "retro-screen-print", "bauhaus-geometric", "neon-noir"].map(poster);

const presenting = (id: string, status: ToolItem["status"] = "done"): ToolItem => ({
	...tool(id, "present_files", "Presenting 4 files", {
		status,
		args: { filepaths: posters.map((file) => `/workspace/${file.path}`) },
		output: "Presented 4 files",
	}),
	...(status === "done" ? { files: posters } : {}),
});

// The reference turn (30 Oct 2026): the agent says what it will do, presents four images, and answers about them.
const referenceTurn = (call: ToolItem): TranscriptItem[] => [
	user("u1", "Make four posters"),
	assistant("a0", "I'll generate 4 distinct variations."),
	call,
	assistant("a1", "I generated 4 new poster iterations."),
];

const generated = (id: string, file: PresentedFile, status: ToolItem["status"] = "done"): ToolItem => ({
	...tool(id, "generate_image", "Making an image", { status, args: { prompt: file.name, aspect: "portrait" } }),
	...(status === "done"
		? { files: [{ ...file, model: "gpt-image-1" }], images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }] }
		: {}),
});

const render = (props: TranscriptProps) => renderToStaticMarkup(createElement(Transcript, props));
const count = (html: string, text: string) => html.split(text).length - 1;

describe("the tool renderer registry", () => {
	it("renders present_files once, as its files' cards, with no generic row and not as a step", () => {
		const html = render({ items: referenceTurn(presenting("p1")) });
		expect(count(html, "Presenting 4 files")).toBe(0);
		expect(html).not.toContain("hb-tool-row");
		for (const file of posters) expect(count(html, `title="${file.path}"`)).toBe(1);
		// The turn's line folds away what the agent said before its answer; it has no steps to count.
		expect(count(html, "Worked for")).toBe(1);
		expect(html).not.toContain("step");
	});

	it("draws no Worked for line over a turn whose only work is a call rendered in place", () => {
		const items: TranscriptItem[] = [user("u1", "Show me the posters"), presenting("p1"), assistant("a1", "Here.")];
		const html = render({ items });
		expect(html).not.toContain("Worked for");
		expect(count(html, "Presenting 4 files")).toBe(0);
		for (const file of posters) expect(count(html, `title="${file.path}"`)).toBe(1);
	});

	it("takes it out of a mixed turn, whose line counts only the other calls", () => {
		const items: TranscriptItem[] = [
			user("u1", "Make four posters"),
			tool("x1", "bash", "Running render.py", { output: "Wrote 4 images" }),
			presenting("p1"),
			assistant("a1", "Here they are."),
		];
		const html = render({ items });
		expect(count(html, "Worked for")).toBe(1);
		expect(html).toContain(", 1 step");
		expect(count(html, "Presenting 4 files")).toBe(0);
		expect(count(html, `title="${posters[0]?.path}"`)).toBe(1);
	});

	it("renders generate_image as its images, once, and present_files of the same images as nothing more", () => {
		const items: TranscriptItem[] = [
			user("u1", "Make four posters"),
			...posters.map((file, index) => generated(`g${index}`, file)),
			presenting("p1"),
			assistant("a1", "I generated 4 new poster iterations."),
		];
		const html = render({ items });
		expect(count(html, "hb-generated-image-picture")).toBe(4);
		expect(count(html, "Made with gpt-image-1")).toBe(4);
		expect(html).not.toContain("Making an image");
		expect(html).not.toContain("Presenting 4 files");
		expect(html).not.toContain("hb-presented-card");
		expect(html).not.toContain("Worked for");
		// While it runs: its row, and a placeholder for the image to come.
		const running = render({ items: [user("u1", "Make a poster"), generated("g0", poster("x"), "running")] });
		expect(count(running, "Making an image")).toBeGreaterThanOrEqual(1);
		expect(running).toContain("hb-image-placeholder");
	});

	it("folds a failed generate_image away with the turn's steps, and the turn's line counts it", () => {
		const failed = { ...generated("g0", poster("x"), "error"), output: "Content policy" };
		const html = render({ items: [user("u1", "Make a poster"), failed, assistant("a1", "It was refused.")] });
		expect(html).toContain(", 1 step");
		expect(html).toContain("1 failed");
		expect(count(html, "Making an image")).toBe(0);
	});

	it("shows the generic row while the call runs, and folds it as a step when it fails", () => {
		const running = render({ items: referenceTurn(presenting("p1", "running")) });
		expect(count(running, "Presenting 4 files")).toBe(1);
		const failed = render({ items: referenceTurn({ ...presenting("p1", "error"), output: "No such file" }) });
		expect(count(failed, "Presenting 4 files")).toBe(0);
		expect(failed).toContain("1 step");
		expect(failed).toContain("1 failed");
		expect(failed).not.toContain("hb-presented-card");
	});

	it("shows image files as pictures when the host previews them, and as file cards when it doesn't", () => {
		const previewImage = () => Promise.resolve("blob:poster");
		const previewed = render({ items: referenceTurn(presenting("p1")), previewImage });
		// Server rendering runs no effects: each image is the frame it shows while the host reads it.
		expect(count(previewed, "hb-presented-image-frame")).toBe(4);
		expect(count(previewed, "hb-presented-images")).toBe(1);
		expect(previewed).not.toContain("hb-presented-card");
		const plain = render({ items: referenceTurn(presenting("p1")) });
		expect(count(plain, "hb-presented-card")).toBe(4);
		expect(plain).not.toContain("hb-presented-image");
	});

	it("renders a host's own in-place tool once, and its own label and detail inside the generic row", () => {
		const chart: ToolRenderer = {
			tools: ["make_chart"],
			inPlace: ({ item }) => createElement("figure", { className: "chart" }, `Chart for ${item.callId}`),
		};
		const shell: ToolRenderer = {
			tools: ["bash"],
			label: () => "Ran the tests",
			openByDefault: () => true,
			detail: ({ item }) => createElement("pre", { className: "terminal" }, item.output),
		};
		const renderers = toolRenderers([...defaultToolRenderers, chart, shell]);
		// The turn is still going, so its last group shows every call.
		const items: TranscriptItem[] = [
			user("u1", "Chart it"),
			tool("c1", "make_chart", "Calling make_chart"),
			tool("b1", "bash", "Running pnpm test", { output: "12 passed" }),
		];
		const html = render({ items, toolRenderers: renderers });
		expect(count(html, "Chart for call-c1")).toBe(1);
		expect(html).not.toContain("Calling make_chart");
		expect(count(html, "Ran the tests")).toBe(1);
		expect(html).not.toContain("Running pnpm test");
		expect(html).toContain('<pre class="terminal">12 passed</pre>');
		// Finished, only bash is a step of the group.
		const done = render({ items: [...items, assistant("a1", "Done.")], toolRenderers: renderers });
		expect(count(done, "Chart for call-c1")).toBe(1);
		expect(done).toContain(", 1 step");
	});

	it("leaves the calls themselves alone: the rows hold each call exactly as the session sent it", () => {
		const call = presenting("p1");
		const items = referenceTurn(call);
		const snapshot = structuredClone(items);
		const rows = groupTranscript(items, undefined, DEFAULT_TOOL_RENDERERS.inPlace);
		render({ items });
		expect(items).toEqual(snapshot);
		const row = rows.find((candidate) => candidate.kind === "call");
		expect(row?.kind === "call" ? row.item : undefined).toBe(call);
	});

	it("gives a call row outside a transcript the file and shell tools' cards, and the generic row otherwise", () => {
		const html = renderToStaticMarkup(createElement(ToolCallChip, { item: presenting("p1") }));
		expect(count(html, "Presenting 4 files")).toBe(1);
		const bash = tool("b1", "bash", "bash", { args: { command: "pnpm test" }, output: "ok" });
		const card = renderToStaticMarkup(createElement(ToolCallChip, { item: bash }));
		expect(card).toContain("Ran pnpm test");
		expect(card).toContain("hb-tool-open");
		const inside = renderToStaticMarkup(
			createElement(
				ToolRenderersContext.Provider,
				{ value: toolRenderers([{ tools: ["present_files"], label: () => "Showing posters" }]) },
				createElement(ToolCallChip, { item: presenting("p1") }),
			),
		);
		expect(inside).toContain("Showing posters");
	});

	it("gives the file and shell tools their cards in a transcript, and lets a host replace them", () => {
		const bash = tool("b1", "bash", "bash", { args: { command: "pnpm test" }, output: "ok" });
		const items = [user("u1", "Run the tests"), bash];
		const html = render({ items });
		expect(html).toContain("Ran pnpm test");
		expect(html).toContain("hb-tool-card-header");
		const mine = toolRenderers([...defaultToolRenderers, { tools: ["bash"], label: () => "Ran the tests" }]);
		const replaced = render({ items, toolRenderers: mine });
		expect(replaced).toContain("Ran the tests");
		expect(replaced).not.toContain("hb-tool-card-header");
	});
});
