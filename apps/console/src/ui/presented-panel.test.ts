import type { PresentedFile } from "@harbour/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkspaceFile } from "../api/client.ts";
import { createImagePreviews } from "./image-previews.ts";
import { PresentedPanel } from "./presented-panel.tsx";

const image: PresentedFile = {
	workspaceId: "ws-1",
	path: "images/cat.png",
	name: "cat.png",
	mimeType: "image/png",
	size: 3,
};
const png: WorkspaceFile = { content: new Uint8Array([1, 2, 3]), contentType: "image/png", version: 1, digest: "abc" };

function panel(previews: ReturnType<typeof createImagePreviews> | undefined) {
	const reads: string[] = [];
	const html = renderToStaticMarkup(
		createElement(PresentedPanel, {
			file: image,
			read: (file) => {
				reads.push(file.path);
				return Promise.resolve(png);
			},
			onClose: () => {},
			images: previews,
		}),
	);
	return { html, reads };
}

describe("PresentedPanel", () => {
	it("opens an image its card has read on that picture, in its first render, with nothing loading", async () => {
		const previews = createImagePreviews(
			() => Promise.resolve(png),
			() => "blob:card",
			() => {},
		);
		await previews.url(image);
		const { html } = panel(previews);
		expect(html).toContain('src="blob:card"');
		expect(html).not.toContain("aria-busy");
	});

	it("loads an image no card has read yet", () => {
		const previews = createImagePreviews(
			() => new Promise(() => {}),
			() => "blob:card",
			() => {},
		);
		const { html } = panel(previews);
		expect(html).toContain('aria-busy="true"');
		expect(html).not.toContain("<img");
	});
});
